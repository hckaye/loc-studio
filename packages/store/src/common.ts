/**
 * SQLite と Postgres の実装が共有する型と補助関数。
 * SQL はここに書かない（方言が違うため、各実装のファイルに置く）。
 */
import type { CellRef, CellValue, HostDb, LogRecord } from "@loc-studio/sdk";

export interface Store extends HostDb {
  /** SQLite はファイルのパス（または ":memory:"）、Postgres はパスワードを除いた接続先とスキーマ。 */
  readonly path: string;
  /** 書き込みのたびに 1 ずつ増える。ほかのクライアントはこれを見て変更に気づく。 */
  changeSeq(): Promise<number>;
  /**
   * バックアップを 1 つのファイルに書く。
   * SQLite: データベースのファイルの写し（VACUUM INTO）。共有モードでは書き込みロックの中で行う。
   * Postgres: 表の中身を JSON Lines で書き出す（README を参照）。
   */
  backup(toPath: string): Promise<void>;
  /** 問題の一覧を返す（空なら正常）。SQLite は PRAGMA integrity_check、Postgres は簡単な整合の確認だけ。 */
  integrityCheck(): Promise<string[]>;
  close(): void;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 値を JSON の文字列にする。undefined と、JSON にできない値（関数など）は null として残す。 */
export function toJson(value: unknown): string {
  const text = JSON.stringify(value === undefined ? null : value);
  return text === undefined ? "null" : text;
}

export function fromJson(text: unknown): unknown {
  return JSON.parse(String(text));
}

/** 言語なしのセルは、言語の列に空文字を入れて区別する（主キーに NULL を入れないため）。 */
export function langKey(language: string | undefined): string {
  return language ?? "";
}

export function cellKey(ref: CellRef): string {
  return JSON.stringify([ref.resourceId, ref.entryKey, ref.columnId, langKey(ref.language)]);
}

/** 呼び出し側が渡したオブジェクトの余分なプロパティを持ち込まないよう、参照だけを写す。 */
export function copyRef(ref: CellRef): CellRef {
  const out: CellRef = { resourceId: ref.resourceId, entryKey: ref.entryKey, columnId: ref.columnId };
  if (ref.language !== undefined) out.language = ref.language;
  return out;
}

export type Row = Record<string, unknown>;

export function rowToRef(row: Row): CellRef {
  const ref: CellRef = {
    resourceId: String(row.resource_id),
    entryKey: String(row.entry_key),
    columnId: String(row.column_id),
  };
  const language = row.language;
  if (typeof language === "string" && language !== "") ref.language = language;
  return ref;
}

export function rowToCell(row: Row): CellValue {
  const cell: CellValue = {
    ...rowToRef(row),
    value: fromJson(row.value),
    version: Number(row.version),
    updatedAt: String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
  if (typeof row.basis_hash === "string") cell.basisHash = row.basis_hash;
  return cell;
}

export function rowToLog<T>(row: Row): LogRecord<T> {
  const rec: LogRecord<T> = {
    id: String(row.id),
    at: String(row.at),
    by: String(row.by),
    data: fromJson(row.data) as T,
  };
  if (row.resource_id !== null && row.resource_id !== undefined) rec.cell = rowToRef(row);
  return rec;
}

/** 1 回の set の計画。同じセルが複数回あれば前から順に当てたものとして版を数える。 */
export interface SetPlan {
  conflicts: { cell: CellRef; current: CellValue | undefined }[];
  /** 入力の i 番目を当てた後の版。 */
  versions: number[];
  /** セルごとの最終状態（最後の書き込みの位置と版）。 */
  finals: Map<string, { index: number; version: number; existed: boolean }>;
}

/**
 * 今の行（入力と同じ順。なければ undefined）から、競合と書き込む版を求める。
 * SQLite と Postgres で同じ規則にするため共有する。
 */
export function planSet(
  writes: { resourceId: string; entryKey: string; columnId: string; language?: string; expectedVersion?: number }[],
  current: (Row | undefined)[],
): SetPlan {
  const start = new Map<string, Row | undefined>();
  writes.forEach((w, i) => {
    const k = cellKey(w);
    if (!start.has(k)) start.set(k, current[i]);
  });
  const conflicts: SetPlan["conflicts"] = [];
  const versions: number[] = [];
  const finals: SetPlan["finals"] = new Map();
  const running = new Map<string, number>();
  writes.forEach((w, i) => {
    const k = cellKey(w);
    const cur = start.get(k);
    const curVersion = running.get(k) ?? (cur ? Number(cur.version) : 0);
    if (w.expectedVersion !== undefined && w.expectedVersion !== curVersion) {
      // 同じ呼び出しの前の書き込みで版が進んでいる場合も、保存済みの値を「今の値」として返す。
      conflicts.push({ cell: copyRef(w), current: cur ? rowToCell(cur) : undefined });
    }
    versions.push(curVersion + 1);
    running.set(k, curVersion + 1);
    finals.set(k, { index: i, version: curVersion + 1, existed: cur !== undefined });
  });
  return { conflicts, versions, finals };
}
