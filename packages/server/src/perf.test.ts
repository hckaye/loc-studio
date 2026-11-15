/**
 * 大きなリソース（5 万行 × 4 言語）での速さ。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Workspace } from "./api-types.js";
import { makeTestProject } from "./testing.js";
import type { TestProject } from "./testing.js";

const ROWS = 50_000;
const BIG = "Assets/Text/big.csv";
const LANGS = ["ja", "JaEnglish", "zh-Hans", "ko"];

let tp: TestProject;
let ws: Workspace;
const timings: Record<string, number> = {};

async function time<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  timings[name] = Math.round((performance.now() - t0) * 10) / 10;
  return r;
}

beforeAll(async () => {
  tp = await makeTestProject();
  const lines = ["ID,JP,EN,CN,KR,MaxLen"];
  for (let i = 0; i < ROWS; i++) {
    lines.push(`BIG_${String(i).padStart(6, "0")},これは {name} の台詞 ${i} です,This is line ${i} for {name},这是第${i}行 {name},이것은 ${i}번째 줄 {name},40`);
  }
  await tp.write(BIG, lines.join("\n") + "\n");
  ws = await tp.open();
}, 60_000);
afterAll(async () => {
  console.log(`[perf] ${ROWS} 行 × ${LANGS.length} 言語:`, JSON.stringify(timings));
  await tp.cleanup();
});

describe("5 万行", () => {
  it("rows（絞り込みなし、limit 200）は読み込み後に速く返る", async () => {
    const first = await time("rows.first(load+parse)", () => ws.rows({ resourceId: BIG, languages: LANGS, offset: 0, limit: 200 }));
    expect(first.totalAll).toBe(ROWS);
    // 2 回目以降（別のページ。バリデーションのキャッシュが効かない行）。
    const r = await time("rows.page(offset 25000)", () => ws.rows({ resourceId: BIG, languages: LANGS, offset: 25_000, limit: 200 }));
    expect(r.rows).toHaveLength(200);
    expect(r.rows[0]!.key).toBe("BIG_025000");
    const again = await time("rows.page(cached)", () => ws.rows({ resourceId: BIG, languages: LANGS, offset: 25_000, limit: 200 }));
    expect(again.rows).toHaveLength(200);
    expect(timings["rows.page(offset 25000)"]!).toBeLessThan(500);
    expect(timings["rows.page(cached)"]!).toBeLessThan(500);
  }, 60_000);

  it("表の中の検索と、リソースをまたぐ検索", async () => {
    const r = await time("rows.search", () => ws.rows({ resourceId: BIG, languages: LANGS, offset: 0, limit: 200, search: "line 4999" }));
    expect(r.total).toBe(11); // 4999, 49990〜49999
    const hits = await time("search(project)", () => ws.search({ query: "번째 줄 {name}", limit: 2000 }));
    expect(hits).toHaveLength(2000);
    const rare = await time("search(rare, full scan)", () => ws.search({ query: "第49999行" }));
    expect(rare).toHaveLength(1);
    expect(timings["search(rare, full scan)"]!).toBeLessThan(3000);
  }, 60_000);

  it("値での絞り込み・統計も現実的な時間で終わる", async () => {
    await ws.setCell({ resourceId: BIG, key: "BIG_000010", cellId: "textStatus@ko", value: "done" });
    const r = await time("rows.filter(textStatus@ko=done)", () =>
      ws.rows({ resourceId: BIG, languages: ["ko"], offset: 0, limit: 200, filters: [{ cellId: "textStatus@ko", values: ["done"] }] }),
    );
    expect(r.rows.map((x) => x.key)).toEqual(["BIG_000010"]);
    const s = await time("stats(first)", () => ws.stats({ resourceIds: [BIG] }));
    expect(s[0]!.progress.textStatus!.ko).toEqual({ complete: 1, total: ROWS });
    await time("stats(cached)", () => ws.stats({ resourceIds: [BIG] }));
    expect(timings["stats(cached)"]!).toBeLessThan(100);
  }, 120_000);
});
