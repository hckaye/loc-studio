/**
 * 条件式（where）と、リソースをまたぐ問い合わせ（query / exportQuery）。
 * サンプルのプロジェクトの中身に対する期待値を、ここに書き下す。
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "./api-types.js";
import { parseQuery, QuerySyntaxError } from "./query-lang.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

const ALL = ["ja", "JaEnglish", "zh-Hans", "ko"];
/** chapter01.csv の行（リソースの中の順）。 */
const CH = {
  i1: "CH01_INTRO_001",
  i2: "CH01_INTRO_002",
  i3: "CH01_INTRO_003",
  a: "CH01_CHOICE_001A",
  b: "CH01_CHOICE_001B",
  item: "CH01_ITEM_001",
  s1: "CH01_SHOP_001",
  s2: "CH01_SHOP_002",
};
const CH_ALL = Object.values(CH);

describe("条件式の構文", () => {
  it("and は or より強く、not はその次の条件だけに掛かる。かっこで順を変えられる", () => {
    expect(parseQuery("a = 1 or b = 2 and not c = 3")).toEqual({
      type: "or",
      items: [
        { type: "compare", field: { raw: "a", pos: 0 }, op: "=", value: { text: "1", quoted: false, pos: 4 } },
        {
          type: "and",
          items: [
            { type: "compare", field: { raw: "b", pos: 9 }, op: "=", value: { text: "2", quoted: false, pos: 13 } },
            { type: "not", item: { type: "compare", field: { raw: "c", pos: 23 }, op: "=", value: { text: "3", quoted: false, pos: 27 } } },
          ],
        },
      ],
    });
    expect(parseQuery("(a = 1 or b = 2) and c = 3")).toMatchObject({ type: "and", items: [{ type: "or" }, { type: "compare" }] });
  });

  it("is empty、in、値だけの条件、引用符の中の空白とエスケープ、全角の空白を読む", () => {
    expect(parseQuery("text@ko is not empty")).toEqual({ type: "empty", field: { raw: "text@ko", pos: 0 }, negate: true });
    expect(parseQuery('s not in (a, "b c")')).toEqual({
      type: "in",
      field: { raw: "s", pos: 0 },
      negate: true,
      values: [
        { text: "a", quoted: false, pos: 10 },
        { text: "b c", quoted: true, pos: 13 },
      ],
    });
    expect(parseQuery("stale")).toEqual({ type: "truthy", field: { raw: "stale", pos: 0 } });
    expect(parseQuery('k ~ "a\\"b"')).toMatchObject({ value: { text: 'a"b', quoted: true } });
    expect(parseQuery("a = 1\u3000AND\u3000b == 2")).toMatchObject({ type: "and", items: [{ op: "=" }, { op: "=" }] });
    expect(parseQuery("   ")).toBeUndefined();
  });

  it.each([
    ['a = "x', 4, "引用符"],
    ["a =", 3, "値がありません"],
    ["a = 1 b = 2", 6, '"and" か "or"'],
    ["a = 1)", 5, '対応する "("'],
    ["(a = 1", 6, '")" がありません'],
    ["a is big", 5, '"empty" か "not empty"'],
    ["a ! b", 2, '"!="'],
    ["= 1", 0, "列の ID"],
  ])("書き方の誤り %s は、位置と理由を添えて断る", (input, pos, reason) => {
    let error: unknown;
    try {
      parseQuery(input);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(QuerySyntaxError);
    expect((error as QuerySyntaxError).pos).toBe(pos);
    expect((error as QuerySyntaxError).message).toContain(reason);
  });
});

let tp: TestProject;
let ws: Workspace;
beforeEach(async () => {
  tp = await makeTestProject();
  const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
  // リソースの中の列（上限。文字列）を、表の列として足す。ui.csv は 4 / 6 / 12 / 空。
  await tp.patchConfig({ columns: [...config.columns, { id: "maxLength", kind: "meta", scope: "entry", type: "string" }] });
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

const keys = async (where: string, opts: { resourceId?: string; languages?: string[]; extra?: Record<string, unknown> } = {}): Promise<string[]> =>
  (await ws.rows({ resourceId: opts.resourceId ?? CHAPTER, languages: opts.languages ?? ALL, offset: 0, limit: 100, where, ...(opts.extra ?? {}) })).rows.map((r) => r.key);

describe("rows の where（条件式）", () => {
  it("空かどうか: 言語を名指しする、どれかの言語（@any と省略）、すべての言語（@all）", async () => {
    expect(await keys("text@ko is empty")).toEqual([CH.b]);
    expect(await keys("text@ja is empty")).toEqual([]);
    expect(await keys("text@any is empty")).toEqual([CH.b]);
    expect(await keys("text@* is empty")).toEqual([CH.b]);
    expect(await keys("text is empty")).toEqual([CH.b]);
    // 対象の言語（要求の languages）に韓国語がなければ、空の本文はない。
    expect(await keys("text is empty", { languages: ["ja", "JaEnglish"] })).toEqual([]);
    expect(await keys("text@all is not empty")).toEqual(CH_ALL.filter((k) => k !== CH.b));
    expect(await keys("not text@ko is empty")).toEqual(CH_ALL.filter((k) => k !== CH.b));
    // @all は、1 つでも合わない言語があれば合わない。@any は、1 つでも合えば合う。
    expect(await keys('text@all ~ "player"')).toEqual([CH.i1]);
    // 対象の言語にその列が 1 つもなければ、@all でも合わない（すべての行が合ってしまわない）。
    expect(await keys("text@all is not empty", { languages: [] })).toEqual([]);
    expect(await keys("text@any is not empty", { languages: [] })).toEqual([]);
    expect(await keys('text@any ~ "herbs"')).toEqual([CH.item]);
  });

  it("選択式の列: 値でも表示名でも書け、未設定は既定の値。大小は選択肢の並び順", async () => {
    await ws.setCell({ resourceId: CHAPTER, key: CH.i1, cellId: "textStatus@ko", value: "done" });
    await ws.setCell({ resourceId: CHAPTER, key: CH.i2, cellId: "textStatus@ko", value: "wip" });
    expect(await keys("textStatus@ko = done")).toEqual([CH.i1]);
    expect(await keys("textStatus@ko = 確定")).toEqual([CH.i1]);
    expect(await keys("textStatus@ko = todo")).toEqual(CH_ALL.filter((k) => k !== CH.i1 && k !== CH.i2));
    expect(await keys("textStatus@ko != done")).toEqual(CH_ALL.filter((k) => k !== CH.i1));
    expect(await keys("textStatus@ko >= wip")).toEqual([CH.i1, CH.i2]);
    expect(await keys("textStatus@ko < done")).toEqual(CH_ALL.filter((k) => k !== CH.i1));
    expect(await keys("textStatus@ko in (wip, done)")).toEqual([CH.i1, CH.i2]);
    expect(await keys("textStatus@ko not in (wip, done)")).toEqual(CH_ALL.filter((k) => k !== CH.i1 && k !== CH.i2));
    // 言語を省くと、対象の言語のどれか。日本語のステータスは変えていないので、done の行は韓国語の 1 行だけ。
    expect(await keys("textStatus = done")).toEqual([CH.i1]);
    expect(await keys("textStatus = done", { languages: ["ja"] })).toEqual([]);
    // 未レビュー（レビュー列の既定の値）。
    await ws.postReview({ resourceId: CHAPTER, key: CH.s2, cellId: "reviewStatus@ko", verdict: "ok", comment: "" });
    expect(await keys("reviewStatus@ko = none")).toEqual(CH_ALL.filter((k) => k !== CH.s2));
    expect(await keys("reviewStatus@ko = 承認")).toEqual([CH.s2]);
  });

  it("かつ、または、否定、かっこを組み合わせられる", async () => {
    await ws.setCell({ resourceId: CHAPTER, key: CH.i1, cellId: "textStatus@ko", value: "done" });
    await ws.setCell({ resourceId: CHAPTER, key: CH.s1, cellId: "textStatus@ko", value: "done" });
    expect(await keys('textStatus@ko = done and key ~ "shop"')).toEqual([CH.s1]);
    expect(await keys('textStatus@ko = done or key ~ "choice"')).toEqual([CH.i1, CH.a, CH.b, CH.s1]);
    // and が先に結び付く: 「done」または「choice かつ 韓国語が空」。
    expect(await keys('textStatus@ko = done or key ~ "choice" and text@ko is empty')).toEqual([CH.i1, CH.b, CH.s1]);
    expect(await keys('(textStatus@ko = done or key ~ "choice") and text@ko is empty')).toEqual([CH.b]);
    expect(await keys('not (textStatus@ko = done or key ~ "choice")')).toEqual([CH.i2, CH.i3, CH.item, CH.s2]);
  });

  it("issues: 検証の問題の重さで絞れる。言語を付けるとその言語、付けないと対象の言語の全体", async () => {
    expect(await keys("issues@ko >= error")).toEqual([CH.a]);
    expect(await keys("issues@ko = warning")).toEqual([CH.i3, CH.b]);
    expect(await keys("issues@ko >= warning")).toEqual([CH.i3, CH.a, CH.b]);
    expect(await keys("issues@ko = none")).toEqual([CH.i1, CH.i2, CH.item, CH.s1, CH.s2]);
    expect(await keys("issues@ko is empty")).toEqual([CH.i1, CH.i2, CH.item, CH.s1, CH.s2]);
    expect(await keys("issues >= error")).toEqual([CH.a, CH.item, CH.s1, CH.s2]);
    expect(await keys("issues = none")).toEqual([CH.i1, CH.i2]);
    // 値だけを書くと「問題がある」。
    expect(await keys("issues@zh-Hans")).toEqual([CH.i3, CH.item]);
    // 対象の言語にない言語の問題は、言語なしの issues には入らない。
    expect(await keys("issues >= error", { languages: ["ko"] })).toEqual([CH.a]);
    // どの言語にも問題がある行。
    expect(await keys("issues@all >= warning")).toEqual([CH.i3]);
  });

  it("issueCode: 問題の種類で絞れる", async () => {
    expect(await keys("issueCode@JaEnglish = too-long")).toEqual([CH.s2]);
    expect(await keys("issueCode ~ placeholder")).toEqual([CH.a, CH.item]);
    expect(await keys("issueCode@ko = tag-unclosed and issueCode@ko = placeholder-missing")).toEqual([CH.a]);
    expect(await keys("issueCode != line-too-long")).toEqual(CH_ALL.filter((k) => k !== CH.i3));
  });

  it("数は数の大きさで比べる（文字の順ではない）。空の値は、大小の比較には合わない", async () => {
    const ui = (where: string) => keys(where, { resourceId: UI });
    // 文字の順なら "12" は "5" より小さい。
    expect(await ui("maxLength > 5")).toEqual(["UI_CANCEL", "UI_SAVE_CONFIRM"]);
    expect(await ui("maxLength <= 6")).toEqual(["UI_OK", "UI_CANCEL"]);
    expect(await ui("maxLength = 12")).toEqual(["UI_SAVE_CONFIRM"]);
    expect(await ui("maxLength != 12")).toEqual(["UI_OK", "UI_CANCEL", "UI_GOLD"]);
    expect(await ui("maxLength is empty")).toEqual(["UI_GOLD"]);
    expect(await ui("maxLength")).toEqual(["UI_OK", "UI_CANCEL", "UI_SAVE_CONFIRM"]);
    expect(await ui("maxLength in (4, 12)")).toEqual(["UI_OK", "UI_SAVE_CONFIRM"]);
  });

  it("小数と負の数も、数の大きさで比べる。日付の列は、日付の前後で比べられる", async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
    await tp.patchConfig({
      columns: [...config.columns, { id: "priority", kind: "meta", scope: "entry", type: "number", source: "builtin.db" }, { id: "due", kind: "meta", scope: "entry", type: "date", source: "builtin.db" }],
    });
    await ws.reloadPlugins();
    const priority: Record<string, number> = { UI_OK: 1.5, UI_CANCEL: -5, UI_SAVE_CONFIRM: 1.25, UI_GOLD: 10 };
    for (const [key, value] of Object.entries(priority)) await ws.setCell({ resourceId: UI, key, cellId: "priority", value });
    const due: Record<string, string> = { UI_OK: "2026-11-15", UI_CANCEL: "2026-11-02", UI_SAVE_CONFIRM: "2027-01-01" };
    for (const [key, value] of Object.entries(due)) await ws.setCell({ resourceId: UI, key, cellId: "due", value });
    const ui = (where: string) => keys(where, { resourceId: UI });
    // 文字として比べると、1.25 は 1.3 より大きくなってしまう（"25" と "3" を比べる）。
    expect(await ui("priority > 1.3")).toEqual(["UI_OK", "UI_GOLD"]);
    expect(await ui("priority < 0")).toEqual(["UI_CANCEL"]);
    expect(await ui("priority = 1.50")).toEqual(["UI_OK"]);
    expect(await ui("due >= 2026-11-10")).toEqual(["UI_OK", "UI_SAVE_CONFIRM"]);
    expect(await ui("due < 2026-11-10")).toEqual(["UI_CANCEL"]);
    expect(await ui("due is empty")).toEqual(["UI_GOLD"]);
  });

  it("文字の比較: = は完全に一致、~ は大文字小文字を区別しない部分一致。引用符で空白を含む値を書ける", async () => {
    const ui = (where: string) => keys(where, { resourceId: UI });
    expect(await ui("text@JaEnglish = OK")).toEqual(["UI_OK"]);
    expect(await ui("text@JaEnglish = ok")).toEqual([]);
    expect(await ui("text@JaEnglish ~ ok")).toEqual(["UI_OK"]);
    expect(await ui('text@JaEnglish = "Save your progress?"')).toEqual(["UI_SAVE_CONFIRM"]);
    expect(await ui('text@JaEnglish !~ "o"')).toEqual(["UI_CANCEL"]);
    expect(await ui("key = UI_GOLD")).toEqual(["UI_GOLD"]);
  });

  it("未保存の編集: 本文の条件は未保存の値で確かめ、unsaved で未保存の行を絞れる", async () => {
    expect(await keys("unsaved")).toEqual([]);
    await ws.setText({ resourceId: CHAPTER, key: CH.b, language: "ko", value: "믿을 수 있을까" });
    expect(await keys("text@ko is empty")).toEqual([]);
    expect(await keys("unsaved")).toEqual([CH.b]);
    expect(await keys("unsaved@ko = true")).toEqual([CH.b]);
    expect(await keys("unsaved@ja")).toEqual([]);
    expect(await keys("not unsaved")).toEqual(CH_ALL.filter((k) => k !== CH.b));
  });

  it("stale: レビューのあとで本文が変わった行を絞れる（言語を付けると、その言語だけ）", async () => {
    expect(await keys("stale")).toEqual([]);
    await ws.postReview({ resourceId: CHAPTER, key: CH.s2, cellId: "reviewStatus@ko", verdict: "ok", comment: "" });
    await ws.setText({ resourceId: CHAPTER, key: CH.s2, language: "ko", value: "해독약" });
    expect(await keys("stale")).toEqual([CH.s2]);
    expect(await keys("stale@ko")).toEqual([CH.s2]);
    expect(await keys("stale@ja")).toEqual([]);
    expect(await keys("stale = false")).toEqual(CH_ALL.filter((k) => k !== CH.s2));
  });

  it("ほかの絞り込みとは「かつ」で重なる", async () => {
    expect(await keys('key ~ "choice"', { extra: { onlyUntranslated: true } })).toEqual([CH.b]);
    expect(await keys('key ~ "choice"', { extra: { search: "信じる" } })).toEqual([CH.a]);
    const r = await ws.rows({ resourceId: CHAPTER, languages: ALL, offset: 0, limit: 1, where: 'key ~ "choice"' });
    expect(r.total).toBe(2);
    expect(r.totalAll).toBe(8);
    expect(r.rows.map((x) => x.key)).toEqual([CH.a]);
  });

  it("誤った式は、リソースを読む前に invalid で断り、何が違うかを伝える", async () => {
    await expect(keys("nope = 1")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('"nope" に当たる列がありません') });
    await expect(keys("nope = 1")).rejects.toMatchObject({ message: expect.stringContaining("使える列: key, text@言語, textStatus@言語, reviewStatus@言語, maxLength") });
    await expect(keys("textStatus@ko = finished")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("選べる値: todo, wip, done") });
    await expect(keys("key@ja = x")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('"@言語" は付けられません') });
    await expect(keys("issues > heavy")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("none / info / warning / error") });
    await expect(keys("stale = maybe")).rejects.toMatchObject({ code: "invalid" });
    await expect(keys("text@ko = ")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("条件式の 11 文字目") });
    await expect(ws.rows({ resourceId: CHAPTER, languages: ALL, offset: 0, limit: 1, where: 5 as never })).rejects.toMatchObject({ code: "invalid" });
    // ないリソースでも、式の誤りを先に伝える。
    await expect(keys("nope = 1", { resourceId: "nope.csv" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("query（リソースをまたぐ問い合わせ）", () => {
  it("条件に合う行を、リソースごとに数える。合う行が 0 のリソースも返す", async () => {
    const r = await ws.query({ languages: ALL, where: "issues >= error" });
    // リソースは、ツリーの並び順（フォルダが先）。
    expect(r.resources).toEqual([
      { resourceId: UI, path: UI, matched: 1, total: 4 },
      { resourceId: CHAPTER, path: CHAPTER, matched: 4, total: 8 },
    ]);
    expect(r.totalRows).toBe(12);
    expect(r.unreadable).toEqual([]);
    // 既定では行を返さない（数だけ）。
    expect(r.rows).toEqual([]);
    expect(r.groups).toBeUndefined();
    const none = await ws.query({ languages: ALL, where: 'key ~ "shop"' });
    expect(none.resources.map((x) => x.matched)).toEqual([0, 2]);
  });

  it("合う行の、原文の文字数と語数を合計する", async () => {
    // <b>信じる</b> = 10、{count} 個の薬草を手に入れた = 18（2 語）、①回復薬 = 4、毒消し = 3、セーブしますか？ = 8。
    const r = await ws.query({ languages: ALL, where: "issues >= error" });
    expect(r.matched).toEqual({ rows: 5, characters: 43, words: 6 });
    // 条件がなければ、すべての行。
    expect((await ws.query({ languages: ["ja"] })).matched.rows).toBe(12);
  });

  it("絞り込み（rows と同じ条件）を、where と重ねて使える", async () => {
    const r = await ws.query({ languages: ["ko"], onlyUntranslated: true });
    expect(r.resources.map((x) => [x.path, x.matched])).toEqual([
      [UI, 0],
      [CHAPTER, 1],
    ]);
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    const byValue = await ws.query({ languages: ["ko"], filters: [{ cellId: "textStatus@ko", values: ["done"] }], where: "maxLength < 10" });
    expect(byValue.resources.map((x) => x.matched)).toEqual([1, 0]);
  });

  it("resourceIds で対象を絞れる。ないリソースは not-found", async () => {
    const r = await ws.query({ languages: ALL, resourceIds: [UI], where: "issues >= error" });
    expect(r.resources).toEqual([{ resourceId: UI, path: UI, matched: 1, total: 4 }]);
    expect(r.totalRows).toBe(4);
    await expect(ws.query({ languages: ALL, resourceIds: ["nope.csv"] })).rejects.toMatchObject({ code: "not-found" });
  });

  it("resource の欄で、リソースのパスを条件にできる", async () => {
    const r = await ws.query({ languages: ["ja"], where: 'resource ~ "system/"' });
    expect(r.resources.map((x) => x.matched)).toEqual([4, 0]);
  });

  it("groupBy: 欄の値ごとに、行数と原文の量を数える。選択式の列は選択肢の順に並び、表示名が付く", async () => {
    await ws.setCell({ resourceId: CHAPTER, key: CH.i1, cellId: "textStatus@ko", value: "done" });
    await ws.setCell({ resourceId: CHAPTER, key: CH.i2, cellId: "textStatus@ko", value: "wip" });
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    const r = await ws.query({ languages: ALL, groupBy: ["textStatus@ko"] });
    // 原文は全体で 129 文字、15 語。目が覚めたか、{player}。 = 16 文字、決定 = 2 文字、ここは……どこだ？ = 9 文字（どれも 1 語）。
    expect(r.groups).toEqual([
      { values: ["todo"], labels: ["未着手"], rows: 9, characters: 102, words: 12 },
      { values: ["wip"], labels: ["作業中"], rows: 1, characters: 9, words: 1 },
      { values: ["done"], labels: ["確定"], rows: 2, characters: 18, words: 2 },
    ]);
  });

  it("groupBy: 問題の重さ、リソース、複数の欄の組でも数えられる。条件に合う行だけが対象", async () => {
    const bySeverity = await ws.query({ languages: ALL, resourceIds: [CHAPTER], groupBy: ["issues@ko"] });
    expect(bySeverity.groups?.map((g) => [g.values[0], g.rows])).toEqual([
      ["none", 5],
      ["warning", 2],
      ["error", 1],
    ]);
    const byResource = await ws.query({ languages: ALL, where: "issues >= error", groupBy: ["resource"] });
    // リソースのパスの順。
    expect(byResource.groups?.map((g) => [g.labels[0], g.rows])).toEqual([
      [CHAPTER, 4],
      [UI, 1],
    ]);
    const pair = await ws.query({ languages: ALL, resourceIds: [UI], groupBy: ["issues@JaEnglish", "maxLength"] });
    expect(pair.groups?.map((g) => [g.values, g.labels, g.rows])).toEqual([
      [["none", "4"], ["none", "4"], 1],
      [["none", "6"], ["none", "6"], 1],
      [["none", null], ["none", "（空）"], 1],
      [["error", "12"], ["error", "12"], 1],
    ]);
  });

  it("groupBy に、1 つの値に決まらない欄（言語を省いた列、@any）は使えない", async () => {
    await expect(ws.query({ languages: ALL, groupBy: ["textStatus"] })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("言語を 1 つ決めて") });
    await expect(ws.query({ languages: ALL, groupBy: ["textStatus@any"] })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.query({ languages: ALL, groupBy: ["nope"] })).rejects.toMatchObject({ code: "invalid" });
  });

  it("行の一覧: リソースをまたいだ並びの offset から limit 個を返し、cells で返すセルを選べる", async () => {
    // ui.csv（4 行）のあとに chapter01.csv（8 行）。
    const r = await ws.query({ languages: ALL, offset: 2, limit: 3, cells: ["text@ja", "maxLength"] });
    expect(r.rows.map((x) => [x.path, x.key])).toEqual([
      [UI, "UI_SAVE_CONFIRM"],
      [UI, "UI_GOLD"],
      [CHAPTER, CH.i1],
    ]);
    expect(r.rows[0]!.cells).toEqual({ "text@ja": { value: "セーブしますか？", issues: [] }, maxLength: { value: "12" } });
    expect((await ws.query({ languages: ALL, offset: 11, limit: 3, cells: [] })).rows.map((x) => x.key)).toEqual([CH.s2]);
    expect(r.matched.rows).toBe(12);
    // cells を省くと、対象の言語のすべての列（キーの列は、行の key にあるので入れない）。
    const all = await ws.query({ languages: ["ja", "ko"], resourceIds: [UI], limit: 1 });
    expect(Object.keys(all.rows[0]!.cells)).toEqual(["text@ja", "text@ko", "textStatus@ja", "textStatus@ko", "reviewStatus@ja", "reviewStatus@ko", "maxLength"]);
    // 行の問題も付く。
    const issue = await ws.query({ languages: ALL, where: "key = UI_SAVE_CONFIRM", limit: 5, cells: ["text@JaEnglish"] });
    expect(issue.rows[0]!.cells["text@JaEnglish"]!.issues?.map((i) => i.code)).toEqual(["too-long"]);
  });

  it("読めないリソースがあっても、ほかのリソースは数え、読めなかったものを返す", async () => {
    // ツリーに載ったあとで消えたリソース。
    await tp.write("Assets/Text/gone.csv", "ID,JP\nA,あ\n");
    await ws.tree();
    await rm(path.join(tp.root, "Assets", "Text", "gone.csv"));
    const r = await ws.query({ languages: ["ja"], where: 'key ~ "UI_"' });
    expect(r.unreadable.map((x) => x.path)).toEqual(["Assets/Text/gone.csv"]);
    expect(r.unreadable[0]!.error).toContain("gone.csv");
    expect(r.resources.map((x) => [x.path, x.matched])).toEqual([
      [UI, 4],
      [CHAPTER, 0],
    ]);
    expect(r.totalRows).toBe(12);
  });

  it("引数の形の誤りは invalid", async () => {
    await expect(ws.query({ languages: "ja" as never })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.query({ languages: ["xx"] })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.query({ languages: ALL, cells: ["nope"] })).rejects.toMatchObject({ code: "not-found" });
    await expect(ws.query({ languages: ALL, groupBy: "key" as never })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("exportQuery（CSV / TSV への書き出し）", () => {
  it("条件に合う行を CSV にする。見出しはリソース、キー、セルの ID。行の終わりは CRLF", async () => {
    const r = await ws.exportQuery({ languages: ALL, format: "csv", resourceIds: [UI], where: "maxLength >= 6", cells: ["text@ja", "text@JaEnglish", "maxLength"] });
    expect(r.text).toBe(
      ["resource,key,text@ja,text@JaEnglish,maxLength", `${UI},UI_CANCEL,キャンセル,Cancel,6`, `${UI},UI_SAVE_CONFIRM,セーブしますか？,Save your progress?,12`, ""].join("\r\n"),
    );
    expect(r.rows).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it("区切り文字、引用符、改行を含む値は、引用符で囲む", async () => {
    await ws.setText({ resourceId: CHAPTER, key: CH.i2, language: "JaEnglish", value: 'He said "where"' });
    const r = await ws.exportQuery({ languages: ALL, format: "csv", where: 'key ~ "intro"', cells: ["text@JaEnglish"] });
    expect(r.text).toBe(
      [
        "resource,key,text@JaEnglish",
        `${CHAPTER},${CH.i1},"You're awake, {player}."`,
        `${CHAPTER},${CH.i2},"He said ""where"""`,
        `${CHAPTER},${CH.i3},"A clinic on the outskirts of the capital.\nThree days ago, I carried you here after you collapsed in the forest."`,
        "",
      ].join("\r\n"),
    );
  });

  it("改行だけを含む値（カンマも引用符もない）も、引用符で囲む", async () => {
    const r = await ws.exportQuery({ languages: ALL, format: "csv", where: `key = ${CH.i3}`, cells: ["text@ja"] });
    expect(r.text).toBe(`resource,key,text@ja\r\n${CHAPTER},${CH.i3},"王都の外れにある診療所だ。\n三日前、森で倒れていたお前を運んできた。"\r\n`);
  });

  it("TSV はタブで区切る（カンマを含む値は囲まない）。選択式の列は、値を書く", async () => {
    await ws.setCell({ resourceId: CHAPTER, key: CH.i1, cellId: "textStatus@ko", value: "done" });
    const r = await ws.exportQuery({ languages: ALL, format: "tsv", where: `key = ${CH.i1}`, cells: ["text@JaEnglish", "textStatus@ko"] });
    expect(r.text).toBe(`resource\tkey\ttext@JaEnglish\ttextStatus@ko\r\n${CHAPTER}\t${CH.i1}\tYou're awake, {player}.\tdone\r\n`);
  });

  it("table: groups で、集計を書き出す", async () => {
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    const r = await ws.exportQuery({ languages: ALL, format: "csv", table: "groups", resourceIds: [UI], groupBy: ["textStatus@ko"] });
    expect(r.text).toBe(["textStatus@ko,rows,characters,words", "todo,3,25,4", "done,1,2,1", ""].join("\r\n"));
    expect(r.rows).toBe(2);
    await expect(ws.exportQuery({ languages: ALL, format: "csv", table: "groups" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("groupBy") });
  });

  it("知らない形式は invalid", async () => {
    await expect(ws.exportQuery({ languages: ALL, format: "xlsx" as never })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.exportQuery({ languages: ALL, format: "csv", table: "cells" as never })).rejects.toMatchObject({ code: "invalid" });
  });
});
