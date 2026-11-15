/**
 * 大きなリソースでも仕事の量が増えないこと（ページ単位の検証、結果の使い回し、解析は 1 回）。
 *
 * 速さを時間で測ると、テストを並べて走らせたときの混み具合で結果が変わり、通ったり落ちたりする。
 * ここでは「バリデータを何回呼んだか」「フォーマットの parse を何回呼んだか」を数えて、
 * 行数に比例して遅くなる変更（毎回全行を検証し直す、毎回解析し直す）を、いつ走らせても同じ結果で見つける。
 * 時間の予算そのものは big-resource.perf.test.ts（`npm run test:perf`）で、単独で走らせて確かめる。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvFormat } from "@loc-studio/builtin";
import type { Plugin } from "@loc-studio/sdk";
import type { Workspace } from "./api-types.js";
import { makeTestProject } from "./testing.js";
import type { TestProject } from "./testing.js";

const ROWS = 5_000;
const BIG = "Assets/Text/big.csv";
const LANGS = ["ja", "JaEnglish", "zh-Hans", "ko"];
const PAGE = 200;

let validated = 0;
let parsed = 0;

const plugin: Plugin = {
  name: "scale-test",
  validators: [{ id: "scale.count", label: "数える", version: "1", validate: () => (validated++, []) }],
  formats: [
    {
      id: "scale.csv",
      match: () => false,
      parse: (input, ctx) => (parsed++, csvFormat.parse(input, ctx)),
      apply: (original, changes, ctx) => csvFormat.apply(original, changes, ctx),
    },
  ],
};

let tp: TestProject;
let ws: Workspace;

beforeAll(async () => {
  tp = await makeTestProject({ plugins: [plugin] });
  const lines = ["ID,JP,EN,CN,KR,MaxLen"];
  for (let i = 0; i < ROWS; i++) {
    lines.push(`BIG_${String(i).padStart(6, "0")},これは {name} の台詞 ${i} です,This is line ${i} for {name},这是第${i}行 {name},이것은 ${i}번째 줄 {name},40`);
  }
  await tp.write(BIG, lines.join("\n") + "\n");
  const config = JSON.parse(await tp.read("loc-studio.project.json")) as { formats: { options: unknown }[] };
  // 数えるバリデータだけにし、大きなリソースは数えるフォーマットで読む。
  await tp.patchConfig({ validators: ["scale.count"], formats: [{ use: "scale.csv", match: "**/big.csv", options: config.formats[0]!.options }, ...config.formats] });
  ws = await tp.open();
}, 60_000);
afterAll(async () => {
  await tp.cleanup();
});

/** fn の間に増えた、バリデータと parse の呼び出しの数。 */
async function work<T>(fn: () => Promise<T>): Promise<{ result: T; validated: number; parsed: number }> {
  const before = { validated, parsed };
  const result = await fn();
  return { result, validated: validated - before.validated, parsed: parsed - before.parsed };
}

const page = (offset: number, extra: Record<string, unknown> = {}) => ws.rows({ resourceId: BIG, languages: LANGS, offset, limit: PAGE, ...extra });

describe(`${ROWS} 行のリソース`, () => {
  // テストは上から順に、前の結果（覚えている検証結果）を前提にしている。
  it("rows は、返すページの行だけを検証する（全行は検証しない）。解析は最初の 1 回だけ", async () => {
    const first = await work(() => page(0));
    expect(first.result.totalAll).toBe(ROWS);
    expect(first.result.rows).toHaveLength(PAGE);
    expect(first).toMatchObject({ validated: PAGE * LANGS.length, parsed: 1 });
    // 離れたページ: そのページの行だけ。解析し直さない。
    const far = await work(() => page(2_500));
    expect(far.result.rows[0]!.key).toBe("BIG_002500");
    expect(far).toMatchObject({ validated: PAGE * LANGS.length, parsed: 0 });
  });

  it("同じページをもう一度読んでも、検証し直さない", async () => {
    expect(await work(() => page(2_500))).toMatchObject({ validated: 0, parsed: 0 });
    // 表示する言語を減らしても、覚えている結果を使う。
    expect(await work(() => ws.rows({ resourceId: BIG, languages: ["ko"], offset: 2_500, limit: PAGE }))).toMatchObject({ validated: 0, parsed: 0 });
  });

  it("検索と値での絞り込みは、検証せずに絞り、返す行だけを検証する", async () => {
    const searched = await work(() => page(0, { search: "line 499" }));
    expect(searched.result.total).toBe(11); // 499, 4990〜4999
    expect(searched).toMatchObject({ validated: 11 * LANGS.length, parsed: 0 });
    await ws.setCell({ resourceId: BIG, key: "BIG_000010", cellId: "textStatus@ko", value: "done" });
    const filtered = await work(() => ws.rows({ resourceId: BIG, languages: ["ko"], offset: 0, limit: PAGE, filters: [{ cellId: "textStatus@ko", values: ["done"] }] }));
    expect(filtered.result.rows.map((r) => r.key)).toEqual(["BIG_000010"]);
    expect(filtered).toMatchObject({ validated: 0, parsed: 0 }); // BIG_000010 は最初のページで検証済み
  });

  it("リソースをまたぐ検索は、検証も解析もしない", async () => {
    const hits = await work(() => ws.search({ query: "第4999行" }));
    expect(hits.result).toHaveLength(1);
    expect(hits).toMatchObject({ validated: 0, parsed: 0 });
  });

  it("統計は、まだ検証していないセルだけを検証し、どのセルも 1 回ずつで済む。2 回目は何もしない", async () => {
    const before = validated;
    const first = await work(() => ws.stats({ resourceIds: [BIG] }));
    expect(first.result[0]!.progress["textStatus"]!["ko"]).toEqual({ complete: 1, total: ROWS });
    expect(first.parsed).toBe(0);
    expect(before + first.validated).toBe(ROWS * LANGS.length);
    expect(await work(() => ws.stats({ resourceIds: [BIG] }))).toMatchObject({ validated: 0, parsed: 0 });
  });

  it("列の値や 1 つの本文が変わっても、変わっていないセルは検証し直さない", async () => {
    await ws.setCell({ resourceId: BIG, key: "BIG_000011", cellId: "textStatus@ko", value: "done" });
    const afterStatus = await work(() => ws.stats({ resourceIds: [BIG] }));
    expect(afterStatus.result[0]!.progress["textStatus"]!["ko"]).toEqual({ complete: 2, total: ROWS });
    expect(afterStatus).toMatchObject({ validated: 0, parsed: 0 });
    // 原文（ja）を 1 つ変えると、その本文と、それを基にする 3 言語のセルだけを確かめ直す。
    const edited = await work(async () => {
      await ws.setText({ resourceId: BIG, key: "BIG_000012", language: "ja", value: "書き換えた台詞" });
      return ws.stats({ resourceIds: [BIG] });
    });
    expect(edited).toMatchObject({ validated: LANGS.length, parsed: 0 });
    // 「問題あり」の絞り込みは全行を見るが、覚えている結果を使う。
    const issues = await work(() => page(0, { onlyIssues: "error" }));
    expect(issues.result.total).toBe(0);
    expect(issues).toMatchObject({ validated: 0, parsed: 0 });
  });
});
