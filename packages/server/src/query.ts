/**
 * 行の条件式（where）の、列への解決と評価。構文は query-lang.ts。
 *
 * 欄の書き方:
 * - 行に 1 つの列: 列の ID（例: MaxLen）
 * - 言語ごとの列: "列 ID@言語 ID"（例: text@en）。"@any"（"@*" でも同じ。対象の言語のどれか）、"@all"（対象の言語のすべて）。
 *   "@" を省くと "@any"。対象の言語は、要求の languages。
 * - 組み込みの欄（同じ ID の列がないとき）: key、resource、issues、issueCode、stale、unsaved
 */
import { cellValueText, columnAppliesTo } from "@loc-studio/core";
import type { ColumnDef, EntryData, LanguageDef } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { CellInfo, IssueInfo } from "./api-types.js";
import { buildCells } from "./cells.js";
import type { WsContext } from "./context.js";
import { enumOf } from "./context.js";
import type { DocState } from "./documents.js";
import { validatedColumns } from "./issues.js";
import { parseQuery, QuerySyntaxError } from "./query-lang.js";
import type { CompareOp, QueryField, QueryNode, QueryValue } from "./query-lang.js";

/** 評価のときに 1 行について分かっていること。 */
export interface RowFacts {
  doc: DocState;
  data: EntryData;
  cells: Record<string, CellInfo>;
}

/** 評価のために読む必要のあるもの。 */
interface Needs {
  columns: Map<string, ColumnDef>;
  languages: Map<string, LanguageDef>;
  /** 検証の結果を使う（本文の列と、検証の対象の列を読む）。 */
  issues: boolean;
  /** 「要確認」の印を使う（本文、レビュー、生成列などを読む）。 */
  stale: boolean;
}

type BuiltinName = "key" | "resource" | "issues" | "issueCode" | "stale" | "unsaved";
const BUILTIN: Record<string, BuiltinName> = { key: "key", resource: "resource", issues: "issues", issuecode: "issueCode", stale: "stale", unsaved: "unsaved" };

/** 問題の重さの順。none は問題なし。 */
const SEVERITY_RANK: Record<string, number> = { none: 0, info: 1, warning: 2, error: 3 };
const SEVERITY_NAMES = ["none", "info", "warning", "error"] as const;

/** 欄を 1 つの値として読む窓口（言語を名指ししたもの、または行に 1 つのもの）。 */
interface FieldVariant {
  kind: "column" | BuiltinName;
  column?: ColumnDef;
  /** 言語ごとの欄の言語。undefined は行全体（組み込みの欄）か、行に 1 つの列。 */
  language?: LanguageDef;
  read(row: RowFacts): unknown;
}

export interface ResolvedField {
  raw: string;
  /** one: 1 つの値。any / all: 対象の言語のどれか / すべて。 */
  quantifier: "one" | "any" | "all";
  variants: FieldVariant[];
  kind: "column" | BuiltinName;
  column?: ColumnDef;
}

export interface CompiledQuery {
  needs: Needs;
  test(row: RowFacts): boolean;
}

const invalid = (message: string): ApiError => new ApiError("invalid", message);

/** 行のセルのうち、その言語のもの（language が undefined なら、対象の言語と行に 1 つの列のすべて）。 */
function cellsIn(ctx: WsContext, row: RowFacts, language: LanguageDef | undefined, targets: LanguageDef[]): CellInfo[] {
  const out: CellInfo[] = [];
  for (const column of ctx.columns()) {
    if (column.kind === "actions") continue;
    if (column.scope === "entry") {
      if (language === undefined) {
        const c = row.cells[column.id];
        if (c) out.push(c);
      }
      continue;
    }
    for (const l of language ? [language] : targets) {
      const c = row.cells[ctx.cellId(column, l.id)];
      if (c) out.push(c);
    }
  }
  return out;
}

const worstSeverity = (issues: IssueInfo[]): number => issues.reduce((worst, i) => Math.max(worst, SEVERITY_RANK[i.severity] ?? 0), 0);

function builtinVariant(ctx: WsContext, name: BuiltinName, language: LanguageDef | undefined, targets: LanguageDef[], needs: Needs): FieldVariant {
  const variant = (read: (row: RowFacts) => unknown): FieldVariant => (language ? { kind: name, language, read } : { kind: name, read });
  if (name === "key") return variant((row) => row.data.key);
  if (name === "resource") return variant((row) => row.doc.resource.path);
  for (const l of language ? [language] : targets) needs.languages.set(l.id, l);
  const issuesOf = (row: RowFacts): IssueInfo[] => cellsIn(ctx, row, language, targets).flatMap((c) => c.issues ?? []);
  if (name === "issues") {
    needs.issues = true;
    return variant((row) => SEVERITY_NAMES[worstSeverity(issuesOf(row))]);
  }
  if (name === "issueCode") {
    needs.issues = true;
    return variant((row) => [...new Set(issuesOf(row).map((i) => i.code))]);
  }
  if (name === "stale") {
    needs.stale = true;
    return variant((row) => cellsIn(ctx, row, language, targets).some((c) => c.stale === true || c.needsRecheck === true));
  }
  const textCol = ctx.textColumn();
  if (textCol) needs.columns.set(textCol.id, textCol);
  return variant((row) => cellsIn(ctx, row, language, targets).some((c) => c.draft === true));
}

/** 欄を列か組み込みの欄に解決する。targets は "@any" / "@all" と、言語を省いたときの対象の言語。 */
export function resolveField(ctx: WsContext, field: QueryField, targets: LanguageDef[], needs: Needs): ResolvedField {
  const raw = field.raw;
  const columnVariant = (column: ColumnDef, language?: LanguageDef): FieldVariant => {
    needs.columns.set(column.id, column);
    if (language) needs.languages.set(language.id, language);
    const id = ctx.cellId(column, language?.id);
    return { kind: "column", column, ...(language ? { language } : {}), read: (row) => row.cells[id]?.value };
  };
  const forLanguages = (column: ColumnDef): FieldVariant[] => targets.filter((l) => columnAppliesTo(column, l.id)).map((l) => columnVariant(column, l));
  const checkUsable = (column: ColumnDef): void => {
    if (column.kind === "actions") throw invalid(`条件式の "${raw}": 列 "${column.id}" はアクション列で、値を持たないため、条件に使えません。`);
  };

  // 1. 行に 1 つの列（ID がそのまま一致）。言語ごとの列の ID だけを書いたら、対象の言語のどれか。
  const direct = ctx.column(raw);
  if (direct) {
    checkUsable(direct);
    if (direct.scope === "entry") return { raw, quantifier: "one", variants: [columnVariant(direct)], kind: "column", column: direct };
    return { raw, quantifier: "any", variants: forLanguages(direct), kind: "column", column: direct };
  }
  // 2. "列 ID@言語"、"列 ID@any"、"列 ID@all"。組み込みの欄にも同じ形で言語を付けられる。
  for (let i = raw.indexOf("@"); i >= 0; i = raw.indexOf("@", i + 1)) {
    const name = raw.slice(0, i);
    const suffix = raw.slice(i + 1);
    const column = ctx.column(name);
    const builtin = column ? undefined : BUILTIN[name.toLowerCase()];
    if (!column && !builtin) continue;
    const lower = suffix.toLowerCase();
    const isLanguage = lower === "any" || lower === "*" || lower === "all" || ctx.language(suffix) !== undefined;
    if (column && column.scope !== "language") {
      if (isLanguage) throw invalid(`条件式の "${raw}": 列 "${name}" は行に 1 つの値なので、"@言語" は付けられません。`);
      continue;
    }
    if (builtin === "key" || builtin === "resource") throw invalid(`条件式の "${raw}": "${name}" は行に 1 つの値なので、"@言語" は付けられません。`);
    if (column) checkUsable(column);
    if (lower === "any" || lower === "*" || lower === "all") {
      const quantifier = lower === "all" ? "all" : "any";
      const variants = column ? forLanguages(column) : targets.map((l) => builtinVariant(ctx, builtin!, l, targets, needs));
      return { raw, quantifier, variants, kind: column ? "column" : builtin!, ...(column ? { column } : {}) };
    }
    const language = ctx.language(suffix);
    if (!language) continue;
    if (column) {
      if (!columnAppliesTo(column, language.id)) throw invalid(`条件式の "${raw}": 列 "${column.id}" は言語 "${language.id}" にはありません。`);
      return { raw, quantifier: "one", variants: [columnVariant(column, language)], kind: "column", column };
    }
    return { raw, quantifier: "one", variants: [builtinVariant(ctx, builtin!, language, targets, needs)], kind: builtin! };
  }
  // 3. 組み込みの欄（言語なし）。
  const builtin = BUILTIN[raw.toLowerCase()];
  if (builtin) return { raw, quantifier: "one", variants: [builtinVariant(ctx, builtin, undefined, targets, needs)], kind: builtin };

  const columns = ctx
    .columns()
    .filter((c) => c.kind !== "actions")
    .map((c) => (c.scope === "language" ? `${c.id}@言語` : c.id));
  throw invalid(
    `条件式の "${raw}" に当たる列がありません。行に 1 つの列は "列 ID"、言語ごとの列は "列 ID@言語 ID"（"@any" はどれかの言語、"@all" はすべての言語）と書きます。` +
      `使える列: ${columns.join(", ")}。組み込み: key, resource, issues, issueCode, stale, unsaved。`,
  );
}

const isEmptyValue = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
const isNumeric = (s: string): boolean => s.trim() !== "" && Number.isFinite(Number(s));

/** 1 つの値と、式に書いた値を比べる関数を作る（列の型に合わせる。書き方の誤りは、ここで断る）。 */
function comparer(field: ResolvedField, op: CompareOp, value: QueryValue): (v: unknown) => boolean {
  const where = `条件式の "${field.raw} ${op} ${value.text}"`;
  const contains = op === "~" || op === "!~";
  const negate = op === "!=" || op === "!~";
  const base: CompareOp = op === "!=" ? "=" : op === "!~" ? "~" : op;
  const wrap = (test: (v: unknown) => boolean) => (negate ? (v: unknown) => !test(v) : test);
  const ordered = (cmp: number): boolean => (base === "=" ? cmp === 0 : base === "<" ? cmp < 0 : base === "<=" ? cmp <= 0 : base === ">" ? cmp > 0 : cmp >= 0);

  if (field.kind === "issues") {
    if (contains) throw invalid(`${where}: issues は問題の重さ（none / info / warning / error）で、"~" は使えません。`);
    const want = SEVERITY_RANK[value.text.toLowerCase()];
    if (want === undefined) throw invalid(`${where}: issues と比べる値は none / info / warning / error のどれかです。`);
    return wrap((v) => ordered((SEVERITY_RANK[String(v)] ?? 0) - want));
  }
  if (field.kind === "issueCode") {
    if (base !== "=" && base !== "~") throw invalid(`${where}: issueCode には "="、"!="、"~"、"!~" だけが使えます。`);
    const want = value.text.toLowerCase();
    return wrap((v) => (Array.isArray(v) ? v : []).some((code) => (base === "=" ? String(code) === value.text : String(code).toLowerCase().includes(want))));
  }
  if (field.kind === "stale" || field.kind === "unsaved") {
    const want = value.text.toLowerCase();
    if (base !== "=" || (want !== "true" && want !== "false")) throw invalid(`${where}: ${field.kind} は true か false と "=" / "!=" で比べます。`);
    return wrap((v) => (v === true) === (want === "true"));
  }
  if (contains) {
    const want = value.text.toLowerCase();
    return wrap((v) => cellValueText(v).toLowerCase().includes(want));
  }
  const options = field.column ? enumOf(field.column)?.enum : undefined;
  if (options) {
    // 選択式の列: 値か表示名で書ける。大小は、選択肢の並び順。
    const index = options.findIndex((o) => o.value === value.text);
    const byLabel = index >= 0 ? index : options.findIndex((o) => (o.label ?? o.value).toLowerCase() === value.text.toLowerCase());
    if (byLabel < 0) {
      if (value.text === "" && base === "=") return wrap(isEmptyValue);
      throw invalid(`${where}: 列 "${field.column!.id}" に選択肢 "${value.text}" はありません（選べる値: ${options.map((o) => o.value).join(", ")}）。`);
    }
    return wrap((v) => {
      const at = options.findIndex((o) => o.value === v);
      return at >= 0 && ordered(at - byLabel);
    });
  }
  const number = !value.quoted && isNumeric(value.text) ? Number(value.text) : undefined;
  const bool = !value.quoted && /^(true|false)$/i.test(value.text) ? value.text.toLowerCase() === "true" : undefined;
  return wrap((v) => {
    if (typeof v === "boolean" && bool !== undefined) return ordered(Number(v) - Number(bool));
    if (isEmptyValue(v)) return base === "=" && value.text === "";
    if (number !== undefined && (typeof v === "number" || (typeof v === "string" && isNumeric(v)))) return ordered(Number(v) - number);
    const text = cellValueText(v);
    return base === "=" ? text === value.text : ordered(text.localeCompare(value.text, undefined, { numeric: true }));
  });
}

/** 欄の値のどれか（any）／すべて（all）／その 1 つ（one）が test に合うか。対象の言語にその列がなければ、合わない。 */
function quantify(field: ResolvedField, test: (v: unknown) => boolean): (row: RowFacts) => boolean {
  const { variants } = field;
  if (field.quantifier === "all") return (row) => variants.length > 0 && variants.every((variant) => test(variant.read(row)));
  return (row) => variants.some((variant) => test(variant.read(row)));
}

/** 値だけを書いた条件（"stale"、"not unsaved" など）: true か、空でない値。issues は、問題があること。 */
const truthyFor = (field: ResolvedField) => (v: unknown): boolean => (field.kind === "issues" ? v !== "none" : v === true || (v !== false && !isEmptyValue(v)));

function compileNode(ctx: WsContext, node: QueryNode, targets: LanguageDef[], needs: Needs): (row: RowFacts) => boolean {
  switch (node.type) {
    case "and": {
      const items = node.items.map((n) => compileNode(ctx, n, targets, needs));
      return (row) => items.every((t) => t(row));
    }
    case "or": {
      const items = node.items.map((n) => compileNode(ctx, n, targets, needs));
      return (row) => items.some((t) => t(row));
    }
    case "not": {
      const item = compileNode(ctx, node.item, targets, needs);
      return (row) => !item(row);
    }
    case "compare": {
      const field = resolveField(ctx, node.field, targets, needs);
      return quantify(field, comparer(field, node.op, node.value));
    }
    case "in": {
      const field = resolveField(ctx, node.field, targets, needs);
      const tests = node.values.map((value) => comparer(field, "=", value));
      const any = (v: unknown): boolean => tests.some((t) => t(v));
      return quantify(field, node.negate ? (v) => !any(v) : any);
    }
    case "empty": {
      const field = resolveField(ctx, node.field, targets, needs);
      const empty = (v: unknown): boolean => isEmptyValue(v) || (field.kind === "issues" && v === "none");
      return quantify(field, node.negate ? (v) => !empty(v) : empty);
    }
    case "truthy": {
      const field = resolveField(ctx, node.field, targets, needs);
      return quantify(field, truthyFor(field));
    }
  }
}

export const emptyNeeds = (): Needs => ({ columns: new Map(), languages: new Map(), issues: false, stale: false });

/** 条件式を、行に当てる関数にする。空の式は undefined。書き方や列の誤りは ApiError "invalid"。 */
export function compileQuery(ctx: WsContext, where: unknown, targets: LanguageDef[]): CompiledQuery | undefined {
  if (where === undefined || where === null) return undefined;
  if (typeof where !== "string") throw invalid("where は条件式の文字列で指定してください。");
  let tree: QueryNode | undefined;
  try {
    tree = parseQuery(where);
  } catch (err) {
    if (err instanceof QuerySyntaxError) throw invalid(`条件式の ${err.pos + 1} 文字目: ${err.message}`);
    throw err;
  }
  if (!tree) return undefined;
  const needs = emptyNeeds();
  const test = compileNode(ctx, tree, targets, needs);
  return { needs, test };
}

/** 集計の区切りや出力に使う、1 つの値の欄（"@any" / "@all" は使えない）。 */
export function resolveSingleField(ctx: WsContext, raw: string, targets: LanguageDef[], needs: Needs, what: string): ResolvedField & { read(row: RowFacts): unknown } {
  if (typeof raw !== "string" || raw === "") throw invalid(`${what} には列の ID を指定してください。`);
  const field = resolveField(ctx, { raw, pos: 0 }, targets, needs);
  if (field.quantifier !== "one" || field.variants.length !== 1) {
    throw invalid(`${what} の "${raw}" は言語ごとの列です。"${raw.split("@")[0]}@言語 ID" のように、言語を 1 つ決めて書いてください。`);
  }
  const variant = field.variants[0]!;
  return { ...field, read: (row) => variant.read(row) };
}

/** needs に合わせて、行のセルを読む（entries と同じ順）。 */
export async function readFacts(ctx: WsContext, doc: DocState, entries: EntryData[], needs: Needs): Promise<RowFacts[]> {
  if (entries.length === 0) return [];
  const columns = new Map(needs.columns);
  if (needs.issues) {
    const textCol = ctx.textColumn();
    if (textCol) columns.set(textCol.id, textCol);
    for (const c of await validatedColumns(ctx, doc)) columns.set(c.id, c);
  }
  if (needs.stale) {
    for (const c of ctx.columns()) if (c.kind === "text" || c.kind === "review" || c.kind === "generated" || c.basis === "text") columns.set(c.id, c);
  }
  if (columns.size === 0) return entries.map((data) => ({ doc, data, cells: {} }));
  const cells = await buildCells(ctx, doc, entries, { columns: [...columns.values()], languages: [...needs.languages.values()], issues: needs.issues });
  return entries.map((data, i) => ({ doc, data, cells: cells[i]! }));
}

/** 2 つの needs を合わせる。 */
export function mergeNeeds(into: Needs, from: Needs): Needs {
  for (const [id, c] of from.columns) into.columns.set(id, c);
  for (const [id, l] of from.languages) into.languages.set(id, l);
  into.issues ||= from.issues;
  into.stale ||= from.stale;
  return into;
}
