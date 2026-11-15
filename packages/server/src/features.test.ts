/**
 * プラグインの信頼、計算列、一括バリデーション、固定できない enforce の警告。
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "@loc-studio/sdk";
import type { Workspace } from "./api-types.js";
import { CHAPTER, makeTestProject, trustSettings, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

let tp: TestProject;
beforeEach(async () => {
  tp = await makeTestProject();
});
afterEach(async () => {
  await tp.cleanup();
});

const markerPlugin = (marker: string, name = "marker-plugin") =>
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\nexport default { name: ${JSON.stringify(name)}, validators: [{ id: "marker.v", label: "印", version: "1", validate: () => [] }] };\n`;

describe("プラグインの信頼", () => {
  it("確認していない project 層のプラグインは実行しない。信頼すると読み込み、開き直しても残り、書き換えると再び確認が要る", async () => {
    const marker = path.join(tp.tmp, "marker");
    const file = path.join(tp.root, "loc-studio-plugins", "marker.mjs");
    await tp.write("loc-studio-plugins/marker.mjs", markerPlugin(marker));
    const ws = await tp.open({ pluginTrust: "prompt" });
    // まず設定ファイルの確認（基盤の項目）。プラグインはそのあと。
    expect(ws.restricted).toBe(true);
    await trustSettings(ws);

    let info = await ws.info();
    expect(existsSync(marker)).toBe(false);
    expect(info.untrustedPlugins).toBe(3); // サンプルの 2 つ + marker
    // 設定が参照する実装（mystudio.lineWidth）がなくても開き、警告になる。
    expect(info.warnings.join("\n")).toContain("mystudio.lineWidth");
    const p = await ws.plugins();
    const entry = p.untrusted.find((u) => u.path === file)!;
    expect(entry).toMatchObject({ kind: "plugin", layer: "project", files: [file] });
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    const pack = p.untrusted.find((u) => u.path.endsWith("studio-pack"))!;
    expect(pack.files.map((f) => path.basename(f)).sort()).toEqual(["index.mjs", "plugin.json"]);
    expect(p.plugins.map((x) => x.name)).not.toContain("marker-plugin");

    info = await ws.trustPlugins({ items: [{ path: file, hash: entry.hash }] });
    expect(existsSync(marker)).toBe(true);
    expect(info.untrustedPlugins).toBe(2);
    expect((await ws.plugins()).plugins.map((x) => x.name)).toContain("marker-plugin");
    const stored = JSON.parse(await readFile(path.join(tp.userDataDir, "settings.json"), "utf8")) as Record<string, any>;
    expect(stored["plugins.trust"][tp.root][file]).toBe(entry.hash);
    // 信頼の記録は設定の一覧には出さず、setLocalSetting でも変えられない。
    expect((await ws.settings()).local.map((s) => s.key)).not.toContain("plugins.trust");
    await expect(ws.setLocalSetting({ key: "plugins.trust", value: {} })).rejects.toMatchObject({ code: "invalid" });

    // 開き直しても信頼は残る。
    await ws.close();
    const ws2 = await tp.open({ pluginTrust: "prompt" });
    expect((await ws2.info()).untrustedPlugins).toBe(2);
    expect((await ws2.plugins()).plugins.map((x) => x.name)).toContain("marker-plugin");

    // 書き換えると、再び確認が要る（コードは実行しない）。
    await rm(marker);
    await tp.write("loc-studio-plugins/marker.mjs", markerPlugin(marker) + "// edited\n");
    info = await ws2.reloadPlugins();
    expect(info.untrustedPlugins).toBe(3);
    expect(existsSync(marker)).toBe(false);

    // 信頼を取り消す。
    const edited = (await ws2.plugins()).untrusted.find((u) => u.path === file)!;
    expect(edited.hash).not.toBe(entry.hash);
    // 確認したときのハッシュと違えば conflict。
    await expect(ws2.trustPlugins({ items: [{ path: file, hash: entry.hash }] })).rejects.toMatchObject({ code: "conflict", data: { hash: edited.hash } });
    await ws2.trustPlugins({ items: [{ path: file, hash: edited.hash }] });
    info = await ws2.untrustPlugins({ paths: [file] });
    expect(info.untrustedPlugins).toBe(3);
    await expect(ws2.trustPlugins({ items: [{ path: "/nope", hash: "x" }] })).rejects.toMatchObject({ code: "not-found" });
    await expect(ws2.trustPlugins({ paths: [file] } as never)).rejects.toMatchObject({ code: "invalid" });
  });

  it("app 層のプラグインは確認なしで読み込む。always ならすべて読み込む", async () => {
    const appMarker = path.join(tp.tmp, "app-marker");
    const appDir = path.join(tp.tmp, "app");
    await tp.write(path.relative(tp.root, path.join(appDir, "plugins", "a.mjs")).split(path.sep).join("/"), markerPlugin(appMarker, "app-plugin"));
    const ws = await tp.open({ pluginTrust: "prompt", appDir });
    // 設定ファイルを確認するまでは、app 層も含めて何も読み込まない。
    expect(existsSync(appMarker)).toBe(false);
    await trustSettings(ws);
    expect(existsSync(appMarker)).toBe(true);
    const p = await ws.plugins();
    expect(p.plugins.find((x) => x.name === "app-plugin")?.layer).toBe("app");
    expect(p.untrusted.every((u) => u.layer === "project")).toBe(true);

    const all = await tp.open({ pluginTrust: "always" });
    expect((await all.info()).untrustedPlugins).toBe(0);
    expect((await all.plugins()).untrusted).toEqual([]);
  });
});

describe("計算列", () => {
  const plugin: Plugin = {
    name: "computed-test",
    columns: [
      { id: "t.keyLen", kind: "computed", scope: "entry", compute: ({ entry }) => ({ value: entry.key.length }) },
      {
        id: "t.check",
        kind: "computed",
        scope: "language",
        options: { max: 5 },
        compute: ({ text, options }) => {
          if (text === "BOOM") throw new Error("計算できません");
          return (text ?? "").length > Number(options.max) ? { value: "長い", error: "長すぎます" } : { value: "ok" };
        },
      },
    ],
  };
  let ws: Workspace;
  beforeEach(async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
    await tp.patchConfig({
      columns: [...config.columns, { use: "builtin.length", id: "length" }, { use: "t.keyLen", id: "keyLen" }, { use: "t.check", id: "check" }],
    });
    ws = await tp.open({ extraBuiltins: [plugin] });
  });

  it("表示する行だけ計算し、本文はドラフト込み。投げても表は壊れない", async () => {
    let r = await ws.rows({ resourceId: UI, languages: ["ja", "JaEnglish"], offset: 0, limit: 2 });
    expect(r.rows[0]!.cells["length@ja"]).toEqual({ value: 2 });
    expect(r.rows[0]!.cells["keyLen"]).toEqual({ value: 5 });
    expect(r.rows[1]!.cells["check@JaEnglish"]).toEqual({ value: "長い", error: "長すぎます" });
    expect(r.rows[0]!.cells["check@JaEnglish"]).toEqual({ value: "ok" });

    await ws.setText({ resourceId: UI, key: "UI_OK", language: "JaEnglish", value: "BOOM" });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ja", value: "決定する😀" });
    r = await ws.rows({ resourceId: UI, languages: ["ja", "JaEnglish"], offset: 0, limit: 2 });
    expect(r.rows[0]!.cells["length@ja"]).toEqual({ value: 5 });
    expect(r.rows[0]!.cells["check@JaEnglish"]!.value).toBeUndefined();
    expect(r.rows[0]!.cells["check@JaEnglish"]!.error).toContain("計算できません");
    expect(r.rows[1]!.cells["text@ja"]!.value).toBe("キャンセル");
    const d = await ws.rowDetail({ resourceId: UI, key: "UI_GOLD" });
    expect(d.row.cells["length@ko"]).toEqual({ value: Array.from("소지금: {gold} G").length });
  });

  it("絞り込みに使え、setCell はできない", async () => {
    const r = await ws.rows({ resourceId: UI, languages: ["ja"], offset: 0, limit: 10, filters: [{ cellId: "length@ja", values: [2] }] });
    expect(r.rows.map((x) => x.key)).toEqual(["UI_OK"]);
    await expect(ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "length@ja", value: 3 })).rejects.toMatchObject({ code: "invalid" });
    expect((await ws.info()).columns.find((c) => c.id === "length")).toMatchObject({ kind: "computed", label: "文字数" });
  });
});

describe("validate", () => {
  it("リソースごとの問題と集計。読めないリソースはそのリソースの error にして続ける", async () => {
    const ws = await tp.open();
    const all = await ws.validate();
    expect(all.resources.map((r) => r.resourceId).sort()).toEqual([CHAPTER, UI]);
    expect(all.summary.error).toBeGreaterThan(0);
    const tag = all.resources.find((x) => x.resourceId === CHAPTER)!.issues.find((i) => i.validatorId === "builtin.tagBalance")!;
    expect(tag).toMatchObject({ key: "CH01_CHOICE_001A", language: "ko", cellId: "text@ko", severity: "error" });
    const sum = all.resources.flatMap((r) => r.issues).length;
    expect(all.summary.error + all.summary.warning + all.summary.info).toBe(sum);
    expect(all.summary.cells).toBeGreaterThan(0);

    await tp.write("Assets/Text/gone.csv", "ID,JP\nA,あ\n");
    await ws.tree();
    await rm(path.join(tp.root, "Assets", "Text", "gone.csv"));
    const r = await ws.validate({ resourceIds: ["Assets/Text/gone.csv", UI, "nope.csv"], languages: ["ko"] });
    expect(r.resources[0]!.error).toContain("gone.csv");
    expect(r.resources[1]!.error).toBeUndefined();
    expect(r.resources[1]!.issues.every((i) => i.language === "ko")).toBe(true);
    expect(r.resources[2]!.error).toContain("nope.csv");
    await expect(ws.validate({ languages: ["xx"] })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("固定できない enforce", () => {
  it("秘密情報とプラグインの信頼を enforce に書くと警告に名前を出す", async () => {
    await tp.patchConfig({ localSettings: { enforce: { "secrets.llm.apiKey": "x", "plugins.trust": {}, "ui.theme": "dark" } } });
    const ws = await tp.open();
    const w = (await ws.info()).warnings.join("\n");
    expect(w).toContain("secrets.llm.apiKey");
    expect(w).toContain("plugins.trust");
    expect(w).not.toContain("ui.theme,");
  });
});
