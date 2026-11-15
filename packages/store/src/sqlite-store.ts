/**
 * HostDb の SQLite 実装（node:sqlite）。
 *
 * 3 種類の入れ物（cells / logs / kv）を、名前空間の列で分けた 3 つの汎用テーブルに置く。
 * SQL を書くのはこのパッケージだけ。
 *
 * 2 つの動かし方:
 * - 通常: 接続を 1 本持ち続ける。WAL、synchronous NORMAL。
 * - 共有（ネットワーク共有上のファイル）: WAL はネットワークのファイルシステムで壊れるため使わない。
 *   操作ごとに接続を開いて閉じ、書き込みはロックファイル（`<path>.lock`）で 1 人ずつにする。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import { withWriteLock } from "@loc-studio/core";
import { StoreConflictError } from "@loc-studio/sdk";
import type { CellRef, CellStore, CellValue, CellWrite, KvStore, LogRecord, LogStore } from "@loc-studio/sdk";
import { copyRef, errorMessage, fromJson, langKey, planSet, rowToCell, rowToLog, sleep, toJson } from "./common.js";
import type { Row, Store } from "./common.js";

export type { Store } from "./common.js";

export interface OpenStoreOptions {
  /** ファイルのパス、または ":memory:"。親フォルダは作る。 */
  path: string;
  /** いまのユーザー名。設定の変更がすぐ効くよう、書き込みのたびに読む。 */
  userName: () => string;
  hostName?: string;
  /** 指定すると、複数人が使うネットワーク共有上のデータベースとして扱う。 */
  sharing?: { mode: "lockfile"; staleAfterMs?: number; waitMs?: number; retryDelayMs?: number };
  /** テスト用。 */
  now?: () => Date;
}


// ---------------------------------------------------------------------------
// スキーマ
// ---------------------------------------------------------------------------

/** i 番目の手順を実行すると、スキーマの版が i + 1 になる。後の版は末尾に足すだけにする。 */
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) WITHOUT ROWID;
      INSERT INTO meta (key, value) VALUES ('schema_version', 0), ('change_seq', 0);

      CREATE TABLE cells (
        ns TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        column_id TEXT NOT NULL,
        language TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        basis_hash TEXT,
        PRIMARY KEY (ns, resource_id, entry_key, column_id, language)
      ) WITHOUT ROWID;
      CREATE INDEX cells_by_column ON cells (ns, column_id, language);

      CREATE TABLE logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ns TEXT NOT NULL,
        resource_id TEXT,
        entry_key TEXT,
        column_id TEXT,
        language TEXT,
        at TEXT NOT NULL,
        by TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX logs_by_cell ON logs (ns, resource_id, entry_key, column_id, language, seq);
      CREATE INDEX logs_by_column ON logs (ns, column_id, seq);
      CREATE INDEX logs_by_ns ON logs (ns, seq);

      CREATE TABLE kv (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (ns, key)
      ) WITHOUT ROWID;
    `);
  },
];

const SCHEMA_VERSION = MIGRATIONS.length;

/** 1 回の問い合わせに入れるセルの数。SQLite の引数の上限（既定 32766）に十分な余裕を持たせる。 */
const CHUNK = 500;

const BUSY_TIMEOUT_MS = 5000;
const READ_RETRIES = 10;

// ---------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------

function isBusy(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { errcode?: unknown }).errcode;
  // SQLITE_BUSY(5) と SQLITE_LOCKED(6)。拡張コードは下位 8 ビットで判定する。
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function valuesPlaceholders(count: number, width: number): string {
  const one = `(${Array.from({ length: width }, () => "?").join(", ")})`;
  return Array.from({ length: count }, () => one).join(", ");
}

// ---------------------------------------------------------------------------
// 接続
// ---------------------------------------------------------------------------

/** 1 本の接続と、その接続で準備した文。 */
class Conn {
  private readonly statements = new Map<string, StatementSync>();

  constructor(readonly db: DatabaseSync) {}

  stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  bumpChangeSeq(): void {
    this.stmt("UPDATE meta SET value = value + 1 WHERE key = 'change_seq'").run();
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as Row | undefined;
  return row ? Number(row.value) : 0;
}

/** 不足している手順を 1 つのトランザクションで当てる。 */
function migrate(db: DatabaseSync, dbPath: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = readSchemaVersion(db);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `データベースのスキーマの版（${current}）が、このアプリが扱える版（${SCHEMA_VERSION}）より新しいです。アプリを更新してください: ${dbPath}`,
      );
    }
    if (current < SCHEMA_VERSION) {
      for (let v = current; v < SCHEMA_VERSION; v++) MIGRATIONS[v]!(db);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(SCHEMA_VERSION);
      db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'change_seq'").run();
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

class SqliteStore implements Store {
  readonly path: string;
  private readonly memory: boolean;
  private readonly shared: OpenStoreOptions["sharing"];
  private readonly userName: () => string;
  private readonly hostName: string;
  private readonly now: () => Date;
  /** 通常モードで持ち続ける接続。 */
  private conn: Conn | undefined;
  private closed = false;
  /** 同じプロセス内の書き込みを順に並べ、ロックファイルの取り合いを減らす。 */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: OpenStoreOptions) {
    this.memory = opts.path === ":memory:";
    this.path = this.memory ? opts.path : path.resolve(opts.path);
    this.shared = opts.sharing;
    this.userName = opts.userName;
    this.hostName = opts.hostName ?? os.hostname();
    this.now = opts.now ?? (() => new Date());
    if (this.shared && this.memory) {
      throw new Error("共有モードでは \":memory:\" は使えません。ファイルのパスを指定してください");
    }
  }

  get lockPath(): string {
    return `${this.path}.lock`;
  }

  async init(): Promise<void> {
    if (!this.memory) {
      try {
        mkdirSync(path.dirname(this.path), { recursive: true });
      } catch (err) {
        throw new Error(`データベースのフォルダを作れませんでした: ${path.dirname(this.path)}: ${errorMessage(err)}`, {
          cause: err,
        });
      }
    }
    if (!this.shared) {
      const conn = this.openConn();
      try {
        migrate(conn.db, this.path);
      } catch (err) {
        conn.close();
        throw err;
      }
      this.conn = conn;
      return;
    }
    // 共有モード: 版と journal_mode を読むだけなら書き込みロックは要らない。直す必要があるときだけ取る。
    const needsWork = await this.readOp((c) => {
      const mode = (c.db.prepare("PRAGMA journal_mode").get() as Row | undefined)?.journal_mode;
      return readSchemaVersion(c.db) !== SCHEMA_VERSION || String(mode).toLowerCase() === "wal";
    });
    if (needsWork) {
      await this.writeOp("データベースの準備", (c) => {
        migrate(c.db, this.path);
      }, false);
    }
  }

  private openConn(): Conn {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.path);
    } catch (err) {
      throw new Error(`データベースを開けませんでした: ${this.path}: ${errorMessage(err)}`, { cause: err });
    }
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      if (this.shared) {
        db.exec("PRAGMA journal_mode = DELETE");
        db.exec("PRAGMA synchronous = FULL");
      } else {
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
      }
    } catch (err) {
      db.close();
      throw new Error(`データベースの設定に失敗しました: ${this.path}: ${errorMessage(err)}`, { cause: err });
    }
    return new Conn(db);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`データベースはすでに閉じられています: ${this.path}`);
  }

  /** 読み取り。共有モードでは接続を開いて閉じ、使用中なら少し待って繰り返す。 */
  private async readOp<T>(fn: (c: Conn) => T): Promise<T> {
    this.assertOpen();
    if (this.conn) return fn(this.conn);
    for (let attempt = 0; ; attempt++) {
      const c = this.openConn();
      try {
        return fn(c);
      } catch (err) {
        if (!isBusy(err) || attempt >= READ_RETRIES) {
          throw new Error(`データベースを読めませんでした: ${this.path}: ${errorMessage(err)}`, { cause: err });
        }
      } finally {
        c.close();
      }
      await sleep(20 * (attempt + 1) + Math.random() * 20);
    }
  }

  /**
   * 書き込み。1 回の呼び出しを 1 つのトランザクションにし、変更番号を同じトランザクションで進める。
   * 共有モードでは書き込みロックの中で、接続を開いて閉じる。
   */
  private writeOp<T>(purpose: string, fn: (c: Conn) => T, transaction = true): Promise<T> {
    this.assertOpen();
    const run = (c: Conn): T => {
      if (!transaction) return fn(c);
      c.db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(c);
        c.bumpChangeSeq();
        c.db.exec("COMMIT");
        return result;
      } catch (err) {
        if (c.db.isTransaction) c.db.exec("ROLLBACK");
        throw err;
      }
    };
    if (this.conn) {
      // 通常モードは同期 API なので、ほかの呼び出しと混ざらない。
      return Promise.resolve().then(() => {
        this.assertOpen();
        return run(this.conn!);
      });
    }
    const shared = this.shared!;
    const task = async (): Promise<T> => {
      this.assertOpen();
      const lockOpts = {
        lockPath: this.lockPath,
        owner: { userName: this.userName(), hostName: this.hostName, pid: process.pid, purpose },
        ...(shared.staleAfterMs !== undefined ? { staleAfterMs: shared.staleAfterMs } : {}),
        ...(shared.waitMs !== undefined ? { waitMs: shared.waitMs } : {}),
        ...(shared.retryDelayMs !== undefined ? { retryDelayMs: shared.retryDelayMs } : {}),
      };
      return withWriteLock(lockOpts, async () => {
        const c = this.openConn();
        try {
          return run(c);
        } finally {
          c.close();
        }
      });
    };
    const result = this.writeChain.then(task, task);
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  // -------------------------------------------------------------------------
  // HostDb
  // -------------------------------------------------------------------------

  cells(namespace: string): CellStore {
    return {
      get: (cells) => this.readOp((c) => this.getCells(c, namespace, cells)),
      set: (values) => this.setCells(namespace, values),
      query: (filter) => this.readOp((c) => this.queryCells(c, namespace, filter)),
      renameEntry: (resourceId, oldKey, newKey) => this.renameCells(namespace, resourceId, oldKey, newKey),
    };
  }

  log<T = unknown>(namespace: string): LogStore<T> {
    return {
      append: (entries) => this.appendLogs<T>(namespace, entries),
      list: (filter) => this.readOp((c) => this.listLogs<T>(c, namespace, filter ?? {})),
      latest: (cells) => this.readOp((c) => this.latestLogs<T>(c, namespace, cells)),
      renameEntry: (resourceId, oldKey, newKey) => this.renameLogs(namespace, resourceId, oldKey, newKey),
    };
  }

  kv(namespace: string): KvStore {
    return {
      get: (key) =>
        this.readOp((c) => {
          const row = c.stmt("SELECT value FROM kv WHERE ns = ? AND key = ?").get(namespace, key) as Row | undefined;
          return row ? fromJson(row.value) : undefined;
        }),
      getMany: (keys) => this.readOp((c) => this.kvGetMany(c, namespace, keys)),
      set: async (key, value) => {
        await this.writeOp(`値の保存（${namespace}）`, (c) => this.kvPut(c, namespace, [[key, value]]));
      },
      setMany: async (values) => {
        const entries = Object.entries(values);
        if (entries.length === 0) return;
        await this.writeOp(`値の保存（${namespace}）`, (c) => this.kvPut(c, namespace, entries));
      },
      delete: async (key) => {
        await this.writeOp(`値の削除（${namespace}）`, (c) => {
          c.stmt("DELETE FROM kv WHERE ns = ? AND key = ?").run(namespace, key);
        });
      },
    };
  }

  // -------------------------------------------------------------------------
  // cells
  // -------------------------------------------------------------------------

  /** 引数の順に、存在するセルの行を返す（重複した参照はそのぶん返す）。 */
  private getCells(c: Conn, ns: string, refs: CellRef[]): CellValue[] {
    const found = this.fetchCellRows(c, ns, refs);
    const out: CellValue[] = [];
    for (let i = 0; i < refs.length; i++) {
      const row = found[i];
      if (row) out.push(rowToCell(row));
    }
    return out;
  }

  /** refs[i] に対応する行（なければ undefined）。チャンクごとに 1 回の問い合わせで引く。 */
  private fetchCellRows(c: Conn, ns: string, refs: CellRef[]): (Row | undefined)[] {
    const result: (Row | undefined)[] = new Array(refs.length);
    let offset = 0;
    for (const part of chunks(refs)) {
      const sql =
        `WITH q(i, r, e, c, l) AS (VALUES ${valuesPlaceholders(part.length, 5)}) ` +
        "SELECT q.i AS i, cells.* FROM q JOIN cells ON cells.ns = ? AND cells.resource_id = q.r " +
        "AND cells.entry_key = q.e AND cells.column_id = q.c AND cells.language = q.l";
      const params: (string | number)[] = [];
      part.forEach((ref, j) => {
        params.push(offset + j, ref.resourceId, ref.entryKey, ref.columnId, langKey(ref.language));
      });
      params.push(ns);
      for (const row of c.stmt(sql).all(...params) as Row[]) result[Number(row.i)] = row;
      offset += part.length;
    }
    return result;
  }

  private async setCells(ns: string, writes: CellWrite[]): Promise<CellValue[]> {
    if (writes.length === 0) {
      this.assertOpen();
      return [];
    }
    return this.writeOp(`セルの保存（${ns}）`, (c) => {
      const rows = this.fetchCellRows(c, ns, writes);
      const plan = planSet(writes, rows);
      if (plan.conflicts.length > 0) throw new StoreConflictError(plan.conflicts);
      const plannedVersions = plan.versions;

      const updatedAt = this.now().toISOString();
      const updatedBy = this.userName();
      const upsert = c.stmt(
        "INSERT INTO cells (ns, resource_id, entry_key, column_id, language, value, version, updated_at, updated_by, basis_hash) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (ns, resource_id, entry_key, column_id, language) DO UPDATE SET " +
          "value = excluded.value, version = excluded.version, updated_at = excluded.updated_at, " +
          "updated_by = excluded.updated_by, basis_hash = excluded.basis_hash",
      );
      return writes.map((w, i) => {
        const version = plannedVersions[i]!;
        const json = toJson(w.value);
        upsert.run(
          ns,
          w.resourceId,
          w.entryKey,
          w.columnId,
          langKey(w.language),
          json,
          version,
          updatedAt,
          updatedBy,
          w.basisHash ?? null,
        );
        const out: CellValue = {
          resourceId: w.resourceId,
          entryKey: w.entryKey,
          columnId: w.columnId,
          value: fromJson(json),
          version,
          updatedAt,
          updatedBy,
        };
        if (w.language !== undefined) out.language = w.language;
        if (w.basisHash !== undefined) out.basisHash = w.basisHash;
        return out;
      });
    });
  }

  private queryCells(
    c: Conn,
    ns: string,
    filter: { resourceId?: string; columnId?: string; language?: string },
  ): CellValue[] {
    const where = ["ns = ?"];
    const params: string[] = [ns];
    if (filter.resourceId !== undefined) {
      where.push("resource_id = ?");
      params.push(filter.resourceId);
    }
    if (filter.columnId !== undefined) {
      where.push("column_id = ?");
      params.push(filter.columnId);
    }
    if (filter.language !== undefined) {
      where.push("language = ?");
      params.push(filter.language);
    }
    const sql = `SELECT * FROM cells WHERE ${where.join(" AND ")} ORDER BY resource_id, entry_key, column_id, language`;
    return (c.stmt(sql).all(...params) as Row[]).map(rowToCell);
  }

  private async renameCells(ns: string, resourceId: string, oldKey: string, newKey: string): Promise<void> {
    if (oldKey === newKey) {
      this.assertOpen();
      return;
    }
    await this.writeOp(`キーの変更（${ns}）`, (c) => {
      // 新しいキーにすでに値があるセルは、そちらを残す。
      c.stmt(
        "DELETE FROM cells WHERE ns = ? AND resource_id = ? AND entry_key = ? AND EXISTS (" +
          "SELECT 1 FROM cells AS n WHERE n.ns = cells.ns AND n.resource_id = cells.resource_id " +
          "AND n.entry_key = ? AND n.column_id = cells.column_id AND n.language = cells.language)",
      ).run(ns, resourceId, oldKey, newKey);
      c.stmt("UPDATE cells SET entry_key = ? WHERE ns = ? AND resource_id = ? AND entry_key = ?").run(
        newKey,
        ns,
        resourceId,
        oldKey,
      );
    });
  }

  // -------------------------------------------------------------------------
  // logs
  // -------------------------------------------------------------------------

  private async appendLogs<T>(ns: string, entries: { cell?: CellRef; data: T }[]): Promise<LogRecord<T>[]> {
    if (entries.length === 0) {
      this.assertOpen();
      return [];
    }
    return this.writeOp(`記録の追加（${ns}）`, (c) => {
      const at = this.now().toISOString();
      const by = this.userName();
      const insert = c.stmt(
        "INSERT INTO logs (id, ns, resource_id, entry_key, column_id, language, at, by, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      return entries.map((e) => {
        const id = randomUUID();
        const json = toJson(e.data);
        const cell = e.cell;
        insert.run(
          id,
          ns,
          cell ? cell.resourceId : null,
          cell ? cell.entryKey : null,
          cell ? cell.columnId : null,
          cell ? langKey(cell.language) : null,
          at,
          by,
          json,
        );
        const rec: LogRecord<T> = { id, at, by, data: fromJson(json) as T };
        if (cell) rec.cell = copyRef(cell);
        return rec;
      });
    });
  }

  private listLogs<T>(
    c: Conn,
    ns: string,
    filter: { cell?: CellRef; resourceId?: string; columnId?: string; limit?: number },
  ): LogRecord<T>[] {
    const where = ["ns = ?"];
    const params: (string | number)[] = [ns];
    if (filter.cell) {
      where.push("resource_id = ?", "entry_key = ?", "column_id = ?", "language = ?");
      params.push(filter.cell.resourceId, filter.cell.entryKey, filter.cell.columnId, langKey(filter.cell.language));
    } else {
      if (filter.resourceId !== undefined) {
        where.push("resource_id = ?");
        params.push(filter.resourceId);
      }
      if (filter.columnId !== undefined) {
        where.push("column_id = ?");
        params.push(filter.columnId);
      }
    }
    const limit = filter.limit !== undefined && filter.limit >= 0 ? Math.floor(filter.limit) : -1;
    params.push(limit);
    const sql = `SELECT * FROM logs WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`;
    return (c.stmt(sql).all(...params) as Row[]).map((r) => rowToLog<T>(r));
  }

  private latestLogs<T>(c: Conn, ns: string, refs: CellRef[]): (LogRecord<T> | undefined)[] {
    const result: (LogRecord<T> | undefined)[] = new Array(refs.length).fill(undefined);
    let offset = 0;
    for (const part of chunks(refs)) {
      const sql =
        `WITH q(i, r, e, c, l) AS (VALUES ${valuesPlaceholders(part.length, 5)}) ` +
        "SELECT q.i AS i, logs.* FROM q JOIN logs ON logs.seq = (" +
        "SELECT max(x.seq) FROM logs AS x WHERE x.ns = ? AND x.resource_id = q.r AND x.entry_key = q.e " +
        "AND x.column_id = q.c AND x.language = q.l)";
      const params: (string | number)[] = [];
      part.forEach((ref, j) => {
        params.push(offset + j, ref.resourceId, ref.entryKey, ref.columnId, langKey(ref.language));
      });
      params.push(ns);
      for (const row of c.stmt(sql).all(...params) as Row[]) result[Number(row.i)] = rowToLog<T>(row);
      offset += part.length;
    }
    return result;
  }

  private async renameLogs(ns: string, resourceId: string, oldKey: string, newKey: string): Promise<void> {
    if (oldKey === newKey) {
      this.assertOpen();
      return;
    }
    await this.writeOp(`キーの変更（${ns}）`, (c) => {
      c.stmt("UPDATE logs SET entry_key = ? WHERE ns = ? AND resource_id = ? AND entry_key = ?").run(
        newKey,
        ns,
        resourceId,
        oldKey,
      );
    });
  }

  // -------------------------------------------------------------------------
  // kv
  // -------------------------------------------------------------------------

  private kvGetMany(c: Conn, ns: string, keys: string[]): Record<string, unknown> {
    const entries: [string, unknown][] = [];
    for (const part of chunks([...new Set(keys)])) {
      const sql = `SELECT key, value FROM kv WHERE ns = ? AND key IN (${part.map(() => "?").join(", ")})`;
      for (const row of c.stmt(sql).all(ns, ...part) as Row[]) entries.push([String(row.key), fromJson(row.value)]);
    }
    // fromEntries は "__proto__" のようなキーも普通のプロパティとして作る。
    return Object.fromEntries(entries);
  }

  private kvPut(c: Conn, ns: string, entries: [string, unknown][]): void {
    const upsert = c.stmt(
      "INSERT INTO kv (ns, key, value) VALUES (?, ?, ?) ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value",
    );
    for (const [key, value] of entries) upsert.run(ns, key, toJson(value));
  }

  // -------------------------------------------------------------------------
  // 管理
  // -------------------------------------------------------------------------

  changeSeq(): Promise<number> {
    return this.readOp((c) => {
      const row = c.stmt("SELECT value FROM meta WHERE key = 'change_seq'").get() as Row | undefined;
      return row ? Number(row.value) : 0;
    });
  }

  async backup(toPath: string): Promise<void> {
    const target = path.resolve(toPath);
    if (!this.memory && target === this.path) {
      throw new Error(`バックアップ先が元のデータベースと同じです: ${target}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    // VACUUM INTO は既存のファイルに書けないため、一時ファイルに書いてから置き換える。
    const tmp = path.join(path.dirname(target), `${path.basename(target)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    const copy = (c: Conn): void => {
      c.db.prepare("VACUUM INTO ?").run(tmp);
    };
    try {
      if (this.shared) await this.writeOp("バックアップ", copy, false);
      else await this.readOp(copy);
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw new Error(`バックアップに失敗しました: ${this.path} → ${target}: ${errorMessage(err)}`, { cause: err });
    }
  }

  integrityCheck(): Promise<string[]> {
    return this.readOp((c) => {
      const rows = c.db.prepare("PRAGMA integrity_check").all() as Row[];
      const problems = rows.map((r) => String(Object.values(r)[0]));
      return problems.length === 1 && problems[0] === "ok" ? [] : problems;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const conn = this.conn;
    this.conn = undefined;
    conn?.close();
  }
}

export async function openStore(opts: OpenStoreOptions): Promise<Store> {
  const store = new SqliteStore(opts);
  await store.init();
  return store;
}
