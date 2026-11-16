import { describe, expect, it } from "vitest";
import { buildLayout, initialPartialPins, initialPins, progressColumn } from "./model";
import { makeInfo } from "@/test/fixtures";

describe("表の列の組み立て", () => {
  const info = makeInfo();
  it("共通グループ → 言語グループ（本文が先、ColumnDef.languages を守る）", () => {
    const l = buildLayout({ info, visibleLanguages: ["ja", "en"], pinnedLanguages: [], widths: {}, viewportWidth: 0 });
    expect(l.groups.map((g) => g.id)).toEqual(["@common", "lang:ja", "lang:en"]);
    expect(l.groups[1]!.columns.map((c) => c.cellId)).toEqual(["text@ja", "status@ja", "review@ja", "tools@ja"]);
    expect(l.groups[2]!.columns.map((c) => c.cellId)).toEqual(["text@en", "status@en", "review@en", "back@en", "tools@en"]);
    expect(l.frozen.map((c) => c.cellId)).toEqual(["key", "note", "maxLen"]);
  });
  it("隠した列は出さない。キーの列は隠せず、列をすべて隠した言語はグループごと出さない", () => {
    const base = { info, visibleLanguages: ["ja", "en"], pinnedLanguages: [], widths: {}, viewportWidth: 0 };
    const l = buildLayout({ ...base, hiddenColumns: ["note", "status", "key"] });
    expect(l.frozen.map((c) => c.cellId)).toEqual(["key", "maxLen"]);
    expect(l.groups[1]!.columns.map((c) => c.cellId)).toEqual(["text@ja", "review@ja", "tools@ja"]);
    expect(l.groups[2]!.columns.map((c) => c.cellId)).toEqual(["text@en", "review@en", "back@en", "tools@en"]);
    // 日本語にある列をすべて隠すと、日本語のグループはなくなる（英語には、英語だけの列が残る）。
    const none = buildLayout({ ...base, hiddenColumns: ["text", "status", "review", "tools"] });
    expect(none.groups.map((g) => g.id)).toEqual(["@common", "lang:en"]);
    expect(none.groups[1]!.columns.map((c) => c.cellId)).toEqual(["back@en"]);
  });
  it("ピン留めした言語は固定側に並び、幅の上限を超えたら後ろから外す", () => {
    expect(initialPins(info)).toEqual(["ja"]);
    const wide = buildLayout({ info, visibleLanguages: ["ja", "en"], pinnedLanguages: ["ja", "en"], widths: {}, viewportWidth: 3000 });
    expect(wide.effectivePins).toEqual(["ja", "en"]);
    const narrow = buildLayout({ info, visibleLanguages: ["ja", "en"], pinnedLanguages: ["ja", "en"], widths: {}, viewportWidth: 1400 });
    expect(narrow.effectivePins).toEqual(["ja"]);
    expect(narrow.autoUnpinned).toEqual(["en"]);
    const tiny = buildLayout({ info, visibleLanguages: ["ja", "en"], pinnedLanguages: ["ja"], widths: {}, viewportWidth: 200 });
    expect(tiny.effectivePins).toEqual([]);
    expect(tiny.frozen.length).toBe(3); // 共通グループは外さない
  });

  it("LanguageDef.pinned が列の配列なら、その列だけを固定する", () => {
    const info2 = makeInfo({ languages: [{ id: "ja", label: "日本語", pinned: ["text"] }, { id: "en", label: "英語", basedOn: "ja" }] });
    const l = buildLayout({ info: info2, visibleLanguages: ["ja", "en"], pinnedLanguages: initialPins(info2), partialPins: initialPartialPins(info2), widths: {}, viewportWidth: 0 });
    expect(l.frozen.map((c) => c.cellId)).toEqual(["key", "note", "maxLen", "text@ja"]);
    expect(l.scrolling.slice(0, 3).map((c) => c.cellId)).toEqual(["status@ja", "review@ja", "tools@ja"]);
    expect(l.groups.map((g) => [g.id, g.part ?? ""])).toEqual([["@common", ""], ["lang:ja", "pinned"], ["lang:ja:rest", "rest"], ["lang:en", ""]]);
  });

  it("grid.pinCommon が false なら共通グループも横スクロールする", () => {
    const info2 = makeInfo({ grid: { pinCommon: false, maxPinnedRatio: 0.9, progressUnit: "rows" } });
    const l = buildLayout({ info: info2, visibleLanguages: ["ja", "en"], pinnedLanguages: [], widths: {}, viewportWidth: 0 });
    expect(l.frozen).toEqual([]);
    expect(l.scrolling.slice(0, 3).map((c) => c.cellId)).toEqual(["key", "note", "maxLen"]);
    const pinned = buildLayout({ info: info2, visibleLanguages: ["ja", "en"], pinnedLanguages: ["en"], widths: {}, viewportWidth: 0 });
    expect(pinned.frozen[0]!.cellId).toBe("text@en");
    expect(pinned.groups.map((g) => g.id).slice(0, 2)).toEqual(["lang:en", "@common"]);
  });
});

describe("progressColumn", () => {
  it("設定の grid.progressColumn があればその列。なければ最初のレビュー列、それもなければ最初の選択式の列", () => {
    const info = makeInfo();
    expect(progressColumn(info)?.id).toBe("review");
    expect(progressColumn({ ...info, grid: { ...info.grid, progressColumn: "status" } })?.id).toBe("status");
    expect(progressColumn({ ...info, columns: info.columns.filter((c) => c.kind !== "review") })?.id).toBe("status");
    expect(progressColumn({ ...info, columns: info.columns.filter((c) => c.id === "key" || c.id === "text") })).toBeUndefined();
    // 設定の列が見つからなければ、既定の決め方に戻る。
    expect(progressColumn({ ...info, grid: { ...info.grid, progressColumn: "nope" } })?.id).toBe("review");
  });
});
