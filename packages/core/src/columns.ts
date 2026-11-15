import type { ColumnDef, ColumnSource, ColumnUse, LanguageId, Options, ProjectConfig, UseRef } from "@loc-studio/sdk";
import type { PluginRegistry } from "./registry.js";

/** 設定の `columns` を省略したときの列。 */
export const DEFAULT_COLUMNS: ColumnDef[] = [
  { id: "key", kind: "key", scope: "entry" },
  { id: "text", kind: "text", scope: "language" },
];

/** 値を列ソースから読まない列の種類。値はフォーマット、計算、アクション、生成器から来る。 */
const KINDS_WITHOUT_SOURCE = new Set<ColumnDef["kind"]>(["key", "text", "computed", "actions", "generated"]);

/** 予約された出所の名前。値はリソースの中にあり、フォーマット経由で読み書きする。 */
export const FILE_SOURCE = "file";

/**
 * 列の定義の深い複製。compute のような関数は structuredClone で複製できない（例外になる）ので、参照のまま残す。
 */
export function cloneColumn<T>(value: T): T {
  if (typeof value === "function" || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => cloneColumn(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneColumn(v);
  return out as T;
}

const isColumnUse = (item: ColumnDef | ColumnUse): item is ColumnUse =>
  typeof (item as ColumnUse).use === "string" && (item as Partial<ColumnDef>).kind === undefined;

const normalizeUse = (ref: UseRef): { use: string; options: Options } =>
  typeof ref === "string" ? { use: ref, options: {} } : { use: ref.use, options: ref.options ?? {} };

/**
 * 設定の `columns` を列の定義の並びにする。
 * 問題のある列は飛ばして警告にする（プロジェクトは開けるようにするため）。
 */
export function resolveColumns(config: ProjectConfig, registry: PluginRegistry): { columns: ColumnDef[]; warnings: string[] } {
  const warnings: string[] = [];
  if (config.columns === undefined) return { columns: DEFAULT_COLUMNS.map((c) => ({ ...c })), warnings };

  const merged: { column: ColumnDef; where: string }[] = [];
  config.columns.forEach((item, i) => {
    const where = `columns[${i}]`;
    if (typeof item !== "object" || item === null) {
      warnings.push(`設定の ${where} はオブジェクトにしてください。この列は表示しません。`);
      return;
    }
    let column: Partial<ColumnDef>;
    if (isColumnUse(item)) {
      const registered = registry.get("column", item.use);
      if (!registered) {
        const ids = registry.list("column").map((e) => `"${e.id}"`).join(", ") || "なし";
        warnings.push(`設定の ${where} の列 "${item.use}" は登録されていません（使える列: ${ids}）。この列は表示しません。`);
        return;
      }
      const { use: _use, ...overrides } = item;
      column = cloneColumn(registered);
      for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined) (column as Record<string, unknown>)[k] = cloneColumn(v);
      }
      column.id = item.id ?? registered.id;
    } else {
      column = { ...item };
    }
    const label = typeof column.id === "string" ? `${where}（"${column.id}"）` : where;
    if (typeof column.id !== "string" || column.id === "") {
      warnings.push(`設定の ${where} に id がありません。この列は表示しません。`);
      return;
    }
    if (typeof column.kind !== "string") {
      warnings.push(`設定の ${label} に kind がありません。この列は表示しません。`);
      return;
    }
    if (column.scope !== "entry" && column.scope !== "language") {
      warnings.push(`設定の ${label} の scope は "entry" か "language" にしてください。この列は表示しません。`);
      return;
    }
    merged.push({ column: column as ColumnDef, where: label });
  });

  const seen = new Set<string>();
  const unique: { column: ColumnDef; where: string }[] = [];
  for (const item of merged) {
    if (seen.has(item.column.id)) {
      warnings.push(`設定の ${item.where} の id は前の列と重なっています。前の列だけを使います。`);
      continue;
    }
    seen.add(item.column.id);
    unique.push(item);
  }

  const columns: ColumnDef[] = [];
  for (const { column, where } of unique) {
    if (column.kind === "review" && (column.of === undefined || column.of === column.id || !seen.has(column.of))) {
      warnings.push(
        `設定の ${where} はレビュー列ですが、of がほかの列を指していません（of: ${column.of === undefined ? "なし" : `"${column.of}"`}）。この列は表示しません。`,
      );
      continue;
    }
    if (column.kind === "computed" && typeof column.compute !== "function") {
      // 列は出すが値は空。関数は設定（JSON）に書けないので、プラグインが登録した列を use で選ぶ。
      warnings.push(`設定の ${where} は計算列（kind: "computed"）ですが、compute 関数がありません。プラグインが登録した計算列を use で選んでください。`);
    }
    if (column.renderer !== undefined && registry.get("renderer", column.renderer) === undefined) {
      const ids = registry.list("renderer").map((e) => `"${e.id}"`).join(", ") || "なし";
      warnings.push(`設定の ${where} の renderer "${column.renderer}" は登録されていません（使える renderer: ${ids}）。既定の見せ方で表示します。`);
    }
    if (needsSource(column) && column.source !== undefined && lookupSource(column.source, config, registry) === undefined) {
      // 列は出すが、値は読み書きできない。
      warnings.push(`設定の ${where} の出所 "${column.source}" は、設定の sources にも登録された列ソースにもありません。`);
    }
    columns.push(column);
  }
  return { columns, warnings };
}

const needsSource = (column: ColumnDef): boolean => !KINDS_WITHOUT_SOURCE.has(column.kind) && column.source !== FILE_SOURCE;

function lookupSource(
  name: string,
  config: ProjectConfig,
  registry: PluginRegistry,
): { source: ColumnSource; options: Options } | undefined {
  const named = config.sources?.[name];
  if (named !== undefined) {
    const ref = normalizeUse(named);
    const source = registry.get("source", ref.use);
    return source ? { source, options: ref.options } : undefined;
  }
  const source = registry.get("source", name);
  return source ? { source, options: {} } : undefined;
}

/** 列の出所を、列ソースの実装と渡す値に解決したもの。 */
export interface ResolvedColumnSource {
  source: ColumnSource;
  options: Options;
  /** 列の `source` に書かれた名前。 */
  name: string;
}

/**
 * 列の値を読み書きする列ソースを求める。
 * `source` は設定の `sources` の名前、なければ登録された列ソースの id として引く。
 * 列ソースを使わない列（本文、キー、出所 "file" など）と、見つからない場合は undefined。
 */
export function resolveColumnSource(
  column: ColumnDef,
  config: ProjectConfig,
  registry: PluginRegistry,
): ResolvedColumnSource | undefined {
  if (column.source === undefined || !needsSource(column)) return undefined;
  const found = lookupSource(column.source, config, registry);
  return found ? { ...found, name: column.source } : undefined;
}

/** その言語に出す列か。languages を省略した列は全言語に出す。 */
export function columnAppliesTo(column: ColumnDef, languageId: LanguageId): boolean {
  return column.languages === undefined || column.languages.includes(languageId);
}

/** 行に 1 つの列（共通グループ）と、言語ごとの列（言語グループ）に分ける。順番は保つ。 */
export function groupColumns(columns: ColumnDef[]): { common: ColumnDef[]; perLanguage: ColumnDef[] } {
  return {
    common: columns.filter((c) => c.scope === "entry"),
    perLanguage: columns.filter((c) => c.scope === "language"),
  };
}
