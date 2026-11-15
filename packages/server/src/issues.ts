/**
 * 本文のセルのバリデーション。結果は本文と基の本文が同じ間、ドキュメントごとに覚えておく。
 */
import { runValidators } from "@loc-studio/core";
import type { ValidationTarget } from "@loc-studio/core";
import type { EntryData, LanguageDef, RowReader } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { IssueInfo } from "./api-types.js";
import type { WsContext } from "./context.js";
import { defaultValue, isFileColumn } from "./context.js";
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

/**
 * 行 × 言語の本文を確かめる。戻り値のキーは issueKey(key, language)。
 * 本文の列がその言語に出ない場合は含めない。
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

function toIssueInfo(iss: { validatorId: string; code: string; message: string; severity: IssueInfo["severity"]; range?: IssueInfo["range"]; fix?: IssueInfo["fix"] }): IssueInfo {
  const info: IssueInfo = { validatorId: iss.validatorId, code: iss.code, message: iss.message, severity: iss.severity };
  if (iss.range) info.range = iss.range;
  if (iss.fix) info.fix = iss.fix;
  return info;
}
