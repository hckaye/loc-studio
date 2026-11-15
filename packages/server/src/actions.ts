/**
 * アクションの実行。cell / row は行ごとに、selection / file / column は 1 回だけ呼ぶ。
 * 返ってきた変更点は setText / setCell と同じ規則で反映する（cause: action）。
 */
import type { Action, ActionContext, ActionResult, ColumnDef, EntryData, LanguageDef, Options } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { RunActionParams, RunActionResult } from "./api-types.js";
import { currentValue, loadSourceValues, pageRowReader } from "./cells.js";
import type { ColumnValues } from "./cells.js";
import type { WsContext } from "./context.js";
import { errorText } from "./context.js";
import type { DocState } from "./documents.js";
import { applyPatches } from "./editing.js";
import { assertCanRun } from "./permissions.js";

/** これを超える行数はジョブにする。 */
export const ACTION_JOB_THRESHOLD = 20;

async function preload(ctx: WsContext, doc: DocState, entries: EntryData[]): Promise<ColumnValues> {
  const langs = ctx.project.languages.map((l) => l.id);
  const specs = ctx
    .columns()
    .filter((c) => ctx.columnSource(c))
    .map((c) => ({ column: c, languages: c.scope === "entry" ? [undefined] : langs.filter((l) => ctx.applies(c, l)) }));
  if (specs.length === 0 || entries.length === 0) return new Map();
  return loadSourceValues(ctx, doc.resource.id, entries.map((e) => e.key), specs);
}

export async function runAction(ctx: WsContext, params: RunActionParams): Promise<RunActionResult> {
  const found = ctx.configuredActions().find((a) => a.action.id === params?.actionId);
  if (!found) throw new ApiError("not-found", `アクション "${String(params?.actionId)}" は設定の actions にありません。`);
  const { action, options } = found;
  assertCanRun("action", action.id);
  if (action.target === "review") {
    throw new ApiError("invalid", `アクション "${action.id}" はレビュー先です。forwardReview で投稿を転載してください。`);
  }
  const doc = await ctx.docs.get(params.resourceId);

  let column: ColumnDef | undefined;
  let language: LanguageDef | undefined;
  if (params.cellId !== undefined) ({ column, language } = ctx.parseCellId(params.cellId));
  if (params.language !== undefined) {
    const l = ctx.requireLanguage(params.language);
    if (language && language.id !== l.id) throw new ApiError("invalid", "cellId の言語と language が違います。");
    language = l;
  }
  if ((action.target === "cell" || action.target === "column") && !column) {
    throw new ApiError("invalid", `アクション "${action.id}"（target: ${action.target}）には cellId が必要です。`);
  }
  if (column && action.columns && !action.columns.includes(column.id)) {
    throw new ApiError("invalid", `アクション "${action.id}" は列 "${column.id}" には使えません（使える列: ${action.columns.join(", ")}）。`);
  }
  if (language && action.languages && !action.languages.includes(language.id)) {
    throw new ApiError("invalid", `アクション "${action.id}" は言語 "${language.id}" には使えません。`);
  }
  if (params.keys !== undefined && !Array.isArray(params.keys)) throw new ApiError("invalid", "keys は配列で指定してください。");
  const keys = params.keys ? [...new Set(params.keys)] : undefined;
  const why = { cause: "action" as const, causeRef: action.id };

  if (action.target === "cell" || action.target === "row") {
    if (!keys || keys.length === 0) throw new ApiError("invalid", `アクション "${action.id}"（target: ${action.target}）には keys が必要です。`);
    const rows = keys.map((k) => ctx.entryOf(doc, k));
    if (rows.length > ACTION_JOB_THRESHOLD) {
      const job = ctx.jobs.start("action", `${action.label}（${rows.length} 行）`, rows.length, async (handle) => {
        const values = await preload(ctx, doc, rows);
        const errors: string[] = [];
        for (const data of rows) {
          if (handle.cancelled()) break;
          try {
            const r = await runOnRow(ctx, action, options, doc, data, column, language, values);
            if (r === undefined) {
              handle.info.skipped++;
              continue;
            }
            const applied = await applyPatches(ctx, r.patches ?? [], why);
            errors.push(...applied.errors);
            if (applied.errors.length > 0) handle.info.failed++;
            else handle.info.done++;
          } catch (err) {
            handle.info.failed++;
            errors.push(`${data.key}: ${errorText(err)}`);
          }
        }
        if (errors.length > 0) handle.info.error = errors.slice(0, 5).join(" / ");
      });
      return { patched: 0, jobId: job.id };
    }
    const values = await preload(ctx, doc, rows);
    const out: RunActionResult = { patched: 0 };
    const messages: string[] = [];
    const errors: string[] = [];
    for (const data of rows) {
      let r: ActionResult | undefined;
      try {
        r = await runOnRow(ctx, action, options, doc, data, column, language, values);
      } catch (err) {
        throw new ApiError("failed", `アクション「${action.label}」が失敗しました（${data.key}）: ${errorText(err)}`);
      }
      if (!r) continue;
      if (r.message) messages.push(r.message);
      if (r.open) out.open = r.open;
      const applied = await applyPatches(ctx, r.patches ?? [], why);
      out.patched += applied.patched;
      errors.push(...applied.errors);
    }
    if (messages.length > 0) out.message = messages.join("\n");
    if (errors.length > 0) out.errors = errors;
    return out;
  }

  // selection / file / column は 1 回だけ。行の値は rows（entries と同じ順）から読める。
  const entries = action.target === "selection" && keys ? keys.map((k) => ctx.entryOf(doc, k)) : doc.entries;
  const values = await preload(ctx, doc, entries);
  const actx: ActionContext = {
    entries: entries.map((e) => ctx.toEntry(doc, e)),
    rows: entries.map((e) => pageRowReader(ctx, doc, e, values)),
    options,
    secrets: ctx.secrets,
    env: ctx.env,
    host: ctx.project.host,
  };
  if (column) actx.column = column;
  if (language) actx.language = language;
  if (action.when && !action.when(actx)) return { patched: 0 };
  let r: ActionResult;
  try {
    r = await action.run(actx);
  } catch (err) {
    throw new ApiError("failed", `アクション「${action.label}」が失敗しました: ${errorText(err)}`);
  }
  const applied = await applyPatches(ctx, r?.patches ?? [], why);
  const out: RunActionResult = { patched: applied.patched };
  if (r?.message) out.message = r.message;
  if (r?.open) out.open = r.open;
  if (applied.errors.length > 0) out.errors = applied.errors;
  return out;
}

/** 1 行に対して実行する。when が false なら undefined。 */
async function runOnRow(
  ctx: WsContext,
  action: Action,
  options: Options,
  doc: DocState,
  data: EntryData,
  column: ColumnDef | undefined,
  language: LanguageDef | undefined,
  values: ColumnValues,
): Promise<ActionResult | undefined> {
  const actx: ActionContext = {
    entry: ctx.toEntry(doc, data),
    row: pageRowReader(ctx, doc, data, values),
    options,
    secrets: ctx.secrets,
    env: ctx.env,
    host: ctx.project.host,
  };
  if (language) actx.language = language;
  if (column && action.target === "cell") {
    actx.column = column;
    actx.value = currentValue(ctx, doc, data, column, column.scope === "language" ? language?.id : undefined, values);
  }
  if (action.when && !action.when(actx)) return undefined;
  return (await action.run(actx)) ?? {};
}
