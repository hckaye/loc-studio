import { StoreConflictError } from "@loc-studio/sdk";
import type {
  CellRef,
  CellStore,
  CellValue,
  CellWrite,
  HostDb,
  KvStore,
  LanguageId,
  LogRecord,
  LogStore,
} from "@loc-studio/sdk";

export interface MemoryDbOptions {
  /** 書き込んだ人として記録する名前。省略時は "unknown"。 */
  userName?: () => string;
  /** 時刻。テストで固定するため。 */
  now?: () => Date;
}

/** セルを一意に表す文字列。区切りに NUL を使い、キーや ID に含まれる文字と衝突しないようにする。 */
const cellKey = (c: CellRef): string => [c.resourceId, c.entryKey, c.columnId, c.language ?? ""].join("\u0000");

const sameCell = (a: CellRef, b: CellRef): boolean =>
  a.resourceId === b.resourceId &&
  a.entryKey === b.entryKey &&
  a.columnId === b.columnId &&
  (a.language ?? undefined) === (b.language ?? undefined);

/** 呼び出し側が保存済みの値を書き換えられないよう、出し入れのたびに複製する。 */
const clone = <T>(value: T): T => structuredClone(value);

const refOf = (c: CellRef): CellRef => {
  const ref: CellRef = { entryKey: c.entryKey, resourceId: c.resourceId, columnId: c.columnId };
  if (c.language !== undefined) ref.language = c.language;
  return ref;
};

/**
 * メモリ上の HostDb。テストと、DB が設定されていないときの代わりに使う。
 * プロセスを終えると中身は消える。
 */
export function createMemoryDb(opts: MemoryDbOptions = {}): HostDb {
  const userName = opts.userName ?? (() => "unknown");
  const now = opts.now ?? (() => new Date());
  const cellSpaces = new Map<string, CellStore>();
  const logSpaces = new Map<string, LogStore<unknown>>();
  const kvSpaces = new Map<string, KvStore>();
  let logSeq = 0;

  function makeCells(): CellStore {
    const data = new Map<string, CellValue>();
    return {
      async get(cells) {
        const out: CellValue[] = [];
        for (const c of cells) {
          const v = data.get(cellKey(c));
          if (v) out.push(clone(v));
        }
        return out;
      },
      async set(values: CellWrite[]) {
        // 先にすべて確かめ、1 つでも合わなければ何も書かない。
        const conflicts: { cell: CellRef; current: CellValue | undefined }[] = [];
        for (const w of values) {
          if (w.expectedVersion === undefined) continue;
          const current = data.get(cellKey(w));
          if ((current?.version ?? 0) !== w.expectedVersion) {
            conflicts.push({ cell: refOf(w), current: current ? clone(current) : undefined });
          }
        }
        if (conflicts.length > 0) throw new StoreConflictError(conflicts);
        const at = now().toISOString();
        const by = userName();
        const out: CellValue[] = [];
        for (const w of values) {
          const key = cellKey(w);
          const current = data.get(key);
          const next: CellValue = {
            ...refOf(w),
            value: clone(w.value),
            version: (current?.version ?? 0) + 1,
            updatedAt: at,
            updatedBy: by,
          };
          if (w.basisHash !== undefined) next.basisHash = w.basisHash;
          data.set(key, next);
          out.push(clone(next));
        }
        return out;
      },
      async query(filter: { resourceId?: string; columnId?: string; language?: LanguageId }) {
        const out: CellValue[] = [];
        for (const v of data.values()) {
          if (filter.resourceId !== undefined && v.resourceId !== filter.resourceId) continue;
          if (filter.columnId !== undefined && v.columnId !== filter.columnId) continue;
          if (filter.language !== undefined && v.language !== filter.language) continue;
          out.push(clone(v));
        }
        return out;
      },
      async renameEntry(resourceId, oldKey, newKey) {
        if (oldKey === newKey) return;
        const moved: CellValue[] = [];
        for (const [key, v] of data) {
          if (v.resourceId === resourceId && v.entryKey === oldKey) {
            data.delete(key);
            moved.push({ ...v, entryKey: newKey });
          }
        }
        for (const v of moved) data.set(cellKey(v), v);
      },
    };
  }

  function makeLog(): LogStore<unknown> {
    // 追加した順に並べる。新しい順は逆から読む。
    const records: LogRecord<unknown>[] = [];
    return {
      async append(entries) {
        const at = now().toISOString();
        const by = userName();
        const out: LogRecord<unknown>[] = [];
        for (const e of entries) {
          logSeq += 1;
          const rec: LogRecord<unknown> = { id: `mem-${logSeq}`, at, by, data: clone(e.data) };
          if (e.cell) rec.cell = refOf(e.cell);
          records.push(rec);
          out.push(clone(rec));
        }
        return out;
      },
      async list(filter = {}) {
        const out: LogRecord<unknown>[] = [];
        const limit = filter.limit;
        for (let i = records.length - 1; i >= 0; i--) {
          if (limit !== undefined && out.length >= limit) break;
          const rec = records[i]!;
          if (filter.cell && !(rec.cell && sameCell(rec.cell, filter.cell))) continue;
          if (filter.resourceId !== undefined && rec.cell?.resourceId !== filter.resourceId) continue;
          if (filter.columnId !== undefined && rec.cell?.columnId !== filter.columnId) continue;
          out.push(clone(rec));
        }
        return out;
      },
      async latest(cells) {
        const latestByCell = new Map<string, LogRecord<unknown>>();
        for (const rec of records) if (rec.cell) latestByCell.set(cellKey(rec.cell), rec);
        return cells.map((c) => {
          const rec = latestByCell.get(cellKey(c));
          return rec ? clone(rec) : undefined;
        });
      },
      async renameEntry(resourceId, oldKey, newKey) {
        for (const rec of records) {
          if (rec.cell && rec.cell.resourceId === resourceId && rec.cell.entryKey === oldKey) {
            rec.cell = { ...rec.cell, entryKey: newKey };
          }
        }
      },
    };
  }

  function makeKv(): KvStore {
    const data = new Map<string, unknown>();
    return {
      async get(key) {
        return clone(data.get(key));
      },
      async getMany(keys) {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k));
        return out;
      },
      async set(key, value) {
        data.set(key, clone(value));
      },
      async setMany(values) {
        for (const [k, v] of Object.entries(values)) data.set(k, clone(v));
      },
      async delete(key) {
        data.delete(key);
      },
    };
  }

  const space = <T>(map: Map<string, T>, ns: string, make: () => T): T => {
    let s = map.get(ns);
    if (!s) {
      s = make();
      map.set(ns, s);
    }
    return s;
  };

  return {
    cells: (ns) => space(cellSpaces, ns, makeCells),
    log: <T = unknown>(ns: string) => space(logSpaces, ns, makeLog) as LogStore<T>,
    kv: (ns) => space(kvSpaces, ns, makeKv),
  };
}
