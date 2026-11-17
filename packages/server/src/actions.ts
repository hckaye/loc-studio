/**
 * アクションの実行。cell / row は行ごとに、selection / file / column は 1 回だけ呼ぶ。
 * 対象の行は、keys（名指し）か filter（条件に合う行。表の絞り込みと同じ RowFilter）で決める。
 * batchSize が 2 以上なら、cell / row のアクションを、その数の行ごとにまとめて呼ぶ（Action.runBatch）。
 * 返ってきた変更点は setText / setCell と同じ規則で反映する（cause: action）。
 */
import type { Action, ActionContext, ActionResult, ColumnDef, EntryData, LanguageDef, Options } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { RunActionParams, RunActionResult } from "./api-types.js";
import { batchSizeOf } from "./batch-size.js";
import { currentValue, loadSourceValues, pageRowReader } from "./cells.js";
import type { ColumnValues } from "./cells.js";
import type { WsContext } from "./context.js";
import { errorText } from "./context.js";
import type { DocState } from "./documents.js";
import { applyPatches } from "./editing.js";
import type { JobHandle } from "./jobs.js";
import { assertCanRun } from "./permissions.js";
import { matchEntries, prepareFilter, requireLanguages } from "./rows.js";

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
  // 1 回の呼び出しにまとめる行の数。2 以上は、行をまとめて受け取れるアクションだけ。
  const batchSize = batchSizeOf(params.batchSize) ?? 1;
  if (batchSize > 1) {
    if (action.target !== "cell" && action.target !== "row") {
      throw new ApiError("invalid", `アクション "${action.id}"（target: ${action.target}）は、対象の行をまとめて 1 回で受け取るので、batchSize は指定できません。`);
    }
    if (typeof action.runBatch !== "function") {
      throw new ApiError("invalid", `アクション "${action.id}" は、複数の行をまとめて受け取れません（runBatch がありません）。batchSize を外すか、1 にしてください。`);
    }
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

  // filter: 条件に合う行を対象にする（表の絞り込み、検索結果の表示、コマンドラインの run --where）。
  let matched: EntryData[] | undefined;
  if (params.filter !== undefined) {
    if (typeof params.filter !== "object" || params.filter === null) throw new ApiError("invalid", "filter はオブジェクトで指定してください。");
    if (keys) throw new ApiError("invalid", "keys と filter は、どちらか一方だけを指定してください。");
    if (action.target !== "cell" && action.target !== "row" && action.target !== "selection") {
      throw new ApiError("invalid", `アクション "${action.id}"（target: ${action.target}）は、ファイルや列の全体が対象なので、filter（条件に合う行）は指定できません。`);
    }
    matched = await matchEntries(ctx, doc, prepareFilter(ctx, params.filter, requireLanguages(ctx, params.filter.languages)));
    // 合う行がなければ、アクションを呼ばない。
    if (matched.length === 0) return { patched: 0, matched: 0 };
  }

  if (action.target === "cell" || action.target === "row") {
    if (!matched && (!keys || keys.length === 0)) {
      throw new ApiError("invalid", `アクション "${action.id}"（target: ${action.target}）には keys か filter が必要です。`);
    }
    const rows = matched ?? keys!.map((k) => ctx.entryOf(doc, k));
    if (batchSize > 1) {
      const target = { action, options, doc, rows, column, language, batchSize, why };
      if (rows.length > ACTION_JOB_THRESHOLD) {
        const job = ctx.jobs.start("action", `${action.label}（${rows.length} 行）`, rows.length, async (handle) => {
          const r = await runBatches(ctx, target, handle);
          if (r.errors.length > 0) handle.info.error = r.errors.slice(0, 5).join(" / ");
        });
        return { patched: 0, jobId: job.id, ...(matched ? { matched: rows.length } : {}) };
      }
      const r = await runBatches(ctx, target);
      const out: RunActionResult = { patched: r.patched };
      if (matched) out.matched = rows.length;
      if (r.messages.length > 0) out.message = r.messages.join("\n");
      if (r.open) out.open = r.open;
      if (r.errors.length > 0) out.errors = r.errors;
      return out;
    }
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
      return { patched: 0, jobId: job.id, ...(matched ? { matched: rows.length } : {}) };
    }
    const values = await preload(ctx, doc, rows);
    const out: RunActionResult = { patched: 0 };
    if (matched) out.matched = rows.length;
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
  const entries = matched ?? (action.target === "selection" && keys ? keys.map((k) => ctx.entryOf(doc, k)) : doc.entries);
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
  if (matched) out.matched = matched.length;
  if (r?.message) out.message = r.message;
  if (r?.open) out.open = r.open;
  if (applied.errors.length > 0) out.errors = applied.errors;
  return out;
}

interface BatchTarget {
  action: Action;
  options: Options;
  doc: DocState;
  rows: EntryData[];
  column: ColumnDef | undefined;
  language: LanguageDef | undefined;
  batchSize: number;
  why: { cause: "action"; causeRef: string };
}

/**
 * 行を batchSize 行ずつに分け、まとまりごとに runBatch を呼ぶ。when が false の行は、まとまりに入れない。
 * ジョブの中（job あり）では、失敗したまとまりを数えて次へ進む。ジョブでなければ、最初の失敗で例外にする
 * （行ごとに呼ぶときと同じ）。
 */
async function runBatches(
  ctx: WsContext,
  target: BatchTarget,
  job?: JobHandle,
): Promise<{ patched: number; messages: string[]; errors: string[]; open?: ActionResult["open"] }> {
  const { action, options, doc, rows, column, language, batchSize, why } = target;
  const values = await preload(ctx, doc, rows);
  const out: { patched: number; messages: string[]; errors: string[]; open?: ActionResult["open"] } = { patched: 0, messages: [], errors: [] };
  const pending: { data: EntryData; actx: ActionContext }[] = [];
  for (const data of rows) {
    const actx = rowContext(ctx, action, options, doc, data, column, language, values);
    let wanted: boolean;
    try {
      wanted = !action.when || action.when(actx);
    } catch (err) {
      if (!job) throw new ApiError("failed", `アクション「${action.label}」が失敗しました（${data.key}）: ${errorText(err)}`);
      job.info.failed++;
      out.errors.push(`${data.key}: ${errorText(err)}`);
      continue;
    }
    if (wanted) pending.push({ data, actx });
    else if (job) job.info.skipped++;
  }
  for (let i = 0; i < pending.length; i += batchSize) {
    if (job?.cancelled()) break;
    const chunk = pending.slice(i, i + batchSize);
    const range = chunk.length === 1 ? chunk[0]!.data.key : `${chunk[0]!.data.key} から ${chunk[chunk.length - 1]!.data.key} までの ${chunk.length} 行`;
    let r: ActionResult;
    try {
      r = (await action.runBatch!(chunk.map((c) => c.actx))) ?? {};
    } catch (err) {
      if (!job) throw new ApiError("failed", `アクション「${action.label}」が失敗しました（${range}）: ${errorText(err)}`);
      job.info.failed += chunk.length;
      out.errors.push(`${range}: ${errorText(err)}`);
      continue;
    }
    if (r.message) out.messages.push(r.message);
    if (r.open) out.open = r.open;
    const applied = await applyPatches(ctx, r.patches ?? [], why);
    out.patched += applied.patched;
    out.errors.push(...applied.errors);
    if (job) {
      if (applied.errors.length > 0) job.info.failed += chunk.length;
      else job.info.done += chunk.length;
    }
  }
  return out;
}

/** 1 行分の、アクションに渡す値。 */
function rowContext(
  ctx: WsContext,
  action: Action,
  options: Options,
  doc: DocState,
  data: EntryData,
  column: ColumnDef | undefined,
  language: LanguageDef | undefined,
  values: ColumnValues,
): ActionContext {
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
  return actx;
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
  const actx = rowContext(ctx, action, options, doc, data, column, language, values);
  if (action.when && !action.when(actx)) return undefined;
  return (await action.run(actx)) ?? {};
}
