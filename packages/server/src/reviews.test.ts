import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionContext, Plugin } from "@loc-studio/sdk";
import type { Workspace } from "./api-types.js";
import { textHash } from "./hash.js";
import { CHAPTER, makeTestProject } from "./testing.js";
import type { TestProject } from "./testing.js";

const calls: ActionContext[] = [];
let failBroken = true;
const reviewPlugin: Plugin = {
  name: "fake-review-targets",
  actions: [
    {
      id: "fake.ticket",
      label: "チケット",
      target: "review",
      async run(ctx) {
        calls.push(ctx);
        return { links: [{ label: "TICKET-1", url: `https://tickets.example/${ctx.review!.id}` }] };
      },
    },
    {
      id: "fake.broken",
      label: "壊れたレビュー先",
      target: "review",
      async run() {
        if (failBroken) throw new Error("接続できません");
        return { links: [{ label: "OK", url: "https://ok.example/" }] };
      },
    },
  ],
};

let tp: TestProject;
let ws: Workspace;
beforeEach(async () => {
  calls.length = 0;
  failBroken = true;
  tp = await makeTestProject({ plugins: [reviewPlugin] });
  await tp.patchConfig({ review: { targets: ["fake.ticket", "fake.broken"] } });
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

const base = { resourceId: CHAPTER, key: "CH01_INTRO_002", cellId: "reviewStatus@ko" };

describe("postReview", () => {
  it("判定を投稿し、対象の本文の版・ユーザー名・履歴を残す", async () => {
    const r = await ws.postReview({ ...base, verdict: "doing", comment: "確認中" });
    expect(r).toMatchObject({ verdict: "doing", comment: "確認中", userName: "tester", stale: false, basisHash: textHash("여기는…… 어디지?") });
    expect(r.links).toBeUndefined();
    const d = await ws.rowDetail({ resourceId: CHAPTER, key: "CH01_INTRO_002" });
    expect(d.row.cells["reviewStatus@ko"]).toMatchObject({ value: "doing", updatedBy: "tester" });
    const h = await ws.history({ ...base });
    expect(h[0]).toMatchObject({ cellId: "reviewStatus@ko", oldValue: "none", newValue: "doing", cause: "review", causeRef: r.id });
    expect((await ws.info()).reviewTargets.map((t) => t.id)).toEqual(["fake.ticket", "fake.broken"]);
  });

  it("requireComment の判定でコメントが空なら invalid、選択肢にない判定も invalid", async () => {
    await expect(ws.postReview({ ...base, verdict: "back", comment: "  " })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.postReview({ ...base, verdict: "maybe", comment: "" })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.postReview({ ...base, cellId: "textStatus@ko", verdict: "ok", comment: "" })).rejects.toMatchObject({ code: "invalid" });
    const r = await ws.postReview({ ...base, verdict: "back", comment: "訳を直して" });
    expect(r.verdict).toBe("back");
  });

  it("対象の本文が変わると stale（ドラフトも含む）", async () => {
    await ws.postReview({ ...base, verdict: "ok", comment: "" });
    expect((await ws.reviews(base))[0]!.stale).toBe(false);
    await ws.setText({ resourceId: CHAPTER, key: base.key, language: "ko", value: "여기가 어디지?" });
    const list = await ws.reviews(base);
    expect(list[0]!.stale).toBe(true);
    expect((await ws.rowDetail({ resourceId: CHAPTER, key: base.key })).row.cells["reviewStatus@ko"]!.stale).toBe(true);
    // 投稿した時点の本文を引ける。
    expect(await ws.textVersion({ hash: list[0]!.basisHash! })).toEqual({ text: "여기는…… 어디지?" });
    // 新しく投稿すれば stale でなくなる。
    await ws.postReview({ ...base, verdict: "ok", comment: "再確認" });
    const again = await ws.reviews(base);
    expect(again.map((p) => p.stale)).toEqual([false, true]);
  });

  it("forwardOnPost が ask（既定）なら forward: true のときだけ転載する。失敗しても投稿は成功する", async () => {
    const r1 = await ws.postReview({ ...base, verdict: "doing", comment: "" });
    expect(calls).toHaveLength(0);
    expect(r1.links).toBeUndefined();

    const r2 = await ws.postReview({ ...base, verdict: "back", comment: "違う", forward: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.review!.id).toBe(r2.id);
    expect(calls[0]!.language!.id).toBe("ko");
    expect(calls[0]!.row!.text("ko")).toBe("여기는…… 어디지?");
    expect(r2.links).toEqual([{ label: "TICKET-1", url: `https://tickets.example/${r2.id}` }]);
    expect(r2.warnings).toHaveLength(1);
    expect(r2.warnings![0]).toContain("接続できません");
    const listed = await ws.reviews(base);
    expect(listed[0]!.links).toEqual(r2.links);
    expect((await ws.info()).warnings.join("\n")).toContain("接続できません");
  });

  it("forwardOnPost: always なら毎回転載する", async () => {
    await ws.setLocalSetting({ key: "review.forwardOnPost", value: "always" });
    const r = await ws.postReview({ ...base, verdict: "doing", comment: "" });
    expect(calls).toHaveLength(1);
    expect(r.links).toHaveLength(1);
  });

  it("forwardOnPost: never なら forward: true でも転載しない", async () => {
    await ws.setLocalSetting({ key: "review.forwardOnPost", value: "never" });
    await ws.postReview({ ...base, verdict: "doing", comment: "", forward: true });
    expect(calls).toHaveLength(0);
  });
});

describe("forwardReview", () => {
  it("手動で転載する。同じアクションへの 2 回目は何もしない", async () => {
    const post = await ws.postReview({ ...base, verdict: "back", comment: "直して" });
    const r1 = await ws.forwardReview({ ...base, reviewId: post.id, actionId: "fake.ticket" });
    expect(r1.links).toHaveLength(1);
    const r2 = await ws.forwardReview({ ...base, reviewId: post.id, actionId: "fake.ticket" });
    expect(r2.links).toHaveLength(1);
    expect(calls).toHaveLength(1);
    // 失敗したレビュー先は failed、あとで直れば転載できる。
    await expect(ws.forwardReview({ ...base, reviewId: post.id, actionId: "fake.broken" })).rejects.toMatchObject({ code: "failed" });
    failBroken = false;
    const r3 = await ws.forwardReview({ ...base, reviewId: post.id, actionId: "fake.broken" });
    expect(r3.links).toHaveLength(2);
  });

  it("知らない投稿・アクションは not-found", async () => {
    const post = await ws.postReview({ ...base, verdict: "doing", comment: "" });
    await expect(ws.forwardReview({ ...base, reviewId: "nope", actionId: "fake.ticket" })).rejects.toMatchObject({ code: "not-found" });
    await expect(ws.forwardReview({ ...base, reviewId: post.id, actionId: "nope" })).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("reviews / history", () => {
  it("新しい順に並べ、履歴の limit を守る", async () => {
    await ws.postReview({ ...base, verdict: "doing", comment: "1" });
    await ws.postReview({ ...base, verdict: "ok", comment: "2" });
    await ws.setCell({ resourceId: CHAPTER, key: base.key, cellId: "textStatus@ko", value: "done" });
    const list = await ws.reviews(base);
    expect(list.map((p) => p.comment)).toEqual(["2", "1"]);
    const h = await ws.history({ resourceId: CHAPTER, key: base.key });
    expect(h.map((x) => x.cellId)).toEqual(["textStatus@ko", "reviewStatus@ko", "reviewStatus@ko"]);
    expect(await ws.history({ resourceId: CHAPTER, key: base.key, limit: 1 })).toHaveLength(1);
  });
});
