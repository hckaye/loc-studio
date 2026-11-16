import type { RowFilter } from "@loc-studio/server";
import type { Severity } from "@/lib/client/model";
import type { BuilderState } from "@/lib/client/query-text";

/* ツールバーの絞り込みの状態と、それをサービス層に送る形（RowFilter）にする処理。表、ツリーの件数、検索結果の表示が同じものを使う。 */

export interface ToolbarFilters {
  search: string;
  values: Record<string, string[]>;
  /** 文字・数値の列の「含む」絞り込み（セルの ID → 探す文字列）。 */
  contains: Record<string, string>;
  onlyUntranslated: boolean;
  onlyIssues: boolean;
  /** 「問題あり」で数える重さ（これ以上の問題がある行）。 */
  issueLevel: Severity;
  onlyStale: boolean;
  onlyUnsaved: boolean;
  /** 条件式（かつ・または・否定を組み合わせた条件）。空なら使わない。 */
  where: string;
  /** 条件式を組み立てた元の並び。式を手で書いたときは null。 */
  builder: BuilderState | null;
}

export const EMPTY_FILTERS: ToolbarFilters = {
  search: "",
  values: {},
  contains: {},
  onlyUntranslated: false,
  onlyIssues: false,
  issueLevel: "warning",
  onlyStale: false,
  onlyUnsaved: false,
  where: "",
  builder: null,
};

/** 保存してあった絞り込み（古い版の形や、欠けた項目があるもの）を、いまの形にする。 */
export function normalizeFilters(value: unknown): ToolbarFilters {
  if (value === null || typeof value !== "object") return EMPTY_FILTERS;
  const v = value as Partial<ToolbarFilters>;
  const record = <T>(r: unknown, ok: (x: unknown) => x is T): Record<string, T> =>
    r !== null && typeof r === "object" ? Object.fromEntries(Object.entries(r as Record<string, unknown>).filter((e): e is [string, T] => ok(e[1]))) : {};
  const builder = v.builder;
  return {
    search: typeof v.search === "string" ? v.search : "",
    values: record(v.values, (x): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string")),
    contains: record(v.contains, (x): x is string => typeof x === "string"),
    onlyUntranslated: v.onlyUntranslated === true,
    onlyIssues: v.onlyIssues === true,
    issueLevel: v.issueLevel === "error" || v.issueLevel === "info" ? v.issueLevel : "warning",
    onlyStale: v.onlyStale === true,
    onlyUnsaved: v.onlyUnsaved === true,
    where: typeof v.where === "string" ? v.where : "",
    builder: builder && typeof builder === "object" && Array.isArray(builder.conditions) && (builder.join === "and" || builder.join === "or") ? builder : null,
  };
}

/** サービス層に送る条件。表示していない言語の列の条件は送らない。 */
export function toRowFilter(filters: ToolbarFilters, visibleLanguages: string[]): RowFilter {
  const shown = (cellId: string): boolean => !cellId.includes("@") || visibleLanguages.includes(cellId.split("@")[1]!);
  const vf: { cellId: string; values?: string[]; contains?: string }[] = [
    ...Object.entries(filters.values)
      .filter(([cellId, vals]) => vals.length > 0 && shown(cellId))
      .map(([cellId, values]) => ({ cellId, values })),
    ...Object.entries(filters.contains)
      .filter(([cellId, text]) => text !== "" && shown(cellId))
      .map(([cellId, contains]) => ({ cellId, contains })),
  ];
  return {
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(vf.length ? { filters: vf } : {}),
    ...(filters.where.trim() ? { where: filters.where.trim() } : {}),
    ...(filters.onlyUntranslated ? { onlyUntranslated: true } : {}),
    ...(filters.onlyIssues ? { onlyIssues: filters.issueLevel } : {}),
    ...(filters.onlyStale ? { onlyStale: true } : {}),
    ...(filters.onlyUnsaved ? { onlyUnsaved: true } : {}),
  };
}

/** 絞り込みの条件が 1 つでもあるか（ツリーに件数を出すかどうかに使う）。 */
export function isFiltering(filters: ToolbarFilters, visibleLanguages: string[]): boolean {
  return Object.keys(toRowFilter(filters, visibleLanguages)).length > 0;
}
