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
    expect(info.grid).toEqual({ pinCommon: true, maxPinnedRatio: 0.6, progressUnit: "rows" });
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

  it("列の値の「含む」での絞り込み（大文字小文字を区別しない。数値は文字にして比べる。values と一緒に書けば両方に合う行）", async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
    await tp.patchConfig({ columns: [...config.columns, { id: "maxLength", kind: "meta", scope: "entry", type: "string" }, { use: "builtin.length", id: "len" }] });
    await ws.reloadPlugins();
    const keys = async (filters: { cellId: string; values?: unknown[]; contains?: string }[], languages = ["ja"]) =>
      (await ws.rows({ resourceId: UI, languages, offset: 0, limit: 50, filters })).rows.map((x) => x.key);
    // 上限（リソースの中の列）: 4 / 6 / 12 / 空
    expect(await keys([{ cellId: "maxLength", contains: "1" }])).toEqual(["UI_SAVE_CONFIRM"]);
    expect(await keys([{ cellId: "maxLength", contains: "" }])).toEqual(["UI_OK", "UI_CANCEL", "UI_SAVE_CONFIRM", "UI_GOLD"]);
    // 計算列（文字数）は数値を文字にして比べる。決定 = 2、キャンセル = 5、セーブしますか？ = 8、所持金：{gold} G = 12。
    expect(await keys([{ cellId: "len@ja", contains: "2" }])).toEqual(["UI_OK", "UI_GOLD"]);
    expect(await keys([{ cellId: "len@ja", contains: "12" }])).toEqual(["UI_GOLD"]);
    expect(await keys([{ cellId: "len@ja", contains: "8" }])).toEqual(["UI_SAVE_CONFIRM"]);
    // values と contains の両方: 両方に合う行だけ。
    await ws.setCell({ resourceId: UI, key: "UI_SAVE_CONFIRM", cellId: "textStatus@ko", value: "done" });
    expect(await keys([{ cellId: "textStatus@ko", values: ["done", "todo"], contains: "DON" }])).toEqual(["UI_SAVE_CONFIRM"]);
    await expect(keys([{ cellId: "maxLength" }])).rejects.toMatchObject({ code: "invalid" });
    await expect(keys([{ cellId: "maxLength", contains: 1 as never }])).rejects.toMatchObject({ code: "invalid" });
  });

  describe("並べ替え（sort）", () => {
    const sorted = async (sort: { cellId: string; dir?: "asc" | "desc" }, extra: Record<string, unknown> = {}) =>
      (await ws.rows({ resourceId: UI, languages: ["ja", "ko"], offset: 0, limit: 50, sort, ...extra })).rows.map((x) => x.key);

    beforeEach(async () => {
      const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
      await tp.patchConfig({
        columns: [...config.columns, { id: "maxLength", kind: "meta", scope: "entry", type: "string" }, { use: "builtin.length", id: "len" }],
      });
      await ws.reloadPlugins();
    });

    it("指定がなければリソースの中の順。キーの列で並べ替えられ、降順は逆になる", async () => {
      expect((await ws.rows({ resourceId: UI, languages: ["ja"], offset: 0, limit: 50 })).rows.map((x) => x.key)).toEqual(["UI_OK", "UI_CANCEL", "UI_SAVE_CONFIRM", "UI_GOLD"]);
      expect(await sorted({ cellId: "key" })).toEqual(["UI_CANCEL", "UI_GOLD", "UI_OK", "UI_SAVE_CONFIRM"]);
      expect(await sorted({ cellId: "key", dir: "desc" })).toEqual(["UI_SAVE_CONFIRM", "UI_OK", "UI_GOLD", "UI_CANCEL"]);
    });

    it("数値は数の順（文字の順ではない）。文字の中の数字も数として比べ、値のない行は昇順でも降順でも最後", async () => {
      // 文字数（計算列。数値）: 決定 = 2、キャンセル = 5、セーブしますか？ = 8、所持金：{gold} G = 12。文字の順なら 12 が 2 の前に来る。
      expect(await sorted({ cellId: "len@ja" })).toEqual(["UI_OK", "UI_CANCEL", "UI_SAVE_CONFIRM", "UI_GOLD"]);
      expect(await sorted({ cellId: "len@ja", dir: "desc" })).toEqual(["UI_GOLD", "UI_SAVE_CONFIRM", "UI_CANCEL", "UI_OK"]);
      // 上限（リソースの中の列。文字列）: 4 / 6 / 12 / 空。
      expect(await sorted({ cellId: "maxLength" })).toEqual(["UI_OK", "UI_CANCEL", "UI_SAVE_CONFIRM", "UI_GOLD"]);
      expect(await sorted({ cellId: "maxLength", dir: "desc" })).toEqual(["UI_SAVE_CONFIRM", "UI_CANCEL", "UI_OK", "UI_GOLD"]);
    });

    it("小数と負の数も、数の大きさの順（文字として比べると 1.5 が 1.25 の前に来てしまう）", async () => {
      const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
      await tp.patchConfig({ columns: [...config.columns, { id: "priority", kind: "meta", scope: "entry", type: "number", source: "builtin.db" }] });
      await ws.reloadPlugins();
      const values: Record<string, number> = { UI_OK: 1.5, UI_CANCEL: -5, UI_SAVE_CONFIRM: 1.25, UI_GOLD: 10 };
      for (const [key, value] of Object.entries(values)) await ws.setCell({ resourceId: UI, key, cellId: "priority", value });
      expect(await sorted({ cellId: "priority" })).toEqual(["UI_CANCEL", "UI_SAVE_CONFIRM", "UI_OK", "UI_GOLD"]);
      expect(await sorted({ cellId: "priority", dir: "desc" })).toEqual(["UI_GOLD", "UI_OK", "UI_SAVE_CONFIRM", "UI_CANCEL"]);
    });

    it("日付の列は、日付の古い順（値のない行は最後）", async () => {
      const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
      await tp.patchConfig({ columns: [...config.columns, { id: "due", kind: "meta", scope: "entry", type: "date", source: "builtin.db" }] });
      await ws.reloadPlugins();
      const values: Record<string, string> = { UI_OK: "2026-11-15", UI_CANCEL: "2026-02-01", UI_GOLD: "2025-12-31" };
      for (const [key, value] of Object.entries(values)) await ws.setCell({ resourceId: UI, key, cellId: "due", value });
      expect(await sorted({ cellId: "due" })).toEqual(["UI_GOLD", "UI_CANCEL", "UI_OK", "UI_SAVE_CONFIRM"]);
      expect(await sorted({ cellId: "due", dir: "desc" })).toEqual(["UI_OK", "UI_CANCEL", "UI_GOLD", "UI_SAVE_CONFIRM"]);
    });

    it("選択式の列は、選択肢の並び順（未着手、作業中、確定）で比べる。同じ値の行は、リソースの中の順のまま", async () => {
      await ws.setCell({ resourceId: UI, key: "UI_CANCEL", cellId: "textStatus@ko", value: "done" });
      await ws.setCell({ resourceId: UI, key: "UI_GOLD", cellId: "textStatus@ko", value: "wip" });
      // 値の文字の順（done < todo < wip）ではなく、選択肢の順（todo < wip < done）。
      expect(await sorted({ cellId: "textStatus@ko" })).toEqual(["UI_OK", "UI_SAVE_CONFIRM", "UI_GOLD", "UI_CANCEL"]);
      expect(await sorted({ cellId: "textStatus@ko", dir: "desc" })).toEqual(["UI_CANCEL", "UI_GOLD", "UI_OK", "UI_SAVE_CONFIRM"]);
    });

    it("本文の列でも並べ替えられる（未保存の編集の値で比べる）。絞り込みとページの切り出しは、並べ替えたあと", async () => {
      await ws.setText({ resourceId: UI, key: "UI_SAVE_CONFIRM", language: "ko", value: "가" });
      expect((await sorted({ cellId: "text@ko" }))[0]).toBe("UI_SAVE_CONFIRM");
      expect(await sorted({ cellId: "key", dir: "desc" }, { search: "UI_" , onlyUnsaved: true })).toEqual(["UI_SAVE_CONFIRM"]);
      const page = await ws.rows({ resourceId: UI, languages: ["ja"], offset: 1, limit: 2, sort: { cellId: "key" } });
      expect(page.rows.map((x) => x.key)).toEqual(["UI_GOLD", "UI_OK"]);
      expect(page.total).toBe(4);
    });

    it("ない列、アクション列、知らない向きは断る", async () => {
      await expect(sorted({ cellId: "nope" })).rejects.toMatchObject({ code: "not-found" });
      await expect(sorted({ cellId: "key", dir: "up" as never })).rejects.toMatchObject({ code: "invalid" });
      const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
      await tp.patchConfig({ columns: [...config.columns, { id: "ops", kind: "actions", scope: "entry" }] });
      await ws.reloadPlugins();
      await expect(sorted({ cellId: "ops" })).rejects.toMatchObject({ code: "invalid" });
    });
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

describe("tokens", () => {
  it("そのリソースの記法で、本文を途切れなくトークンに分ける（texts と同じ順・同じ数）", async () => {
    const [a, b, c] = await ws.tokens({ resourceId: UI, texts: ["所持金：{gold} G", "<b>太字</b>", ""] });
    expect(a).toEqual([
      { kind: "text", value: "所持金：", range: { start: 0, end: 4 } },
      { kind: "variable", value: "{gold}", range: { start: 4, end: 10 } },
      { kind: "text", value: " G", range: { start: 10, end: 12 } },
    ]);
    expect(b!.map((t) => [t.kind, t.value])).toEqual([
      ["tag", "<b>"],
      ["text", "太字"],
      ["tag", "</b>"],
    ]);
    expect(c).toEqual([]);
  });

  it("文字列でない本文、多すぎる本文、知らないリソースは断る", async () => {
    await expect(ws.tokens({ resourceId: UI, texts: [1 as never] })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.tokens({ resourceId: UI, texts: Array.from({ length: 201 }, () => "x") })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.tokens({ resourceId: "nope.csv", texts: ["x"] })).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("info.editor", () => {
  it("設定がなければ、参照は基になる言語だけ、長さはコードポイント", async () => {
    expect((await ws.info()).editor).toEqual({ referenceLanguages: [], count: { unit: "codepoints", skipTokens: false } });
  });

  it("設定の値を返す。プロジェクトにない言語・列・数え方は使わず、警告にする", async () => {
    await tp.patchConfig({
      editor: { referenceLanguages: ["JaEnglish", "xx"], referenceColumns: ["textStatus", "nope"], count: { unit: "pixels", skipTokens: true } },
    });
    const info = await ws.reloadPlugins();
    expect(info.editor).toEqual({ referenceLanguages: ["JaEnglish"], referenceColumns: ["textStatus"], count: { unit: "codepoints", skipTokens: true } });
    expect(info.warnings.filter((w) => w.includes("editor."))).toHaveLength(3);
    await tp.patchConfig({ editor: { count: { unit: "width" }, referenceColumns: [] } });
    expect((await ws.reloadPlugins()).editor).toEqual({ referenceLanguages: [], referenceColumns: [], count: { unit: "width", skipTokens: false } });
  });
});

describe("info.grid.progressColumn", () => {
  it("設定がなければ入らない。選択式の列の ID なら入り、そうでなければ警告にして入れない", async () => {
    expect((await ws.info()).grid).toEqual({ pinCommon: true, maxPinnedRatio: 0.6, progressUnit: "rows" });
    await tp.patchConfig({ grid: { progressColumn: "textStatus" } });
    expect((await ws.reloadPlugins()).grid).toEqual({ pinCommon: true, maxPinnedRatio: 0.6, progressColumn: "textStatus", progressUnit: "rows" });
    for (const bad of ["text", "key", "nope"]) {
      await tp.patchConfig({ grid: { progressColumn: bad } });
      const info = await ws.reloadPlugins();
      expect(info.grid, bad).toEqual({ pinCommon: true, maxPinnedRatio: 0.6, progressUnit: "rows" });
      expect(info.warnings.filter((w) => w.includes("grid.progressColumn")), bad).toHaveLength(1);
    }
  });
});

describe("進捗の数え方（grid.progressUnit）", () => {
  // ui.csv の原文（ja）: 決定 = 2 文字、キャンセル = 5、セーブしますか？ = 8、所持金：{gold} G = 12（空白で区切ると 2 語）。合計 27 文字、5 語。
  const progressOf = async (column = "textStatus") => (await ws.stats({ resourceIds: [UI] }))[0]!.progress[column]!;

  beforeEach(async () => {
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    await ws.setCell({ resourceId: UI, key: "UI_GOLD", cellId: "textStatus@ko", value: "done" });
    await ws.setCell({ resourceId: UI, key: "UI_CANCEL", cellId: "textStatus@ja", value: "done" });
  });

  it("設定がなければ行数で数える", async () => {
    expect((await ws.info()).grid.progressUnit).toBe("rows");
    const p = await progressOf();
    expect(p["ko"]).toEqual({ complete: 2, total: 4 });
    expect(p["ja"]).toEqual({ complete: 1, total: 4 });
  });

  it("characters: 原文の文字数で数える（訳の言語は基になる言語の本文、原文の言語は自分の本文）", async () => {
    await tp.patchConfig({ grid: { progressUnit: "characters" } });
    expect((await ws.reloadPlugins()).grid.progressUnit).toBe("characters");
    const p = await progressOf();
    expect(p["ko"]).toEqual({ complete: 2 + 12, total: 27 });
    expect(p["ja"]).toEqual({ complete: 5, total: 27 });
    // 原文が変わると（未保存の編集でも）、重みも変わる。
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ja", value: "決定する" });
    expect((await progressOf())["ko"]).toEqual({ complete: 4 + 12, total: 29 });
  });

  it("words: 原文を空白で区切った語数で数える（空の原文は 0）", async () => {
    await tp.patchConfig({ grid: { progressUnit: "words" } });
    await ws.reloadPlugins();
    expect((await progressOf())["ko"]).toEqual({ complete: 1 + 2, total: 5 });
    await ws.setText({ resourceId: UI, key: "UI_CANCEL", language: "ja", value: "" });
    expect((await progressOf())["ko"]).toEqual({ complete: 3, total: 4 });
  });

  it("行に 1 つの列は、最初の原文の言語の本文で量る", async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
    const flag = { id: "checked", kind: "meta", scope: "entry", source: "builtin.db", type: { default: "no", enum: [{ value: "no" }, { value: "yes", complete: true }] } };
    await tp.patchConfig({ columns: [...config.columns, flag], grid: { progressUnit: "characters" } });
    await ws.reloadPlugins();
    await ws.setCell({ resourceId: UI, key: "UI_GOLD", cellId: "checked", value: "yes" });
    expect((await progressOf("checked"))["*"]).toEqual({ complete: 12, total: 27 });
  });

  it("知らない値は行数で数え、警告にする", async () => {
    await tp.patchConfig({ grid: { progressUnit: "pages" } });
    const info = await ws.reloadPlugins();
    expect(info.grid.progressUnit).toBe("rows");
    expect(info.warnings.filter((w) => w.includes("grid.progressUnit"))).toHaveLength(1);
    expect((await progressOf())["ko"]).toEqual({ complete: 2, total: 4 });
  });
});

describe("要確認の印の切り替え（validation.recheck）", () => {
  const recheckOf = async () => (await ws.rowDetail({ resourceId: UI, key: "UI_OK" })).row.cells["text@ko"]!.needsRecheck;
  const editBoth = async () => {
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    await ws.save({ resourceId: UI });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ja", value: "けってい" });
    await ws.save({ resourceId: UI });
  };

  it("既定では、訳文を保存したあとで基になる言語の本文が変わると、印が付く", async () => {
    await editBoth();
    expect(await recheckOf()).toBe(true);
    // 要確認の絞り込みにも入る。
    expect((await ws.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 10, onlyStale: true })).rows.map((r) => r.key)).toEqual(["UI_OK"]);
  });

  it("recheck: false にすると、印を付けず、要確認の絞り込みにも入らない", async () => {
    await tp.patchConfig({ validation: { recheck: false } });
    await ws.reloadPlugins();
    await editBoth();
    expect(await recheckOf()).toBeUndefined();
    expect((await ws.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 10, onlyStale: true })).rows).toEqual([]);
  });

  it("recheck: false のあいだも保存時の原文は記録し、設定を戻すと、そのあいだの変更にも正しく印が付く", async () => {
    await tp.patchConfig({ validation: { recheck: false } });
    await ws.reloadPlugins();
    await editBoth(); // 訳文を保存したあとで、原文が変わった
    // 原文を変えたあとで保存し直した訳文（UI_CANCEL）には、印が付かない。
    await ws.setText({ resourceId: UI, key: "UI_CANCEL", language: "ja", value: "やめる" });
    await ws.save({ resourceId: UI });
    await ws.setText({ resourceId: UI, key: "UI_CANCEL", language: "ko", value: "그만" });
    await ws.save({ resourceId: UI });
    await tp.patchConfig({ validation: { recheck: true } });
    await ws.reloadPlugins();
    expect(await recheckOf()).toBe(true);
    expect((await ws.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 10, onlyStale: true })).rows.map((r) => r.key)).toEqual(["UI_OK"]);
  });
});
