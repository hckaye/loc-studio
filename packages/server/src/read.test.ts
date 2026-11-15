import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "./api-types.js";
import { textHash } from "./hash.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

const ALL = ["ja", "JaEnglish", "zh-Hans", "ko"];

let tp: TestProject;
let ws: Workspace;
beforeEach(async () => {
  tp = await makeTestProject();
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

describe("info", () => {
  it("設定、列、ユーザー、DB の場所を返す", async () => {
    const info = await ws.info();
    expect(info.name).toBe("SampleGame");
    expect(info.languages.map((l) => l.id)).toEqual(ALL);
    expect(info.columns.map((c) => c.id)).toEqual(["key", "text", "textStatus", "reviewStatus"]);
    expect(info.user).toEqual({ name: "tester", source: "local", locked: false });
    expect(info.storage.path).toBe(path.join(tp.root, ".loc-studio", "meta.db"));
    expect(info.storage.shared).toBe(false);
    expect(info.validators.map((v) => v.id)).toContain("mystudio.lineWidth");
    expect(info.blockComplete).toBe(false);
    expect(info.pluginErrors).toEqual([]);
    expect(typeof info.changeSeq).toBe("number");
    expect(info.grid).toEqual({ pinCommon: true, maxPinnedRatio: 0.6 });
  });
});

describe("tree", () => {
  it("フォルダとリソース、未保存の件数", async () => {
    let tree = await ws.tree();
    const flat = JSON.stringify(tree);
    expect(flat).toContain(CHAPTER);
    expect(flat).toContain(UI);
    expect(flat).not.toContain("unsaved");
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_001", language: "ko", value: "x" });
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "y" });
    tree = await ws.tree();
    const assets = tree[0]!;
    expect(assets.unsaved).toBe(2);
    const find = (nodes: typeof tree, id: string): (typeof tree)[number] | undefined => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const c = n.children ? find(n.children, id) : undefined;
        if (c) return c;
      }
      return undefined;
    };
    expect(find(tree, CHAPTER)?.unsaved).toBe(2);
    expect(find(tree, UI)?.unsaved).toBeUndefined();
  });
});

describe("stats", () => {
  it("進捗と問題の件数。stale なレビューは complete に数えない", async () => {
    let [s] = await ws.stats({ resourceIds: [CHAPTER] });
    expect(s!.entries).toBe(8);
    expect(s!.unsaved).toBe(0);
    expect(s!.progress.textStatus!.ko).toEqual({ complete: 0, total: 8 });
    expect(s!.progress.reviewStatus!.ja).toEqual({ complete: 0, total: 8 });
    expect(s!.issues.error).toBeGreaterThan(0);

    await ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "done" });
    await ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_002", cellId: "textStatus@ko", value: "wip" });
    await ws.postReview({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "reviewStatus@ko", verdict: "ok", comment: "" });
    await ws.postReview({ resourceId: CHAPTER, key: "CH01_INTRO_002", cellId: "reviewStatus@ko", verdict: "ok", comment: "" });
    [s] = await ws.stats({ resourceIds: [CHAPTER] });
    expect(s!.progress.textStatus!.ko).toEqual({ complete: 1, total: 8 });
    expect(s!.progress.reviewStatus!.ko).toEqual({ complete: 2, total: 8 });

    // 本文が変わったレビューと textStatus（basis: text）は complete に数えない。
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_001", language: "ko", value: "바뀜" });
    [s] = await ws.stats({ resourceIds: [CHAPTER] });
    expect(s!.unsaved).toBe(1);
    expect(s!.progress.reviewStatus!.ko).toEqual({ complete: 1, total: 8 });
    expect(s!.progress.textStatus!.ko).toEqual({ complete: 0, total: 8 });
  });

  it("2 つのリソースをまとめて返し、キャッシュする", async () => {
    const a = await ws.stats({ resourceIds: [CHAPTER, UI] });
    expect(a.map((s) => s.resourceId)).toEqual([CHAPTER, UI]);
    const b = await ws.stats({ resourceIds: [CHAPTER, UI] });
    expect(b[0]).toBe(a[0]);
  });

  it("知らないリソースは not-found", async () => {
    await expect(ws.stats({ resourceIds: ["nope.csv"] })).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("rows", () => {
  it("ページと件数、セルの形", async () => {
    const r = await ws.rows({ resourceId: CHAPTER, languages: ["ja", "ko"], offset: 2, limit: 3 });
    expect(r.total).toBe(8);
    expect(r.totalAll).toBe(8);
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_INTRO_003", "CH01_CHOICE_001A", "CH01_CHOICE_001B"]);
    expect(r.rows[0]!.index).toBe(2);
    const cells = r.rows[0]!.cells;
    expect(Object.keys(cells).sort()).toEqual(
      ["key", "text@ja", "text@ko", "textStatus@ja", "textStatus@ko", "reviewStatus@ja", "reviewStatus@ko"].sort(),
    );
    expect(cells["key"]!.value).toBe("CH01_INTRO_003");
    expect(cells["text@ja"]!.value).toContain("王都の外れ");
    // 値のない enum の列は既定値（版なし）。
    expect(cells["textStatus@ko"]).toEqual({ value: "todo" });
    expect(cells["reviewStatus@ko"]).toEqual({ value: "none" });
    expect(r.diagnostics).toEqual([]);
  });

  it("本文のセルに問題を付ける", async () => {
    const r = await ws.rows({ resourceId: CHAPTER, languages: ["ja", "zh-Hans", "ko"], offset: 0, limit: 100 });
    const row = (k: string) => r.rows.find((x) => x.key === k)!;
    expect(row("CH01_CHOICE_001A").cells["text@ko"]!.issues!.map((i) => i.validatorId)).toContain("builtin.tagBalance");
    expect(row("CH01_ITEM_001").cells["text@zh-Hans"]!.issues!.map((i) => i.validatorId)).toContain("builtin.placeholders");
    const forb = row("CH01_SHOP_001").cells["text@ja"]!.issues!.find((i) => i.validatorId === "mystudio.forbiddenChars");
    expect(forb).toMatchObject({ code: "forbidden-char", severity: "error", range: { start: 0, end: 1 } });
    expect(row("CH01_INTRO_002").cells["text@ja"]!.issues).toEqual([]);
  });

  it("検索（キーと表示中の言語の本文、大文字小文字を区別しない）", async () => {
    let r = await ws.rows({ resourceId: CHAPTER, languages: ["JaEnglish"], offset: 0, limit: 50, search: "TRUST" });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_CHOICE_001A"]);
    r = await ws.rows({ resourceId: CHAPTER, languages: ["ja"], offset: 0, limit: 50, search: "trust" });
    expect(r.total).toBe(0);
    r = await ws.rows({ resourceId: CHAPTER, languages: ["ja"], offset: 0, limit: 50, search: "shop" });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_SHOP_001", "CH01_SHOP_002"]);
    // ドラフトも検索の対象。
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ja", value: "ドラフトの本文 Zebra" });
    r = await ws.rows({ resourceId: CHAPTER, languages: ["ja"], offset: 0, limit: 50, search: "zebra" });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_INTRO_002"]);
  });

  it("onlyUntranslated / onlyIssues / onlyUnsaved", async () => {
    let r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 50, onlyUntranslated: true });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_CHOICE_001B"]);
    r = await ws.rows({ resourceId: CHAPTER, languages: ["JaEnglish"], offset: 0, limit: 50, onlyUntranslated: true });
    expect(r.total).toBe(0);

    r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 50, onlyIssues: "error" });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_CHOICE_001A"]);
    r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 50, onlyIssues: "warning" });
    expect(r.rows.map((x) => x.key)).toEqual(expect.arrayContaining(["CH01_CHOICE_001A", "CH01_CHOICE_001B"]));
    await expect(ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 5, onlyIssues: "bad" as never })).rejects.toMatchObject({
      code: "invalid",
    });

    r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 50, onlyUnsaved: true });
    expect(r.total).toBe(0);
    await ws.setText({ resourceId: CHAPTER, key: "CH01_SHOP_002", language: "ja", value: "毒消し草" });
    r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 50, onlyUnsaved: true });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_SHOP_002"]);
  });

  it("onlyStale: レビュー後の本文の変更と、要再確認", async () => {
    let r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 50, onlyStale: true });
    expect(r.total).toBe(0);
    await ws.postReview({ resourceId: CHAPTER, key: "CH01_SHOP_002", cellId: "reviewStatus@ko", verdict: "ok", comment: "" });
    await ws.setText({ resourceId: CHAPTER, key: "CH01_SHOP_002", language: "ko", value: "해독약" });
    r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 50, onlyStale: true });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_SHOP_002"]);
    expect(r.rows[0]!.cells["reviewStatus@ko"]!.stale).toBe(true);
    // 表示していない言語の stale は数えない。
    r = await ws.rows({ resourceId: CHAPTER, languages: ["ja"], offset: 0, limit: 50, onlyStale: true });
    expect(r.total).toBe(0);
  });

  it("列の値での絞り込み（未設定は既定値）", async () => {
    await ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "done" });
    await ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_002", cellId: "textStatus@ko", value: "wip" });
    let r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 50, filters: [{ cellId: "textStatus@ko", values: ["done"] }] });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_INTRO_001"]);
    r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 50, filters: [{ cellId: "textStatus@ko", values: ["todo"] }] });
    expect(r.total).toBe(6);
    r = await ws.rows({
      resourceId: CHAPTER,
      languages: ["ko"],
      offset: 0,
      limit: 50,
      filters: [
        { cellId: "textStatus@ko", values: ["todo", "wip"] },
        { cellId: "reviewStatus@ko", values: ["none"] },
      ],
      search: "intro",
    });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_INTRO_002", "CH01_INTRO_003"]);
    // 表示していない言語の列でも絞り込める。
    r = await ws.rows({ resourceId: CHAPTER, languages: ["ja"], offset: 0, limit: 50, filters: [{ cellId: "textStatus@ko", values: ["wip"] }] });
    expect(r.rows.map((x) => x.key)).toEqual(["CH01_INTRO_002"]);
    await expect(
      ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 5, filters: [{ cellId: "nope@ko", values: [] }] }),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("ドラフトを表示する", async () => {
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "어디야?" });
    const r = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 1, limit: 1 });
    expect(r.rows[0]!.cells["text@ko"]).toMatchObject({ value: "어디야?", saved: "여기는…… 어디지?", draft: true });
  });

  it("知らない言語は invalid", async () => {
    await expect(ws.rows({ resourceId: CHAPTER, languages: ["xx"], offset: 0, limit: 5 })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("rowDetail", () => {
  it("全言語・全列", async () => {
    const d = await ws.rowDetail({ resourceId: UI, key: "UI_OK" });
    expect(d.languages).toEqual(ALL);
    expect(d.row.cells["text@zh-Hans"]!.value).toBe("确定");
    expect(Object.keys(d.row.cells)).toHaveLength(1 + 3 * 4);
    await expect(ws.rowDetail({ resourceId: UI, key: "NOPE" })).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("search", () => {
  it("リソースをまたいで探し、言語とスニペットを返す", async () => {
    const hits = await ws.search({ query: "{gold}" });
    expect(hits.length).toBe(4);
    expect(hits.every((h) => h.resourceId === UI && h.key === "UI_GOLD")).toBe(true);
    const ko = await ws.search({ query: "확인", languages: ["ko"] });
    expect(ko).toEqual([{ resourceId: UI, key: "UI_OK", language: "ko", snippet: "확인" }]);
    const keys = await ws.search({ query: "ch01_intro", limit: 2 });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({ resourceId: CHAPTER, key: "CH01_INTRO_001", snippet: "CH01_INTRO_001" });
    expect(keys[0]!.language).toBeUndefined();
    expect(await ws.search({ query: "  " })).toEqual([]);
  });
});

describe("textVersion", () => {
  it("レビューで参照した本文の全文を引ける", async () => {
    await ws.postReview({ resourceId: UI, key: "UI_OK", cellId: "reviewStatus@JaEnglish", verdict: "ok", comment: "" });
    const [post] = await ws.reviews({ resourceId: UI, key: "UI_OK", cellId: "reviewStatus@JaEnglish" });
    expect(post!.basisHash).toBe(textHash("OK"));
    expect(await ws.textVersion({ hash: post!.basisHash! })).toEqual({ text: "OK" });
    expect(await ws.textVersion({ hash: "0".repeat(64) })).toEqual({});
  });
});

describe("changes", () => {
  it("共有 DB の変更番号と、このワークスペースの変更番号", async () => {
    const c0 = await ws.changes({ since: -1 });
    expect(c0.changed).toBe(true);
    const c1 = await ws.changes({ since: c0.changeSeq });
    expect(c1.changed).toBe(false);
    // ドラフトは共有 DB を変えないが localSeq は進む。
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    const c2 = await ws.changes({ since: c0.changeSeq });
    expect(c2.changed).toBe(false);
    expect(c2.localSeq).toBeGreaterThan(c1.localSeq);
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" });
    const c3 = await ws.changes({ since: c0.changeSeq });
    expect(c3.changed).toBe(true);
    expect(c3.changeSeq).toBeGreaterThan(c0.changeSeq);
  });
});

describe("validateText", () => {
  it("rows が setText のあとに出す結果と同じで、何も保存しない", async () => {
    const value = "소지금: G  ";
    const before = await ws.changes({ since: -1 });
    const issues = await ws.validateText({ resourceId: UI, key: "UI_GOLD", language: "ko", value });
    expect(issues.map((i) => i.validatorId)).toEqual(expect.arrayContaining(["builtin.placeholders", "builtin.whitespace"]));
    const after = await ws.changes({ since: before.changeSeq });
    expect(after).toEqual({ changeSeq: before.changeSeq, changed: false, localSeq: before.localSeq });
    let d = await ws.rowDetail({ resourceId: UI, key: "UI_GOLD" });
    expect(d.row.cells["text@ko"]).toMatchObject({ value: "소지금: {gold} G" });
    expect(d.row.cells["text@ko"]!.draft).toBeUndefined();
    expect(d.row.cells["text@ko"]!.issues).toEqual([]);
    expect(await ws.history({ resourceId: UI, key: "UI_GOLD" })).toEqual([]);

    await ws.setText({ resourceId: UI, key: "UI_GOLD", language: "ko", value });
    d = await ws.rowDetail({ resourceId: UI, key: "UI_GOLD" });
    expect(d.row.cells["text@ko"]!.issues).toEqual(issues);
  });

  it("基の言語の本文はドラフト込み", async () => {
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ja", value: "決定 {x}" });
    const issues = await ws.validateText({ resourceId: UI, key: "UI_OK", language: "JaEnglish", value: "OK" });
    expect(issues.map((i) => i.validatorId)).toContain("builtin.placeholders");
  });

  it("知らないキー・言語は not-found", async () => {
    await expect(ws.validateText({ resourceId: UI, key: "NOPE", language: "ko", value: "x" })).rejects.toMatchObject({ code: "not-found" });
    await expect(ws.validateText({ resourceId: UI, key: "UI_OK", language: "xx", value: "x" })).rejects.toMatchObject({ code: "not-found" });
    await expect(ws.validateText({ resourceId: "nope", key: "UI_OK", language: "ko", value: "x" })).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("info.localSettings", () => {
  it("解決済みのローカル設定の値。秘密情報は伏せる", async () => {
    await ws.setLocalSetting({ key: "secrets.llm.apiKey", value: "sk-secret" });
    const info = await ws.info();
    expect(info.localSettings).toMatchObject({ "user.name": "tester", "ui.theme": "light", "review.forwardOnPost": "ask", "plugins.local.formats": "deny" });
    expect(info.localSettings["secrets.llm.apiKey"]).toBe((await ws.settings()).local.find((s) => s.key === "secrets.llm.apiKey")!.value);
    expect(JSON.stringify(info)).not.toContain("sk-secret");
  });
});
