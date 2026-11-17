import { describe, expect, it, vi } from "vitest";
import type { JobInfo } from "@loc-studio/server";
import { RpcError } from "@/lib/client/api";
import { makeInfo } from "@/test/fixtures";
import { generateChoices, isGenerateChoice, matchChoices, runOnMatches, supportsBatch, type GenerateChoice, type MatchChoice, type MatchRunState } from "./match-actions";

/* 条件に合う行へのアクション: 選択肢の作り方と、リソースを順に回す処理。API はモック（プロセスの外との境目）。 */

const job = (over: Partial<JobInfo>): JobInfo => ({ id: "j1", kind: "action", label: "x", status: "done", total: 30, done: 30, failed: 0, skipped: 0, startedBy: "tester", startedAt: 0, ...over }) as JobInfo;

function fakeApi() {
  return {
    runAction: vi.fn(async (_p: unknown) => ({ patched: 1, matched: 1 }) as { patched: number; matched?: number; jobId?: string; message?: string; errors?: string[] }),
    generate: vi.fn(async (_p: unknown) => ({ total: 1, cached: 0, toRun: 1, batchSize: 1 }) as { total: number; cached: number; toRun: number; batchSize: number; jobId?: string }),
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

  it("生成の選択肢は、生成列ごと、表示中の言語のうち、その列のある言語ごとに 1 つ（行に 1 つの生成列は 1 つ）", () => {
    const base = makeInfo();
    const info = makeInfo({
      columns: [
        ...base.columns,
        { id: "check", kind: "generated", scope: "language", label: "翻訳の評価", generator: "eval" },
        { id: "summary", kind: "generated", scope: "entry", label: "要約", generator: "sum" },
      ],
    });
    expect(generateChoices(info, ["ja", "en"]).map(({ column, id: _id, ...rest }) => ({ columnId: column.id, ...rest }))).toEqual([
      // 逆翻訳の列は、英語だけにある。
      { columnId: "back", cellId: "back@en", language: "en", label: "逆翻訳 を生成（英語）" },
      { columnId: "check", cellId: "check@ja", language: "ja", label: "翻訳の評価 を生成（日本語）" },
      { columnId: "check", cellId: "check@en", language: "en", label: "翻訳の評価 を生成（英語）" },
      { columnId: "summary", cellId: "summary", label: "要約 を生成" },
    ]);
    // 表示していない言語の列は出さない。生成列がなければ、選択肢もない。
    expect(generateChoices(info, ["ja"]).map((c) => c.cellId)).toEqual(["check@ja", "summary"]);
    expect(generateChoices(makeInfo({ columns: base.columns.filter((c) => c.kind !== "generated") }), ["ja", "en"])).toEqual([]);
  });

  it("まとめる数を指定できるのは、生成と、行をまとめて受け取れるアクション（batch）だけ", () => {
    const [gen] = generateChoices(makeInfo(), ["en"]);
    expect(isGenerateChoice(gen!)).toBe(true);
    expect(supportsBatch(gen!)).toBe(true);
    const plain: MatchChoice = { id: "p", action: { id: "p", label: "P", target: "row" }, label: "P" };
    const batch: MatchChoice = { id: "b", action: { id: "b", label: "B", target: "row", batch: true }, label: "B" };
    expect([isGenerateChoice(plain), supportsBatch(plain), supportsBatch(batch)]).toEqual([false, false, true]);
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
    expect(r).toEqual({ done: 2, total: 2, rows: 4, patched: 2, jobRows: 0, cached: 0, errors: ["text/b.csv: KEY_9: 変えられません"], messages: ["text/a.csv: 2 件を変えました"], stopped: false });
    expect(api.generate).not.toHaveBeenCalled();
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

  it("batchSize を渡すと、runAction に付けて送る（渡さなければ、付けない）", async () => {
    const api = fakeApi();
    await runOnMatches(api, choice, FILTER, [TARGETS[0]!], { batchSize: 25 });
    expect(api.runAction.mock.calls[0]![0]).toEqual({ actionId: "mark", resourceId: "a.csv", filter: FILTER, cellId: "status@en", language: "en", batchSize: 25 });
  });

  it("生成の選択肢では、リソースごとに、条件と言語を渡して generate を呼び、対象、キャッシュ済み、生成した数を足し上げる", async () => {
    const api = fakeApi();
    const [gen] = generateChoices(makeInfo(), ["en"]) as [GenerateChoice];
    api.generate.mockResolvedValueOnce({ total: 6, cached: 2, toRun: 4, batchSize: 5, jobId: "g1" }).mockResolvedValueOnce({ total: 3, cached: 3, toRun: 0, batchSize: 5 });
    api.job.mockResolvedValue(job({ id: "g1", kind: "generate", status: "done", total: 4, done: 3, failed: 1, error: '生成器 "llm" が失敗しました' }));
    const onJob = vi.fn();
    const r = await runOnMatches(api, gen, FILTER, TARGETS, { pollMs: 0, onJob, batchSize: 5 });
    expect(api.generate.mock.calls.map((c) => c[0])).toEqual([
      { columnId: "back", scope: "resource", resourceId: "a.csv", filter: FILTER, languages: ["en"], batchSize: 5 },
      { columnId: "back", scope: "resource", resourceId: "b.csv", filter: FILTER, languages: ["en"], batchSize: 5 },
    ]);
    expect(api.runAction).not.toHaveBeenCalled();
    expect(onJob).toHaveBeenCalledWith("g1");
    expect(r).toEqual({ done: 2, total: 2, rows: 9, patched: 0, jobRows: 3, cached: 5, errors: ['text/a.csv: 生成器 "llm" が失敗しました'], messages: [], stopped: false });
  });

  it("行に 1 つの生成列では、言語を渡さない。batchSize を渡さなければ、付けない（生成器の既定で動く）", async () => {
    const api = fakeApi();
    const choiceEntry: GenerateChoice = { id: "g", column: { id: "summary", kind: "generated", scope: "entry" }, cellId: "summary", label: "要約 を生成" };
    await runOnMatches(api, choiceEntry, FILTER, [TARGETS[0]!]);
    expect(api.generate.mock.calls[0]![0]).toEqual({ columnId: "summary", scope: "resource", resourceId: "a.csv", filter: FILTER });
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
