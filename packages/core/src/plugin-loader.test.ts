import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_API_VERSION } from "@loc-studio/sdk";
import { defaultPluginDirs, discoverPluginEntries, loadPluginDirs, resolveSdkPath, validatePluginShape } from "./plugin-loader.js";

const sdkPath = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-plugins-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function put(rel: string, content: string): Promise<string> {
  const full = path.join(tmp, ...rel.split("/"));
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

const validatorSrc = (id: string, extra = "") =>
  `{ id: ${JSON.stringify(id)}, label: "L", version: "1", validate: () => []${extra} }`;

describe("discoverPluginEntries", () => {
  it("フォルダがなければ空", async () => {
    expect(await discoverPluginEntries(path.join(tmp, "none"))).toEqual([]);
  });

  it("直下のファイルとフォルダを名前順に見つけ、除外の規則に従う", async () => {
    await put("b.ts", "");
    await put("a.mjs", "");
    await put("c.cjs", "");
    await put("d.js", "");
    await put("e.mts", "");
    await put("types.d.ts", "");
    await put("x.test.ts", "");
    await put("_draft.ts", "");
    await put(".hidden.ts", "");
    await put("readme.md", "");
    await put("withjson/plugin.json", JSON.stringify({ name: "J", main: "src/main.ts" }));
    await put("withjson/src/main.ts", "");
    await put("noindex/data.txt", "");
    await put("idx/index.js", "");
    await put("idx/index.ts", "");
    await put("off/plugin.json", JSON.stringify({ enabled: false }));
    await put("off/index.ts", "");
    await put("node_modules/index.ts", "");
    await put("_skip/index.ts", "");
    await put("deep/sub/index.ts", "");
    await put("badjson/plugin.json", "{ nope");
    await put("missingmain/plugin.json", JSON.stringify({ main: "gone.ts" }));

    const found = await discoverPluginEntries(tmp);
    const rel = (p: string) => path.relative(tmp, p).split(path.sep).join("/");
    expect(found.map((f) => [rel(f.root), rel(f.entry), f.error ? "error" : "ok"])).toEqual([
      ["a.mjs", "a.mjs", "ok"],
      ["b.ts", "b.ts", "ok"],
      ["badjson", "badjson", "error"],
      ["c.cjs", "c.cjs", "ok"],
      ["d.js", "d.js", "ok"],
      ["e.mts", "e.mts", "ok"],
      ["idx", "idx/index.ts", "ok"],
      ["missingmain", "missingmain", "error"],
      ["withjson", "withjson/src/main.ts", "ok"],
    ]);
    expect(found.find((f) => rel(f.root) === "withjson")?.manifest?.name).toBe("J");
  });
});

describe("loadPluginDirs", () => {
  it(".ts（SDK を import）、.mjs、plugin.json 付きのフォルダを読み込む", async () => {
    await put(
      "one.ts",
      `import { definePlugin, defineValidator } from "@loc-studio/sdk";
       const id: string = "ts.v";
       export default definePlugin({ name: "one", validators: [defineValidator(${validatorSrc("ts.v").replace('"ts.v"', "id")})] });`,
    );
    await put("two.mjs", `export default { validators: [${validatorSrc("mjs.v")}] };`);
    await put("three.cjs", `module.exports = { name: "three", syntaxes: [{ id: "cjs.s", tokenize: () => [] }] };`);
    await put("folder/plugin.json", JSON.stringify({ name: "FromManifest", version: "2.0.0", main: "main.ts", apiVersion: PLUGIN_API_VERSION }));
    await put("folder/main.ts", `import { helper } from "./helper.ts"; export default { validators: [helper] };`);
    await put("folder/helper.ts", `export const helper = ${validatorSrc("folder.v")};`);
    await put("plain/index.mjs", `export default { syntaxes: [{ id: "plain.s", tokenize: () => [] }] };`);

    const { plugins, errors } = await loadPluginDirs([{ dir: tmp, layer: "project" }], { sdkPath });
    expect(errors).toEqual([]);
    const byName = Object.fromEntries(plugins.map((p) => [p.plugin.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["FromManifest", "one", "plain", "three", "two"]);
    expect(byName.one?.plugin.validators?.[0]?.id).toBe("ts.v");
    expect(byName.one?.origin).toEqual({ layer: "project", path: path.join(tmp, "one.ts") });
    expect(byName.FromManifest?.plugin.version).toBe("2.0.0");
    expect(byName.FromManifest?.plugin.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(byName.FromManifest?.origin.path).toBe(path.join(tmp, "folder"));
    expect(byName.two?.plugin.validators?.[0]?.id).toBe("mjs.v");
  });

  it("sdkPath を省略してもアプリ自身の SDK を見つける", async () => {
    expect(resolveSdkPath()).toBeTruthy();
    await put("auto.ts", `import { definePlugin, PLUGIN_API_VERSION } from "@loc-studio/sdk"; export default definePlugin({ name: "auto", apiVersion: PLUGIN_API_VERSION });`);
    const { plugins, errors } = await loadPluginDirs([{ dir: tmp, layer: "app" }]);
    expect(errors).toEqual([]);
    expect(plugins.map((p) => p.plugin.name)).toEqual(["auto"]);
  });

  it("関数（非同期も）と配列の既定のエクスポートを受け付ける", async () => {
    await put("fac.ts", `export default async () => ({ name: "fac", validators: [${validatorSrc("fac.v")}] });`);
    await put("arr.mjs", `export default [{ name: "arr1" }, { validators: [${validatorSrc("arr.v")}] }];`);
    await put("facarr.mjs", `export default () => [{ name: "fa1" }, { name: "fa2" }];`);
    const { plugins, errors } = await loadPluginDirs([{ dir: tmp, layer: "project" }], { sdkPath });
    expect(errors).toEqual([]);
    expect(plugins.map((p) => p.plugin.name)).toEqual(["arr1", "arr#2", "fac", "fa1", "fa2"]);
  });

  it("壊れたプラグインはエラーに集め、ほかは読み込む", async () => {
    await put("a-good.mjs", `export default { name: "good" };`);
    await put("b-novalidate.mjs", `export default { name: "nv", validators: [{ id: "x", label: "x", version: "1" }] };`);
    await put("c-notarray.mjs", `export default { name: "na", formats: {} };`);
    await put("d-noid.mjs", `export default { name: "ni", syntaxes: [{ tokenize() { return []; } }] };`);
    await put("e-syntax.ts", `export default {{{`);
    await put("f-nodefault.mjs", `export const x = 1;`);
    await put("g-throws.mjs", `throw new Error("boom-in-plugin");`);
    await put("h-badformat.mjs", `export default { name: "bf", formats: [{ id: "f", match() { return true; } }] };`);
    await put("i-badname.mjs", `export default { name: 42 };`);
    await put("j-factorythrows.mjs", `export default () => { throw new Error("factory-failed"); };`);

    const { plugins, errors } = await loadPluginDirs([{ dir: tmp, layer: "local" }], { sdkPath });
    expect(plugins.map((p) => p.plugin.name)).toEqual(["good"]);
    const msg = (name: string) => errors.find((e) => path.basename(e.path) === name)?.message ?? "";
    expect(errors).toHaveLength(9);
    expect(errors.every((e) => e.layer === "local")).toBe(true);
    expect(msg("b-novalidate.mjs")).toContain("validate");
    expect(msg("c-notarray.mjs")).toContain("formats は配列");
    expect(msg("d-noid.mjs")).toContain("id");
    expect(msg("e-syntax.ts")).toContain("e-syntax.ts");
    expect(msg("f-nodefault.mjs")).toContain("export default");
    expect(msg("g-throws.mjs")).toContain("boom-in-plugin");
    expect(msg("h-badformat.mjs")).toMatch(/parse[\s\S]*apply/);
    expect(msg("i-badname.mjs")).toContain("name");
    expect(msg("j-factorythrows.mjs")).toContain("factory-failed");
  });

  it("API の版が違うプラグインは読み込まない（プラグイン側と plugin.json 側）", async () => {
    await put("old.mjs", `export default { name: "old", apiVersion: ${PLUGIN_API_VERSION + 99} };`);
    await put("m/plugin.json", JSON.stringify({ apiVersion: PLUGIN_API_VERSION + 1 }));
    await put("m/index.mjs", `export default { name: "m" };`);
    await put("ok.mjs", `export default { name: "ok", apiVersion: ${PLUGIN_API_VERSION} };`);
    const { plugins, errors } = await loadPluginDirs([{ dir: tmp, layer: "app" }], { sdkPath });
    expect(plugins.map((p) => p.plugin.name)).toEqual(["ok"]);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.message.includes("API の版"))).toBe(true);
  });

  it("もう一度呼ぶと編集したファイルを読み直す", async () => {
    const file = await put("live.ts", `export default { name: "live", version: "1" };`);
    await put("dep/index.ts", `import { v } from "./value.ts"; export default { name: "dep", version: v };`);
    const valueFile = await put("dep/value.ts", `export const v = "a";`);
    const first = await loadPluginDirs([{ dir: tmp, layer: "project" }], { sdkPath });
    expect(first.plugins.map((p) => p.plugin.version)).toEqual(["a", "1"]);
    await writeFile(file, `export default { name: "live", version: "2" };`);
    await writeFile(valueFile, `export const v = "b";`);
    const second = await loadPluginDirs([{ dir: tmp, layer: "project" }], { sdkPath });
    expect(second.plugins.map((p) => p.plugin.version)).toEqual(["b", "2"]);
  });

  it("フォルダではないパスはエラーにして続ける", async () => {
    const notDir = await put("file.txt", "x");
    await put("ok/index.mjs", `export default { name: "ok" };`);
    const { plugins, errors } = await loadPluginDirs(
      [
        { dir: notDir, layer: "app" },
        { dir: path.join(tmp, "missing"), layer: "app" },
        { dir: tmp, layer: "project" },
      ],
      { sdkPath },
    );
    expect(plugins.map((p) => p.plugin.name)).toEqual(["ok"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe(notDir);
  });
});

describe("defaultPluginDirs", () => {
  it("app → 環境変数 → project → local の順", () => {
    const root = path.resolve(tmp, "proj");
    const a = path.resolve(tmp, "e1");
    const b = path.resolve(tmp, "e2");
    const dirs = defaultPluginDirs({
      projectRoot: root,
      config: { languages: [{ id: "ja", label: "日本語" }], pluginDirs: ["p1", "tools/p2"] },
      appDir: path.resolve(tmp, "app"),
      userDataDir: path.resolve(tmp, "user"),
      env: { LOC_STUDIO_PLUGIN_DIRS: [a, "", b].join(path.delimiter) },
    });
    expect(dirs).toEqual([
      { dir: path.resolve(tmp, "app", "plugins"), layer: "app" },
      { dir: a, layer: "app" },
      { dir: b, layer: "app" },
      { dir: path.join(root, "p1"), layer: "project" },
      { dir: path.join(root, "tools", "p2"), layer: "project" },
      { dir: path.resolve(tmp, "user", "plugins"), layer: "local" },
    ]);
  });

  it("pluginDirs の既定は loc-studio-plugins", () => {
    const root = path.resolve(tmp, "proj");
    expect(defaultPluginDirs({ projectRoot: root, config: { languages: [] } })).toEqual([
      { dir: path.join(root, "loc-studio-plugins"), layer: "project" },
    ]);
  });
});

describe("validatePluginShape", () => {
  it("生成器は cacheParams / input / run / version、列ソースは load / save / saveMode が必須", () => {
    const fn = () => undefined;
    expect(
      validatePluginShape({
        name: "ok",
        generators: [{ id: "g", version: "1", cacheParams: fn, input: fn, run: fn }],
        sources: [{ id: "s", saveMode: "immediate", load: fn, save: fn }],
      }),
    ).toEqual([]);
    const problems = validatePluginShape({
      name: "bad",
      generators: [{ id: "g", input: fn, run: fn }],
      sources: [{ id: "s", load: fn }],
    });
    expect(problems.some((p) => p.includes('"g"') && p.includes("cacheParams"))).toBe(true);
    expect(problems.some((p) => p.includes('"g"') && p.includes("version"))).toBe(true);
    expect(problems.some((p) => p.includes('"s"') && p.includes("save"))).toBe(true);
    expect(problems.some((p) => p.includes('"s"') && p.includes("saveMode"))).toBe(true);
  });
});
