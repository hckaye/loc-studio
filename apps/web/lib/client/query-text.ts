import type { ProjectInfo } from "@loc-studio/server";
import { columnAppliesTo, columnLabel, enumOptions, optionLabel, type ColumnDef } from "@/lib/client/model";

/*
 * 条件式（rows / query の where）を、式の書き方を知らなくても組み立てられるようにするための部品。
 * - 欄の一覧（プロジェクトの列と、組み込みの欄）と、欄ごとに選べる比べ方
 * - 「欄・言語・比べ方・値」の並び（BuilderState）から式を作る
 * - 式を手で書くときの補完
 * 式を解釈するのはサーバー（packages/server/src/query.ts）。ここは式を作るだけで、列の ID や値は設定から読む。
 */

/** 値の種類（選べる比べ方と、値の入力欄が変わる）。 */
export type FieldType = "enum" | "text" | "number" | "date" | "boolean" | "severity" | "code" | "flag";

export interface QueryFieldInfo {
  /** 式に書く名前（列の ID か、組み込みの欄の名前）。 */
  name: string;
  label: string;
  type: FieldType;
  /** 言語ごとの欄か。そのときは languages の言語か、any / all を付ける。 */
  perLanguage: boolean;
  /** 付けられる言語（perLanguage のとき）。 */
  languages: string[];
  /** 選べる値（選択式の列、問題の重さ）。 */
  options?: { value: string; label: string }[];
  builtin: boolean;
}

const SEVERITY_OPTIONS = [
  { value: "none", label: "問題なし" },
  { value: "info", label: "情報" },
  { value: "warning", label: "警告" },
  { value: "error", label: "エラー" },
];

function fieldType(col: ColumnDef): FieldType {
  if (enumOptions(col)) return "enum";
  if (col.kind === "text" || col.kind === "key" || col.kind === "generated") return "text";
  if (col.type === "number") return "number";
  if (col.type === "boolean") return "boolean";
  if (col.type === "date") return "date";
  return "text";
}

/** 条件に使える欄。列は設定の順、そのあとに組み込みの欄（同じ名前の列があれば、列が優先）。 */
export function queryFields(info: ProjectInfo): QueryFieldInfo[] {
  const langIds = info.languages.map((l) => l.id);
  const fields: QueryFieldInfo[] = [];
  for (const col of info.columns) {
    if (col.kind === "actions") continue;
    const options = enumOptions(col)?.map((o) => ({ value: o.value, label: optionLabel(o) }));
    const perLanguage = col.scope === "language";
    fields.push({
      name: col.id,
      label: columnLabel(col),
      type: fieldType(col),
      perLanguage,
      languages: perLanguage ? langIds.filter((l) => columnAppliesTo(col, l)) : [],
      ...(options ? { options } : {}),
      builtin: false,
    });
  }
  const builtins: QueryFieldInfo[] = [
    { name: "key", label: "キー", type: "text", perLanguage: false, languages: [], builtin: true },
    { name: "resource", label: "リソースのパス", type: "text", perLanguage: false, languages: [], builtin: true },
    { name: "issues", label: "検証の問題", type: "severity", perLanguage: true, languages: langIds, options: SEVERITY_OPTIONS, builtin: true },
    { name: "issueCode", label: "問題の種類", type: "code", perLanguage: true, languages: langIds, builtin: true },
    { name: "stale", label: "要確認", type: "flag", perLanguage: true, languages: langIds, builtin: true },
    { name: "unsaved", label: "未保存", type: "flag", perLanguage: true, languages: langIds, builtin: true },
  ];
  const taken = new Set(fields.map((f) => f.name.toLowerCase()));
  for (const b of builtins) if (!taken.has(b.name.toLowerCase())) fields.push(b);
  return fields;
}

/** 比べ方。text は式に書く形（{f} が欄、{v} が値）。needsValue が false なら値は要らない。 */
export interface QueryOp {
  id: string;
  label: string;
  needsValue: boolean;
  template: string;
}

const OP = {
  eq: { id: "eq", label: "が次と同じ", needsValue: true, template: "{f} = {v}" },
  ne: { id: "ne", label: "が次と違う", needsValue: true, template: "{f} != {v}" },
  contains: { id: "contains", label: "が次を含む", needsValue: true, template: "{f} ~ {v}" },
  notContains: { id: "notContains", label: "が次を含まない", needsValue: true, template: "{f} !~ {v}" },
  gt: { id: "gt", label: "が次より大きい", needsValue: true, template: "{f} > {v}" },
  ge: { id: "ge", label: "が次以上", needsValue: true, template: "{f} >= {v}" },
  lt: { id: "lt", label: "が次より小さい", needsValue: true, template: "{f} < {v}" },
  le: { id: "le", label: "が次以下", needsValue: true, template: "{f} <= {v}" },
  empty: { id: "empty", label: "が空", needsValue: false, template: "{f} is empty" },
  notEmpty: { id: "notEmpty", label: "が空でない", needsValue: false, template: "{f} is not empty" },
  yes: { id: "yes", label: "である", needsValue: false, template: "{f}" },
  no: { id: "no", label: "でない", needsValue: false, template: "not {f}" },
} as const satisfies Record<string, QueryOp>;

const OPS_BY_TYPE: Record<FieldType, QueryOp[]> = {
  enum: [OP.eq, OP.ne, OP.ge, OP.le],
  text: [OP.contains, OP.notContains, OP.eq, OP.ne, OP.empty, OP.notEmpty],
  number: [OP.eq, OP.ne, OP.gt, OP.ge, OP.lt, OP.le, OP.empty, OP.notEmpty],
  date: [OP.eq, OP.ge, OP.le, OP.gt, OP.lt, OP.empty, OP.notEmpty],
  boolean: [OP.yes, OP.no],
  severity: [OP.ge, OP.eq, OP.ne, OP.le],
  code: [OP.eq, OP.contains, OP.ne, OP.empty, OP.notEmpty],
  flag: [OP.yes, OP.no],
};

export function opsFor(field: QueryFieldInfo): QueryOp[] {
  return OPS_BY_TYPE[field.type];
}

/** 組み立てた条件の 1 行。language は言語 ID、"any"（どれかの言語）、"all"（すべての言語）。行に 1 つの欄では ""。 */
export interface BuilderCondition {
  field: string;
  language: string;
  op: string;
  value: string;
}

export interface BuilderState {
  /** and: すべてに合う。or: どれかに合う。 */
  join: "and" | "or";
  conditions: BuilderCondition[];
}

const KEYWORDS = new Set(["and", "or", "not", "is", "in", "empty"]);

/** 値を式に書ける形にする。空白や記号を含む値、空の値、予約語は引用符で囲む。 */
export function quoteValue(value: string, forceQuote = false): string {
  if (!forceQuote && value !== "" && /^[^\s()",'=<>~!]+$/.test(value) && !KEYWORDS.has(value.toLowerCase())) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 新しい条件の初期値（その欄の最初の比べ方と、最初の選択肢）。 */
export function defaultCondition(field: QueryFieldInfo, language?: string): BuilderCondition {
  const op = opsFor(field)[0]!;
  // 問題の重さは「警告以上」から始める（よく使う条件）。
  const value = field.type === "severity" ? "warning" : (field.options?.[0]?.value ?? "");
  return { field: field.name, language: field.perLanguage ? (language ?? "any") : "", op: op.id, value };
}

/** 1 行の条件を式にする。欄や比べ方が分からなければ undefined。値が要るのに空なら、空と比べる式になる。 */
export function conditionToText(cond: BuilderCondition, fields: QueryFieldInfo[]): string | undefined {
  const field = fields.find((f) => f.name === cond.field);
  if (!field) return undefined;
  const op = opsFor(field).find((o) => o.id === cond.op);
  if (!op) return undefined;
  const name = field.perLanguage ? `${field.name}@${cond.language || "any"}` : field.name;
  // 文字の欄は、数字だけの値も文字として比べるよう、いつも引用符で囲む。
  const value = quoteValue(cond.value, field.type === "text" || field.type === "code");
  return op.template.replace("{f}", name).replace("{v}", value);
}

/** 組み立てた条件を式にする。条件がなければ空文字。 */
export function builderToText(state: BuilderState, fields: QueryFieldInfo[]): string {
  const parts = state.conditions.map((c) => conditionToText(c, fields)).filter((t): t is string => t !== undefined);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  // "not 欄" は、and / or と並べても読み違えないよう、かっこで囲む。
  return parts.map((p) => (p.startsWith("not ") ? `(${p})` : p)).join(` ${state.join} `);
}

/** 条件を人が読める文にする（お気に入りや、いまの条件の表示に使う）。 */
export function describeCondition(cond: BuilderCondition, fields: QueryFieldInfo[], info: ProjectInfo): string {
  const field = fields.find((f) => f.name === cond.field);
  const op = field ? opsFor(field).find((o) => o.id === cond.op) : undefined;
  if (!field || !op) return "";
  const lang = !field.perLanguage ? "" : cond.language === "any" || cond.language === "" ? "（どれかの言語）" : cond.language === "all" ? "（すべての言語）" : `（${info.languages.find((l) => l.id === cond.language)?.label ?? cond.language}）`;
  const value = op.needsValue ? `「${field.options?.find((o) => o.value === cond.value)?.label ?? cond.value}」` : "";
  return `${field.label}${lang}${op.label}${value}`;
}

// ---------------------------------------------------------------------------
// 補完
// ---------------------------------------------------------------------------

export interface Suggestion {
  /** 一覧に出す文字。 */
  label: string;
  /** 説明（列の表示名など）。 */
  detail?: string;
  /** 入れる文字（from から to を置き換える）。 */
  insert: string;
}

export interface SuggestResult {
  from: number;
  to: number;
  items: Suggestion[];
}

type Lexeme = { kind: "word" | "string" | "op" | "(" | ")" | ","; text: string; start: number; end: number };

const WORD_END = /[\s()",'=<>~!]/;

/** 補完のための、ゆるい字句解析（閉じていない引用符も 1 つの文字列として読む）。 */
function lex(text: string): Lexeme[] {
  const out: Lexeme[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (ch === "(" || ch === ")" || ch === ",") {
      i++;
      out.push({ kind: ch, text: ch, start, end: i });
    } else if (ch === '"' || ch === "'") {
      i++;
      while (i < text.length && text[i] !== ch) i += text[i] === "\\" ? 2 : 1;
      i = Math.min(text.length, i + 1);
      out.push({ kind: "string", text: text.slice(start, i), start, end: i });
    } else if ("=<>~!".includes(ch)) {
      while (i < text.length && "=<>~!".includes(text[i]!)) i++;
      out.push({ kind: "op", text: text.slice(start, i), start, end: i });
    } else {
      while (i < text.length && !WORD_END.test(text[i]!)) i++;
      out.push({ kind: "word", text: text.slice(start, i), start, end: i });
    }
  }
  return out;
}

const lower = (s: string): string => s.toLowerCase();

function findField(raw: string, fields: QueryFieldInfo[]): QueryFieldInfo | undefined {
  const exact = fields.find((f) => lower(f.name) === lower(raw));
  if (exact) return exact;
  const at = raw.lastIndexOf("@");
  return at > 0 ? fields.find((f) => f.perLanguage && lower(f.name) === lower(raw.slice(0, at))) : undefined;
}

const OPERATOR_ITEMS: Record<FieldType, Suggestion[]> = (() => {
  const eq = { label: "=", detail: "同じ", insert: "= " };
  const ne = { label: "!=", detail: "違う", insert: "!= " };
  const contains = { label: "~", detail: "含む", insert: "~ " };
  const notContains = { label: "!~", detail: "含まない", insert: "!~ " };
  const order = [
    { label: ">=", detail: "以上", insert: ">= " },
    { label: "<=", detail: "以下", insert: "<= " },
    { label: ">", detail: "より大きい", insert: "> " },
    { label: "<", detail: "より小さい", insert: "< " },
  ];
  const empty = [
    { label: "is empty", detail: "空", insert: "is empty " },
    { label: "is not empty", detail: "空でない", insert: "is not empty " },
  ];
  const inList = { label: "in (…)", detail: "どれかと同じ", insert: "in (" };
  return {
    enum: [eq, ne, inList, ...order],
    text: [contains, notContains, eq, ne, ...empty, inList],
    number: [eq, ne, ...order, ...empty, inList],
    date: [eq, ...order, ...empty],
    boolean: [
      { label: "= true", insert: "= true " },
      { label: "= false", insert: "= false " },
    ],
    severity: [...order.slice(0, 2), eq, ne],
    code: [eq, contains, ne, notContains, ...empty],
    flag: [
      { label: "= true", insert: "= true " },
      { label: "= false", insert: "= false " },
    ],
  };
})();

const JOIN_ITEMS: Suggestion[] = [
  { label: "and", detail: "かつ", insert: "and " },
  { label: "or", detail: "または", insert: "or " },
];

/**
 * カーソルの位置で入れられるものを返す。
 * 欄を書く場所では欄（言語ごとの欄は、"@" のあとに言語）、欄のあとでは比べ方、比べ方のあとでは値、条件のあとでは and / or。
 */
export function suggest(text: string, caret: number, fields: QueryFieldInfo[], info: ProjectInfo): SuggestResult {
  const before = text.slice(0, caret);
  const tokens = lex(before);
  const last = tokens[tokens.length - 1];
  // 入力の途中の語（カーソルが語の終わりにある）。
  const typing = last && last.end === before.length && (last.kind === "word" || last.kind === "string") ? last : undefined;
  const done = typing ? tokens.slice(0, -1) : tokens;
  const partial = typing ? typing.text : "";
  const from = typing ? typing.start : caret;

  // 直前までの並びから、いま何を書く場所かを決める。
  type State = "field" | "afterField" | "value" | "afterCondition" | "afterIs" | "list";
  let state: State = "field";
  let field: QueryFieldInfo | undefined;
  for (const t of done) {
    const word = t.kind === "word" ? lower(t.text) : "";
    if (state === "field") {
      if (t.kind === "(" || word === "not") continue;
      if (t.kind === "word") {
        field = findField(t.text, fields);
        state = "afterField";
      }
    } else if (state === "afterField") {
      if (t.kind === "op") state = "value";
      else if (word === "is") state = "afterIs";
      else if (word === "in") state = "list";
      else if (word === "not") state = "afterField";
      else if (word === "and" || word === "or") state = "field";
      else if (t.kind === ")") state = "afterCondition";
    } else if (state === "afterIs") {
      if (word === "empty") state = "afterCondition";
    } else if (state === "value") {
      state = "afterCondition";
    } else if (state === "list") {
      if (t.kind === ")") state = "afterCondition";
    } else if (state === "afterCondition") {
      if (word === "and" || word === "or") state = "field";
    }
  }

  const match = (items: Suggestion[], key: string): Suggestion[] => {
    const k = lower(key);
    if (k === "") return items;
    const starts = items.filter((i) => lower(i.label).startsWith(k));
    const includes = items.filter((i) => !lower(i.label).startsWith(k) && (lower(i.label).includes(k) || lower(i.detail ?? "").includes(k)));
    return [...starts, ...includes];
  };
  const result = (items: Suggestion[]): SuggestResult => ({ from, to: caret, items: items.slice(0, 30) });
  const langLabel = (id: string): string => info.languages.find((l) => l.id === id)?.label ?? id;

  if (state === "field") {
    // "列@" まで書いたら、言語を出す。
    const at = partial.lastIndexOf("@");
    const owner = at > 0 ? fields.find((f) => f.perLanguage && lower(f.name) === lower(partial.slice(0, at))) : undefined;
    if (owner) {
      const langs: Suggestion[] = [
        ...owner.languages.map((l) => ({ label: `${owner.name}@${l}`, detail: `${owner.label}（${langLabel(l)}）`, insert: `${owner.name}@${l} ` })),
        { label: `${owner.name}@any`, detail: `${owner.label}（どれかの言語）`, insert: `${owner.name}@any ` },
        { label: `${owner.name}@all`, detail: `${owner.label}（すべての言語）`, insert: `${owner.name}@all ` },
      ];
      return result(match(langs, partial));
    }
    const items: Suggestion[] = fields.map((f) =>
      f.perLanguage ? { label: `${f.name}@`, detail: `${f.label}（言語ごと）`, insert: `${f.name}@` } : { label: f.name, detail: f.label, insert: `${f.name} ` },
    );
    items.push({ label: "not", detail: "否定", insert: "not " }, { label: "(", detail: "かっこ", insert: "(" });
    return result(match(items, partial));
  }
  if (state === "afterField") {
    const ops = field ? OPERATOR_ITEMS[field.type] : OPERATOR_ITEMS.text;
    return result(match(partial === "" ? [...ops, ...JOIN_ITEMS] : ops, partial));
  }
  if (state === "afterIs") {
    return result(match([{ label: "empty", detail: "空", insert: "empty " }, { label: "not empty", detail: "空でない", insert: "not empty " }], partial));
  }
  if (state === "value" || state === "list") {
    let values: Suggestion[] = [];
    if (field?.options) values = field.options.map((o) => ({ label: o.value, detail: o.label, insert: `${quoteValue(o.value)}${state === "list" ? "" : " "}` }));
    else if (field?.type === "flag" || field?.type === "boolean") values = ["true", "false"].map((v) => ({ label: v, insert: `${v} ` }));
    // 引用符の途中では、引用符を除いた部分で探す。
    return result(match(values, partial.replace(/^["']/, "")));
  }
  return result(match(JOIN_ITEMS, partial));
}

/** 補完の候補を式に入れる。戻り値は、新しい式と、カーソルの位置。 */
export function applySuggestion(text: string, result: SuggestResult, item: Suggestion): { text: string; caret: number } {
  const next = text.slice(0, result.from) + item.insert + text.slice(result.to);
  return { text: next, caret: result.from + item.insert.length };
}
