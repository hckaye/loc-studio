import { describe, expect, it } from "vitest";
import {
  columnIdOf,
  columnKindOf,
  columnProblems,
  columnUseOf,
  defaultColumnEntries,
  languageProblems,
  mappingProblems,
  newColumnEntry,
  newLanguage,
  parseEntryJson,
  readMapping,
  suggestColumnId,
  withSeverity,
  writeMapping,
  type AvailableColumn,
  type ColumnEntry,
} from "./config-edit";

/* 設定の画面の編集の計算。期待する設定の形は、ここに書き下す。 */

const AVAILABLE: AvailableColumn[] = [
  { id: "builtin.key", kind: "key", scope: "entry" },
  { id: "builtin.text", kind: "text", scope: "language" },
  { id: "builtin.textStatus", kind: "meta", scope: "language", label: "テキスト" },
  { id: "builtin.reviewStatus", kind: "review", scope: "language", label: "レビュー" },
];

describe("言語", () => {
  const ja = { id: "ja", label: "日本語" };

  it("足す言語は、原文の言語を基にする。表示名が空なら ID を表示名にする", () => {
    expect(newLanguage([ja, { id: "en", label: "英語", basedOn: "ja" }], "ko", " 韓国語 ")).toEqual({ id: "ko", label: "韓国語", basedOn: "ja" });
    expect(newLanguage([ja], "ko", "  ")).toEqual({ id: "ko", label: "ko", basedOn: "ja" });
    expect(newLanguage([], "ja", "")).toEqual({ id: "ja", label: "ja" });
  });

  it("誤りがなければ空。重複、空の一覧、基にする言語の誤りを知らせる", () => {
    expect(languageProblems([ja, { id: "en", label: "英語", basedOn: "ja" }], ["ja"])).toEqual([]);
    expect(languageProblems([], [])).toEqual(["言語を 1 つ以上残してください。"]);
    expect(languageProblems([ja, { ...ja }], ["ja"])).toEqual(['言語の ID "ja" が重複しています。']);
    expect(languageProblems([{ id: "ja", label: "日本語", basedOn: "ja" }], ["ja"])).toEqual(['言語 "ja" の基にする言語に、その言語自身は選べません。']);
    // 基にしていた言語を消したとき。
    expect(languageProblems([{ id: "en", label: "英語", basedOn: "ja" }], ["ja", "en"])).toEqual(['言語 "en" の基にする言語 "ja" がありません。基にする言語を選び直してください。']);
  });

  it("ID の文字の決まりは、新しく足した言語だけに当てる（すでにある言語の ID は、そのまま使える）", () => {
    expect(languageProblems([{ id: "ja jp", label: "x" }], [])).toHaveLength(1);
    expect(languageProblems([{ id: "ja jp", label: "x" }], [])[0]).toContain('言語の ID "ja jp" は使えません。半角の英数字で始め');
    expect(languageProblems([{ id: "Any", label: "x" }], [])[0]).toContain("条件式で");
    expect(languageProblems([{ id: "ja jp", label: "x" }, { id: "all", label: "y" }], ["ja jp", "all"])).toEqual([]);
  });
});

describe("列", () => {
  it("設定に列がないときの 2 列は、登録名で選ぶ書き方にする", () => {
    expect(defaultColumnEntries()).toEqual([
      { use: "builtin.key", id: "key" },
      { use: "builtin.text", id: "text" },
    ]);
  });

  it("ID と種類は、登録名で選んだ列でも、定義をそのまま書いた列でも読める", () => {
    const used: ColumnEntry = { use: "builtin.textStatus" };
    const inline: ColumnEntry = { id: "note", kind: "meta", scope: "entry" };
    expect([columnIdOf(used), columnKindOf(used, AVAILABLE)]).toEqual(["builtin.textStatus", "meta"]);
    expect([columnIdOf(inline), columnKindOf(inline, AVAILABLE)]).toEqual(["note", "meta"]);
    expect(columnKindOf({ use: "nope.column", id: "x" }, AVAILABLE)).toBeUndefined();
    // kind を書いた項目は、use があっても、列の定義そのもの（サーバーの読み方と同じ）。
    const both = { use: "builtin.textStatus", id: "flag", kind: "computed", scope: "entry" } as unknown as ColumnEntry;
    expect([columnUseOf(both), columnKindOf(both, AVAILABLE)]).toEqual([undefined, "computed"]);
  });

  it("足す列の ID は登録名の最後の部分。使われていたら数字を付ける", () => {
    expect(suggestColumnId("builtin.textStatus", ["key", "text"])).toBe("textStatus");
    expect(suggestColumnId("builtin.textStatus", ["textStatus", "textStatus2"])).toBe("textStatus3");
    expect(suggestColumnId("plain", [])).toBe("plain");
  });

  it("レビュー列を足すと、対象（of）に最初の本文の列が入る。ほかの列には of を付けない", () => {
    const entries = defaultColumnEntries();
    expect(newColumnEntry(AVAILABLE[3]!, "reviewStatus", entries, AVAILABLE)).toEqual({ use: "builtin.reviewStatus", id: "reviewStatus", of: "text" });
    expect(newColumnEntry(AVAILABLE[2]!, "textStatus", entries, AVAILABLE)).toEqual({ use: "builtin.textStatus", id: "textStatus" });
  });

  it("誤り: ID の重複、対象のないレビュー列、キーや本文の列がない", () => {
    const base = defaultColumnEntries();
    expect(columnProblems([...base, { use: "builtin.reviewStatus", id: "review", of: "text" }], AVAILABLE)).toEqual([]);
    expect(columnProblems([...base, { use: "builtin.textStatus", id: "text" }], AVAILABLE)).toEqual(['列の ID "text" が重複しています。']);
    expect(columnProblems([...base, { use: "builtin.reviewStatus", id: "review", of: "nope" }], AVAILABLE)[0]).toContain('レビューの列 "review" の対象の列（of）がありません');
    expect(columnProblems([base[0]!], AVAILABLE)).toEqual(["本文の列がありません。"]);
    expect(columnProblems([base[1]!], AVAILABLE)).toEqual(["キーの列がありません。"]);
  });
});

describe("検証", () => {
  it("重さを付けるとオブジェクトの書き方になり、外してほかの項目もなければ名前だけに戻る", () => {
    expect(withSeverity("builtin.whitespace", "info")).toEqual({ use: "builtin.whitespace", severity: "info" });
    expect(withSeverity({ use: "builtin.whitespace", severity: "info" }, undefined)).toBe("builtin.whitespace");
    expect(withSeverity({ use: "x.width", options: { max: 3 }, severity: "error" }, undefined)).toEqual({ use: "x.width", options: { max: 3 } });
  });
});

describe("CSV / TSV の列の対応", () => {
  const LANGS = ["ja", "en"];

  it("formats がなければ既定の対応。雛形の書き方（CSV と TSV に同じ対応）はまとめて読める", () => {
    expect(readMapping(undefined)).toEqual({ mapping: { key: "", text: {}, encoding: "auto" } });
    const options = { key: "ID", text: { ja: "JP" }, encoding: "shift_jis" };
    expect(readMapping([{ use: "builtin.csv", match: "**/*.csv", options }, { use: "builtin.tsv", match: "**/*.tsv", options }])).toEqual({
      mapping: { key: "ID", text: { ja: "JP" }, encoding: "shift_jis" },
    });
  });

  it("まとめて編集できない書き方は、理由を返す", () => {
    const differ = readMapping([{ use: "builtin.csv", options: { key: "ID" } }, { use: "builtin.tsv", options: { key: "Key" } }]);
    expect(differ).toEqual({ reason: expect.stringContaining("フォーマットごとに違う列の対応") });
    expect(readMapping([{ use: "studio.xml" }])).toEqual({ reason: expect.stringContaining("同梱の CSV / TSV（builtin.csv、builtin.tsv）がありません") });
    expect(readMapping([{ use: "builtin.csv", options: { text: { ja: 1 } } }] as never)).toEqual({ reason: expect.stringContaining("フォーマットごとに違う") });
  });

  it("formats がないときは、対応を変えたら雛形と同じ 2 つの項目を書く。既定のままなら書かない", () => {
    expect(writeMapping(undefined, { key: "", text: {}, encoding: "auto" }, LANGS)).toBeNull();
    // 言語 ID と同じ見出しは、書かない。
    expect(writeMapping(undefined, { key: "", text: { ja: "ja", en: "" }, encoding: "auto" }, LANGS)).toBeNull();
    expect(writeMapping(undefined, { key: "ID", text: { ja: "JP", en: "en" }, encoding: "utf-8" }, LANGS)).toEqual([
      { use: "builtin.csv", match: "**/*.csv", options: { key: "ID", text: { ja: "JP" }, encoding: "utf-8" } },
      { use: "builtin.tsv", match: "**/*.tsv", options: { key: "ID", text: { ja: "JP" }, encoding: "utf-8" } },
    ]);
  });

  it("すでにある formats では、対応だけを書き換え、ほかのオプションとほかのフォーマットは変えない", () => {
    const formats = [
      { use: "builtin.csv", match: "**/*.csv", options: { key: "ID", text: { ja: "JP", en: "EN", old: "OLD" }, columns: { maxLength: "MaxLen" }, delimiter: ";" } },
      { use: "studio.xml", match: "**/*.xml", options: { key: "name" } },
    ];
    expect(writeMapping(formats, { key: "", text: { ja: "JP", en: "English" }, encoding: "shift_jis" }, LANGS)).toEqual([
      // プロジェクトにない言語（old）の対応は残す。キーを空にしたので key は消える。
      { use: "builtin.csv", match: "**/*.csv", options: { columns: { maxLength: "MaxLen" }, delimiter: ";", text: { old: "OLD", ja: "JP", en: "English" }, encoding: "shift_jis" } },
      { use: "studio.xml", match: "**/*.xml", options: { key: "name" } },
    ]);
    // 項目の並びは元のまま（設定ファイルの差分を小さくする）。新しい項目は後ろに足す。
    const written = writeMapping(formats, { key: "Key", text: { ja: "JP", en: "English" }, encoding: "shift_jis" }, LANGS)![0]!.options as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(["key", "text", "columns", "delimiter", "encoding"]);
    expect(Object.keys(written.text as object)).toEqual(["ja", "en", "old"]);
    // オプションが空になったら、options ごと消す。
    expect(writeMapping([{ use: "builtin.csv", match: "**/*.csv", options: { key: "ID" } }], { key: "", text: {}, encoding: "auto" }, LANGS)).toEqual([{ use: "builtin.csv", match: "**/*.csv" }]);
  });

  it("誤り: 同じ見出しを、キーと本文や、2 つの言語に使っている", () => {
    expect(mappingProblems({ key: "ID", text: { ja: "JP", en: "EN" }, encoding: "auto" }, LANGS)).toEqual([]);
    expect(mappingProblems({ key: "ID", text: { ja: "ID" }, encoding: "auto" }, LANGS)).toEqual(['列「ID」を、キーと言語 "ja" の本文の両方に使っています。別の列にしてください。']);
    expect(mappingProblems({ key: "", text: { ja: "T", en: "T" }, encoding: "auto" }, LANGS)).toEqual(['列「T」を、言語 "ja" の本文と言語 "en" の本文の両方に使っています。別の列にしてください。']);
  });
});

describe("詳細の JSON", () => {
  it("オブジェクトを読む。検証は名前の文字列でもよい。それ以外は理由を返す", () => {
    expect(parseEntryJson('{ "use": "a", "id": "b" }', false)).toEqual({ value: { use: "a", id: "b" } });
    expect(parseEntryJson('"builtin.whitespace"', true)).toEqual({ value: "builtin.whitespace" });
    expect(parseEntryJson('"builtin.whitespace"', false)).toEqual({ error: "オブジェクト（{ … }）で書いてください。" });
    expect(parseEntryJson("[1]", true)).toEqual({ error: "オブジェクト（{ … }）か、名前の文字列で書いてください。" });
    expect(parseEntryJson("{ broken", false)).toEqual({ error: "JSON の形が正しくありません。" });
  });
});
