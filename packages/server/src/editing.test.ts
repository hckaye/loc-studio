import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "./api-types.js";
import { textHash } from "./hash.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

let tp: TestProject;
let ws: Workspace;
beforeEach(async () => {
  tp = await makeTestProject();
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

const cell = async (resourceId: string, key: string, cellId: string, languages: string[]) => {
  const d = await ws.rowDetail({ resourceId, key });
  void languages;
  return d.row.cells[cellId]!;
};

describe("setText / discardDrafts", () => {
  it("ドラフトに積み、保存済みの値に戻したら消す", async () => {
    let r = await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "어디야?" });
    expect(r.unsaved).toBe(1);
    expect(r.cell).toMatchObject({ value: "어디야?", saved: "여기는…… 어디지?", draft: true });
    expect(r.cell.issues).toEqual([]);
    r = await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "여기는…… 어디지?" });
    expect(r.unsaved).toBe(0);
    expect(r.cell).toEqual({ value: "여기는…… 어디지?", issues: [] });
  });

  it("ドラフトはワークスペースを開き直しても残る", async () => {
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "어디야?" });
    await ws.close();
    const ws2 = await tp.open();
    expect((await ws2.rowDetail({ resourceId: CHAPTER, key: "CH01_INTRO_002" })).row.cells["text@ko"]).toMatchObject({
      value: "어디야?",
      draft: true,
    });
  });

  it("ドラフトのバリデーション結果を返す", async () => {
    const r = await ws.setText({ resourceId: UI, key: "UI_GOLD", language: "ko", value: "소지금: G" });
    expect(r.cell.issues!.map((i) => i.validatorId)).toContain("builtin.placeholders");
  });

  it("知らないキーは not-found、本文でない値は invalid", async () => {
    await expect(ws.setText({ resourceId: CHAPTER, key: "NOPE", language: "ko", value: "x" })).rejects.toMatchObject({ code: "not-found" });
    await expect(ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: 1 as never })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(ws.setText({ resourceId: "nope.csv", key: "a", language: "ko", value: "x" })).rejects.toMatchObject({ code: "not-found" });
  });

  it("読み取り専用の言語は blocked", async () => {
    await tp.patchConfig({
      languages: [
        { id: "ja", label: "日本語", editable: false },
        { id: "JaEnglish", label: "英語", basedOn: "ja" },
        { id: "zh-Hans", label: "中国語", basedOn: "ja" },
        { id: "ko", label: "韓国語", basedOn: "ja" },
      ],
    });
    const ws2 = await tp.open();
    await expect(ws2.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ja", value: "x" })).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("discardDrafts（キーを指定、全部）", async () => {
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_001", language: "ko", value: "a" });
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "b" });
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ja", value: "c" });
    expect(await ws.discardDrafts({ resourceId: CHAPTER, keys: ["CH01_INTRO_002"] })).toEqual({ unsaved: 1 });
    expect(await ws.discardDrafts({ resourceId: CHAPTER })).toEqual({ unsaved: 0 });
    expect((await cell(CHAPTER, "CH01_INTRO_001", "text@ko", ["ko"])).draft).toBeUndefined();
  });
});

describe("save", () => {
  it("変えたフィールドだけを書き戻す（ほかのバイトは同じ）", async () => {
    const original = await tp.read(CHAPTER);
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "여기가 어디지?" });
    await ws.setText({ resourceId: CHAPTER, key: "CH01_SHOP_002", language: "JaEnglish", value: "Antidote, \"strong\"" });
    const r = await ws.save({ resourceId: CHAPTER });
    expect(r).toEqual({ saved: 2, conflicts: [] });
    const after = await tp.read(CHAPTER);
    const expected = original
      .replace("여기는…… 어디지?", "여기가 어디지?")
      .replace("毒消し,Antidote,", '毒消し,"Antidote, ""strong""",');
    expect(after).toBe(expected);
    const rows = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 1, limit: 1 });
    expect(rows.rows[0]!.cells["text@ko"]).toMatchObject({ value: "여기가 어디지?" });
    expect(rows.rows[0]!.cells["text@ko"]!.draft).toBeUndefined();
    expect((await ws.tree())[0]!.unsaved).toBeUndefined();
  });

  it("履歴（cause: manual）と本文の版を残す", async () => {
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "여기가 어디지?" });
    await ws.save({ resourceId: CHAPTER });
    const h = await ws.history({ resourceId: CHAPTER, key: "CH01_INTRO_002" });
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ cellId: "text@ko", oldValue: "여기는…… 어디지?", newValue: "여기가 어디지?", cause: "manual", by: "tester" });
    expect(await ws.textVersion({ hash: textHash("여기는…… 어디지?") })).toEqual({ text: "여기는…… 어디지?" });
    const only = await ws.history({ resourceId: CHAPTER, key: "CH01_INTRO_002", cellId: "text@ja" });
    expect(only).toEqual([]);
  });

  it("要再確認: 訳文を保存したあとで基の本文が変わって保存されたら印を付ける", async () => {
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "여기가 어디지?" });
    await ws.save({ resourceId: CHAPTER });
    expect((await cell(CHAPTER, "CH01_INTRO_002", "text@ko", [])).needsRecheck).toBeUndefined();

    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ja", value: "ここはどこだ？" });
    // 基の本文は保存するまで印を付けない。
    expect((await cell(CHAPTER, "CH01_INTRO_002", "text@ko", [])).needsRecheck).toBeUndefined();
    await ws.save({ resourceId: CHAPTER });
    expect((await cell(CHAPTER, "CH01_INTRO_002", "text@ko", [])).needsRecheck).toBe(true);
    // ツールで編集していない訳文には付けない。
    expect((await cell(CHAPTER, "CH01_INTRO_002", "text@zh-Hans", [])).needsRecheck).toBeUndefined();
    const stale = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 10, onlyStale: true });
    expect(stale.rows.map((r) => r.key)).toEqual(["CH01_INTRO_002"]);

    // 訳文を直して保存すると消える。
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "여기는 어디지?" });
    await ws.save({ resourceId: CHAPTER });
    expect((await cell(CHAPTER, "CH01_INTRO_002", "text@ko", [])).needsRecheck).toBeUndefined();
  });

  it("読んだあとで外部でほかの行が変わっても、両方の変更が残る", async () => {
    await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 10 });
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "여기가 어디지?" });
    const original = await tp.read(CHAPTER);
    await tp.write(CHAPTER, original.replace("毒消し,Antidote", "毒消し,Antidote!"));
    const r = await ws.save({ resourceId: CHAPTER });
    expect(r).toEqual({ saved: 1, conflicts: [] });
    const after = await tp.read(CHAPTER);
    expect(after).toContain("Antidote!");
    expect(after).toContain("여기가 어디지?");
    // 保存のあとは外部の変更も表に出る。
    const d = await ws.rowDetail({ resourceId: CHAPTER, key: "CH01_SHOP_002" });
    expect(d.row.cells["text@JaEnglish"]!.value).toBe("Antidote!");
  });

  it("同じセルが外部で変わっていたら競合として書かずに残す", async () => {
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "여기가 어디지?" });
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_001", language: "ko", value: "깼구나" });
    const original = await tp.read(CHAPTER);
    await tp.write(CHAPTER, original.replace("여기는…… 어디지?", "외부에서 바꿈"));
    const r = await ws.save({ resourceId: CHAPTER });
    expect(r.saved).toBe(1);
    expect(r.conflicts).toEqual([{ key: "CH01_INTRO_002", language: "ko" }]);
    const after = await tp.read(CHAPTER);
    expect(after).toContain("외부에서 바꿈");
    expect(after).toContain("깼구나");
    const c = await cell(CHAPTER, "CH01_INTRO_002", "text@ko", []);
    expect(c).toMatchObject({ value: "여기가 어디지?", saved: "외부에서 바꿈", draft: true });
    // 利用者がもう一度確定すると、いまの値を基にして保存できる。
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "여기가 어디지?" });
    expect(await ws.save({ resourceId: CHAPTER })).toEqual({ saved: 1, conflicts: [] });
  });

  it("外部で同じ値にされていたら競合にせずドラフトを消す", async () => {
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "같은 값" });
    await tp.write(CHAPTER, (await tp.read(CHAPTER)).replace("여기는…… 어디지?", "같은 값"));
    expect(await ws.save({ resourceId: CHAPTER })).toEqual({ saved: 0, conflicts: [] });
    expect((await ws.tree())[0]!.unsaved).toBeUndefined();
  });

  it("ドラフトがなければ何もしない", async () => {
    expect(await ws.save({ resourceId: CHAPTER })).toEqual({ saved: 0, conflicts: [] });
  });

  it("saveAll", async () => {
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "a" });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "b" });
    await ws.setText({ resourceId: UI, key: "UI_CANCEL", language: "ko", value: "c" });
    expect(await ws.saveAll()).toEqual({ resources: 2, saved: 3, conflicts: 0, conflictList: [] });
    expect(await tp.read(UI)).toContain("UI_OK,決定,OK,确定,b,4");
  });

  it("saveAll は競合の一覧も返す", async () => {
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_002", language: "ko", value: "a" });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "b" });
    await tp.write(UI, (await tp.read(UI)).replace("확인", "외부"));
    expect(await ws.saveAll()).toEqual({
      resources: 2,
      saved: 1,
      conflicts: 1,
      conflictList: [{ resourceId: UI, key: "UI_OK", language: "ko" }],
    });
  });

  it("同時に呼んでも壊れない（リソースごとに直列）", async () => {
    const keys = ["CH01_INTRO_001", "CH01_INTRO_002", "CH01_SHOP_001", "CH01_SHOP_002", "CH01_ITEM_001"];
    await Promise.all([
      ...keys.map((k, i) => ws.setText({ resourceId: CHAPTER, key: k, language: "JaEnglish", value: `v${i}` })),
      ws.save({ resourceId: CHAPTER }),
      ws.rows({ resourceId: CHAPTER, languages: ["JaEnglish"], offset: 0, limit: 10 }),
      ws.save({ resourceId: CHAPTER }),
    ]);
    await ws.save({ resourceId: CHAPTER });
    const text = await tp.read(CHAPTER);
    keys.forEach((_, i) => expect(text).toMatch(new RegExp(`,"?v${i}"?,`)));
    expect((await ws.rows({ resourceId: CHAPTER, languages: ["JaEnglish"], offset: 0, limit: 10 })).totalAll).toBe(8);
  });
});

describe("setCell / setCells", () => {
  it("列ソースに保存し、版と更新者を返し、履歴に残す", async () => {
    const c = await ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "wip" });
    expect(c).toMatchObject({ value: "wip", version: 1, updatedBy: "tester" });
    expect(c.basisHash).toBe(textHash("눈을 떴구나, {player}."));
    const h = await ws.history({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko" });
    expect(h).toEqual([expect.objectContaining({ oldValue: "todo", newValue: "wip", cause: "manual", by: "tester" })]);
  });

  it("版が合わなければ conflict（data にいまの値）", async () => {
    await ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "wip", expectedVersion: 0 });
    const err = await ws
      .setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "done", expectedVersion: 0 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "conflict", data: { cellId: "textStatus@ko", current: { value: "wip", version: 1 } } });
    const ok = await ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "done", expectedVersion: 1 });
    expect(ok.version).toBe(2);
  });

  it("basis: text の列は本文が変わると stale", async () => {
    await ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "done" });
    expect((await cell(CHAPTER, "CH01_INTRO_001", "textStatus@ko", [])).stale).toBeUndefined();
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_001", language: "ko", value: "바뀜" });
    expect((await cell(CHAPTER, "CH01_INTRO_001", "textStatus@ko", [])).stale).toBe(true);
  });

  it("本文・レビュー列・選択肢にない値は invalid", async () => {
    await expect(ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "text@ko", value: "x" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "reviewStatus@ko", value: "ok" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "zzz" })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("blockComplete: 本文に問題がある行を complete にできない", async () => {
    await tp.patchConfig({ validation: { blockComplete: "error" } });
    const ws2 = await tp.open();
    expect((await ws2.info()).blockComplete).toBe("error");
    await expect(
      ws2.setCell({ resourceId: CHAPTER, key: "CH01_CHOICE_001A", cellId: "textStatus@ko", value: "done" }),
    ).rejects.toMatchObject({ code: "blocked" });
    // complete でない選択肢や、問題のない行はよい。
    await ws2.setCell({ resourceId: CHAPTER, key: "CH01_CHOICE_001A", cellId: "textStatus@ko", value: "wip" });
    await ws2.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_002", cellId: "textStatus@ko", value: "done" });
    const r = await ws2.setCells({
      resourceId: CHAPTER,
      keys: ["CH01_CHOICE_001A", "CH01_INTRO_001", "CH01_INTRO_003"],
      cellId: "textStatus@ko",
      value: "done",
    });
    expect(r).toEqual({ updated: 2, blocked: ["CH01_CHOICE_001A"] });
  });

  it("setCells は一括で変え、履歴に cause: bulk で残す", async () => {
    const r = await ws.setCells({ resourceId: UI, keys: ["UI_OK", "UI_CANCEL", "UI_GOLD"], cellId: "textStatus@ja", value: "done" });
    expect(r).toEqual({ updated: 3, blocked: [] });
    const rows = await ws.rows({ resourceId: UI, languages: ["ja"], offset: 0, limit: 10, filters: [{ cellId: "textStatus@ja", values: ["done"] }] });
    expect(rows.total).toBe(3);
    const h = await ws.history({ resourceId: UI, key: "UI_GOLD" });
    expect(h[0]).toMatchObject({ cellId: "textStatus@ja", cause: "bulk", newValue: "done" });
  });
});

describe("日付の列（type: \"date\"）", () => {
  it("\"2026-11-15\" の形の、実在する日付だけを受け付ける。null で値を消せる", async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
    await tp.patchConfig({ columns: [...config.columns, { id: "due", kind: "meta", scope: "entry", type: "date", source: "builtin.db" }] });
    await ws.reloadPlugins();
    const set = (value: unknown) => ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "due", value });
    expect(await set("2026-11-15")).toMatchObject({ value: "2026-11-15" });
    expect(await set("2028-02-29")).toMatchObject({ value: "2028-02-29" }); // うるう年
    for (const bad of ["2026-02-30", "2026-13-01", "2026/11/15", "2026-1-5", "tomorrow", "", 20261115, true]) {
      await expect(set(bad), String(bad)).rejects.toMatchObject({ code: "invalid" });
    }
    expect((await ws.rowDetail({ resourceId: UI, key: "UI_OK" })).row.cells["due"]).toMatchObject({ value: "2028-02-29" });
    expect(await set(null)).toMatchObject({ value: null });
  });
});

describe("Shift_JIS の CSV（formats の options.encoding）", () => {
  const SJIS = "Assets/Text/sjis/menu.csv";
  const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
  // 期待するバイト列は、ここに書き下す。「表」= 95 5C、「あ」= 82 A0。
  const original = Buffer.from([...ascii("ID,JP,EN,CN,KR,MaxLen\r\nMENU_A,"), 0x95, 0x5c, ...ascii(",Table,,,\r\n")]);
  const bytes = async (): Promise<string> => (await readFile(path.join(tp.root, ...SJIS.split("/")))).toString("hex");

  beforeEach(async () => {
    await mkdir(path.join(tp.root, "Assets", "Text", "sjis"), { recursive: true });
    await writeFile(path.join(tp.root, ...SJIS.split("/")), original);
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { formats: { options: Record<string, unknown> }[] };
    await tp.patchConfig({
      formats: [{ use: "builtin.csv", match: "Assets/Text/sjis/*.csv", options: { ...config.formats[0]!.options, encoding: "shift_jis" } }, ...config.formats],
    });
    await ws.reloadPlugins();
  });

  it("読めて、保存すると変えたセルだけが Shift_JIS のバイト列で変わる", async () => {
    const rows = await ws.rows({ resourceId: SJIS, languages: ["ja"], offset: 0, limit: 10 });
    expect(rows.rows.map((r) => [r.key, r.cells["text@ja"]!.value])).toEqual([["MENU_A", "表"]]);
    await ws.setText({ resourceId: SJIS, key: "MENU_A", language: "ja", value: "あ表" });
    expect(await ws.save({ resourceId: SJIS })).toEqual({ saved: 1, conflicts: [] });
    expect(await bytes()).toBe(original.toString("hex").replace("955c", "82a0955c"));
    // ほかのリソース（UTF-8）は、これまでどおり読める。
    expect((await ws.rows({ resourceId: UI, languages: ["ja"], offset: 0, limit: 1 })).rows[0]!.cells["text@ja"]!.value).toBe("決定");
  });

  it("Shift_JIS で表せない文字の保存は、文字を示して断り、ファイルは変えず、編集は未保存のまま残す", async () => {
    await ws.setText({ resourceId: SJIS, key: "MENU_A", language: "ko", value: "확인" });
    const error = await ws.save({ resourceId: SJIS }).then(
      () => undefined,
      (e: unknown) => e as { code?: string; message: string },
    );
    expect(error?.code).toBe("failed");
    expect(error?.message).toBe("リソース Assets/Text/sjis/menu.csv に変更を当てられませんでした: 文字「확」（U+D655）は Shift_JIS で表せません。");
    expect(await bytes()).toBe(original.toString("hex"));
    const cell = (await ws.rows({ resourceId: SJIS, languages: ["ko"], offset: 0, limit: 10 })).rows[0]!.cells["text@ko"]!;
    expect(cell).toMatchObject({ value: "확인", draft: true });
  });
});
