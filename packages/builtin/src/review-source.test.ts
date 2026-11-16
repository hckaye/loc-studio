import { describe, expect, it } from "vitest";
import { createMemoryDb, createPluginHost } from "@loc-studio/core";
import type { CellRef, ColumnSourceContext, HostDb, Options } from "@loc-studio/sdk";
import { reviewSource } from "./review-source.js";

const state = { user: "alice" };
/** 記録に残る名前は DB の userName から来るので、DB とホストに同じ関数を渡す。 */
const newDb = (): HostDb => createMemoryDb({ userName: () => state.user });

function makeCtx(db: HostDb, options: Options = {}) {
  const ctx: ColumnSourceContext = {
    projectRoot: "/p",
    options,
    host: createPluginHost({ db, userName: () => state.user, projectRoot: "/p", env: {} }),
  };
  return { ctx, state };
}

const cell = (entryKey: string, language = "ja"): CellRef => ({ entryKey, resourceId: "a.csv", columnId: "review", language });
const resource = { id: "a.csv", path: "a.csv", name: "a.csv" };

describe("reviewSource", () => {
  it("投稿はログに追記し、値は最新の投稿の判定", async () => {
    state.user = "alice";
    const db = newDb();
    const { ctx } = makeCtx(db);
    expect(reviewSource.id).toBe("builtin.reviews");
    expect(reviewSource.saveMode).toBe("immediate");

    const p1 = await reviewSource.postReview!({ cell: cell("k"), verdict: "back", comment: "誤字", basisHash: "h1" }, ctx);
    expect(p1).toMatchObject({ cell: cell("k"), columnId: "review", verdict: "back", comment: "誤字", userName: "alice", basisHash: "h1" });
    expect(typeof p1.id).toBe("string");
    expect(typeof p1.createdAt).toBe("string");
    // 値には、最新の投稿のコメントと投稿者も付く（表のセルに出る）。
    expect(await reviewSource.load([cell("k")], ctx)).toEqual([{ ...cell("k"), value: "back", updatedAt: p1.createdAt, updatedBy: "alice", basisHash: "h1", comment: "誤字" }]);

    state.user = "bob";
    const p2 = await reviewSource.postReview!({ cell: cell("k"), verdict: "ok", comment: "" }, ctx);
    expect(p2.userName).toBe("bob");
    expect(p2.basisHash).toBeUndefined();

    // コメントのない投稿が最新になると、前の投稿のコメントは付かない。
    const values = await reviewSource.load([cell("none"), cell("k")], ctx);
    expect(values).toEqual([{ ...cell("k"), value: "ok", updatedAt: p2.createdAt, updatedBy: "bob" }]);

    expect((await reviewSource.listReviews!(cell("k"), ctx)).map((p) => p.verdict)).toEqual(["ok", "back"]);
    expect(await reviewSource.listReviews!(cell("none"), ctx)).toEqual([]);
    expect(await db.log("builtin.reviews").list()).toHaveLength(2);
  });

  it("リンクを投稿に紐づけ、一覧に混ぜる。知らない投稿はエラー", async () => {
    const { ctx } = makeCtx(newDb());
    const p1 = await reviewSource.postReview!({ cell: cell("k"), verdict: "back", comment: "c" }, ctx);
    const p2 = await reviewSource.postReview!({ cell: cell("k"), verdict: "ok", comment: "" }, ctx);
    await reviewSource.addReviewLinks!(p1.id, [{ label: "#1", url: "https://example.invalid/1" }], ctx);
    await reviewSource.addReviewLinks!(p1.id, [{ label: "#2", url: "https://example.invalid/2" }], ctx);
    const list = await reviewSource.listReviews!(cell("k"), ctx);
    expect(list.find((p) => p.id === p2.id)?.links).toBeUndefined();
    expect(list.find((p) => p.id === p1.id)?.links).toEqual([
      { label: "#1", url: "https://example.invalid/1" },
      { label: "#2", url: "https://example.invalid/2" },
    ]);
    await expect(reviewSource.addReviewLinks!("nope", [{ label: "x", url: "y" }], ctx)).rejects.toThrow("nope");
  });

  it("save は分かるエラー。空なら何もしない", async () => {
    const { ctx } = makeCtx(newDb());
    expect(await reviewSource.save([], ctx)).toEqual([]);
    await expect(reviewSource.save([{ ...cell("k"), value: "ok" }], ctx)).rejects.toThrow("postReview");
  });

  it("options.namespace で置き場所を分け、キーの変更に追従する", async () => {
    const db = newDb();
    const { ctx } = makeCtx(db, { namespace: "rv" });
    const p = await reviewSource.postReview!({ cell: cell("old"), verdict: "ok", comment: "" }, ctx);
    await reviewSource.addReviewLinks!(p.id, [{ label: "L", url: "u" }], ctx);
    expect(await db.log("rv").list()).toHaveLength(1);
    expect(await db.log("rv.links").list()).toHaveLength(1);
    expect(await reviewSource.load([cell("old")], makeCtx(db).ctx)).toEqual([]);

    await reviewSource.onEntriesChanged!([{ type: "rename", key: "old", newKey: "new" }, { type: "remove", key: "x" }], resource, ctx);
    expect(await reviewSource.load([cell("old")], ctx)).toEqual([]);
    expect((await reviewSource.load([cell("new")], ctx))[0]).toMatchObject({ entryKey: "new", value: "ok" });
    const [moved] = await reviewSource.listReviews!(cell("new"), ctx);
    expect(moved?.links).toEqual([{ label: "L", url: "u" }]);
  });
});
