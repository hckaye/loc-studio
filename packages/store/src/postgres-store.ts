/**
 * HostDb の Postgres 実装（pg / node-postgres）。
 *
 * 表の形と規則は SQLite の実装と同じ（cells / logs / kv を名前空間の列で分ける）。
 * チームでデータベースサーバーを使うときのためのもの。
 *
 * 設計の要点:
 * - 値は TEXT に JSON の文字列のまま置く（JSONB にしない）。JSONB はキーの順序や数値の書き方を正規化し、
 *   文字列中の "\u0000" を受け付けないため、SQLite と同じ「書いた JSON がそのまま戻る」にならない。
 *   値の中身で検索する用途はないので、JSONB の利点は要らない。
 * - 文字列の列は COLLATE "C"。比較と並び順がバイト順（SQLite の BINARY と同じ）になり、サーバーのロケールに左右されない。
 * - set は 1 つのトランザクションで、対象の既存行を決まった順に SELECT ... FOR UPDATE で押さえてから版を比べる。
 *   まだない行を 2 人が同時に作ろうとしたときは、後の人が一意制約違反になるので、トランザクションごとやり直す
 *   （やり直すと行が見えるので、版の比較で正しく競合になる）。デッドロックと直列化の失敗も同じくやり直す。
 * - 変更番号は 16 行に分けた数の合計。書き込みは 1 行だけを、トランザクションの最後に 1 増やす。
 *   シーケンスと違い、取り消された書き込みで飛ばず、コミットされた書き込みと同時にだけ見える（読んだ番号と中身が食い違わない）。
 *   行の更新はコミットの直前なので、行ロックを持つのはコミットの間だけで、書き込む人どうしをほとんど待たせない。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import pg from "pg";
import type { PoolClient } from "pg";
import { StoreConflictError } from "@loc-studio/sdk";
import type { CellRef, CellStore, CellValue, CellWrite, KvStore, LogRecord, LogStore } from "@loc-studio/sdk";
import {
  copyRef,
  errorMessage,
  fromJson,
  langKey,
  planSet,
  rowToCell,
  rowToLog,
  sleep,
  toJson,
  cellKey,
} from "./common.js";
import type { Row, Store } from "./common.js";

export interface OpenPostgresStoreOptions {
  /** 接続文字列。例: postgres://user:pass@host:5432/dbname */
  url: string;
  /** いまのユーザー名。設定の変更がすぐ効くよう、書き込みのたびに読む。 */
  userName: () => string;
  /** 表を置くスキーマ。なければ作る。既定 "loc_studio"。スキーマを分ければ 1 つのデータベースを複数のプロジェクトで使える。 */
  schema?: string;
  /** テスト用。 */
  now?: () => Date;
  /** 接続プールの大きさ。既定 5。 */
  maxConnections?: number;
}

const DEFAULT_SCHEMA = "loc_studio";
const COUNTER_SLOTS = 16;
/** 一意制約違反・デッドロック・直列化の失敗をやり直す最大回数。 */
const MAX_ATTEMPTS = 10;
/** バックアップでカーソルから一度に読む行数。 */
const EXPORT_BATCH = 1000;
export const EXPORT_FORMAT = "loc-studio-store-export";
export const EXPORT_FORMAT_VERSION = 1;

/** 書き込みをやり直してよいエラー。 */
const RETRYABLE = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "23505", // unique_violation（まだない行を同時に作った）
]);

function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 表示用の接続先。パスワードは出さない。 */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.password = "";
    return u.toString();
  } catch {
    return "(接続文字列を解釈できません)";
  }
}

/** i 番目の手順を実行すると、スキーマの版が i + 1 になる。後の版は末尾に足すだけにする。 */
function migrations(s: string): string[] {
  return [
    `
    CREATE TABLE ${s}.cells (
      ns text COLLATE "C" NOT NULL,
      resource_id text COLLATE "C" NOT NULL,
      entry_key text COLLATE "C" NOT NULL,
      column_id text COLLATE "C" NOT NULL,
      language text COLLATE "C" NOT NULL,
      value text NOT NULL,
      version integer NOT NULL,
      updated_at text NOT NULL,
      updated_by text NOT NULL,
      basis_hash text,
      PRIMARY KEY (ns, resource_id, entry_key, column_id, language)
    );
    CREATE INDEX cells_by_column ON ${s}.cells (ns, column_id, language);

    CREATE TABLE ${s}.logs (
      seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id text NOT NULL UNIQUE,
      ns text COLLATE "C" NOT NULL,
      resource_id text COLLATE "C",
      entry_key text COLLATE "C",
      column_id text COLLATE "C",
      language text COLLATE "C",
      at text NOT NULL,
      by text NOT NULL,
      data text NOT NULL
    );
    CREATE INDEX logs_by_cell ON ${s}.logs (ns, resource_id, entry_key, column_id, language, seq);
    CREATE INDEX logs_by_column ON ${s}.logs (ns, column_id, seq);
    CREATE INDEX logs_by_ns ON ${s}.logs (ns, seq);

    CREATE TABLE ${s}.kv (
      ns text COLLATE "C" NOT NULL,
      key text COLLATE "C" NOT NULL,
      value text NOT NULL,
      PRIMARY KEY (ns, key)
    );

    CREATE TABLE ${s}.change_counter (
      slot integer PRIMARY KEY,
      n bigint NOT NULL
    );
    INSERT INTO ${s}.change_counter (slot, n) SELECT g, 0 FROM generate_series(0, ${COUNTER_SLOTS - 1}) AS g;
    `,
  ];
}

const SCHEMA_VERSION = migrations("x").length;

/** 参照の配列を、unnest に渡す列ごとの配列に分ける。 */
function refColumns(refs: CellRef[]): [string[], string[], string[], string[]] {
  const r: string[] = [];
  const e: string[] = [];
  const c: string[] = [];
  const l: string[] = [];
  for (const ref of refs) {
    r.push(ref.resourceId);
    e.push(ref.entryKey);
    c.push(ref.columnId);
    l.push(langKey(ref.language));
  }
  return [r, e, c, l];
}

class PostgresStore implements Store {
  readonly path: string;
  private readonly pool: pg.Pool;
  private readonly s: string;
  private readonly schemaName: string;
  private readonly userName: () => string;
  private readonly now: () => Date;
  private readonly target: string;
  private closed = false;

  constructor(opts: OpenPostgresStoreOptions) {
    this.schemaName = opts.schema ?? DEFAULT_SCHEMA;
    if (this.schemaName === "") throw new Error("Postgres のスキーマ名が空です");
    this.s = quoteIdent(this.schemaName);
    this.target = describeUrl(opts.url);
    this.path = `${this.target}#${this.schemaName}`;
    this.userName = opts.userName;
    this.now = opts.now ?? (() => new Date());
    this.pool = new pg.Pool({ connectionString: opts.url, max: opts.maxConnections ?? 5 });
    // 待機中の接続が切れたときに出る。プールはその接続を捨てるので、次の操作が改めて接続し、失敗すればそこで報告される。
    // ここで受けないとプロセスごと落ちる。
    this.pool.on("error", () => undefined);
  }

  // -------------------------------------------------------------------------
  // 接続とトランザクション
  // -------------------------------------------------------------------------

  private assertOpen(): void {
    if (this.closed) throw new Error(`データベースへの接続はすでに閉じられています: ${this.path}`);
  }

  private async connect(): Promise<PoolClient> {
    this.assertOpen();
    try {
      return await this.pool.connect();
    } catch (err) {
      throw new Error(`Postgres に接続できませんでした: ${this.target}: ${errorMessage(err)}`, { cause: err });
    }
  }

  private async read<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }

  /**
   * 書き込み。1 回の呼び出しを 1 つのトランザクションにし、最後に変更番号を 1 増やす。
   * やり直してよいエラーなら、少し待ってトランザクションごとやり直す。
   */
  private async write<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const c = await this.connect();
      let broken = false;
      try {
        await c.query("BEGIN");
        const result = await fn(c);
        await this.bumpChangeSeq(c);
        await c.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await c.query("ROLLBACK");
        } catch {
          // 接続が壊れている。プールに戻さず捨てる（元のエラーを報告する）。
          broken = true;
        }
        if (err instanceof StoreConflictError) throw err;
        const code = pgCode(err);
        if (code && RETRYABLE.has(code)) {
          if (attempt < MAX_ATTEMPTS) {
            await sleep(Math.random() * 10 * attempt + 1);
            continue;
          }
          throw new Error(
            `ほかの書き込みと衝突し続けたため、${MAX_ATTEMPTS} 回試しても保存できませんでした: ${this.path}: ${errorMessage(err)}`,
            { cause: err },
          );
        }
        throw new Error(`Postgres への書き込みに失敗しました: ${this.path}: ${errorMessage(err)}`, { cause: err });
      } finally {
        c.release(broken);
      }
    }
  }

  private async bumpChangeSeq(c: PoolClient): Promise<void> {
    const slot = Math.floor(Math.random() * COUNTER_SLOTS);
    await c.query(`UPDATE ${this.s}.change_counter SET n = n + 1 WHERE slot = $1`, [slot]);
  }

  /** スキーマを作り、足りない手順を当てる。複数のサーバーが同時に起動しても 1 つずつ行うよう勧告ロックを取る。 */
  async init(): Promise<void> {
    const c = await this.connect();
    try {
      await c.query("BEGIN");
      try {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`loc-studio:migrate:${this.schemaName}`]);
        await c.query(`CREATE SCHEMA IF NOT EXISTS ${this.s}`);
        await c.query(`CREATE TABLE IF NOT EXISTS ${this.s}.meta (key text PRIMARY KEY, value bigint NOT NULL)`);
        const row = (await c.query(`SELECT value FROM ${this.s}.meta WHERE key = 'schema_version'`)).rows[0] as
          Row | undefined;
        const current = row ? Number(row.value) : 0;
        if (current > SCHEMA_VERSION) {
          throw new Error(
            `データベースのスキーマの版（${current}）が、このアプリが扱える版（${SCHEMA_VERSION}）より新しいです。アプリを更新してください: ${this.path}`,
          );
        }
        if (current < SCHEMA_VERSION) {
          const steps = migrations(this.s);
          for (let v = current; v < SCHEMA_VERSION; v++) await c.query(steps[v]!);
          await c.query(
            `INSERT INTO ${this.s}.meta (key, value) VALUES ('schema_version', $1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            [SCHEMA_VERSION],
          );
          await this.bumpChangeSeq(c);
        }
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    } catch (err) {
      throw new Error(`Postgres のスキーマを準備できませんでした: ${this.path}: ${errorMessage(err)}`, { cause: err });
    } finally {
      c.release();
    }
  }

  // -------------------------------------------------------------------------
  // HostDb
  // -------------------------------------------------------------------------

  cells(namespace: string): CellStore {
    return {
      get: (cells) => this.getCells(namespace, cells),
      set: (values) => this.setCells(namespace, values),
      query: (filter) => this.queryCells(namespace, filter),
      renameEntry: (resourceId, oldKey, newKey) => this.renameCells(namespace, resourceId, oldKey, newKey),
    };
  }

  log<T = unknown>(namespace: string): LogStore<T> {
    return {
      append: (entries) => this.appendLogs<T>(namespace, entries),
      list: (filter) => this.listLogs<T>(namespace, filter ?? {}),
      latest: (cells) => this.latestLogs<T>(namespace, cells),
      renameEntry: (resourceId, oldKey, newKey) => this.renameLogs(namespace, resourceId, oldKey, newKey),
    };
  }

  kv(namespace: string): KvStore {
    return {
      get: (key) =>
        this.read(async (c) => {
          const res = await c.query(`SELECT value FROM ${this.s}.kv WHERE ns = $1 AND key = $2`, [namespace, key]);
          const row = res.rows[0] as Row | undefined;
          return row ? fromJson(row.value) : undefined;
        }),
      getMany: (keys) => this.kvGetMany(namespace, keys),
      set: (key, value) => this.kvPut(namespace, [[key, value]]),
      setMany: (values) => this.kvPut(namespace, Object.entries(values)),
      delete: async (key) => {
        await this.write(async (c) => {
          await c.query(`DELETE FROM ${this.s}.kv WHERE ns = $1 AND key = $2`, [namespace, key]);
        });
      },
    };
  }

  // -------------------------------------------------------------------------
  // cells
  // -------------------------------------------------------------------------

  /** refs[i] に対応する行（なければ undefined）。1 回の問い合わせで引く。lock なら決まった順に行ロックを取る。 */
  private async fetchCellRows(c: PoolClient, ns: string, refs: CellRef[], lock: boolean): Promise<(Row | undefined)[]> {
    const result: (Row | undefined)[] = new Array(refs.length).fill(undefined);
    if (refs.length === 0) return result;
    const res = await c.query(
      `SELECT q.i, t.* FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS q(r, e, c, l, i)
       JOIN ${this.s}.cells AS t ON t.ns = $1 AND t.resource_id = q.r AND t.entry_key = q.e
         AND t.column_id = q.c AND t.language = q.l
       ${lock ? "ORDER BY t.resource_id, t.entry_key, t.column_id, t.language FOR UPDATE OF t" : ""}`,
      [ns, ...refColumns(refs)],
    );
    for (const row of res.rows as Row[]) result[Number(row.i) - 1] = row;
    return result;
  }

  private async getCells(ns: string, refs: CellRef[]): Promise<CellValue[]> {
    this.assertOpen();
    if (refs.length === 0) return [];
    const rows = await this.read((c) => this.fetchCellRows(c, ns, refs, false));
    const out: CellValue[] = [];
    for (const row of rows) if (row) out.push(rowToCell(row));
    return out;
  }

  private async setCells(ns: string, writes: CellWrite[]): Promise<CellValue[]> {
    this.assertOpen();
    if (writes.length === 0) return [];
    return this.write(async (c) => {
      // 同じセルが複数回あっても行ロックは 1 回でよい。
      const unique = new Map<string, CellRef>();
      for (const w of writes) if (!unique.has(cellKey(w))) unique.set(cellKey(w), w);
      const uniqueRefs = [...unique.values()];
      const lockedRows = await this.fetchCellRows(c, ns, uniqueRefs, true);
      const byKey = new Map<string, Row | undefined>();
      uniqueRefs.forEach((r, i) => byKey.set(cellKey(r), lockedRows[i]));
      const plan = planSet(
        writes,
        writes.map((w) => byKey.get(cellKey(w))),
      );
      if (plan.conflicts.length > 0) throw new StoreConflictError(plan.conflicts);

      const updatedAt = this.now().toISOString();
      const updatedBy = this.userName();
      const jsons = writes.map((w) => toJson(w.value));

      // セルごとの最終状態だけを書く。新しい行と既存の行で文を分ける。
      const inserts: { ref: CellRef; json: string; version: number; basis: string | null }[] = [];
      const updates: typeof inserts = [];
      for (const fin of plan.finals.values()) {
        const w = writes[fin.index]!;
        const item = { ref: w, json: jsons[fin.index]!, version: fin.version, basis: w.basisHash ?? null };
        (fin.existed ? updates : inserts).push(item);
      }
      if (inserts.length > 0) {
        await c.query(
          `INSERT INTO ${this.s}.cells (ns, resource_id, entry_key, column_id, language, value, version, updated_at, updated_by, basis_hash)
           SELECT $1, q.r, q.e, q.c, q.l, q.v, q.ver, $8, $9, q.b
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $10::text[]) AS q(r, e, c, l, v, ver, b)
           ORDER BY q.r COLLATE "C", q.e COLLATE "C", q.c COLLATE "C", q.l COLLATE "C"`,
          [
            ns,
            ...refColumns(inserts.map((x) => x.ref)),
            inserts.map((x) => x.json),
            inserts.map((x) => x.version),
            updatedAt,
            updatedBy,
            inserts.map((x) => x.basis),
          ],
        );
      }
      if (updates.length > 0) {
        await c.query(
          `UPDATE ${this.s}.cells AS t SET value = q.v, version = q.ver, updated_at = $8, updated_by = $9, basis_hash = q.b
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $10::text[]) AS q(r, e, c, l, v, ver, b)
           WHERE t.ns = $1 AND t.resource_id = q.r AND t.entry_key = q.e AND t.column_id = q.c AND t.language = q.l`,
          [
            ns,
            ...refColumns(updates.map((x) => x.ref)),
            updates.map((x) => x.json),
            updates.map((x) => x.version),
            updatedAt,
            updatedBy,
            updates.map((x) => x.basis),
          ],
        );
      }

      return writes.map((w, i) => {
        const out: CellValue = {
          ...copyRef(w),
          value: fromJson(jsons[i]),
          version: plan.versions[i]!,
          updatedAt,
          updatedBy,
        };
        if (w.basisHash !== undefined) out.basisHash = w.basisHash;
        return out;
      });
    });
  }

  private async queryCells(
    ns: string,
    filter: { resourceId?: string; columnId?: string; language?: string },
  ): Promise<CellValue[]> {
    const where = ["ns = $1"];
    const params: string[] = [ns];
    const add = (col: string, v: string | undefined) => {
      if (v === undefined) return;
      params.push(v);
      where.push(`${col} = $${params.length}`);
    };
    add("resource_id", filter.resourceId);
    add("column_id", filter.columnId);
    add("language", filter.language);
    return this.read(async (c) => {
      const res = await c.query(
        `SELECT * FROM ${this.s}.cells WHERE ${where.join(" AND ")} ORDER BY resource_id, entry_key, column_id, language`,
        params,
      );
      return (res.rows as Row[]).map(rowToCell);
    });
  }

  private async renameCells(ns: string, resourceId: string, oldKey: string, newKey: string): Promise<void> {
    this.assertOpen();
    if (oldKey === newKey) return;
    await this.write(async (c) => {
      // 新しいキーにすでに値があるセルは、そちらを残す。
      await c.query(
        `DELETE FROM ${this.s}.cells AS t WHERE t.ns = $1 AND t.resource_id = $2 AND t.entry_key = $3 AND EXISTS (
           SELECT 1 FROM ${this.s}.cells AS n WHERE n.ns = t.ns AND n.resource_id = t.resource_id
             AND n.entry_key = $4 AND n.column_id = t.column_id AND n.language = t.language)`,
        [ns, resourceId, oldKey, newKey],
      );
      await c.query(`UPDATE ${this.s}.cells SET entry_key = $4 WHERE ns = $1 AND resource_id = $2 AND entry_key = $3`, [
        ns,
        resourceId,
        oldKey,
        newKey,
      ]);
    });
  }

  // -------------------------------------------------------------------------
  // logs
  // -------------------------------------------------------------------------

  private async appendLogs<T>(ns: string, entries: { cell?: CellRef; data: T }[]): Promise<LogRecord<T>[]> {
    this.assertOpen();
    if (entries.length === 0) return [];
    return this.write(async (c) => {
      const at = this.now().toISOString();
      const by = this.userName();
      const ids = entries.map(() => randomUUID());
      const jsons = entries.map((e) => toJson(e.data));
      const col = (f: (ref: CellRef) => string) => entries.map((e) => (e.cell ? f(e.cell) : null));
      // 番号（seq）が入力の順に振られるよう、順序を付けて挿入する。
      await c.query(
        `INSERT INTO ${this.s}.logs (id, ns, resource_id, entry_key, column_id, language, at, by, data)
         SELECT q.id, $1, q.r, q.e, q.c, q.l, $7, $8, q.d
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $9::text[]) WITH ORDINALITY AS q(id, r, e, c, l, d, i)
         ORDER BY q.i`,
        [
          ns,
          ids,
          col((r) => r.resourceId),
          col((r) => r.entryKey),
          col((r) => r.columnId),
          col((r) => langKey(r.language)),
          at,
          by,
          jsons,
        ],
      );
      return entries.map((e, i) => {
        const rec: LogRecord<T> = { id: ids[i]!, at, by, data: fromJson(jsons[i]) as T };
        if (e.cell) rec.cell = copyRef(e.cell);
        return rec;
      });
    });
  }

  private async listLogs<T>(
    ns: string,
    filter: { cell?: CellRef; resourceId?: string; columnId?: string; limit?: number },
  ): Promise<LogRecord<T>[]> {
    const where = ["ns = $1"];
    const params: (string | number | null)[] = [ns];
    const add = (col: string, v: string | undefined) => {
      if (v === undefined) return;
      params.push(v);
      where.push(`${col} = $${params.length}`);
    };
    if (filter.cell) {
      add("resource_id", filter.cell.resourceId);
      add("entry_key", filter.cell.entryKey);
      add("column_id", filter.cell.columnId);
      add("language", langKey(filter.cell.language));
    } else {
      add("resource_id", filter.resourceId);
      add("column_id", filter.columnId);
    }
    // LIMIT NULL は「制限なし」。
    params.push(filter.limit !== undefined && filter.limit >= 0 ? Math.floor(filter.limit) : null);
    return this.read(async (c) => {
      const res = await c.query(
        `SELECT * FROM ${this.s}.logs WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT $${params.length}`,
        params,
      );
      return (res.rows as Row[]).map((r) => rowToLog<T>(r));
    });
  }

  private async latestLogs<T>(ns: string, refs: CellRef[]): Promise<(LogRecord<T> | undefined)[]> {
    this.assertOpen();
    const result: (LogRecord<T> | undefined)[] = new Array(refs.length).fill(undefined);
    if (refs.length === 0) return result;
    await this.read(async (c) => {
      const res = await c.query(
        `SELECT q.i, x.* FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS q(r, e, c, l, i)
         CROSS JOIN LATERAL (
           SELECT * FROM ${this.s}.logs AS g
           WHERE g.ns = $1 AND g.resource_id = q.r AND g.entry_key = q.e AND g.column_id = q.c AND g.language = q.l
           ORDER BY g.seq DESC LIMIT 1
         ) AS x`,
        [ns, ...refColumns(refs)],
      );
      for (const row of res.rows as Row[]) result[Number(row.i) - 1] = rowToLog<T>(row);
    });
    return result;
  }

  private async renameLogs(ns: string, resourceId: string, oldKey: string, newKey: string): Promise<void> {
    this.assertOpen();
    if (oldKey === newKey) return;
    await this.write(async (c) => {
      await c.query(`UPDATE ${this.s}.logs SET entry_key = $4 WHERE ns = $1 AND resource_id = $2 AND entry_key = $3`, [
        ns,
        resourceId,
        oldKey,
        newKey,
      ]);
    });
  }

  // -------------------------------------------------------------------------
  // kv
  // -------------------------------------------------------------------------

  private async kvGetMany(ns: string, keys: string[]): Promise<Record<string, unknown>> {
    this.assertOpen();
    if (keys.length === 0) return {};
    return this.read(async (c) => {
      const res = await c.query(`SELECT key, value FROM ${this.s}.kv WHERE ns = $1 AND key = ANY($2::text[])`, [
        ns,
        [...new Set(keys)],
      ]);
      // fromEntries は "__proto__" のようなキーも普通のプロパティとして作る。
      return Object.fromEntries((res.rows as Row[]).map((r) => [String(r.key), fromJson(r.value)]));
    });
  }

  private async kvPut(ns: string, entries: [string, unknown][]): Promise<void> {
    this.assertOpen();
    if (entries.length === 0) return;
    await this.write(async (c) => {
      // 同時に別の順で書く人とのデッドロックを避けるため、キーの順に書く。
      await c.query(
        `INSERT INTO ${this.s}.kv (ns, key, value)
         SELECT $1, q.k, q.v FROM unnest($2::text[], $3::text[]) AS q(k, v) ORDER BY q.k COLLATE "C"
         ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value`,
        [ns, entries.map(([k]) => k), entries.map(([, v]) => toJson(v))],
      );
    });
  }

  // -------------------------------------------------------------------------
  // 管理
  // -------------------------------------------------------------------------

  async changeSeq(): Promise<number> {
    return this.read(async (c) => {
      const res = await c.query(`SELECT coalesce(sum(n), 0)::bigint AS n FROM ${this.s}.change_counter`);
      return Number((res.rows[0] as Row).n);
    });
  }

  /**
   * 表の中身を JSON Lines で書き出す。REPEATABLE READ の 1 つのトランザクションで読むので、全体が同じ時点の内容になる。
   * カーソルで少しずつ読み、少しずつ書く（全体をメモリに載せない）。形式は README を参照。
   */
  async backup(toPath: string): Promise<void> {
    this.assertOpen();
    const target = path.resolve(toPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = path.join(
      path.dirname(target),
      `${path.basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    const out = createWriteStream(tmp, { encoding: "utf8" });
    const streamError = new Promise<never>((_, reject) => out.once("error", reject));
    streamError.catch(() => undefined);
    const put = async (text: string) => {
      if (!out.write(text)) await Promise.race([once(out, "drain"), streamError]);
    };
    const c = await this.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const version = (await c.query(`SELECT value FROM ${this.s}.meta WHERE key = 'schema_version'`)).rows[0] as
          Row | undefined;
        const seq = (await c.query(`SELECT coalesce(sum(n), 0)::bigint AS n FROM ${this.s}.change_counter`))
          .rows[0] as Row;
        await put(
          JSON.stringify({
            type: "header",
            format: EXPORT_FORMAT,
            formatVersion: EXPORT_FORMAT_VERSION,
            schema: this.schemaName,
            schemaVersion: version ? Number(version.value) : null,
            changeSeq: Number(seq.n),
            exportedAt: this.now().toISOString(),
          }) + "\n",
        );
        // 値は保存してある JSON の文字列をそのまま埋め込む（読み直して書き直さない）。
        const tables: { name: string; sql: string; line: (r: Row) => string }[] = [
          {
            name: "cells",
            sql: `SELECT * FROM ${this.s}.cells ORDER BY ns, resource_id, entry_key, column_id, language`,
            line: (r) => {
              const head = JSON.stringify({
                type: "cell",
                ns: r.ns,
                resourceId: r.resource_id,
                entryKey: r.entry_key,
                columnId: r.column_id,
                language: r.language,
                version: Number(r.version),
                updatedAt: r.updated_at,
                updatedBy: r.updated_by,
                basisHash: r.basis_hash,
              });
              return `${head.slice(0, -1)},"value":${String(r.value)}}`;
            },
          },
          {
            name: "logs",
            sql: `SELECT * FROM ${this.s}.logs ORDER BY seq`,
            line: (r) => {
              const head = JSON.stringify({
                type: "log",
                ns: r.ns,
                seq: Number(r.seq),
                id: r.id,
                resourceId: r.resource_id,
                entryKey: r.entry_key,
                columnId: r.column_id,
                language: r.language,
                at: r.at,
                by: r.by,
              });
              return `${head.slice(0, -1)},"data":${String(r.data)}}`;
            },
          },
          {
            name: "kv",
            sql: `SELECT * FROM ${this.s}.kv ORDER BY ns, key`,
            line: (r) =>
              `${JSON.stringify({ type: "kv", ns: r.ns, key: r.key }).slice(0, -1)},"value":${String(r.value)}}`,
          },
        ];
        for (const t of tables) {
          await c.query(`DECLARE export_${t.name} NO SCROLL CURSOR FOR ${t.sql}`);
          for (;;) {
            const res = await c.query(`FETCH ${EXPORT_BATCH} FROM export_${t.name}`);
            if (res.rows.length === 0) break;
            await put((res.rows as Row[]).map((r) => t.line(r) + "\n").join(""));
          }
          await c.query(`CLOSE export_${t.name}`);
        }
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      out.end();
      await Promise.race([once(out, "finish"), streamError]);
      await fs.rename(tmp, target);
    } catch (err) {
      out.destroy();
      await fs.rm(tmp, { force: true });
      throw new Error(`バックアップ（書き出し）に失敗しました: ${this.path} → ${target}: ${errorMessage(err)}`, {
        cause: err,
      });
    } finally {
      c.release();
    }
  }

  /** 簡単な整合の確認だけ。ストレージの破損は調べない（それはサーバーの管理の領分）。 */
  async integrityCheck(): Promise<string[]> {
    return this.read(async (c) => {
      const problems: string[] = [];
      const v = (await c.query(`SELECT value FROM ${this.s}.meta WHERE key = 'schema_version'`)).rows[0] as
        Row | undefined;
      if (!v) problems.push("スキーマの版が記録されていません");
      else if (Number(v.value) !== SCHEMA_VERSION) {
        problems.push(`スキーマの版が ${String(v.value)} です（このアプリは ${SCHEMA_VERSION}）`);
      }
      const slots = (await c.query(`SELECT count(*)::int AS n FROM ${this.s}.change_counter`)).rows[0] as Row;
      if (Number(slots.n) !== COUNTER_SLOTS)
        problems.push(`変更番号の行が ${String(slots.n)} 行です（${COUNTER_SLOTS} 行のはず）`);
      const nulls = (
        await c.query(
          `SELECT
             (SELECT count(*) FROM ${this.s}.cells WHERE ns IS NULL OR resource_id IS NULL OR entry_key IS NULL
                OR column_id IS NULL OR language IS NULL OR version IS NULL OR version < 1)::int AS cells,
             (SELECT count(*) FROM ${this.s}.logs WHERE ns IS NULL OR id IS NULL
                OR ((resource_id IS NULL) <> (entry_key IS NULL)) OR ((resource_id IS NULL) <> (column_id IS NULL))
                OR ((resource_id IS NULL) <> (language IS NULL)))::int AS logs,
             (SELECT count(*) FROM ${this.s}.kv WHERE ns IS NULL OR key IS NULL)::int AS kv`,
        )
      ).rows[0] as Row;
      if (Number(nulls.cells) > 0) problems.push(`キーか版が不正なセルが ${String(nulls.cells)} 件あります`);
      if (Number(nulls.logs) > 0) problems.push(`セルの指定が不完全な記録が ${String(nulls.logs)} 件あります`);
      if (Number(nulls.kv) > 0) problems.push(`キーが空の値が ${String(nulls.kv)} 件あります`);
      return problems;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // close は同期の契約なので終了を待てない。終了時の失敗（すでに切れていた等）は、閉じた後では対処のしようがない。
    this.pool.end().catch(() => undefined);
  }
}

export async function openPostgresStore(opts: OpenPostgresStoreOptions): Promise<Store> {
  const store = new PostgresStore(opts);
  try {
    await store.init();
  } catch (err) {
    store.close();
    throw err;
  }
  return store;
}
