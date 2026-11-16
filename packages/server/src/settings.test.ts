import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "./api-types.js";
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

// 期待する一覧は書き下す（同梱の列と検証、サンプルのプラグインの検証）。
const AVAILABLE_COLUMNS = [
  { id: "builtin.key", kind: "key", scope: "entry" },
  { id: "builtin.text", kind: "text", scope: "language" },
  { id: "builtin.textStatus", kind: "meta", label: "テキスト", scope: "language" },
  { id: "builtin.reviewStatus", kind: "review", label: "レビュー", scope: "language" },
  { id: "builtin.length", kind: "computed", label: "文字数", scope: "language" },
];
const AVAILABLE_VALIDATORS = [
  { id: "builtin.placeholders", label: "変数・タグの過不足" },
  { id: "builtin.tagBalance", label: "タグの対応" },
  { id: "builtin.maxLength", label: "文字数の上限" },
  { id: "builtin.whitespace", label: "空白" },
  { id: "builtin.untranslated", label: "未翻訳" },
  { id: "mystudio.lineWidth", label: "1 行の幅と行数" },
  { id: "mystudio.forbiddenChars", label: "使えない文字" },
];

describe("settings / setLocalSetting", () => {
  it("層ごとの値と固定を返す", async () => {
    const s = await ws.settings();
    expect(s.localFile).toBe(path.join(tp.userDataDir, "settings.json"));
    expect(s.projectFile).toBe(path.join(tp.root, "loc-studio.project.json"));
    expect(s.project.name).toBe("SampleGame");
    expect(s.projectFromCode).toEqual([]);
    const byKey = Object.fromEntries(s.local.map((x) => [x.key, x]));
    expect(byKey["user.name"]).toEqual({ key: "user.name", value: "tester", source: "local", locked: false });
    expect(byKey["ui.theme"]).toEqual({ key: "ui.theme", value: "light", source: "defaults", locked: false });
    expect(byKey["plugins.local.formats"]).toMatchObject({ value: "deny", source: "enforce", locked: true });
    expect(byKey["review.forwardOnPost"]).toMatchObject({ value: "ask", source: "app" });
  });

  it("設定の画面で選べる、登録済みの列と検証を返す（設定で使っていないものも含む）", async () => {
    const { available } = await ws.settings();
    expect(available.columns).toEqual(AVAILABLE_COLUMNS);
    expect(available.validators).toEqual(AVAILABLE_VALIDATORS);
  });

  it("固定された項目は locked", async () => {
    await expect(ws.setLocalSetting({ key: "plugins.local.formats", value: "allow" })).rejects.toMatchObject({ code: "locked" });
  });

  it("値を書き、null で消す。秘密情報は伏せて返す", async () => {
    let list = await ws.setLocalSetting({ key: "ui.theme", value: "dark" });
    expect(list.find((x) => x.key === "ui.theme")).toMatchObject({ value: "dark", source: "local" });
    const file = JSON.parse(await readFile(path.join(tp.userDataDir, "settings.json"), "utf8")) as Record<string, unknown>;
    expect(file["ui.theme"]).toBe("dark");
    list = await ws.setLocalSetting({ key: "ui.theme", value: null });
    expect(list.find((x) => x.key === "ui.theme")).toMatchObject({ value: "light", source: "defaults" });
    list = await ws.setLocalSetting({ key: "secrets.llm.apiKey", value: "sk-123" });
    expect(list.find((x) => x.key === "secrets.llm.apiKey")!.value).not.toBe("sk-123");
    expect(ws.project.host.secrets.get("llm.apiKey")).toBe("sk-123");
  });

  it("ユーザー名を変えたら次の記録に反映する", async () => {
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" });
    await ws.setLocalSetting({ key: "user.name", value: "佐藤" });
    expect((await ws.info()).user).toEqual({ name: "佐藤", source: "local", locked: false });
    expect(ws.project.host.user.name).toBe("佐藤");
    const c = await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    expect(c.updatedBy).toBe("佐藤");
    const h = await ws.history({ resourceId: UI, key: "UI_OK" });
    expect(h.map((x) => x.by)).toEqual(["佐藤", "tester"]);
  });

  it("起動引数のユーザー名はローカル設定より優先する", async () => {
    const ws2 = await tp.open({ cliSettings: { "user.name": "cli-user" } });
    expect((await ws2.info()).user).toMatchObject({ name: "cli-user", source: "cli" });
    const ws3 = await tp.open({ env: { LOC_STUDIO_USER: "env-user" } });
    expect((await ws3.info()).user).toMatchObject({ name: "env-user", source: "cli" });
  });

  it("enforce の user.name は固定", async () => {
    await tp.patchConfig({ localSettings: { enforce: { "user.name": "固定さん" } } });
    const ws2 = await tp.open();
    expect((await ws2.info()).user).toEqual({ name: "固定さん", source: "enforce", locked: true });
    await expect(ws2.setLocalSetting({ key: "user.name", value: "x" })).rejects.toMatchObject({ code: "locked" });
  });
});

describe("updateProjectSettings", () => {
  it("最上位のキーを置き換え（null で削除）、読み直して新しい言語が使える", async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { languages: unknown[] };
    const info = await ws.updateProjectSettings({
      patch: { languages: [...config.languages, { id: "fr", label: "フランス語", basedOn: "ja" }], languageSets: { main: ["ja", "fr"] }, localSettings: null },
    });
    expect(info.languages.map((l) => l.id)).toContain("fr");
    expect(info.languageSets).toEqual({ main: ["ja", "fr"] });
    const written = JSON.parse(await tp.read("loc-studio.project.json")) as Record<string, unknown>;
    expect(written.localSettings).toBeUndefined();
    expect(written.name).toBe("SampleGame");
    const r = await ws.rows({ resourceId: CHAPTER, languages: ["fr"], offset: 0, limit: 1 });
    expect(r.rows[0]!.cells["text@fr"]!.value).toBe("");
    // enforce がなくなったので固定も外れる。
    expect((await ws.settings()).local.find((x) => x.key === "plugins.local.formats")).toBeUndefined();
  });

  it("読めない設定は書かずに元に戻して invalid", async () => {
    const before = await tp.read("loc-studio.project.json");
    await expect(ws.updateProjectSettings({ patch: { languages: [] } })).rejects.toMatchObject({ code: "invalid" });
    expect(await tp.read("loc-studio.project.json")).toBe(before);
    expect((await ws.info()).languages).toHaveLength(4);
  });

  it("コードの設定にあるキーは locked", async () => {
    await tp.write("loc-studio.config.ts", 'export default { name: "FromCode" };\n');
    const ws2 = await tp.open();
    expect((await ws2.settings()).projectFromCode).toEqual(["name"]);
    expect((await ws2.info()).name).toBe("FromCode");
    await expect(ws2.updateProjectSettings({ patch: { name: "x" } })).rejects.toMatchObject({ code: "locked" });
  });
});

describe("plugins / reloadPlugins / reloadResource", () => {
  it("読み込んだプラグインと層、フォルダを返す", async () => {
    const p = await ws.plugins();
    const names = p.plugins.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["@loc-studio/builtin", "@loc-studio/plugin-llm", "mystudio-line-width", "studio-pack"]));
    const line = p.plugins.find((x) => x.name === "mystudio-line-width")!;
    expect(line).toMatchObject({ layer: "project", version: "1.0.0" });
    expect(line.provides.validator).toEqual(["mystudio.lineWidth"]);
    expect(p.plugins.find((x) => x.name === "@loc-studio/plugin-llm")!.provides.generator).toEqual(["llm.translate"]);
    expect(p.dirs.find((d) => d.layer === "project")).toMatchObject({ dir: path.join(tp.root, "loc-studio-plugins"), exists: true });
    expect(p.dirs.find((d) => d.layer === "local")).toMatchObject({ exists: false });
    expect(p.errors).toEqual([]);
  });

  it("プラグインフォルダにファイルを足して読み直すと出てくる", async () => {
    await tp.write(
      "loc-studio-plugins/added.mjs",
      `export default { name: "added-plugin", version: "0.0.1", validators: [{ id: "added.noX", label: "X 禁止", version: "1", validate: ({ value }) => value.includes("X") ? [{ code: "x", message: "X があります" }] : [] }] };\n`,
    );
    expect((await ws.plugins()).plugins.map((x) => x.name)).not.toContain("added-plugin");
    await ws.reloadPlugins();
    expect((await ws.plugins()).plugins.map((x) => x.name)).toContain("added-plugin");
    // 設定で選べば使える。
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { validators: unknown[] };
    await ws.updateProjectSettings({ patch: { validators: [...config.validators, "added.noX"] } });
    const r = await ws.setText({ resourceId: UI, key: "UI_OK", language: "JaEnglish", value: "OX" });
    expect(r.cell.issues!.map((i) => i.validatorId)).toContain("added.noX");
  });

  it("壊れたプラグインはエラーに出る", async () => {
    await tp.write("loc-studio-plugins/broken.mjs", "export default 42;\n");
    const info = await ws.reloadPlugins();
    expect(info.pluginErrors).toHaveLength(1);
    expect((await ws.plugins()).errors[0]!.path).toContain("broken.mjs");
  });

  it("版の確認の間隔の間はキャッシュを使い、reloadResource は必ず読み直す", async () => {
    const slow = await tp.open({ revisionCheckIntervalMs: 60_000 });
    await slow.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 1 });
    await tp.write(UI, (await tp.read(UI)).replace("확인", "오케이"));
    let r = await slow.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 1 });
    expect(r.rows[0]!.cells["text@ko"]!.value).toBe("확인");
    const { revision } = await slow.reloadResource({ resourceId: UI });
    expect(revision).toBeTruthy();
    r = await slow.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 1 });
    expect(r.rows[0]!.cells["text@ko"]!.value).toBe("오케이");
    expect(r.revision).toBe(revision);
  });

  it("間隔 0 なら外部の変更（ファイルの版）をすぐ読み直す", async () => {
    await ws.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 1 });
    await tp.write(UI, (await tp.read(UI)).replace("확인", "오케이!"));
    const r = await ws.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 1 });
    expect(r.rows[0]!.cells["text@ko"]!.value).toBe("오케이!");
  });
});
