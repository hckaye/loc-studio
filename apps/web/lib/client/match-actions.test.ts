import { describe, expect, it, vi } from "vitest";
import type { JobInfo } from "@loc-studio/server";
import { RpcError } from "@/lib/client/api";
import { makeInfo } from "@/test/fixtures";
import { matchChoices, runOnMatches, type MatchChoice, type MatchRunState } from "./match-actions";

/* 条件に合う行へのアクション: 選択肢の作り方と、リソースを順に回す処理。API はモック（プロセスの外との境目）。 */

const job = (over: Partial<JobInfo>): JobInfo => ({ id: "j1", kind: "action", label: "x", status: "done", total: 30, done: 30, failed: 0, skipped: 0, startedBy: "tester", startedAt: 0, ...over }) as JobInfo;

function fakeApi() {
  return {
    runAction: vi.fn(async (_p: unknown) => ({ patched: 1, matched: 1 }) as { patched: number; matched?: number; jobId?: string; message?: string; errors?: string[] }),
    job: vi.fn(async (_p: { id: string }) => job({})),
    cancelJob: vi.fn(async (_p: { id: string }) => job({ status: "cancelled" })),
  };
}

const FILTER = { where: "status@en = todo", languages: ["ja", "en"] };
const TARGETS = [
  { resourceId: "a.csv", path: "text/a.csv" },
  { resourceId: "b.csv", path: "text/b.csv" },
];

describe("選択肢", () => {
  it("cell のアクションは、列（columns。なければ本文）と表示中の言語の組ごと。row / selection は 1 つ。file / column は出さない", () => {
    const info = makeInfo({
      actions: [
        { id: "ticket", label: "チケット", target: "cell" },
        { id: "mark", label: "完了にする", target: "cell", columns: ["status"], languages: ["en"] },
        { id: "memo", label: "メモを消す", target: "cell", columns: ["note"] },
        { id: "row", label: "行を送る", target: "row" },
        { id: "rowEn", label: "訳を依頼", target: "row", languages: ["en", "ko"] },
        { id: "sel", label: "まとめて送る", target: "selection" },
        { id: "file", label: "書き出し", target: "file" },
        { id: "col", label: "一括入力", target: "column", columns: ["status"] },
      ],
    });
    expect(matchChoices(info, ["ja", "en"]).map(({ action, id: _id, ...rest }) => ({ actionId: action.id, ...rest }))).toEqual([
      { actionId: "ticket", cellId: "text@ja", language: "ja", label: "チケット（日本語 / 本文）" },
      { actionId: "ticket", cellId: "text@en", language: "en", label: "チケット（英語 / 本文）" },
      { actionId: "mark", cellId: "status@en", language: "en", label: "完了にする（英語 / 状態）" },
      { actionId: "memo", cellId: "note", label: "メモを消す（メモ）" },
      { actionId: "row", label: "行を送る" },
      { actionId: "rowEn", language: "en", label: "訳を依頼（英語）" },
      { actionId: "sel", label: "まとめて送る" },
    ]);
    // 表示していない言語と、その言語に当てはまらない列（逆翻訳は en だけ）は出さない。
    const back = makeInfo({ actions: [{ id: "redo", label: "やり直す", target: "cell", columns: ["back"] }] });
    expect(matchChoices(back, ["ja"])).toEqual([]);
    expect(matchChoices(back, ["ja", "en"]).map((c) => c.cellId)).toEqual(["back@en"]);
    expect(new Set(matchChoices(info, ["ja", "en"]).map((c) => c.id)).size).toBe(7);
  });
});

describe("実行", () => {
  const choice: MatchChoice = { id: "x", action: { id: "mark", label: "完了にする", target: "cell" }, cellId: "status@en", language: "en", label: "完了にする（英語 / 状態）" };

  it("リソースを順に回し、条件（filter）とセルを渡して、合った行と反映の数を足し上げる", async () => {
    const api = fakeApi();
    api.runAction.mockResolvedValueOnce({ patched: 2, matched: 3, message: "2 件を変えました" }).mockResolvedValueOnce({ patched: 0, matched: 1, errors: ["KEY_9: 変えられません"] });
    const progress: MatchRunState[] = [];
    const r = await runOnMatches(api, choice, FILTER, TARGETS, { onProgress: (s) => progress.push(s) });
    expect(api.runAction.mock.calls.map((c) => c[0])).toEqual([
      { actionId: "mark", resourceId: "a.csv", filter: FILTER, cellId: "status@en", language: "en" },
      { actionId: "mark", resourceId: "b.csv", filter: FILTER, cellId: "status@en", language: "en" },
    ]);
    expect(r).toEqual({ done: 2, total: 2, rows: 4, patched: 2, jobRows: 0, errors: ["text/b.csv: KEY_9: 変えられません"], messages: ["text/a.csv: 2 件を変えました"], stopped: false });
    expect(progress.map((s) => s.done)).toEqual([0, 1, 2, 2]);
    expect(api.job).not.toHaveBeenCalled();
  });

  it("セルも言語もない選択肢（row / selection）では、cellId と language を渡さない", async () => {
    const api = fakeApi();
    await runOnMatches(api, { id: "r", action: { id: "row", label: "行", target: "row" }, label: "行" }, FILTER, [TARGETS[0]!]);
    expect(api.runAction.mock.calls[0]![0]).toEqual({ actionId: "row", resourceId: "a.csv", filter: FILTER });
  });

  it("ジョブになったリソースは、終わるのを待ってから次に進む。ジョブの失敗は、リソースの名前を付けて残す", async () => {
    const api = fakeApi();
    const order: string[] = [];
    api.runAction.mockImplementation(async (p) => {
      const resourceId = (p as { resourceId: string }).resourceId;
      order.push(`run ${resourceId}`);
      return resourceId === "a.csv" ? { patched: 0, matched: 30, jobId: "j1" } : { patched: 1, matched: 1 };
    });
    let polls = 0;
    api.job.mockImplementation(async () => {
      order.push("job");
      return ++polls < 3 ? job({ status: "running", done: 10 }) : job({ status: "done", done: 28, failed: 2, error: "K3: 失敗 / K7: 失敗" });
    });
    const onJob = vi.fn();
    const r = await runOnMatches(api, choice, FILTER, TARGETS, { pollMs: 0, onJob });
    expect(order).toEqual(["run a.csv", "job", "job", "job", "run b.csv"]);
    expect(onJob).toHaveBeenCalledWith("j1");
    expect(r).toMatchObject({ done: 2, rows: 31, patched: 1, jobRows: 28, errors: ["text/a.csv: K3: 失敗 / K7: 失敗"], stopped: false });
  });

  it("1 つのリソースで失敗しても、ほかのリソースは続ける", async () => {
    const api = fakeApi();
    api.runAction.mockRejectedValueOnce(new RpcError("runAction", "failed", "アクション「完了にする」が失敗しました")).mockResolvedValueOnce({ patched: 1, matched: 1 });
    const r = await runOnMatches(api, choice, FILTER, TARGETS);
    expect(r).toMatchObject({ done: 2, rows: 1, patched: 1, errors: ["text/a.csv: アクション「完了にする」が失敗しました"] });
  });

  it("ジョブの上限で断られたら、待ってやり直す。決めた回数を超えたら、そのリソースの失敗にする", async () => {
    const api = fakeApi();
    const throttled = new RpcError("runAction", "throttled", "同時に動かせるジョブの上限です");
    api.runAction.mockRejectedValueOnce(throttled).mockResolvedValueOnce({ patched: 1, matched: 1 });
    const ok = await runOnMatches(api, choice, FILTER, [TARGETS[0]!], { throttleWaitMs: 0, throttleRetries: 1, stopped: () => false });
    expect(api.runAction).toHaveBeenCalledTimes(2);
    expect(ok).toMatchObject({ patched: 1, errors: [] });
    const api2 = fakeApi();
    api2.runAction.mockRejectedValue(throttled);
    const ng = await runOnMatches(api2, choice, FILTER, [TARGETS[0]!], { throttleWaitMs: 0, throttleRetries: 0 });
    expect(api2.runAction).toHaveBeenCalledTimes(1);
    expect(ng.errors).toEqual(["text/a.csv: 同時に動かせるジョブの上限です"]);
  });

  it("中止したら、次のリソースには進まない。動いているジョブは取り消す", async () => {
    const api = fakeApi();
    let stop = false;
    api.runAction.mockResolvedValue({ patched: 0, matched: 30, jobId: "j1" });
    let cancelled = false;
    api.cancelJob.mockImplementation(async () => ((cancelled = true), job({ status: "running" })));
    api.job.mockImplementation(async () => {
      // 1 回目の問い合わせのあとで、利用者が中止を押す。
      const j = cancelled ? job({ status: "cancelled", done: 12 }) : job({ status: "running", done: 5 });
      stop = true;
      return j;
    });
    const r = await runOnMatches(api, choice, FILTER, TARGETS, { pollMs: 0, stopped: () => stop });
    expect(api.cancelJob).toHaveBeenCalledTimes(1);
    expect(api.cancelJob).toHaveBeenCalledWith({ id: "j1" });
    expect(api.runAction).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ done: 1, total: 2, jobRows: 12, stopped: true });
  });
});
