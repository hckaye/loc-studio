/**
 * プラグインの設定: 宣言（Plugin.settings）、設定ファイル（loc-studio-plugin-settings/<名前>.json）、
 * 入口の関数が受け取る setup.settings、サービス層の pluginSettings / setPluginSettings、確認のモードでの信頼。
 * プラグインは、本物のファイルとして一時のプロジェクトに置いて読み込ませる（docs/plugins/settings.md の例と同じ形）。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext, Workspace } from "./api-types.js";
import { dispatch } from "./rpc.js";
import { CHAPTER, makeTestProject, trustSettings } from "./testing.js";
import type { TestProject } from "./testing.js";

/** 設定で上限と重さを変えられる検証。値は、検証のたびに setup.settings.get で読む。 */
const WIDTH_PLUGIN = `
export default (setup) => ({
  name: "mystudio-width",
  version: "1.0.0",
  settings: [
    { key: "maxLength", label: "文字数の上限", description: "これより長い本文を指摘します。", type: "number", default: 5 },
    { key: "severity", label: "重さ", type: "enum", options: [{ value: "warning", label: "警告" }, { value: "error", label: "エラー" }], default: "warning" },
    { key: "skipEmpty", label: "空の本文を飛ばす", type: "boolean", default: true },
    { key: "note", label: "メモ", type: "string" },
  ],
  validators: [
    {
      id: "mystudio.width",
      label: "文字数（設定つき）",
      version: "1",
      severity: "warning",
      validate(ctx) {
        const max = setup.settings.get("maxLength");
        if (ctx.value === "" && setup.settings.get("skipEmpty")) return [];
        if (ctx.value.length <= max) return [];
        return [{ code: "too-wide", message: ctx.value.length + " 文字（上限 " + max + "）", severity: setup.settings.get("severity") }];
      },
    },
  ],
});
`;

/** 設定ファイルの場所（プラグインの名前がファイル名になる）。 */
const settingsFile = (tp: TestProject) => path.join(tp.root, "loc-studio-plugin-settings", "mystudio-width.json");
const readSettings = async (tp: TestProject) => JSON.parse(await readFile(settingsFile(tp), "utf8")) as unknown;

/** サンプルの CH01_INTRO_002 の韓国語は「여기는…… 어디지?」（10 文字）。その行の、この検証の指摘。 */
async function widthIssues(ws: Workspace): Promise<{ message: string; severity: string }[]> {
  const page = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 1000 });
  const cell = page.rows.find((r) => r.key === "CH01_INTRO_002")!.cells["text@ko"]!;
  return (cell.issues ?? []).filter((i) => i.code === "too-wide").map((i) => ({ message: i.message, severity: i.severity }));
}

let tp: TestProject;
beforeEach(async () => {
  tp = await makeTestProject();
  await tp.write("loc-studio-plugins/width.mjs", WIDTH_PLUGIN);
  await tp.patchConfig({ validators: ["mystudio.width"] });
});
afterEach(async () => {
  await tp.cleanup();
});

describe("pluginSettings（一覧）", () => {
  it("設定を宣言したプラグインの項目と、いまの値を返す。設定ファイルがなければ、既定の値で動く", async () => {
    const ws = await tp.open();
    expect(await ws.pluginSettings()).toEqual([
      {
        plugin: "mystudio-width",
        version: "1.0.0",
        layer: "project",
        file: settingsFile(tp),
        items: [
          { key: "maxLength", label: "文字数の上限", description: "これより長い本文を指摘します。", type: "number", default: 5, value: 5, stored: false },
          { key: "severity", label: "重さ", type: "enum", options: [{ value: "warning", label: "警告" }, { value: "error", label: "エラー" }], default: "warning", value: "warning", stored: false },
          { key: "skipEmpty", label: "空の本文を飛ばす", type: "boolean", default: true, value: true, stored: false },
          // 既定の値のない項目は、値を持たない。
          { key: "note", label: "メモ", type: "string", stored: false },
        ],
        problems: [],
      },
    ]);
    expect(existsSync(settingsFile(tp))).toBe(false);
    // 既定の上限（5）で検証する。
    expect(await widthIssues(ws)).toEqual([{ message: "10 文字（上限 5）", severity: "warning" }]);
    expect((await ws.info()).warnings.join("\n")).not.toContain("mystudio-width");
  });

  it("設定を宣言していないプラグインは、一覧に出ない", async () => {
    const ws = await tp.open();
    const names = (await ws.plugins()).plugins.map((p) => p.name);
    // サンプルのプラグイン（設定の宣言なし）も読み込まれている。
    expect(names).toContain("mystudio-width");
    expect(names.length).toBeGreaterThan(1);
    expect((await ws.pluginSettings()).map((p) => p.plugin)).toEqual(["mystudio-width"]);
  });

  it("設定ファイルの、種類の合わない値は使わず、既定の値に倒して警告にする。読めないファイルも同じ", async () => {
    await tp.write("loc-studio-plugin-settings/mystudio-width.json", JSON.stringify({ maxLength: "長め", severity: "fatal", skipEmpty: false }));
    const ws = await tp.open();
    const [state] = await ws.pluginSettings();
    expect(state!.items.map((i) => [i.key, i.value, i.stored])).toEqual([
      ["maxLength", 5, false],
      ["severity", "warning", false],
      ["skipEmpty", false, true],
      ["note", undefined, false],
    ]);
    expect(state!.problems).toEqual([
      `プラグイン "mystudio-width" の設定「文字数の上限」（${settingsFile(tp)} の "maxLength"）は数値ではありません。 既定の値（5）で動かします。設定の画面の「プラグインの設定」で直せます。`,
      `プラグイン "mystudio-width" の設定「重さ」（${settingsFile(tp)} の "severity"）は選択肢（warning / error）にありません。 既定の値（"warning"）で動かします。設定の画面の「プラグインの設定」で直せます。`,
    ]);
    // 警告は、プロジェクトの警告にも出る。検証は、既定の値で動く。
    expect((await ws.info()).warnings).toEqual(expect.arrayContaining(state!.problems));
    expect(await widthIssues(ws)).toEqual([{ message: "10 文字（上限 5）", severity: "warning" }]);
    await ws.close();

    await tp.write("loc-studio-plugin-settings/mystudio-width.json", "{ こわれた");
    const ws2 = await tp.open();
    const [broken] = await ws2.pluginSettings();
    expect(broken!.problems).toHaveLength(1);
    expect(broken!.problems[0]).toContain(`プラグイン "mystudio-width" の設定ファイル ${settingsFile(tp)} はJSON として読めませんでした`);
    expect(broken!.problems[0]).toContain("既定の値で動かします");
    expect(broken!.items.map((i) => i.value)).toEqual([5, "warning", true, undefined]);
  });
});

describe("setPluginSettings（保存）", () => {
  it("値を設定ファイルに書き、読み直して、プラグインが新しい値を受け取る。null は既定に戻し、すべて消えたらファイルを消す", async () => {
    const ws = await tp.open();
    const saved = await ws.setPluginSettings({ plugin: "mystudio-width", values: { maxLength: 9, severity: "error", note: "LQA 用" } });
    expect(await readSettings(tp)).toEqual({ maxLength: 9, severity: "error", note: "LQA 用" });
    expect((await readFile(settingsFile(tp), "utf8")).endsWith("}\n")).toBe(true);
    expect(saved[0]!.items.map((i) => [i.key, i.value, i.stored])).toEqual([
      ["maxLength", 9, true],
      ["severity", "error", true],
      ["skipEmpty", true, false],
      ["note", "LQA 用", true],
    ]);
    // 検証の結果が、新しい値に変わる（前の結果を覚えたままにしない）。
    expect(await widthIssues(ws)).toEqual([{ message: "10 文字（上限 9）", severity: "error" }]);
    await ws.setPluginSettings({ plugin: "mystudio-width", values: { maxLength: 10 } });
    expect(await widthIssues(ws)).toEqual([]);
    // 書かなかったキーは変わらない。
    expect(await readSettings(tp)).toEqual({ maxLength: 10, severity: "error", note: "LQA 用" });

    // null は値を消して、既定の値に戻す。
    await ws.setPluginSettings({ plugin: "mystudio-width", values: { maxLength: null } });
    expect(await readSettings(tp)).toEqual({ severity: "error", note: "LQA 用" });
    expect(await widthIssues(ws)).toEqual([{ message: "10 文字（上限 5）", severity: "error" }]);
    const cleared = await ws.setPluginSettings({ plugin: "mystudio-width", values: { severity: null, note: null } });
    expect(existsSync(settingsFile(tp))).toBe(false);
    expect(cleared[0]!.items.every((i) => !i.stored)).toBe(true);

    // 開き直しても、保存した値で動く。
    await ws.setPluginSettings({ plugin: "mystudio-width", values: { maxLength: 7 } });
    await ws.close();
    const ws2 = await tp.open();
    expect(await widthIssues(ws2)).toEqual([{ message: "10 文字（上限 7）", severity: "warning" }]);
  });

  it("宣言にないキー、種類の合わない値、知らないプラグインは、何も書かずに断る", async () => {
    const ws = await tp.open();
    await ws.setPluginSettings({ plugin: "mystudio-width", values: { maxLength: 8 } });
    const before = await readFile(settingsFile(tp), "utf8");
    const rejects = async (values: Record<string, unknown>, code: string, message: string, plugin = "mystudio-width") => {
      await expect(ws.setPluginSettings({ plugin, values })).rejects.toMatchObject({ code, message: expect.stringContaining(message) as unknown });
      expect(await readFile(settingsFile(tp), "utf8")).toBe(before);
    };
    await rejects({ maxLength: 20, limit: 3 }, "invalid", 'プラグイン "mystudio-width" は、設定 "limit" を宣言していません（宣言している設定: maxLength, severity, skipEmpty, note）');
    await rejects({ maxLength: "20" }, "invalid", "設定「文字数の上限」（maxLength）の値 \"20\" は数値ではありません。");
    await rejects({ severity: "fatal" }, "invalid", "設定「重さ」（severity）の値 \"fatal\" は選択肢（warning / error）にありません。");
    await rejects({ skipEmpty: "yes" }, "invalid", "true か false ではありません。");
    await rejects({ note: 5 }, "invalid", "文字列ではありません。");
    await rejects({ maxLength: 3 }, "not-found", 'プラグイン "nope" は読み込まれていないか、設定（settings）を宣言していません。', "nope");
    // 断ったあとも、前の値で動いている。
    expect(await widthIssues(ws)).toEqual([{ message: "10 文字（上限 8）", severity: "warning" }]);
  });

  it("宣言にないキーが設定ファイルにあっても、保存で消さない。読めないファイルは、保存した値で書き直す", async () => {
    await tp.write("loc-studio-plugin-settings/mystudio-width.json", JSON.stringify({ legacy: { a: 1 }, maxLength: 6 }));
    const ws = await tp.open();
    await ws.setPluginSettings({ plugin: "mystudio-width", values: { severity: "error" } });
    expect(await readSettings(tp)).toEqual({ legacy: { a: 1 }, maxLength: 6, severity: "error" });
    await ws.close();

    await tp.write("loc-studio-plugin-settings/mystudio-width.json", "{ こわれた");
    const ws2 = await tp.open();
    const saved = await ws2.setPluginSettings({ plugin: "mystudio-width", values: { maxLength: 4 } });
    expect(await readSettings(tp)).toEqual({ maxLength: 4 });
    expect(saved[0]!.problems).toEqual([]);
  });
});

describe("入口の関数と setup.settings", () => {
  it("読み込みの途中（入口の関数の中）で値を読むと、理由つきの読み込みエラーになる", async () => {
    await tp.write(
      "loc-studio-plugins/eager.mjs",
      `export default (setup) => {
  const max = setup.settings.get("max");
  return { name: "eager", settings: [{ key: "max", label: "上限", type: "number", default: 1 }], validators: [{ id: "eager.v", label: "v", version: "1", severity: "info", validate: () => (max ? [] : []) }] };
};
`,
    );
    const ws = await tp.open();
    const errors = (await ws.plugins()).errors.filter((e) => e.path.endsWith("eager.mjs"));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("プラグインの設定（settings.get）は、プラグインの読み込みが終わってから使えます");
    expect((await ws.pluginSettings()).map((p) => p.plugin)).toEqual(["mystudio-width"]);
  });

  it("宣言の形が誤っているプラグインは、読み込まない（理由を読み込みエラーに出す）", async () => {
    await tp.write(
      "loc-studio-plugins/bad-settings.mjs",
      `export default { name: "bad-settings", settings: [
  { key: "a", label: "A", type: "text" },
  { key: "b", label: "B", type: "enum" },
  { key: "c", label: "C", type: "number", default: "多い" },
  { key: "c", label: "", type: "boolean" },
] };
`,
    );
    const ws = await tp.open();
    const error = (await ws.plugins()).errors.find((e) => e.path.endsWith("bad-settings.mjs"))!;
    expect(error.message).toContain('settings[0]（"a"） の type は string / number / boolean / enum のどれかにしてください。');
    expect(error.message).toContain('settings[1]（"b"） は type が enum なので、options に選択肢を 1 つ以上書いてください。');
    expect(error.message).toContain('settings[2]（"c"） の default は使えません: 数値ではありません。');
    expect(error.message).toContain('settings[3]（"c"） の key が重複しています。');
    expect(error.message).toContain('settings[3]（"c"） の label は空でない文字列にしてください。');
    expect((await ws.plugins()).plugins.map((p) => p.name)).not.toContain("bad-settings");
  });

  it("宣言していないキーを読むと、宣言したキーを添えた例外になる（検証の失敗として出る）", async () => {
    await tp.write(
      "loc-studio-plugins/typo.mjs",
      `export default (setup) => ({
  name: "typo",
  settings: [{ key: "limit", label: "上限", type: "number", default: 1 }],
  validators: [{ id: "typo.v", label: "v", version: "1", severity: "info", validate: () => { setup.settings.get("limt"); return []; } }],
});
`,
    );
    await tp.patchConfig({ validators: ["typo.v"] });
    const ws = await tp.open();
    const page = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 10 });
    const texts = [...page.rows.flatMap((r) => (r.cells["text@ko"]?.issues ?? []).map((i) => i.message)), ...page.diagnostics.map((d) => d.message), ...(await ws.info()).warnings];
    expect(texts.join("\n")).toContain('設定 "limt" は、プラグインの settings に宣言されていません（宣言したキー: limit）。');
  });
});

describe("Web モードの権限", () => {
  const as = (name: string, role: string, admin = false): CallContext => ({ user: { name }, role, ...(admin ? { admin: true } : {}) });

  it("読むのは全員、保存は manage の権限がある役割だけ。管理者でない人には、設定ファイルの場所を返さない", async () => {
    const ws = await tp.open();
    const viewer = await dispatch(ws, "pluginSettings", {}, as("v", "viewer"));
    expect("result" in viewer && (viewer.result as { plugin: string; file: string }[]).map((p) => [p.plugin, p.file])).toEqual([["mystudio-width", ""]]);
    const denied = await dispatch(ws, "setPluginSettings", { plugin: "mystudio-width", values: { maxLength: 9 } }, as("t", "translator"));
    expect(denied).toMatchObject({ error: { code: "forbidden" } });
    expect(existsSync(settingsFile(tp))).toBe(false);

    const saved = await dispatch(ws, "setPluginSettings", { plugin: "mystudio-width", values: { maxLength: 9 } }, as("m", "manager"));
    expect("result" in saved && (saved.result as { file: string; items: { key: string; value?: unknown }[] }[])[0]).toMatchObject({ file: "", items: expect.arrayContaining([expect.objectContaining({ key: "maxLength", value: 9 })]) as unknown });
    expect(await readSettings(tp)).toEqual({ maxLength: 9 });
    // サーバーの管理者には、場所も返す。
    const admin = await dispatch(ws, "pluginSettings", {}, as("a", "manager", true));
    expect("result" in admin && (admin.result as { file: string }[])[0]!.file).toBe(settingsFile(tp));
  });
});

describe("確認のモード（ローカルモードの画面）", () => {
  /** 設定ファイルと、プロジェクトのプラグインをすべて信頼する。 */
  async function trustAll(ws: Workspace): Promise<void> {
    await trustSettings(ws);
    const untrusted = (await ws.plugins()).untrusted;
    if (untrusted.length > 0) await ws.trustPlugins({ items: untrusted.map((u) => ({ path: u.path, hash: u.hash })) });
  }

  it("画面から保存した値は確認済みになる。アプリの外で書き換えられた値は、確認するまで使わない（確認の画面に、値が出る）", async () => {
    const ws = await tp.open({ pluginTrust: "prompt" });
    await trustAll(ws);
    expect((await ws.info()).restricted).not.toBe(true);
    await ws.setPluginSettings({ plugin: "mystudio-width", values: { maxLength: 9 } });
    expect(await widthIssues(ws)).toEqual([{ message: "10 文字（上限 9）", severity: "warning" }]);
    await ws.close();

    // 開き直しても、確認は出ない（自分が画面から保存した値なので）。
    const ws2 = await tp.open({ pluginTrust: "prompt" });
    expect(ws2.restricted).toBe(false);
    expect((await ws2.plugins()).untrusted).toEqual([]);
    expect(await widthIssues(ws2)).toEqual([{ message: "10 文字（上限 9）", severity: "warning" }]);
    await ws2.close();

    // アプリの外で、値を書き換える。
    await tp.write("loc-studio-plugin-settings/mystudio-width.json", JSON.stringify({ maxLength: 2 }));
    const ws3 = await tp.open({ pluginTrust: "prompt" });
    expect(ws3.restricted).toBe(true);
    const untrusted = (await ws3.plugins()).untrusted;
    expect(untrusted.map((u) => u.kind)).toEqual(["settings"]);
    expect(untrusted[0]!.files).toContain(settingsFile(tp));
    expect(untrusted[0]!.summary).toContainEqual({
      label: "プラグインの設定（loc-studio-plugin-settings/mystudio-width.json）",
      value: "maxLength = 2",
      note: "プラグインは、この値を読んで動きを変えます",
    });
    // 確認すると、その値で動く。
    await ws3.trustPlugins({ items: untrusted.map((u) => ({ path: u.path, hash: u.hash })) });
    expect((await ws3.info()).restricted).not.toBe(true);
    expect(await widthIssues(ws3)).toEqual([{ message: "10 文字（上限 2）", severity: "warning" }]);
  });
});
