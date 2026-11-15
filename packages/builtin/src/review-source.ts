import type { CellRef, CellValue, ColumnSource, ColumnSourceContext, LogRecord, LogStore, ReviewPost } from "@loc-studio/sdk";
import { namespaceOption } from "./db-source.js";

/** options.namespace を省略したときの名前空間。リンクは「名前空間 + ".links"」に置く。 */
export const REVIEW_SOURCE_DEFAULT_NAMESPACE = "builtin.reviews";

/** 投稿 1 件としてログに残す中身。 */
export interface ReviewRecordData {
  verdict: string;
  comment: string;
  basisHash?: string;
}

/** 投稿に紐づけたリンクとしてログに残す中身。 */
export interface ReviewLinkData {
  reviewId: string;
  links: { label: string; url: string }[];
}

const logs = (ctx: ColumnSourceContext): { posts: LogStore<ReviewRecordData>; links: LogStore<ReviewLinkData> } => {
  const ns = namespaceOption(ctx, REVIEW_SOURCE_DEFAULT_NAMESPACE, reviewSource.id);
  return { posts: ctx.host.db.log<ReviewRecordData>(ns), links: ctx.host.db.log<ReviewLinkData>(`${ns}.links`) };
};

function toPost(rec: LogRecord<ReviewRecordData>, links?: { label: string; url: string }[]): ReviewPost {
  if (!rec.cell) throw new Error(`レビューの記録 ${rec.id} に対象のセルがありません。`);
  const post: ReviewPost = {
    id: rec.id,
    cell: rec.cell,
    columnId: rec.cell.columnId,
    verdict: rec.data.verdict,
    comment: rec.data.comment,
    userName: rec.by,
    createdAt: rec.at,
  };
  if (rec.data.basisHash !== undefined) post.basisHash = rec.data.basisHash;
  if (links && links.length > 0) post.links = links;
  return post;
}

/**
 * レビュー列の出所。レビューは「列に対する投稿」で、ホストの DB のログに追記する（書き換えも削除もしない）。
 * セルの値は最新の投稿の判定。
 */
export const reviewSource: ColumnSource = {
  id: "builtin.reviews",
  saveMode: "immediate",
  async load(cells, ctx) {
    if (cells.length === 0) return [];
    const latest = await logs(ctx).posts.latest(cells);
    const out: CellValue[] = [];
    cells.forEach((cell, i) => {
      const rec = latest[i];
      if (!rec) return;
      const value: CellValue = { ...cell, value: rec.data.verdict, updatedAt: rec.at, updatedBy: rec.by };
      if (rec.data.basisHash !== undefined) value.basisHash = rec.data.basisHash;
      out.push(value);
    });
    return out;
  },
  async save(values) {
    if (values.length === 0) return [];
    throw new Error(
      `列ソース "builtin.reviews" の値は直接保存できません。レビューの判定は投稿（postReview）で変えてください（対象: ${values
        .map((v) => `${v.resourceId} の ${v.entryKey} / ${v.columnId}`)
        .join(", ")}）。`,
    );
  },
  async onEntriesChanged(changes, resource, ctx) {
    const { posts, links } = logs(ctx);
    for (const change of changes) {
      if (change.type !== "rename") continue;
      await posts.renameEntry(resource.id, change.key, change.newKey);
      await links.renameEntry(resource.id, change.key, change.newKey);
    }
  },
  async postReview(post, ctx) {
    if (typeof post.verdict !== "string" || post.verdict === "") throw new Error("レビューの判定（verdict）が空です。");
    const data: ReviewRecordData = { verdict: post.verdict, comment: post.comment ?? "" };
    if (post.basisHash !== undefined) data.basisHash = post.basisHash;
    const [rec] = await logs(ctx).posts.append([{ cell: post.cell, data }]);
    if (!rec) throw new Error("レビューの投稿を保存できませんでした（DB が記録を返しませんでした）。");
    return toPost(rec);
  },
  async listReviews(cell: CellRef, ctx) {
    const { posts, links } = logs(ctx);
    const records = await posts.list({ cell });
    if (records.length === 0) return [];
    // リンクは追加した順に並べたいので、新しい順の一覧を逆からたどる。
    const linkRecords = await links.list({ cell });
    const byReview = new Map<string, { label: string; url: string }[]>();
    for (let i = linkRecords.length - 1; i >= 0; i--) {
      const { reviewId, links: added } = linkRecords[i]!.data;
      byReview.set(reviewId, [...(byReview.get(reviewId) ?? []), ...added]);
    }
    return records.map((rec) => toPost(rec, byReview.get(rec.id)));
  },
  async addReviewLinks(reviewId, links, ctx) {
    if (links.length === 0) return;
    const store = logs(ctx);
    // リンクを投稿と同じセルに紐づけておき、一覧のときにセルで絞れるようにする。
    const target = (await store.posts.list()).find((rec) => rec.id === reviewId);
    if (!target) throw new Error(`レビューの投稿 ${reviewId} が見つかりません。`);
    await store.links.append([{ ...(target.cell ? { cell: target.cell } : {}), data: { reviewId, links } }]);
  },
};
