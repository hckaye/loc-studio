/**
 * 同梱の LLM のプラグイン（機械翻訳の列 llm.translation、翻訳の評価の列 llm.evaluation）を、サービス層から動かす。
 * 外部の HTTP だけを、手元に立てた OpenAI 互換のサーバー（chat/completions）に置き換える。生成、キャッシュ、
 * 「変更あり」の表示、条件に合う行だけの生成、バッチサイズ、プラグインの設定は、本物を通す。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerateParams, GenerateResult, JobInfo, Workspace } from "./api-types.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

interface ChatRequest {
  system: string;
  user: string;
  authorization: string | undefined;
}

/** 手元の OpenAI 互換のサーバー。受けた要求を覚え、reply が返した文字列を返事にする。 */
class MockLlm {
  readonly requests: ChatRequest[] = [];
  /** 返事を作る関数（テストごとに差し替えられる）。 */
  reply: (req: ChatRequest) => string = defaultReply;
  private server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      const request: ChatRequest = { system: body.messages[0]?.content ?? "", user: body.messages[1]?.content ?? "", authorization: req.headers.authorization };
      this.requests.push(request);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "mock-model", choices: [{ message: { content: this.reply(request) } }] }));
    });
  });
  url = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** 訳文から決める、テスト用の判定。 */
const verdictOf = (translation: string): string => (translation.includes("취소") ? "NG" : translation.includes("?") ? "WARNING" : "OK");

/** 翻訳は「訳:<本文>」、評価は訳文から決めた判定を返す。まとめて送られたら、id ごとに返す。 */
function defaultReply(req: ChatRequest): string {
  const evaluating = req.system.includes("verdict");
  if (evaluating) {
    const one = (pair: { source: string; translation: string }) => ({ verdict: verdictOf(pair.translation), reason: `理由（${pair.source}）` });
    const parsed = JSON.parse(req.user) as { id: number; source: string; translation: string }[] | { source: string; translation: string };
    return JSON.stringify(Array.isArray(parsed) ? parsed.map((p) => ({ id: p.id, ...one(p) })) : one(parsed));
  }
  if (req.system.includes('"translation"')) {
    const items = JSON.parse(req.user) as { id: number; text: string }[];
    return JSON.stringify(items.map((item) => ({ id: item.id, translation: `訳:${item.text}` })));
  }
  return `訳:${req.user}`;
}

let tp: TestProject;
let llm: MockLlm;
beforeEach(async () => {
  llm = new MockLlm();
  await llm.start();
  tp = await makeTestProject();
  await tp.patchConfig({
    generators: {
      mt: { use: "llm.translate", options: { endpoint: llm.url, model: "test-model" } },
      check: { use: "llm.evaluate", options: { endpoint: llm.url, model: "test-model" } },
    },
    columns: [
      { use: "builtin.key", id: "key" },
      { use: "builtin.text", id: "text" },
      { use: "llm.translation", id: "mt", generator: "mt", languages: ["JaEnglish", "ko"] },
      { use: "llm.evaluation", id: "mtCheck", generator: "check", languages: ["JaEnglish", "ko"] },
    ],
  });
});
afterEach(async () => {
  await tp.cleanup();
  await llm.stop();
});

/** 生成を始め、ジョブがあれば終わるまで待つ。 */
async function generate(ws: Workspace, params: GenerateParams): Promise<{ result: GenerateResult; job?: JobInfo }> {
  const result = await ws.generate(params);
  return result.jobId ? { result, job: await ws.waitForJob(result.jobId) } : { result };
}

/** リソースの行の、セルの値（キー → 値）。 */
async function cellsOf(ws: Workspace, resourceId: string, cellId: string, languages: string[]) {
  const r = await ws.rows({ resourceId, languages, offset: 0, limit: 100 });
  return Object.fromEntries(r.rows.map((row) => [row.key, row.cells[cellId]]));
}

const SETTINGS_FILE = "loc-studio-plugin-settings/%40loc-studio%2Fplugin-llm.json";

describe("機械翻訳の列（llm.translation）", () => {
  it("言語の本文を 1 件ずつ送って翻訳し、列に出す。結果は DB に残り、同じ本文はもう送らない", async () => {
    const ws = await tp.open();
    const info = await ws.info();
    expect(info.warnings.filter((w) => w.includes("mt") || w.includes("llm"))).toEqual([]);
    expect(info.columns.find((c) => c.id === "mt")).toMatchObject({ kind: "generated", scope: "language", label: "機械翻訳", generator: "mt", languages: ["JaEnglish", "ko"] });

    const first = await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["JaEnglish"] });
    expect(first.result).toMatchObject({ total: 4, cached: 0, toRun: 4, batchSize: 1 });
    expect(first.job).toMatchObject({ status: "done", total: 4, done: 4, failed: 0 });
    // 1 件ずつ、本文をそのまま送る。
    expect(llm.requests.map((r) => r.user).sort()).toEqual(["Cancel", "Gold: {gold} G", "OK", "Save your progress?"]);
    expect(llm.requests[0]?.system).toContain("ユーザーが送る文章を日本語に翻訳してください。");
    expect(llm.requests[0]?.authorization).toBeUndefined();

    const cells = await cellsOf(ws, UI, "mt@JaEnglish", ["JaEnglish"]);
    expect(cells["UI_OK"]).toEqual({ value: "訳:OK", generated: "fresh" });
    expect(cells["UI_GOLD"]).toEqual({ value: "訳:Gold: {gold} G", generated: "fresh" });
    // 生成していない言語は、未生成。
    expect((await cellsOf(ws, UI, "mt@ko", ["ko"]))["UI_OK"]).toEqual({ value: undefined, generated: "missing" });

    // もう一度生成しても、キャッシュにあるので送らない。
    const again = await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["JaEnglish"] });
    expect(again.result).toMatchObject({ total: 4, cached: 4, toRun: 0 });
    expect(again.result.jobId).toBeUndefined();
    expect(llm.requests).toHaveLength(4);

    // 開き直しても、DB のキャッシュから値が出る。
    await ws.close();
    const reopened = await tp.open();
    expect((await cellsOf(reopened, UI, "mt@JaEnglish", ["JaEnglish"]))["UI_OK"]).toEqual({ value: "訳:OK", generated: "fresh" });
    expect(llm.requests).toHaveLength(4);
  });

  it("本文が変わると、結果は「変更あり」になり（値は残る）、生成し直すと最新になる", async () => {
    const ws = await tp.open();
    await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["JaEnglish"] });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "JaEnglish", value: "Okay" });

    const cells = await cellsOf(ws, UI, "mt@JaEnglish", ["JaEnglish"]);
    expect(cells["UI_OK"]).toEqual({ value: "訳:OK", generated: "stale", stale: true });
    expect(cells["UI_CANCEL"]).toEqual({ value: "訳:Cancel", generated: "fresh" });
    // 「要確認」の絞り込みにも掛かる。
    const stale = await ws.query({ where: "stale@JaEnglish", languages: ["JaEnglish"], resourceIds: [UI], limit: 10 });
    expect(stale.rows.map((r) => r.key)).toEqual(["UI_OK"]);

    const redo = await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["JaEnglish"] });
    expect(redo.result).toMatchObject({ total: 4, cached: 3, toRun: 1 });
    expect(llm.requests[llm.requests.length - 1]?.user).toBe("Okay");
    expect((await cellsOf(ws, UI, "mt@JaEnglish", ["JaEnglish"]))["UI_OK"]).toEqual({ value: "訳:Okay", generated: "fresh" });
  });

  it("バッチサイズを指定すると、その数ずつまとめて 1 回の要求で送る", async () => {
    const ws = await tp.open();
    const keys = (await ws.rows({ resourceId: CHAPTER, languages: ["JaEnglish"], offset: 0, limit: 100 })).rows.map((r) => r.key);
    expect(keys).toHaveLength(8);

    const dry = await ws.generate({ columnId: "mt", scope: "resource", resourceId: CHAPTER, languages: ["JaEnglish"], batchSize: 3, dryRun: true });
    expect(dry).toEqual({ total: 8, cached: 0, toRun: 8, batchSize: 3 });
    expect(llm.requests).toHaveLength(0);

    const run = await generate(ws, { columnId: "mt", scope: "resource", resourceId: CHAPTER, languages: ["JaEnglish"], batchSize: 3 });
    expect(run.result).toMatchObject({ total: 8, toRun: 8, batchSize: 3 });
    expect(run.job).toMatchObject({ status: "done", done: 8, failed: 0 });
    // 8 件を 3 件ずつ: 3、3、2 の 3 回。
    const sizes = llm.requests.map((r) => (JSON.parse(r.user) as unknown[]).length).sort();
    expect(sizes).toEqual([2, 3, 3]);
    expect(llm.requests.every((r) => r.system.includes('[{"id": 1, "translation": "..."}, ...]'))).toBe(true);

    // まとめて送っても、行ごとに自分の本文の翻訳が入る。
    const rows = await ws.rows({ resourceId: CHAPTER, languages: ["JaEnglish"], offset: 0, limit: 100 });
    for (const row of rows.rows) {
      expect(row.cells["mt@JaEnglish"]).toEqual({ value: `訳:${String(row.cells["text@JaEnglish"]?.value)}`, generated: "fresh" });
    }
  });

  it("バッチサイズが 1 以上 1000 以下の整数でなければ断り、何も送らない", async () => {
    const ws = await tp.open();
    for (const batchSize of [0, -1, 1.5, 1001, "3"]) {
      await expect(ws.generate({ columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"], batchSize: batchSize as number })).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining("batchSize は 1 以上 1000 以下の整数で指定してください"),
      });
    }
    expect(llm.requests).toHaveLength(0);
    expect((await ws.jobs()).length).toBe(0);
  });

  it("まとめて送った返事に足りない行があると、そのまとまりは失敗になり、値は入らない", async () => {
    llm.reply = (req) => {
      const items = JSON.parse(req.user) as { id: number; text: string }[];
      // 最後の 1 件を返さない。
      return JSON.stringify(items.slice(0, -1).map((item) => ({ id: item.id, translation: `訳:${item.text}` })));
    };
    const ws = await tp.open();
    const run = await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"], batchSize: 4 });
    expect(run.job).toMatchObject({ status: "failed", done: 0, failed: 4 });
    expect(run.job?.error).toContain('生成器 "llm.translate" が失敗しました（3 回試行）');
    expect(run.job?.error).toContain("id 4 の結果がありません");
    // やり直しを含めて 3 回送っている。
    expect(llm.requests).toHaveLength(3);
    expect((await cellsOf(ws, UI, "mt@ko", ["ko"]))["UI_OK"]).toEqual({ value: undefined, generated: "missing" });
  });

  it("接続先（endpoint）を設定していない列は、直し方の分かるエラーで失敗する", async () => {
    await tp.patchConfig({
      generators: null,
      columns: [
        { use: "builtin.key", id: "key" },
        { use: "builtin.text", id: "text" },
        { use: "llm.translation", id: "mt", languages: ["ko"] },
      ],
    });
    const ws = await tp.open();
    const run = await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"] });
    expect(run.job).toMatchObject({ status: "failed", done: 0, failed: 4 });
    expect(run.job?.error).toContain('llm.translate: オプション "endpoint" が設定されていません。');
    expect(run.job?.error).toContain("プロジェクト設定の generators");
    expect(llm.requests).toHaveLength(0);
  });
});

describe("条件に合う行だけを生成する（filter）", () => {
  it("リソースの中の、条件に合う行だけを生成する", async () => {
    const ws = await tp.open();
    const filter = { where: 'key ~ "GOLD" or key = UI_OK', languages: ["JaEnglish"] };
    const dry = await ws.generate({ columnId: "mt", scope: "resource", resourceId: UI, languages: ["JaEnglish"], filter, dryRun: true });
    expect(dry).toMatchObject({ total: 2, cached: 0, toRun: 2 });
    const run = await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["JaEnglish"], filter });
    expect(run.job).toMatchObject({ status: "done", total: 2, done: 2 });
    expect(llm.requests.map((r) => r.user).sort()).toEqual(["Gold: {gold} G", "OK"]);
    const cells = await cellsOf(ws, UI, "mt@JaEnglish", ["JaEnglish"]);
    expect(Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, cell?.generated]))).toEqual({
      UI_OK: "fresh",
      UI_CANCEL: "missing",
      UI_SAVE_CONFIRM: "missing",
      UI_GOLD: "fresh",
    });
  });

  it("プロジェクト全体でも、リソースをまたいで、条件に合う行だけを生成する", async () => {
    const ws = await tp.open();
    const filter = { where: 'key ~ "UI_C" or key = CH01_INTRO_001', languages: ["ko"] };
    const run = await generate(ws, { columnId: "mt", scope: "project", languages: ["ko"], filter });
    expect(run.result).toMatchObject({ total: 2, cached: 0, toRun: 2 });
    expect(llm.requests.map((r) => r.user).sort()).toEqual(["눈을 떴구나, {player}.", "취소"]);
    expect((await cellsOf(ws, CHAPTER, "mt@ko", ["ko"]))["CH01_INTRO_001"]?.generated).toBe("fresh");
    expect((await cellsOf(ws, CHAPTER, "mt@ko", ["ko"]))["CH01_INTRO_002"]?.generated).toBe("missing");
    expect((await cellsOf(ws, UI, "mt@ko", ["ko"]))["UI_CANCEL"]?.generated).toBe("fresh");
    expect((await cellsOf(ws, UI, "mt@ko", ["ko"]))["UI_OK"]?.generated).toBe("missing");
  });

  it("絞り込みの切り替え（未生成の行だけなど）も、表と同じ条件で効く", async () => {
    const ws = await tp.open();
    await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"], filter: { where: "key = UI_OK", languages: ["ko"] } });
    // 機械翻訳がまだ空の行だけ。
    const rest = await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"], filter: { where: "mt@ko is empty", languages: ["ko"] } });
    expect(rest.result).toMatchObject({ total: 3, cached: 0, toRun: 3 });
    expect(llm.requests).toHaveLength(4);
  });

  it("条件に合う行がなければ、何も送らない", async () => {
    const ws = await tp.open();
    const run = await generate(ws, { columnId: "mt", scope: "project", languages: ["ko"], filter: { where: 'key = "NO_SUCH_KEY"', languages: ["ko"] } });
    expect(run.result).toMatchObject({ total: 0, cached: 0, toRun: 0 });
    expect(run.result.jobId).toBeUndefined();
    expect(llm.requests).toHaveLength(0);
  });

  it("行を名指しする範囲（cell / selection）と filter の併用、誤った条件式は断る", async () => {
    const ws = await tp.open();
    await expect(
      ws.generate({ columnId: "mt", scope: "selection", resourceId: UI, keys: ["UI_OK"], languages: ["ko"], filter: { where: "key = UI_OK", languages: ["ko"] } }),
    ).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("filter（条件に合う行）は、scope が resource か project のときに指定できます") });
    await expect(ws.generate({ columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"], filter: { where: "noSuchColumn = 1", languages: ["ko"] } })).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining('条件式の "noSuchColumn" に当たる列がありません'),
    });
    await expect(ws.generate({ columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"], filter: { where: "key = UI_OK" } as never })).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("languages は言語 ID の配列で指定してください"),
    });
    expect(llm.requests).toHaveLength(0);
  });
});

describe("翻訳の評価の列（llm.evaluation）", () => {
  it("原文と訳文を送り、判定（OK / WARNING / NG）を値に、理由をコメントに入れる", async () => {
    const ws = await tp.open();
    const info = await ws.info();
    expect(info.columns.find((c) => c.id === "mtCheck")).toMatchObject({
      kind: "generated",
      label: "翻訳の評価",
      generator: "check",
      type: { enum: [{ value: "OK", label: "OK", color: "green" }, { value: "WARNING", label: "WARNING", color: "amber" }, { value: "NG", label: "NG", color: "red" }] },
    });

    const run = await generate(ws, { columnId: "mtCheck", scope: "resource", resourceId: UI, languages: ["ko"] });
    expect(run.result).toMatchObject({ total: 4, cached: 0, toRun: 4, batchSize: 1 });
    expect(run.job).toMatchObject({ status: "done", done: 4, failed: 0 });
    // 基にする言語（ja）の本文を原文として、1 組ずつ送る。
    expect(llm.requests.map((r) => JSON.parse(r.user) as unknown)).toContainEqual({ source: "キャンセル", translation: "취소" });
    expect(llm.requests.every((r) => r.system.includes("ゲームのローカライズの品質を確かめるレビュアー"))).toBe(true);

    const cells = await cellsOf(ws, UI, "mtCheck@ko", ["ko"]);
    expect(cells).toEqual({
      UI_OK: { value: "OK", comment: "理由（決定）", generated: "fresh" },
      UI_CANCEL: { value: "NG", comment: "理由（キャンセル）", generated: "fresh" },
      UI_SAVE_CONFIRM: { value: "WARNING", comment: "理由（セーブしますか？）", generated: "fresh" },
      UI_GOLD: { value: "OK", comment: "理由（所持金：{gold} G）", generated: "fresh" },
    });

    // 判定で絞り込める（値、選択肢の並び順での大小）。
    const ng = await ws.query({ where: "mtCheck@ko = NG", languages: ["ko"], limit: 10 });
    expect(ng.rows.map((r) => r.key)).toEqual(["UI_CANCEL"]);
    const doubtful = await ws.query({ where: "mtCheck@ko >= WARNING", languages: ["ko"], limit: 10 });
    expect(doubtful.rows.map((r) => r.key)).toEqual(["UI_CANCEL", "UI_SAVE_CONFIRM"]);
    // 集計の区切りにも使える。
    const groups = await ws.query({ groupBy: ["mtCheck@ko"], languages: ["ko"], resourceIds: [UI] });
    expect(groups.groups?.map((g) => [g.values[0], g.rows])).toEqual([["OK", 2], ["WARNING", 1], ["NG", 1]]);
  });

  it("原文か訳文のどちらが変わっても、結果は「変更あり」になる", async () => {
    const ws = await tp.open();
    await generate(ws, { columnId: "mtCheck", scope: "resource", resourceId: UI, languages: ["ko"] });
    // 原文を変える。
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ja", value: "決定する" });
    // 訳文を変える。
    await ws.setText({ resourceId: UI, key: "UI_GOLD", language: "ko", value: "골드: {gold} G" });
    const cells = await cellsOf(ws, UI, "mtCheck@ko", ["ko"]);
    expect(cells["UI_OK"]).toEqual({ value: "OK", comment: "理由（決定）", generated: "stale", stale: true });
    expect(cells["UI_GOLD"]).toEqual({ value: "OK", comment: "理由（所持金：{gold} G）", generated: "stale", stale: true });
    expect(cells["UI_CANCEL"]).toEqual({ value: "NG", comment: "理由（キャンセル）", generated: "fresh" });

    const redo = await generate(ws, { columnId: "mtCheck", scope: "resource", resourceId: UI, languages: ["ko"] });
    expect(redo.result).toMatchObject({ total: 4, cached: 2, toRun: 2 });
    expect((await cellsOf(ws, UI, "mtCheck@ko", ["ko"]))["UI_OK"]).toEqual({ value: "OK", comment: "理由（決定する）", generated: "fresh" });
  });

  it("まとめて送っても、組ごとの判定が自分の行に入る", async () => {
    const ws = await tp.open();
    const run = await generate(ws, { columnId: "mtCheck", scope: "resource", resourceId: UI, languages: ["ko"], batchSize: 3 });
    expect(run.job).toMatchObject({ status: "done", done: 4 });
    // 4 組を 3 組ずつ: 3 組（配列）と、残りの 1 組（1 組のときの形）。
    const sizes = llm.requests.map((r) => {
      const parsed = JSON.parse(r.user) as unknown;
      return Array.isArray(parsed) ? parsed.length : 1;
    });
    expect(sizes.sort()).toEqual([1, 3]);
    const cells = await cellsOf(ws, UI, "mtCheck@ko", ["ko"]);
    expect(Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, cell?.value]))).toEqual({ UI_OK: "OK", UI_CANCEL: "NG", UI_SAVE_CONFIRM: "WARNING", UI_GOLD: "OK" });
  });
});

describe("プラグインの設定（プロンプト、訳し先、比べる原文）", () => {
  it("設定の一覧に、プロンプトなどの項目が、既定の値と一緒に出る", async () => {
    const ws = await tp.open();
    const list = await ws.pluginSettings();
    const llmSettings = list.find((p) => p.plugin === "@loc-studio/plugin-llm")!;
    expect(llmSettings.layer).toBe("builtin");
    expect(llmSettings.file).toBe(path.join(tp.root, ...SETTINGS_FILE.split("/")));
    expect(llmSettings.items.map((i) => [i.key, i.type, i.multiline === true, i.stored])).toEqual([
      ["translateTo", "string", false, false],
      ["translatePrompt", "string", true, false],
      ["evaluateSource", "string", false, false],
      ["evaluatePrompt", "string", true, false],
    ]);
    expect(llmSettings.items[0]?.value).toBe("日本語");
    expect(String(llmSettings.items[1]?.value)).toContain("ユーザーが送る文章を{to}に翻訳してください。");
    expect(llmSettings.items[2]?.value).toBeUndefined();
  });

  it("プロンプトと訳し先を変えると、次の生成からその値を送り、生成済みの結果は「変更あり」になる", async () => {
    const ws = await tp.open();
    await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"] });
    expect(llm.requests).toHaveLength(4);

    const saved = await ws.setPluginSettings({ plugin: "@loc-studio/plugin-llm", values: { translatePrompt: "次の台詞を、{to}で、短く言い換える。", translateTo: "英語" } });
    expect(saved.find((p) => p.plugin === "@loc-studio/plugin-llm")?.items.filter((i) => i.stored).map((i) => [i.key, i.value])).toEqual([
      ["translateTo", "英語"],
      ["translatePrompt", "次の台詞を、{to}で、短く言い換える。"],
    ]);
    expect(JSON.parse(await tp.read(SETTINGS_FILE))).toEqual({ translatePrompt: "次の台詞を、{to}で、短く言い換える。", translateTo: "英語" });

    // 前のプロンプトで作った結果は、値を残したまま「変更あり」になる。
    expect((await cellsOf(ws, UI, "mt@ko", ["ko"]))["UI_OK"]).toEqual({ value: "訳:확인", generated: "stale", stale: true });
    const redo = await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"] });
    expect(redo.result).toMatchObject({ total: 4, cached: 0, toRun: 4 });
    expect(llm.requests).toHaveLength(8);
    expect(llm.requests[7]?.system).toBe("次の台詞を、英語で、短く言い換える。");
    expect((await cellsOf(ws, UI, "mt@ko", ["ko"]))["UI_OK"]?.generated).toBe("fresh");

    // 値を消すと既定のプロンプトに戻り、前に既定のプロンプトで作った結果が、また最新として出る。
    await ws.setPluginSettings({ plugin: "@loc-studio/plugin-llm", values: { translatePrompt: null, translateTo: null } });
    const back = await ws.generate({ columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"], dryRun: true });
    expect(back).toMatchObject({ total: 4, cached: 4, toRun: 0 });
  });

  it("評価のプロンプトと、比べる原文の言語を変えられる", async () => {
    const ws = await tp.open();
    await ws.setPluginSettings({ plugin: "@loc-studio/plugin-llm", values: { evaluatePrompt: "敬語が崩れていないかだけを見て、verdict を決める。", evaluateSource: "zh-Hans" } });
    const run = await generate(ws, { columnId: "mtCheck", scope: "resource", resourceId: UI, languages: ["ko"], filter: { where: "key = UI_OK", languages: ["ko"] } });
    expect(run.job).toMatchObject({ status: "done", done: 1 });
    expect(llm.requests).toHaveLength(1);
    // 原文は、設定した言語（zh-Hans）の本文。
    expect(JSON.parse(llm.requests[0]!.user)).toEqual({ source: "确定", translation: "확인" });
    expect(llm.requests[0]?.system.startsWith("敬語が崩れていないかだけを見て、verdict を決める。\n")).toBe(true);
    expect((await cellsOf(ws, UI, "mtCheck@ko", ["ko"]))["UI_OK"]).toEqual({ value: "OK", comment: "理由（确定）", generated: "fresh" });
  });

  it("生成器の options の値は、プラグインの設定より優先される（使う場所ごとに変えられる）", async () => {
    await tp.patchConfig({
      generators: {
        mt: { use: "llm.translate", options: { endpoint: llm.url, model: "test-model", to: "韓国語", prompt: "options の指示（{to}）" } },
        check: { use: "llm.evaluate", options: { endpoint: llm.url, model: "test-model", source: "JaEnglish" } },
      },
    });
    const ws = await tp.open();
    await ws.setPluginSettings({ plugin: "@loc-studio/plugin-llm", values: { translatePrompt: "設定の指示（{to}）", translateTo: "英語", evaluateSource: "zh-Hans" } });
    const only = { where: "key = UI_OK", languages: ["ko"] };
    await generate(ws, { columnId: "mt", scope: "resource", resourceId: UI, languages: ["ko"], filter: only });
    expect(llm.requests[0]?.system).toBe("options の指示（韓国語）");
    await generate(ws, { columnId: "mtCheck", scope: "resource", resourceId: UI, languages: ["ko"], filter: only });
    expect(JSON.parse(llm.requests[1]!.user)).toEqual({ source: "OK", translation: "확인" });
  });
});
