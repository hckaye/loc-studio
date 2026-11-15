/**
 * レビュー: 投稿（postReview）、一覧（reviews）、レビュー先への転載（forwardReview）。
 */
import { resolveSetting } from "@loc-studio/core";
import type { Action, ActionContext, ColumnDef, ColumnSource, EntryData, LanguageDef, Options, ReviewPost, WorkflowEvent } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { ReviewInfo } from "./api-types.js";
import { loadSourceValues, pageRowReader, targetHash } from "./cells.js";
import type { ColumnValues } from "./cells.js";
import type { WsContext } from "./context.js";
import { defaultValue, enumOf, errorText, REVIEW_FORWARDS_NS } from "./context.js";
import { assertCan } from "./permissions.js";
import { applyPatches, transitionProblem } from "./editing.js";
import { runAfter, runBefore } from "./hooks.js";
import type { DocState } from "./documents.js";

interface ReviewCell {
  doc: DocState;
  data: EntryData;
  column: ColumnDef;
  language: LanguageDef | undefined;
  source: ColumnSource;
  sourceCtx: ReturnType<WsContext["project"]["sourceContext"]>;
}

async function reviewCell(ctx: WsContext, params: { resourceId: string; key: string; cellId: string }): Promise<ReviewCell> {
  const { column, language } = ctx.parseCellId(params?.cellId);
  if (column.kind !== "review") throw new ApiError("invalid", `列 "${column.id}" はレビュー列ではありません。`);
  const resolved = ctx.columnSource(column);
  if (!resolved || !resolved.source.postReview || !resolved.source.listReviews) {
    throw new ApiError("invalid", `レビュー列 "${column.id}" の出所 "${column.source ?? ""}" はレビューの投稿に対応していません。`);
  }
  const doc = await ctx.docs.get(params.resourceId);
  const data = ctx.entryOf(doc, params.key);
  return { doc, data, column, language, source: resolved.source, sourceCtx: ctx.project.sourceContext(resolved) };
}

/** レビューの対象の列の値を読む（列ソースの列なら DB から）。 */
async function targetValues(ctx: WsContext, rc: ReviewCell): Promise<ColumnValues> {
  const target = rc.column.of !== undefined ? ctx.column(rc.column.of) : undefined;
  if (!target || !ctx.columnSource(target)) return new Map();
  return loadSourceValues(ctx, rc.doc.resource.id, [rc.data.key], [
    { column: target, languages: [target.scope === "language" ? rc.language?.id : undefined] },
  ]);
}

function toInfo(post: ReviewPost, current: string | undefined): ReviewInfo {
  return { ...post, stale: post.basisHash !== undefined && current !== undefined && post.basisHash !== current };
}

export async function reviews(ctx: WsContext, params: { resourceId: string; key: string; cellId: string }): Promise<ReviewInfo[]> {
  const rc = await reviewCell(ctx, params);
  const ref = ctx.cellRef(rc.doc.resource.id, rc.data.key, rc.column, rc.language?.id);
  const posts = await rc.source.listReviews!(ref, rc.sourceCtx);
  const current = targetHash(ctx, rc.doc, rc.data, rc.column, rc.language?.id, await targetValues(ctx, rc));
  return posts.map((p) => toInfo(p, current));
}

export async function postReview(
  ctx: WsContext,
  params: { resourceId: string; key: string; cellId: string; verdict: string; comment: string; forward?: boolean },
): Promise<ReviewInfo> {
  const rc = await reviewCell(ctx, params);
  const { column, language, doc, data } = rc;
  assertCan("review", column.scope === "language" ? language?.id : undefined, column.id);
  const verdict = params.verdict;
  const comment = typeof params.comment === "string" ? params.comment : "";
  if (typeof verdict !== "string" || verdict === "") throw new ApiError("invalid", "レビューの判定（verdict）を指定してください。");
  const options = enumOf(column)?.enum;
  const option = options?.find((o) => o.value === verdict);
  if (options && !option) {
    throw new ApiError("invalid", `レビュー列 "${column.id}" に判定 "${verdict}" はありません（選択肢: ${options.map((o) => o.value).join(", ")}）。`);
  }
  if (option?.requireComment && comment.trim() === "") {
    throw new ApiError("invalid", `判定「${option.label ?? option.value}」にはコメントが必要です。`);
  }

  const rid = doc.resource.id;
  const ref = ctx.cellRef(rid, data.key, column, language?.id);
  const values = await targetValues(ctx, rc);
  const basisHash = targetHash(ctx, doc, data, column, language?.id, values);
  const target = column.of !== undefined ? ctx.column(column.of) : undefined;
  if (target?.kind === "text" && language) {
    // 「その時点の本文」をあとで見られるよう、全文を残す。
    const tlang = target.scope === "language" ? language.id : undefined;
    if (tlang !== undefined) await ctx.rememberTexts([ctx.effectiveText(rid, data, tlang) ?? ""]);
  }
  const [previous] = await rc.source.load([ref], rc.sourceCtx);
  const previousVerdict = previous ? previous.value : defaultValue(column);
  // 判定の選択肢の from / roles（遷移と役割の制限）。直前の判定がいまの値。
  const problem = transitionProblem(column, previousVerdict, verdict);
  if (problem !== undefined) throw new ApiError("blocked", problem, { transition: { from: previousVerdict ?? null, to: verdict } });
  const event: WorkflowEvent = { type: "review.post", resource: doc.resource, column, cell: ref, verdict, comment, previous: previousVerdict };
  if (language && column.scope === "language") event.language = language;
  await runBefore(ctx, event);

  let post: ReviewPost;
  try {
    post = await rc.source.postReview!({ cell: ref, verdict, comment, ...(basisHash !== undefined ? { basisHash } : {}) }, rc.sourceCtx);
  } catch (err) {
    throw new ApiError("failed", `レビューを投稿できませんでした: ${errorText(err)}`);
  }
  if (ctx.recordsHistory(column)) {
    await ctx.appendHistory([
      { cell: ref, data: { oldValue: previousVerdict, newValue: verdict, cause: "review", causeRef: post.id } },
    ]);
  }
  ctx.bump();
  await runAfter(ctx, { ...event, review: post }, applyPatches);

  const mode = resolveSetting("review.forwardOnPost", ctx.currentLayers())?.value ?? "ask";
  const doForward = mode === "always" || (mode === "ask" && params.forward === true);
  const warnings: string[] = [];
  const links = [...(post.links ?? [])];
  if (doForward) {
    for (const t of ctx.reviewTargets()) {
      try {
        const added = await forwardOne(ctx, rc, post, t.action, t.options, values);
        links.push(...added);
      } catch (err) {
        const message = `レビューをレビュー先「${t.action.label}」（${t.action.id}）に転載できませんでした: ${errorText(err)}`;
        warnings.push(message);
        ctx.warn(message);
      }
    }
  }
  const info: ReviewInfo = { ...post, stale: false };
  if (links.length > 0) info.links = links;
  if (warnings.length > 0) info.warnings = warnings;
  return info;
}

/** 1 つのレビュー先に転載する。すでに転載済みなら何もしない。戻り値は増えたリンク。 */
async function forwardOne(
  ctx: WsContext,
  rc: ReviewCell,
  post: ReviewPost,
  action: Action,
  options: Options,
  values: ColumnValues,
): Promise<{ label: string; url: string }[]> {
  const kv = ctx.shared.kv(REVIEW_FORWARDS_NS);
  const fk = `${post.id}\u0000${action.id}`;
  if ((await kv.get(fk)) !== undefined) return [];
  const actx: ActionContext = {
    entry: ctx.toEntry(rc.doc, rc.data),
    column: rc.column,
    value: post.verdict,
    row: pageRowReader(ctx, rc.doc, rc.data, values),
    review: post,
    options,
    secrets: ctx.secrets,
    env: ctx.env,
    host: ctx.project.host,
  };
  if (rc.language) actx.language = rc.language;
  if (action.when && !action.when(actx)) return [];
  const result = await action.run(actx);
  const links = Array.isArray(result?.links) ? result.links : [];
  if (links.length > 0) {
    if (!rc.source.addReviewLinks) {
      throw new Error(`レビュー列の出所 "${rc.column.source ?? ""}" はリンクの保存（addReviewLinks）に対応していません。`);
    }
    await rc.source.addReviewLinks(post.id, links, rc.sourceCtx);
  }
  await kv.set(fk, { links, at: new Date().toISOString(), by: ctx.userName() });
  ctx.bump();
  return links;
}

export async function forwardReview(
  ctx: WsContext,
  params: { resourceId: string; key: string; cellId: string; reviewId: string; actionId: string },
): Promise<ReviewInfo> {
  const rc = await reviewCell(ctx, params);
  assertCan("review", rc.column.scope === "language" ? rc.language?.id : undefined, rc.column.id);
  const ref = ctx.cellRef(rc.doc.resource.id, rc.data.key, rc.column, rc.language?.id);
  const posts = await rc.source.listReviews!(ref, rc.sourceCtx);
  const post = posts.find((p) => p.id === params.reviewId);
  if (!post) throw new ApiError("not-found", `レビューの投稿 "${params.reviewId}" が見つかりません。`);
  // 設定 review.targets に書かれたレビュー先だけ（登録されていても設定にないアクションは使わない）。
  const configured = ctx.reviewTargets().find((t) => t.action.id === params.actionId);
  const action = configured?.action;
  if (!action || action.target !== "review") {
    throw new ApiError("not-found", `レビュー先 "${params.actionId}" は設定 review.targets にありません。`);
  }
  const values = await targetValues(ctx, rc);
  try {
    await forwardOne(ctx, rc, post, action, configured.options, values);
  } catch (err) {
    throw new ApiError("failed", `レビューをレビュー先「${action.label}」に転載できませんでした: ${errorText(err)}`);
  }
  const updated = (await rc.source.listReviews!(ref, rc.sourceCtx)).find((p) => p.id === post.id) ?? post;
  return toInfo(updated, targetHash(ctx, rc.doc, rc.data, rc.column, rc.language?.id, values));
}
