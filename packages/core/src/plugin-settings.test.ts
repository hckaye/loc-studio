import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin, PluginSettingDef } from "@loc-studio/sdk";
import {
  createSettingsReader,
  loadPluginSettings,
  pluginSettingsFile,
  pluginSettingsFileName,
  readPluginSettingsTexts,
  resolveSettingValues,
  settingValueProblem,
  validateSettingDefs,
} from "./plugin-settings.js";
import { settingsCandidate } from "./settings-trust.js";

/* プラグインの設定: 宣言の形、値の確かめ方、設定ファイルの名前と読み込み、入口の関数に渡す窓口、信頼の確認のハッシュ。 */

const DEFS: PluginSettingDef[] = [
  { key: "max", label: "上限", type: "number", default: 10 },
  { key: "mode", label: "やり方", type: "enum", options: [{ value: "strict" }, { value: "loose", label: "ゆるい" }], default: "strict" },
  { key: "enabled", label: "使う", type: "boolean" },
  { key: "note", label: "メモ", type: "string" },
];

describe("設定の宣言の形", () => {
  it("正しい宣言には、問題がない（宣言がなくてもよい）", () => {
    expect(validateSettingDefs(DEFS)).toEqual([]);
    expect(validateSettingDefs(undefined)).toEqual([]);
    expect(validateSettingDefs([])).toEqual([]);
  });

  it("誤りは、どの項目の何が誤りかを添えて返す", () => {
    expect(validateSettingDefs({})).toEqual(["settings は配列にしてください。"]);
    expect(validateSettingDefs(["x"])).toEqual(["settings[0] はオブジェクトにしてください。"]);
    expect(validateSettingDefs([{ label: "A", type: "string" }])).toEqual(["settings[0] の key は空でない文字列にしてください。"]);
    expect(validateSettingDefs([{ key: "a", type: "string" }])).toEqual(['settings[0]（"a"） の label は空でない文字列にしてください。']);
    expect(validateSettingDefs([{ key: "a", label: "A", type: "date" }])).toEqual(['settings[0]（"a"） の type は string / number / boolean / enum のどれかにしてください。']);
    expect(validateSettingDefs([{ key: "a", label: "A", type: "string", description: 1 }])).toEqual(['settings[0]（"a"） の description は文字列にしてください。']);
    expect(validateSettingDefs([{ key: "a", label: "A", type: "string" }, { key: "a", label: "B", type: "number" }])).toEqual(['settings[1]（"a"） の key が重複しています。']);
    // 選択式: 選択肢が要る。値は空でない文字列で、重複しない。
    expect(validateSettingDefs([{ key: "a", label: "A", type: "enum" }])).toEqual(['settings[0]（"a"） は type が enum なので、options に選択肢を 1 つ以上書いてください。']);
    expect(validateSettingDefs([{ key: "a", label: "A", type: "enum", options: [{ value: 1 }] }])).toEqual(['settings[0]（"a"） の options は { value: 空でない文字列, label?: 文字列 } の配列にしてください。']);
    expect(validateSettingDefs([{ key: "a", label: "A", type: "enum", options: [{ value: "x" }, { value: "x" }] }])).toEqual(['settings[0]（"a"） の options の値 "x" が重複しています。']);
    expect(validateSettingDefs([{ key: "a", label: "A", type: "number", options: [{ value: "x" }] }])).toEqual(['settings[0]（"a"） の options は、type が enum のときだけ書けます。']);
    // 既定の値も、種類に合っていること。
    expect(validateSettingDefs([{ key: "a", label: "A", type: "boolean", default: "yes" }])).toEqual(['settings[0]（"a"） の default は使えません: true か false ではありません。']);
    // multiline（複数行の入力欄）は、文字の項目だけに書ける。
    expect(validateSettingDefs([{ key: "a", label: "A", type: "string", multiline: true, default: "1 行目\n2 行目" }])).toEqual([]);
    expect(validateSettingDefs([{ key: "a", label: "A", type: "number", multiline: true }])).toEqual(['settings[0]（"a"） の multiline は、type が string のときだけ書けます。']);
    expect(validateSettingDefs([{ key: "a", label: "A", type: "string", multiline: "yes" }])).toEqual(['settings[0]（"a"） の multiline は true か false にしてください。']);
    expect(validateSettingDefs([{ key: "a", label: "A", type: "enum", options: [{ value: "x" }], default: "y" }])).toEqual(['settings[0]（"a"） の default は使えません: 選択肢（x）にありません。']);
  });
});

describe("値の確かめ方", () => {
  it("種類ごとに、合う値と合わない値を見分ける", () => {
    const def = (key: string) => DEFS.find((d) => d.key === key)!;
    expect(settingValueProblem(def("max"), 3.5)).toBeUndefined();
    expect(settingValueProblem(def("max"), "3")).toBe("数値ではありません。");
    expect(settingValueProblem(def("max"), Number.NaN)).toBe("数値ではありません。");
    expect(settingValueProblem(def("max"), Number.POSITIVE_INFINITY)).toBe("数値ではありません。");
    expect(settingValueProblem(def("mode"), "loose")).toBeUndefined();
    expect(settingValueProblem(def("mode"), "ゆるい")).toBe("選択肢（strict / loose）にありません。");
    expect(settingValueProblem(def("enabled"), false)).toBeUndefined();
    expect(settingValueProblem(def("enabled"), 0)).toBe("true か false ではありません。");
    expect(settingValueProblem(def("note"), "")).toBeUndefined();
    expect(settingValueProblem(def("note"), 1)).toBe("文字列ではありません。");
  });

  it("設定ファイルの値を使い、ない項目は既定の値にする。合わない値は使わず、既定の値に倒して理由を返す", () => {
    expect(resolveSettingValues(DEFS, { max: 3, enabled: true, note: "x", other: 1 })).toEqual({
      stored: { max: 3, enabled: true, note: "x" },
      // mode は既定の値。宣言にないキー（other）は入らない。
      values: { max: 3, mode: "strict", enabled: true, note: "x" },
      problems: [],
    });
    expect(resolveSettingValues(DEFS, { max: "多い", mode: "none", enabled: "yes", note: null })).toEqual({
      stored: {},
      // 既定の値のない項目（enabled、note）は、値なし。
      values: { max: 10, mode: "strict" },
      problems: [
        { key: "max", problem: "数値ではありません。" },
        { key: "mode", problem: "選択肢（strict / loose）にありません。" },
        { key: "enabled", problem: "true か false ではありません。" },
      ],
    });
  });
});

describe("設定ファイルの名前", () => {
  it("プラグインの名前をそのまま使い、ファイル名に使えない文字は %XX にする（フォルダの外を指さない）", () => {
    expect(pluginSettingsFileName("mystudio-width")).toBe("mystudio-width.json");
    expect(pluginSettingsFileName("my.studio_pack-2")).toBe("my.studio_pack-2.json");
    expect(pluginSettingsFileName("pack#1")).toBe("pack%231.json");
    expect(pluginSettingsFileName("../evil")).toBe("%2E.%2Fevil.json");
    expect(pluginSettingsFileName("a/b\\c:d")).toBe("a%2Fb%5Cc%3Ad.json");
    expect(pluginSettingsFileName("設定")).toBe("%E8%A8%AD%E5%AE%9A.json");
    expect(pluginSettingsFile("/proj", "pack#1")).toBe(path.join(path.resolve("/proj"), "loc-studio-plugin-settings", "pack%231.json"));
  });
});

describe("設定ファイルの読み込み", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "loc-studio-plugin-settings-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const plugin = (name: string, settings?: PluginSettingDef[]): { plugin: Plugin; origin: { layer: "project" } } => ({ plugin: { name, ...(settings ? { settings } : {}) }, origin: { layer: "project" } });
  const put = async (name: string, text: string) => {
    await mkdir(path.join(root, "loc-studio-plugin-settings"), { recursive: true });
    await writeFile(path.join(root, "loc-studio-plugin-settings", name), text);
  };

  it("設定を宣言しているプラグインだけを読む。ファイルがなければ、既定の値", async () => {
    await put("with.json", JSON.stringify({ max: 4 }));
    const { states, warnings } = await loadPluginSettings(root, [plugin("none"), plugin("with", DEFS), plugin("fresh", DEFS), plugin("empty", [])]);
    expect(warnings).toEqual([]);
    expect(states.map((s) => [s.plugin, s.file, s.stored, s.values])).toEqual([
      ["with", path.join(root, "loc-studio-plugin-settings", "with.json"), { max: 4 }, { max: 4, mode: "strict" }],
      ["fresh", path.join(root, "loc-studio-plugin-settings", "fresh.json"), {}, { max: 10, mode: "strict" }],
    ]);
  });

  it("同じ名前のプラグインが 2 つ設定を宣言していたら、先のものだけを使い、警告にする", async () => {
    const { states, warnings } = await loadPluginSettings(root, [plugin("same", DEFS), plugin("same", [{ key: "x", label: "X", type: "string" }])]);
    expect(states.map((s) => s.defs.map((d) => d.key))).toEqual([["max", "mode", "enabled", "note"]]);
    expect(warnings).toEqual(['プラグイン "same" が 2 つあり、どちらも設定（settings）を宣言しています。設定ファイルは名前で決まるので、あとから読み込んだほうの設定は使いません。プラグインの name を別にしてください。']);
  });

  it("JSON のオブジェクトでないファイルは使わず、既定の値で動かして警告にする", async () => {
    await put("list.json", "[1, 2]");
    const { states, warnings } = await loadPluginSettings(root, [plugin("list", DEFS)]);
    expect(states[0]!.values).toEqual({ max: 10, mode: "strict" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('はJSON のオブジェクト（{ "キー": 値 }）ではありません。 既定の値で動かします。');
  });

  it("信頼の確認に使う中身は、フォルダの .json だけを、名前の順に返す（フォルダがなければ空）", async () => {
    expect(await readPluginSettingsTexts(root)).toEqual({});
    await put("b.json", '{"x":1}');
    await put("a.json", '{"y":2}');
    await put("memo.txt", "ignored");
    expect(Object.entries(await readPluginSettingsTexts(root))).toEqual([
      ["a.json", '{"y":2}'],
      ["b.json", '{"x":1}'],
    ]);
  });
});

describe("入口の関数に渡す窓口", () => {
  const plugins: Plugin[] = [
    { name: "first", settings: [{ key: "a", label: "A", type: "number" }] },
    { name: "second", settings: [{ key: "b", label: "B", type: "string" }] },
  ];
  const values: Record<string, Record<string, string | number | boolean>> = { first: { a: 1 }, second: { b: "x" } };

  it("キーを宣言したプラグインの、いまの値を返す（呼ぶたびに引き直す）", () => {
    const reader = createSettingsReader(() => plugins, (name) => values[name]);
    expect(reader.get("a")).toBe(1);
    expect(reader.get("b")).toBe("x");
    values.first = { a: 2 };
    expect(reader.get("a")).toBe(2);
    // 値のない項目は undefined。
    values.second = {};
    expect(reader.get("b")).toBeUndefined();
  });

  it("読み込みが終わる前と、値を読む前は、理由つきの例外にする。宣言にないキーも例外", () => {
    const early = createSettingsReader(() => undefined, () => ({}));
    expect(() => early.get("a")).toThrow("プラグインの読み込みが終わってから使えます");
    const noValues = createSettingsReader(() => plugins, () => undefined);
    expect(() => noValues.get("a")).toThrow("プラグインの読み込みが終わってから使えます");
    const reader = createSettingsReader(() => plugins, (name) => values[name]);
    expect(() => reader.get("c")).toThrow('設定 "c" は、プラグインの settings に宣言されていません（宣言したキー: a, b）。');
  });
});

describe("信頼の確認（設定ファイルのハッシュと要約）", () => {
  const FILE = path.join(path.resolve("/proj"), "loc-studio.project.json");
  const json = { languages: [{ id: "ja" }], sources: { s: { use: "builtin.db" } } };
  const text = JSON.stringify(json);

  it("プラグインの設定ファイルがなければ、ハッシュはこれまでと同じ（確認のやり直しにならない）", () => {
    const before = settingsCandidate(FILE, json, text)!;
    expect(settingsCandidate(FILE, json, text, {})).toEqual(before);
    expect(before.files).toEqual([FILE]);
  });

  it("プラグインの設定ファイルの中身が、ハッシュと、確認の対象のファイルと、要約に入る。中身が変わるとハッシュも変わる", () => {
    const before = settingsCandidate(FILE, json, text)!;
    const withSettings = settingsCandidate(FILE, json, text, { "width.json": '{"max":5,"mode":"strict"}' })!;
    expect(withSettings.hash).not.toBe(before.hash);
    expect(withSettings.files).toEqual([FILE, path.join(path.resolve("/proj"), "loc-studio-plugin-settings", "width.json")]);
    expect(withSettings.summary!.at(-1)).toEqual({ label: "プラグインの設定（loc-studio-plugin-settings/width.json）", value: 'max = 5、mode = "strict"', note: "プラグインは、この値を読んで動きを変えます" });
    expect(settingsCandidate(FILE, json, text, { "width.json": '{"max":6,"mode":"strict"}' })!.hash).not.toBe(withSettings.hash);
    // ファイルの並びにはよらない。
    const two = { "a.json": "{}", "b.json": '{"x":1}' };
    expect(settingsCandidate(FILE, json, text, two)!.hash).toBe(settingsCandidate(FILE, json, text, { "b.json": '{"x":1}', "a.json": "{}" })!.hash);
  });

  it("基盤の項目のない設定ファイルでも、プラグインの設定ファイルがあれば、確認の対象になる", () => {
    const plain = { languages: [{ id: "ja" }] };
    expect(settingsCandidate(FILE, plain, JSON.stringify(plain))).toBeUndefined();
    const c = settingsCandidate(FILE, plain, JSON.stringify(plain), { "width.json": "こわれた" })!;
    expect(c.kind).toBe("settings");
    // JSON として読めない中身は、そのまま出す。
    expect(c.summary).toEqual([{ label: "プラグインの設定（loc-studio-plugin-settings/width.json）", value: "こわれた", note: "プラグインは、この値を読んで動きを変えます" }]);
  });
});
