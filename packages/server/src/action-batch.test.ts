/**
 * アクションを、複数の行ごとにまとめて呼ぶ（runAction の batchSize と、Action.runBatch）。
 * テスト用のプラグインが、呼ばれた回数と受け取った行を記録する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionContext, ActionResult, Plugin } from "@loc-studio/sdk";
import type { Workspace } from "./api-types.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

const BIG = "Assets/Text/big.csv";

/** 呼ばれ方の記録。 */
const seen = {
  /** runBatch が受け取ったまとまり（行のキーの配列）。 */
  batches: [] as string[][],
  /** run（行ごと）が受け取った行のキー。 */
  rows: [] as string[],
  /** runBatch が受け取った最初のまとまりの、各行の値。 */
  first: [] as { key: string; value: unknown; column: string | undefined; language: string | undefined; text: string | undefined }[],
  /** このキーを含むまとまりで、例外を投げる。 */
  failOn: undefined as string | undefined,
};

/** 本文を「[まとまりの行数]本文」に変える変更点。 */
const tag = (items: ActionContext[]): ActionResult => ({
  patches: items.map((item) => ({
    resourceId: item.entry!.resource.id,
    entryKey: item.entry!.key,
    columnId: "text",
    language: item.language!.id,
    value: `[${items.length}]${String(item.value)}`,
  })),
  message: `${items.length} 行をまとめて処理`,
});

const batchPlugin: Plugin = {
  name: "batch-test",
  actions: [
    {
      id: "t.tag",
      label: "まとめて印を付ける",
      target: "cell",
      columns: ["text"],
      // 本文が空の行と、印を付け終えた行は対象にしない。
      when: (ctx) => typeof ctx.value === "string" && ctx.value !== "" && !ctx.value.startsWith("["),
      async run(ctx) {
        seen.rows.push(ctx.entry!.key);
        return tag([ctx]);
      },
      async runBatch(items) {
        const keys = items.map((item) => item.entry!.key);
        if (seen.batches.length === 0) {
          seen.first = items.map((item) => ({ key: item.entry!.key, value: item.value, column: item.column?.id, language: item.language?.id, text: item.row?.text("ja") }));
        }
        seen.batches.push(keys);
        if (seen.failOn !== undefined && keys.includes(seen.failOn)) throw new Error("外部の API が失敗しました");
        return tag(items);
      },
    },
    {
      id: "t.plain",
      label: "1 行ずつだけ",
      target: "row",
      async run(ctx) {
        seen.rows.push(ctx.entry!.key);
        return {};
      },
    },
    {
      id: "t.selection",
      label: "選択をまとめて",
      target: "selection",
      async run(ctx) {
        return { message: `${ctx.entries!.length} 行` };
      },
      // target が selection のアクションに runBatch を書いても、使わない。
      async runBatch(items) {
        seen.batches.push(items.map((item) => item.entry!.key));
        return {};
      },
    },
  ],
};

let tp: TestProject;
let ws: Workspace;
beforeEach(async () => {
  Object.assign(seen, { batches: [], rows: [], first: [], failOn: undefined });
  tp = await makeTestProject({ plugins: [batchPlugin] });
  await tp.patchConfig({ actions: ["t.tag", "t.plain", "t.selection"] });
  // 30 行のリソース（20 行を超えるので、ジョブになる）。K7 と K8 は英語の本文が空。
  const lines = ["ID,JP,EN,CN,KR,MaxLen", ...Array.from({ length: 30 }, (_, i) => `K${i},本文${i},${i === 7 || i === 8 ? "" : `text${i}`},,,`)];
  await tp.write(BIG, lines.join("\n") + "\n");
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

const textsOf = async (resourceId: string, language: string): Promise<Record<string, unknown>> => {
  const r = await ws.rows({ resourceId, languages: [language], offset: 0, limit: 100 });
  return Object.fromEntries(r.rows.map((row) => [row.key, row.cells[`text@${language}`]?.value]));
};

describe("アクションを行ごとにまとめて呼ぶ（batchSize）", () => {
  it("info は、行をまとめて受け取れるアクション（target が cell / row で runBatch がある）に印を付ける", async () => {
    const actions = (await ws.info()).actions;
    expect(actions.map((a) => [a.id, a.target, a.batch])).toEqual([
      ["t.tag", "cell", true],
      ["t.plain", "row", undefined],
      ["t.selection", "selection", undefined],
    ]);
  });

  it("batchSize 行ずつに分けて runBatch を呼び、run は呼ばない。変更点は行ごとに反映する", async () => {
    const r = await ws.runAction({ actionId: "t.tag", resourceId: CHAPTER, cellId: "text@JaEnglish", filter: { languages: ["JaEnglish"] }, batchSize: 3 });
    // 8 行を 3 行ずつ: 3、3、2。
    expect(seen.batches).toEqual([
      ["CH01_INTRO_001", "CH01_INTRO_002", "CH01_INTRO_003"],
      ["CH01_CHOICE_001A", "CH01_CHOICE_001B", "CH01_ITEM_001"],
      ["CH01_SHOP_001", "CH01_SHOP_002"],
    ]);
    expect(seen.rows).toEqual([]);
    expect(r).toEqual({ patched: 8, matched: 8, message: "3 行をまとめて処理\n3 行をまとめて処理\n2 行をまとめて処理" });
    // 各行は、run が行ごとに受け取るのと同じ値（セルの値、列、言語、行の読み出し）を受け取る。
    expect(seen.first).toEqual([
      { key: "CH01_INTRO_001", value: "You're awake, {player}.", column: "text", language: "JaEnglish", text: "目が覚めたか、{player}。" },
      { key: "CH01_INTRO_002", value: "Where... am I?", column: "text", language: "JaEnglish", text: "ここは……どこだ？" },
      { key: "CH01_INTRO_003", value: "A clinic on the outskirts of the capital.\nThree days ago, I carried you here after you collapsed in the forest.", column: "text", language: "JaEnglish", text: "王都の外れにある診療所だ。\n三日前、森で倒れていたお前を運んできた。" },
    ]);
    const texts = await textsOf(CHAPTER, "JaEnglish");
    expect(texts["CH01_INTRO_001"]).toBe("[3]You're awake, {player}.");
    expect(texts["CH01_SHOP_002"]).toBe("[2]Antidote");
    // 本文の変更は、行ごとに未保存の変更になる（ファイルには、まだ書かない）。
    const stats = await ws.stats({ resourceIds: [CHAPTER] });
    expect(stats[0]?.unsaved).toBe(8);
    expect(await tp.read(CHAPTER)).toContain("CH01_SHOP_002,毒消し,Antidote,");
  });

  it("batchSize を省くか 1 にすると、これまでどおり run を行ごとに呼ぶ", async () => {
    await ws.runAction({ actionId: "t.tag", resourceId: UI, cellId: "text@JaEnglish", keys: ["UI_OK", "UI_CANCEL"] });
    await ws.runAction({ actionId: "t.tag", resourceId: UI, cellId: "text@JaEnglish", keys: ["UI_GOLD"], batchSize: 1 });
    expect(seen.rows).toEqual(["UI_OK", "UI_CANCEL", "UI_GOLD"]);
    expect(seen.batches).toEqual([]);
    expect((await textsOf(UI, "JaEnglish"))["UI_OK"]).toBe("[1]OK");
  });

  it("when が false を返した行は、まとまりに入れない", async () => {
    // 韓国語の本文が空の行（CH01_CHOICE_001B）は、when が false。
    const r = await ws.runAction({ actionId: "t.tag", resourceId: CHAPTER, cellId: "text@ko", filter: { languages: ["ko"], where: 'key ~ "CHOICE" or key ~ "ITEM"' }, batchSize: 5 });
    expect(seen.batches).toEqual([["CH01_CHOICE_001A", "CH01_ITEM_001"]]);
    expect(r).toMatchObject({ patched: 2, matched: 3 });
    expect((await textsOf(CHAPTER, "ko"))["CH01_CHOICE_001B"]).toBe("");
  });

  it("行をまとめて受け取れないアクションと、対象を 1 回で受け取るアクションに batchSize を付けると断り、何も実行しない", async () => {
    await expect(ws.runAction({ actionId: "t.plain", resourceId: UI, keys: ["UI_OK", "UI_CANCEL"], batchSize: 2 })).rejects.toMatchObject({
      code: "invalid",
      message: 'アクション "t.plain" は、複数の行をまとめて受け取れません（runBatch がありません）。batchSize を外すか、1 にしてください。',
    });
    await expect(ws.runAction({ actionId: "t.selection", resourceId: UI, keys: ["UI_OK", "UI_CANCEL"], batchSize: 2 })).rejects.toMatchObject({
      code: "invalid",
      message: 'アクション "t.selection"（target: selection）は、対象の行をまとめて 1 回で受け取るので、batchSize は指定できません。',
    });
    for (const batchSize of [0, 2.5, 1001, "2"]) {
      await expect(ws.runAction({ actionId: "t.tag", resourceId: UI, cellId: "text@JaEnglish", keys: ["UI_OK"], batchSize: batchSize as number })).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining("batchSize は 1 以上 1000 以下の整数で指定してください"),
      });
    }
    expect(seen.rows).toEqual([]);
    expect(seen.batches).toEqual([]);
    expect((await textsOf(UI, "JaEnglish"))["UI_OK"]).toBe("OK");
    // batchSize が 1 なら、行をまとめて受け取れないアクションも実行できる。
    await ws.runAction({ actionId: "t.plain", resourceId: UI, keys: ["UI_OK"], batchSize: 1 });
    expect(seen.rows).toEqual(["UI_OK"]);
  });

  it("まとまりが失敗したら、どの行のまとまりかを添えて失敗にする（20 行以下のとき）。先に済んだまとまりの変更は残る", async () => {
    seen.failOn = "CH01_ITEM_001";
    await expect(ws.runAction({ actionId: "t.tag", resourceId: CHAPTER, cellId: "text@JaEnglish", filter: { languages: ["JaEnglish"] }, batchSize: 3 })).rejects.toMatchObject({
      code: "failed",
      message: "アクション「まとめて印を付ける」が失敗しました（CH01_CHOICE_001A から CH01_ITEM_001 までの 3 行）: 外部の API が失敗しました",
    });
    // 失敗したまとまりのあとは呼ばない。
    expect(seen.batches).toHaveLength(2);
    const texts = await textsOf(CHAPTER, "JaEnglish");
    expect(texts["CH01_INTRO_001"]).toBe("[3]You're awake, {player}.");
    expect(texts["CH01_CHOICE_001A"]).toBe("<b>Trust him</b>");
    expect(texts["CH01_SHOP_001"]).toBe("Potion");
  });
});

describe("20 行を超えるとき（ジョブ）", () => {
  it("ジョブの中で batchSize 行ずつ呼び、済んだ行、飛ばした行を数える", async () => {
    const r = await ws.runAction({ actionId: "t.tag", resourceId: BIG, cellId: "text@JaEnglish", filter: { languages: ["JaEnglish"] }, batchSize: 10 });
    expect(r).toMatchObject({ patched: 0, matched: 30 });
    const job = await ws.waitForJob(r.jobId!);
    // 本文が空の 2 行は飛ばし、残りの 28 行を 10 行ずつ: 10、10、8。
    expect(job).toMatchObject({ kind: "action", status: "done", total: 30, done: 28, skipped: 2, failed: 0 });
    expect(seen.batches.map((b) => b.length)).toEqual([10, 10, 8]);
    expect(seen.batches[0]?.slice(0, 3)).toEqual(["K0", "K1", "K2"]);
    expect(seen.batches.flat()).not.toContain("K7");
    expect(seen.rows).toEqual([]);
    const texts = await textsOf(BIG, "JaEnglish");
    expect(texts["K0"]).toBe("[10]text0");
    expect(texts["K29"]).toBe("[8]text29");
    expect(texts["K7"]).toBe("");
  });

  it("失敗したまとまりは失敗として数え、ほかのまとまりは続ける", async () => {
    seen.failOn = "K12";
    const r = await ws.runAction({ actionId: "t.tag", resourceId: BIG, cellId: "text@JaEnglish", filter: { languages: ["JaEnglish"] }, batchSize: 10 });
    const job = await ws.waitForJob(r.jobId!);
    // 2 つ目のまとまり（K10 と、K12 から K20。K7 と K8 を飛ばすので、1 つ目は K0 から K11 のうちの 10 行）が失敗する。
    expect(seen.batches.map((b) => b.length)).toEqual([10, 10, 8]);
    expect(seen.batches[1]).toContain("K12");
    expect(job).toMatchObject({ status: "failed", total: 30, done: 18, skipped: 2, failed: 10 });
    expect(job.error).toBe(`${seen.batches[1]![0]} から ${seen.batches[1]![9]} までの 10 行: 外部の API が失敗しました`);
    const texts = await textsOf(BIG, "JaEnglish");
    expect(texts["K0"]).toBe("[10]text0");
    expect(texts["K12"]).toBe("text12");
    expect(texts["K29"]).toBe("[8]text29");
  });
});
