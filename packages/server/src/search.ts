/**
 * リソースをまたぐ検索（キーと本文の部分一致、大文字小文字を区別しない）。
 */
import { ApiError } from "./api-types.js";
import type { SearchHit } from "./api-types.js";
import type { WsContext } from "./context.js";
import { errorText } from "./context.js";
import { lowerOf } from "./documents.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 2000;
/** 一致箇所の前後に付ける文字数。 */
const CONTEXT_CHARS = 30;

function snippet(text: string, lowerText: string, q: string): string {
  const at = lowerText.indexOf(q);
  // 小文字にすると長さが変わる文字があるので、位置は目安として元の本文に当てる。
  if (at < 0 || lowerText.length !== text.length) return text.length > CONTEXT_CHARS * 2 ? `${text.slice(0, CONTEXT_CHARS * 2)}…` : text;
  const start = Math.max(0, at - CONTEXT_CHARS);
  const end = Math.min(text.length, at + q.length + CONTEXT_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

export async function search(
  ctx: WsContext,
  params: { query: string; languages?: string[]; limit?: number },
): Promise<SearchHit[]> {
  if (typeof params?.query !== "string") throw new ApiError("invalid", "query を指定してください。");
  const q = params.query.trim().toLowerCase();
  if (q === "") return [];
  if (params.languages !== undefined && !Array.isArray(params.languages)) {
    throw new ApiError("invalid", "languages は言語 ID の配列で指定してください。");
  }
  const langs = [...new Set((params.languages ?? ctx.project.languages.map((l) => l.id)).map(String))].map((id) => ctx.requireLanguage(id).id);
  const textCol = ctx.textColumn();
  const textLangs = textCol ? langs.filter((l) => ctx.applies(textCol, l)) : [];
  const limit = Math.min(MAX_LIMIT, params.limit !== undefined ? Math.max(0, Math.floor(Number(params.limit)) || 0) : DEFAULT_LIMIT);
  const hits: SearchHit[] = [];
  if (limit === 0) return hits;

  for (const resource of await ctx.docs.allResources()) {
    let doc;
    try {
      doc = await ctx.docs.get(resource.id);
    } catch (err) {
      ctx.warn(`検索中にリソース ${resource.path} を読めませんでした: ${errorText(err)}`);
      continue;
    }
    const lower = lowerOf(doc, textLangs);
    const drafts = ctx.drafts.mapOf(resource.id);
    for (let i = 0; i < doc.entries.length; i++) {
      const data = doc.entries[i]!;
      if (lower.keys[i]!.includes(q)) {
        hits.push({ resourceId: resource.id, key: data.key, snippet: data.key });
        if (hits.length >= limit) return hits;
      }
      for (const lang of textLangs) {
        const d = drafts?.get(`${data.key}\u0000${lang}`);
        const text = d ? d.value : (data.text[lang] ?? "");
        const lt = d ? text.toLowerCase() : lower.texts.get(lang)![i]!;
        if (!lt.includes(q)) continue;
        hits.push({ resourceId: resource.id, key: data.key, language: lang, snippet: snippet(text, lt, q) });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}
