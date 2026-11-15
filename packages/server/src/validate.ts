/**
 * 複数のリソースの一括バリデーション（コマンドラインなど）。
 * 読めない・解析できないリソースはそのリソースの error に出し、ほかのリソースは続ける。
 */
import { ApiError } from "./api-types.js";
import type { ValidateIssue, ValidateResult } from "./api-types.js";
import type { WsContext } from "./context.js";
import { errorText } from "./context.js";
import { issueKey, validateEntries } from "./issues.js";

export async function validate(ctx: WsContext, params: { resourceIds?: string[]; languages?: string[] } = {}): Promise<ValidateResult> {
  if (params.resourceIds !== undefined && !Array.isArray(params.resourceIds)) throw new ApiError("invalid", "resourceIds は配列で指定してください。");
  if (params.languages !== undefined && !Array.isArray(params.languages)) throw new ApiError("invalid", "languages は配列で指定してください。");
  const languages = params.languages ? [...new Set(params.languages.map(String))].map((l) => ctx.requireLanguage(l)) : ctx.project.languages;
  // 同じリソースを何度も並べて仕事を増やせないよう、重複を除く。
  const ids = [...new Set(params.resourceIds?.map(String) ?? (await ctx.docs.refreshTree(), (await ctx.docs.allResources()).map((r) => r.id)))];
  const textCol = ctx.textColumn();
  const result: ValidateResult = { resources: [], summary: { error: 0, warning: 0, info: 0, cells: 0 } };
  for (const id of ids) {
    try {
      // 一括の確認は最新の中身で行う。
      const doc = await ctx.docs.get(id, { force: true });
      const found = await validateEntries(ctx, doc, doc.entries, languages);
      const issues: ValidateIssue[] = [];
      for (const data of doc.entries) {
        for (const lang of languages) {
          const list = found.get(issueKey(data.key, lang.id));
          if (!list || list.length === 0 || !textCol) continue;
          result.summary.cells++;
          for (const iss of list) {
            result.summary[iss.severity]++;
            issues.push({ ...iss, key: data.key, language: lang.id, cellId: ctx.cellId(textCol, lang.id) });
          }
        }
      }
      result.resources.push({ resourceId: id, issues, diagnostics: doc.diagnostics });
    } catch (err) {
      result.resources.push({ resourceId: id, issues: [], diagnostics: [], error: errorText(err) });
    }
  }
  return result;
}
