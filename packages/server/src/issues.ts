/**
 * 本文のセルのバリデーション。結果は本文と基の本文が同じ間、ドキュメントごとに覚えておく。
 */
import { cellValueText, runResourceValidators, runValidators, stableStringify, validatedMetaColumns } from "@loc-studio/core";
import type { ValidationTarget } from "@loc-studio/core";
import type { ColumnDef, EntryData, LanguageDef, LanguageId, RowReader } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { IssueInfo } from "./api-types.js";
import type { WsContext } from "./context.js";
import { defaultValue, errorText, isFileColumn } from "./context.js";
import type { DocState } from "./documents.js";

export const issueKey = (key: string, language: string): string => `${key}\u0000${language}`;

/** ファイルから読める値（本文とファイル内の列）だけを返す RowReader。 */
export function basicRowReader(ctx: WsContext, doc: DocState, data: EntryData, extra?: (columnId: string, language?: string) => unknown): RowReader {
  const rid = doc.resource.id;
  return {
    text: (language) => ctx.effectiveText(rid, data, language),
    get: (columnId, language) => {
      const column = ctx.column(columnId);
      if (column?.kind === "text") return language === undefined ? undefined : ctx.effectiveText(rid, data, language);
      if (column?.kind === "key") return data.key;
      if (!column || isFileColumn(column)) {
        return language === undefined ? data.meta?.[columnId] : data.languageMeta?.[language]?.[columnId];
      }
      const v = extra?.(columnId, language);
      return v === undefined ? defaultValue(column) : v;
    },
  };
}

/** 行のキー → セルの ID → 問題。 */
export type IssuesByEntry = Map<string, Map<string, IssueInfo[]>>;

const NO_ISSUES: IssuesByEntry = new Map();

/**
 * リソース全体を見るバリデータ（validateResource）の結果。リソース、未保存の編集、共有 DB、設定のどれかが
 * 変わるまで覚えておく。そういうバリデータを使っていなければ、何も読まずに空を返す。
 */
export async function resourceIssues(ctx: WsContext, doc: DocState): Promise<IssuesByEntry> {
  const validators = ctx.project.resolveValidators().filter((rv) => typeof rv.validator.validateResource === "function");
  if (validators.length === 0) return NO_ISSUES;
  const rid = doc.resource.id;
  const stamp = `${ctx.drafts.version(rid)}:${await ctx.shared.changeSeq()}:${ctx.sourceSeq}:${ctx.configGen}`;
  if (doc.resourceIssues?.stamp === stamp) return doc.resourceIssues.byEntry;
  const byEntry: IssuesByEntry = new Map();
  try {
    const rows = await ctx.project.host.project.rows(rid);
    const { issues, problems } = await runResourceValidators({ resource: doc.resource, rows, languages: ctx.project.languages, columns: ctx.columns() }, validators);
    for (const p of problems) ctx.warn(p);
    for (const { key, columnId, language, ...issue } of issues) {
      const column = ctx.column(columnId);
      if (!column) continue;
      let cells = byEntry.get(key);
      if (!cells) byEntry.set(key, (cells = new Map()));
      const cellId = ctx.cellId(column, language);
      const list = cells.get(cellId);
      if (list) list.push(toIssueInfo(issue));
      else cells.set(cellId, [toIssueInfo(issue)]);
    }
  } catch (err) {
    ctx.warn(`リソース ${doc.resource.path} の全体の検証に失敗しました: ${errorText(err)}`);
  }
  doc.resourceIssues = { stamp, byEntry };
  return byEntry;
}

/** 本文以外の列のうち、検証の結果が付きうる列（セルごとのバリデータが名指しした列と、リソース全体の検証で問題が出た列）。 */
export async function validatedColumns(ctx: WsContext, doc: DocState): Promise<ColumnDef[]> {
  const named = validatedMetaColumns(ctx.columns(), ctx.project.resolveValidators());
  const fromResource = new Set<string>();
  for (const cells of (await resourceIssues(ctx, doc)).values()) {
    for (const cellId of cells.keys()) fromResource.add(ctx.parseCellId(cellId).column.id);
  }
  const ids = new Set(named.map((c) => c.id));
  return ctx.columns().filter((c) => c.kind !== "text" && (ids.has(c.id) || fromResource.has(c.id)));
}

/**
 * 本文以外の列のセルを確かめる。valueOf はセルのいまの値（列ソースの値を含む）、rowOf は同じ行のほかの値を読む窓口。
 * 戻り値は「行のキー → セルの ID → 問題」。問題のないセルは入れない。
 */
export async function validateMetaCells(
  ctx: WsContext,
  doc: DocState,
  entries: EntryData[],
  languages: LanguageDef[],
  columns: ColumnDef[],
  valueOf: (data: EntryData, column: ColumnDef, language: LanguageId | undefined) => unknown,
  rowOf: (data: EntryData) => RowReader,
): Promise<IssuesByEntry> {
  const out: IssuesByEntry = new Map();
  if (columns.length === 0 || entries.length === 0) return out;
  const add = (key: string, cellId: string, issues: IssueInfo[]): void => {
    if (issues.length === 0) return;
    let cells = out.get(key);
    if (!cells) out.set(key, (cells = new Map()));
    cells.set(cellId, [...(cells.get(cellId) ?? []), ...issues]);
  };
  const validators = ctx.project.resolveValidators();
  const named = new Set(validatedMetaColumns(columns, validators).map((c) => c.id));
  const pending: { key: string; cellId: string; cacheKey: string; value: string; target: ValidationTarget }[] = [];
  for (const data of entries) {
    let entry;
    let row: RowReader | undefined;
    for (const column of columns) {
      if (!named.has(column.id)) continue;
      const langs = column.scope === "entry" ? [undefined] : languages.filter((l) => ctx.applies(column, l.id));
      for (const language of langs) {
        const cellId = ctx.cellId(column, language?.id);
        const raw = valueOf(data, column, language?.id);
        // 値が同じ間は結果を使い回す（数値の 1 と文字列の "1" は別の値として扱う）。
        const value = stableStringify(raw);
        const cacheKey = `\u0001${data.key}\u0000${cellId}`;
        const cached = doc.validation.get(cacheKey);
        if (cached && cached.value === value) {
          add(data.key, cellId, cached.issues);
          continue;
        }
        entry ??= ctx.toEntry(doc, data);
        row ??= rowOf(data);
        const target: ValidationTarget = { entry, column, value: cellValueText(raw), row };
        if (raw !== undefined && raw !== null) target.raw = raw;
        if (language) target.language = language;
        pending.push({ key: data.key, cellId, cacheKey, value, target });
      }
    }
  }
  if (pending.length > 0) {
    const results = await runValidators(pending.map((p) => p.target), validators, { tokenize: doc.tokenize });
    results.forEach((r, i) => {
      const p = pending[i]!;
      const issues = r.issues.map(toIssueInfo);
      doc.validation.set(p.cacheKey, { value: p.value, base: undefined, issues });
      add(p.key, p.cellId, issues);
    });
  }
  // リソース全体の検証で見つかった、本文以外の列の問題。
  const wanted = new Set(columns.map((c) => c.id));
  const langIds = new Set(languages.map((l) => l.id));
  const fromResource = await resourceIssues(ctx, doc);
  if (fromResource.size > 0) {
    for (const data of entries) {
      for (const [cellId, issues] of fromResource.get(data.key) ?? []) {
        const { column, language } = ctx.parseCellId(cellId);
        if (!wanted.has(column.id) || (language && !langIds.has(language.id))) continue;
        add(data.key, cellId, issues);
      }
    }
  }
  return out;
}

/**
 * 行 × 言語の本文を確かめる。戻り値のキーは issueKey(key, language)。
 * 本文の列がその言語に出ない場合は含めない。リソース全体の検証で見つかった本文の問題も含む。
 */
export async function validateEntries(
  ctx: WsContext,
  doc: DocState,
  entries: EntryData[],
  languages: LanguageDef[],
): Promise<Map<string, IssueInfo[]>> {
  const out = new Map<string, IssueInfo[]>();
  const textCol = ctx.textColumn();
  if (!textCol) return out;
  const validators = ctx.project.resolveValidators();
  const rid = doc.resource.id;
  const langs = languages.filter((l) => ctx.applies(textCol, l.id));
  const pending: { k: string; value: string; base: string | undefined; target: ValidationTarget }[] = [];

  for (const data of entries) {
    let entry;
    let row: RowReader | undefined;
    for (const language of langs) {
      const k = issueKey(data.key, language.id);
      const value = ctx.effectiveText(rid, data, language.id) ?? "";
      const baseLang = language.basedOn !== undefined ? ctx.language(language.basedOn) : undefined;
      const base = baseLang ? ctx.effectiveText(rid, data, baseLang.id) : undefined;
      const cached = doc.validation.get(k);
      if (cached && cached.value === value && cached.base === base) {
        out.set(k, cached.issues);
        continue;
      }
      if (validators.length === 0) {
        out.set(k, []);
        continue;
      }
      entry ??= ctx.toEntry(doc, data);
      row ??= basicRowReader(ctx, doc, data);
      const target: ValidationTarget = { entry, column: textCol, language, value, row };
      if (baseLang && base !== undefined) target.base = { language: baseLang, value: base };
      pending.push({ k, value, base, target });
    }
  }

  if (pending.length > 0) {
    const results = await runValidators(
      pending.map((p) => p.target),
      validators,
      { tokenize: doc.tokenize },
    );
    results.forEach((r, i) => {
      const p = pending[i]!;
      const issues: IssueInfo[] = r.issues.map(toIssueInfo);
      doc.validation.set(p.k, { value: p.value, base: p.base, issues });
      out.set(p.k, issues);
    });
  }
  // リソース全体の検証で見つかった本文の問題を足す（セルごとの結果のキャッシュは書き換えない）。
  const fromResource = await resourceIssues(ctx, doc);
  if (fromResource.size > 0) {
    for (const data of entries) {
      const cells = fromResource.get(data.key);
      if (!cells) continue;
      for (const language of langs) {
        const extra = cells.get(ctx.cellId(textCol, language.id));
        if (!extra) continue;
        const k = issueKey(data.key, language.id);
        out.set(k, [...(out.get(k) ?? []), ...extra]);
      }
    }
  }
  return out;
}

/**
 * 保存せずに 1 つのセルの本文を確かめる（入力中の確認用）。
 * ドラフトにも、保存済みの本文の結果のキャッシュにも、履歴にも触らない。
 */
export async function validateText(
  ctx: WsContext,
  params: { resourceId: string; key: string; language: string; value: string },
): Promise<IssueInfo[]> {
  if (typeof params?.value !== "string") throw new ApiError("invalid", "本文（value）は文字列で指定してください。");
  const textCol = ctx.requireTextColumn();
  const language = ctx.language(params.language);
  if (!language) throw new ApiError("not-found", `言語 "${String(params.language)}" はプロジェクトにありません。`);
  if (!ctx.applies(textCol, language.id)) throw new ApiError("not-found", `本文の列は言語 "${language.id}" にはありません。`);
  const doc = await ctx.docs.get(params.resourceId);
  const data = ctx.entryOf(doc, params.key);
  const validators = ctx.project.resolveValidators();
  if (validators.length === 0) return [];
  const rid = doc.resource.id;
  const base = basicRowReader(ctx, doc, data);
  // 同じ行のほかの列からは、確かめている値が見えるようにする。
  const row: RowReader = {
    text: (l) => (l === language.id ? params.value : base.text(l)),
    get: (columnId, l) => (columnId === textCol.id && l === language.id ? params.value : base.get(columnId, l)),
  };
  const target: ValidationTarget = { entry: ctx.toEntry(doc, data), column: textCol, language, value: params.value, row };
  const baseLang = language.basedOn !== undefined ? ctx.language(language.basedOn) : undefined;
  const baseText = baseLang ? ctx.effectiveText(rid, data, baseLang.id) : undefined;
  if (baseLang && baseText !== undefined) target.base = { language: baseLang, value: baseText };
  const [result] = await runValidators([target], validators, { tokenize: doc.tokenize });
  return (result?.issues ?? []).map(toIssueInfo);
}

/** 1 回の tokens で受け付ける本文の数と、合計の文字数。 */
const MAX_TOKEN_TEXTS = 200;
const MAX_TOKEN_CHARS = 1_000_000;

/** 本文を、そのリソースの記法でトークンに分ける（画面の色分けと、変数の差し込み用）。 */
export async function tokens(ctx: WsContext, params: { resourceId: string; texts: string[] }): Promise<import("@loc-studio/sdk").TextToken[][]> {
  const texts = params?.texts;
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== "string")) throw new ApiError("invalid", "texts は文字列の配列で指定してください。");
  if (texts.length > MAX_TOKEN_TEXTS) throw new ApiError("invalid", `texts は ${MAX_TOKEN_TEXTS} 個までにしてください。`);
  if (texts.reduce((n, t) => n + t.length, 0) > MAX_TOKEN_CHARS) throw new ApiError("invalid", `texts は合わせて ${MAX_TOKEN_CHARS} 文字までにしてください。`);
  const doc = await ctx.docs.get(params.resourceId);
  return texts.map((t) => doc.tokenize(t));
}

function toIssueInfo(iss: { validatorId: string; code: string; message: string; severity: IssueInfo["severity"]; range?: IssueInfo["range"]; fix?: IssueInfo["fix"] }): IssueInfo {
  const info: IssueInfo = { validatorId: iss.validatorId, code: iss.code, message: iss.message, severity: iss.severity };
  if (iss.range) info.range = iss.range;
  if (iss.fix) info.fix = iss.fix;
  return info;
}
