import type { ColumnDef, ColumnUse, FormatUse, LanguageDef, ValidatorUse } from "@loc-studio/sdk";

/*
 * 設定の画面で、プロジェクト設定（言語、列、検証、CSV / TSV の列の対応）を編集するための計算。
 * 画面が知らない項目（プラグイン向けのオプションなど）は、そのまま残す。設定の正しさを最後に確かめるのはサーバー
 * （updateProjectSettings は、読み直せない設定を書かずに元に戻す）。ここでは、保存する前に分かる誤りだけを知らせる。
 */

/** 新しく足す言語の ID に使える文字（新しいプロジェクトの作成と同じ決まり）。 */
const LANGUAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** 条件式で「どれかの言語」「すべての言語」を表す語。 */
const RESERVED_LANGUAGE_IDS = new Set(["any", "all"]);

/** 言語の一覧の誤り（なければ空）。ID の文字の決まりは、新しく足した言語（original にない ID）だけに当てる。 */
export function languageProblems(list: LanguageDef[], original: readonly string[]): string[] {
  const problems: string[] = [];
  if (list.length === 0) problems.push("言語を 1 つ以上残してください。");
  const known = new Set(original);
  const seen = new Set<string>();
  for (const l of list) {
    if (seen.has(l.id)) problems.push(`言語の ID "${l.id}" が重複しています。`);
    seen.add(l.id);
    if (known.has(l.id)) continue;
    if (!LANGUAGE_ID.test(l.id)) problems.push(`言語の ID "${l.id}" は使えません。半角の英数字で始め、英数字と - _ だけの 40 文字までにしてください（例: ja、en、zh-Hans）。`);
    else if (RESERVED_LANGUAGE_IDS.has(l.id.toLowerCase())) problems.push(`言語の ID "${l.id}" は使えません（条件式で「どれかの言語」「すべての言語」を表す語です）。`);
  }
  for (const l of list) {
    if (l.basedOn === undefined) continue;
    if (l.basedOn === l.id) problems.push(`言語 "${l.id}" の基にする言語に、その言語自身は選べません。`);
    else if (!seen.has(l.basedOn)) problems.push(`言語 "${l.id}" の基にする言語 "${l.basedOn}" がありません。基にする言語を選び直してください。`);
  }
  return problems;
}

/** 足す言語の初期値。原文の言語（基にする言語のない最初の言語）があれば、それを基にする。 */
export function newLanguage(list: LanguageDef[], id: string, label: string): LanguageDef {
  const source = list.find((l) => l.basedOn === undefined);
  return { id, label: label.trim() === "" ? id : label.trim(), ...(source ? { basedOn: source.id } : {}) };
}

export type ColumnEntry = ColumnDef | ColumnUse;

/** 設定に columns がないときに使われる 2 列を、設定に書く形にしたもの（新しいプロジェクトの雛形と同じ書き方）。 */
export function defaultColumnEntries(): ColumnEntry[] {
  return [
    { use: "builtin.key", id: "key" },
    { use: "builtin.text", id: "text" },
  ];
}

export interface AvailableColumn {
  id: string;
  label?: string;
  kind: ColumnDef["kind"];
  scope: ColumnDef["scope"];
}

/** 設定の列の 1 つが、名前で選んでいる登録済みの列（use）。列の定義をそのまま書いた項目では undefined。 */
export function columnUseOf(entry: ColumnEntry): string | undefined {
  const e = entry as Partial<ColumnUse> & Partial<ColumnDef>;
  return typeof e.use === "string" && e.kind === undefined ? e.use : undefined;
}

export function columnIdOf(entry: ColumnEntry): string {
  const e = entry as { id?: unknown };
  return typeof e.id === "string" ? e.id : (columnUseOf(entry) ?? "");
}

export function columnKindOf(entry: ColumnEntry, available: readonly AvailableColumn[]): ColumnDef["kind"] | undefined {
  const use = columnUseOf(entry);
  if (use !== undefined) return available.find((a) => a.id === use)?.kind;
  return (entry as ColumnDef).kind;
}

/** 足す列の ID の候補: 登録名の最後の部分（"builtin.textStatus" なら "textStatus"）。使われていたら数字を付ける。 */
export function suggestColumnId(use: string, taken: readonly string[]): string {
  const base = use.split(".").pop() || use;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}${n}`)) return `${base}${n}`;
}

/** 登録済みの列を、設定に足す形にする。レビュー列は、対象の列（最初の本文の列）を of に入れる。 */
export function newColumnEntry(use: AvailableColumn, id: string, entries: ColumnEntry[], available: readonly AvailableColumn[]): ColumnEntry {
  const entry: ColumnUse = { use: use.id, id };
  if (use.kind === "review") {
    const text = entries.find((e) => columnKindOf(e, available) === "text");
    if (text) entry.of = columnIdOf(text);
  }
  return entry;
}

export function columnProblems(entries: ColumnEntry[], available: readonly AvailableColumn[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const id = columnIdOf(e);
    if (id === "") problems.push("ID のない列があります。「詳細」で id を書いてください。");
    else if (seen.has(id)) problems.push(`列の ID "${id}" が重複しています。`);
    seen.add(id);
  }
  for (const e of entries) {
    if (columnKindOf(e, available) !== "review") continue;
    const of = (e as { of?: unknown }).of;
    if (typeof of !== "string" || !seen.has(of) || of === columnIdOf(e)) {
      problems.push(`レビューの列 "${columnIdOf(e)}" の対象の列（of）がありません。「詳細」で、対象にする列の ID を of に書いてください。`);
    }
  }
  for (const kind of ["key", "text"] as const) {
    if (!entries.some((e) => columnKindOf(e, available) === kind)) problems.push(kind === "key" ? "キーの列がありません。" : "本文の列がありません。");
  }
  return problems;
}

export type ValidatorEntry = string | ValidatorUse;

export const validatorUseOf = (entry: ValidatorEntry): string => (typeof entry === "string" ? entry : entry.use);

/** 重さの上書きを変える。上書きも、ほかの項目もなくなったら、名前だけの書き方に戻す。 */
export function withSeverity(entry: ValidatorEntry, severity: ValidatorUse["severity"] | undefined): ValidatorEntry {
  const next: ValidatorUse = typeof entry === "string" ? { use: entry } : { ...entry };
  if (severity === undefined) delete next.severity;
  else next.severity = severity;
  return Object.keys(next).length === 1 ? next.use : next;
}

/** 同梱の CSV / TSV の、列の対応（キーの列、言語ごとの本文の列、文字コード）。 */
export interface DelimitedMapping {
  /** キーの列の見出し。空なら先頭の列。 */
  key: string;
  /** 言語 ID → 本文の列の見出し。空や、書いていない言語は、言語 ID と同じ見出しの列。 */
  text: Record<string, string>;
  encoding: string;
}

export const MAPPING_ENCODINGS = ["auto", "utf-8", "utf-16le", "utf-16be", "shift_jis"] as const;

const DELIMITED_FORMATS = ["builtin.csv", "builtin.tsv"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameMapping = (a: DelimitedMapping, b: DelimitedMapping): boolean =>
  a.key === b.key && a.encoding === b.encoding && JSON.stringify(Object.entries(a.text).sort()) === JSON.stringify(Object.entries(b.text).sort());

function mappingOfOptions(options: unknown): DelimitedMapping | undefined {
  const o = options === undefined ? {} : options;
  if (!isRecord(o)) return undefined;
  if (o.key !== undefined && typeof o.key !== "string") return undefined;
  if (o.encoding !== undefined && typeof o.encoding !== "string") return undefined;
  const text: Record<string, string> = {};
  if (o.text !== undefined) {
    if (!isRecord(o.text)) return undefined;
    for (const [id, header] of Object.entries(o.text)) {
      if (typeof header !== "string") return undefined;
      text[id] = header;
    }
  }
  return { key: o.key ?? "", text, encoding: o.encoding ?? "auto" };
}

/**
 * 設定の formats から、列の対応を読む。formats がなければ、既定（何も書いていない対応）。
 * 画面でまとめて編集できない書き方（同梱の CSV / TSV がない、フォーマットごとに対応が違う）は、理由を返す。
 */
export function readMapping(formats: readonly FormatUse[] | undefined): { mapping: DelimitedMapping } | { reason: string } {
  if (formats === undefined) return { mapping: { key: "", text: {}, encoding: "auto" } };
  const entries = formats.filter((f) => isRecord(f) && DELIMITED_FORMATS.includes(f.use));
  if (entries.length === 0) return { reason: "設定の formats に、同梱の CSV / TSV（builtin.csv、builtin.tsv）がありません。列の対応は、設定ファイルで、使っているフォーマットのオプションに書いてください。" };
  const mappings = entries.map((f) => mappingOfOptions(f.options));
  const first = mappings[0];
  if (first === undefined || mappings.some((m) => m === undefined || !sameMapping(m, first))) {
    return { reason: "設定の formats に、フォーマットごとに違う列の対応が書かれています。ここではまとめて変えられないので、設定ファイルで編集してください。" };
  }
  return { mapping: first };
}

/** 列の対応の誤り: 同じ見出しを、キーと本文や、2 つの言語の本文に使っている。 */
export function mappingProblems(mapping: DelimitedMapping, languageIds: readonly string[]): string[] {
  const problems: string[] = [];
  const used = new Map<string, string>();
  const use = (header: string, what: string): void => {
    if (header === "") return;
    const other = used.get(header);
    if (other !== undefined) problems.push(`列「${header}」を、${other}と${what}の両方に使っています。別の列にしてください。`);
    else used.set(header, what);
  };
  use(mapping.key, "キー");
  for (const id of languageIds) use(mapping.text[id] ?? "", `言語 "${id}" の本文`);
  return problems;
}

/**
 * 列の対応を、設定の formats に書き戻す。対応のほかのオプション（区切り文字など）と、ほかのフォーマットの項目は変えない。
 * formats がなく、対応も既定のままなら null（formats を書かない）。
 */
export function writeMapping(formats: readonly FormatUse[] | undefined, mapping: DelimitedMapping, languageIds: readonly string[]): FormatUse[] | null {
  // 言語 ID と同じ見出しは、書かなくても同じ動きになるので、書かない。
  const headerOf = (id: string): string | undefined => {
    const header = mapping.text[id] ?? "";
    return header !== "" && header !== id ? header : undefined;
  };
  const apply = (options: Record<string, unknown>): Record<string, unknown> => {
    // 設定ファイルの差分が小さくなるよう、項目の並びは元のままにする（新しい項目は後ろに足す）。
    const text: Record<string, string> = {};
    if (isRecord(options.text)) {
      for (const [id, header] of Object.entries(options.text)) {
        // プロジェクトにない言語の対応（設定に残っていたもの）は、そのまま残す。
        const next = languageIds.includes(id) ? headerOf(id) : typeof header === "string" ? header : undefined;
        if (next !== undefined) text[id] = next;
      }
    }
    for (const id of languageIds) {
      const header = headerOf(id);
      if (header !== undefined && !(id in text)) text[id] = header;
    }
    const values: Record<string, unknown> = {
      key: mapping.key !== "" ? mapping.key : undefined,
      text: Object.keys(text).length > 0 ? text : undefined,
      encoding: mapping.encoding !== "auto" ? mapping.encoding : undefined,
    };
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(options)) {
      if (!(k in values)) next[k] = v;
      else if (values[k] !== undefined) next[k] = values[k];
    }
    for (const k of Object.keys(values)) if (!(k in next) && values[k] !== undefined) next[k] = values[k];
    return next;
  };
  if (formats === undefined) {
    const options = apply({});
    if (Object.keys(options).length === 0) return null;
    return [
      { use: "builtin.csv", match: "**/*.csv", options },
      { use: "builtin.tsv", match: "**/*.tsv", options },
    ];
  }
  return formats.map((f) => {
    if (!isRecord(f) || !DELIMITED_FORMATS.includes(f.use)) return f;
    const options = apply(isRecord(f.options) ? f.options : {});
    const { options: _options, ...rest } = f;
    return Object.keys(options).length > 0 ? { ...rest, options } : rest;
  });
}

/** 「詳細」の欄の JSON を読む。オブジェクトでなければ（検証は文字列でもよい）、理由を返す。 */
export function parseEntryJson(text: string, allowString: boolean): { value: unknown } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "JSON の形が正しくありません。" };
  }
  if (isRecord(value)) return { value };
  if (allowString && typeof value === "string" && value !== "") return { value };
  return { error: allowString ? "オブジェクト（{ … }）か、名前の文字列で書いてください。" : "オブジェクト（{ … }）で書いてください。" };
}
