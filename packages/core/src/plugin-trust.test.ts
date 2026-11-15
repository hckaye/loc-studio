import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "@loc-studio/sdk";
import { PluginRegistry } from "./registry.js";
import { resolveColumns } from "./columns.js";
import { pluginContentHash, pluginFiles } from "./plugin-loader.js";
import type { PluginCandidate } from "./plugin-loader.js";
import { openProject } from "./project.js";

const sdkPath = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));

let tmp: string;
let root: string;
let appDir: string;
let userDataDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-trust-"));
  root = path.join(tmp, "proj");
  appDir = path.join(tmp, "app");
  userDataDir = path.join(tmp, "user");
  await put(path.join(root, "loc-studio.project.json"), JSON.stringify({ languages: [{ id: "ja", label: "日本語" }], validators: ["p.v"] }));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function put(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

/** 読み込まれると印のファイルを書くプラグイン。 */
const pluginSource = (name: string, marker: string, validatorId: string) =>
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "loaded");\nexport default { name: ${JSON.stringify(name)}, validators: [{ id: ${JSON.stringify(validatorId)}, label: "v", version: "1", validate: () => [] }] };\n`;

describe("pluginContentHash / pluginFiles", () => {
  it("1 ファイルは中身、フォルダは node_modules を含むすべてのファイルを相対パス順に", async () => {
    const file = path.join(tmp, "a.mjs");
    await put(file, "export default {}");
    const h1 = await pluginContentHash(file);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    await put(file, "export default { }");
    expect(await pluginContentHash(file)).not.toBe(h1);

    const dir = path.join(tmp, "pack");
    await put(path.join(dir, "index.mjs"), "x");
    await put(path.join(dir, "lib", "b.mjs"), "y");
    await put(path.join(dir, "node_modules", "dep", "index.js"), "z");
    expect((await pluginFiles(dir)).map((f) => path.relative(dir, f).split(path.sep).join("/"))).toEqual(["index.mjs", "lib/b.mjs", "node_modules/dep/index.js"]);
    const d1 = await pluginContentHash(dir);
    // node_modules のコードも実行されうるので、ハッシュに入れる。
    await put(path.join(dir, "node_modules", "dep", "index.js"), "changed");
    expect(await pluginContentHash(dir)).not.toBe(d1);
    await put(path.join(dir, "lib", "b.mjs"), "y2");
    expect(await pluginContentHash(dir)).not.toBe(d1);
  });
});

describe("openProject の trust", () => {
  it("信頼されていないプラグインは import しない。信頼すると読み込む。中身が変わると再び確認が要る", async () => {
    const marker = path.join(tmp, "project-marker");
    const file = path.join(root, "loc-studio-plugins", "p.mjs");
    await put(file, pluginSource("p", marker, "p.v"));
    const seen: PluginCandidate[] = [];
    const trusted = new Map<string, string>();
    const trust = (c: PluginCandidate) => {
      seen.push(c);
      return trusted.get(c.path) === c.hash;
    };

    const project = await openProject(root, { env: {}, sdkPath, trust });
    expect(existsSync(marker)).toBe(false);
    expect(project.untrustedPlugins).toEqual([{ kind: "plugin", path: file, layer: "project", hash: await pluginContentHash(file), files: [file] }]);
    expect(project.registry.get("validator", "p.v")).toBeUndefined();
    // 設定が参照する実装がなくてもプロジェクトは開き、警告になる。
    expect(project.warnings.join("\n")).toContain("p.v");

    trusted.set(file, project.untrustedPlugins[0]!.hash);
    await project.reload();
    expect(existsSync(marker)).toBe(true);
    expect(project.untrustedPlugins).toEqual([]);
    expect(project.registry.get("validator", "p.v")).toBeDefined();

    await rm(marker);
    await put(file, pluginSource("p", marker, "p.v") + "// edited\n");
    await project.reload();
    expect(existsSync(marker)).toBe(false);
    expect(project.untrustedPlugins).toHaveLength(1);
    expect(seen.every((c) => c.layer === "project")).toBe(true);
  });

  it("app 層は確認しない。local 層は確認する。trust を省略するとすべて読み込む", async () => {
    const appMarker = path.join(tmp, "app-marker");
    const localMarker = path.join(tmp, "local-marker");
    await put(path.join(appDir, "plugins", "a.mjs"), pluginSource("a", appMarker, "a.v"));
    await put(path.join(userDataDir, "plugins", "l", "index.mjs"), pluginSource("l", localMarker, "l.v"));
    const layers: string[] = [];
    const project = await openProject(root, {
      env: {},
      sdkPath,
      appDir,
      userDataDir,
      trust: (c) => {
        layers.push(c.layer);
        return false;
      },
    });
    expect(existsSync(appMarker)).toBe(true);
    expect(existsSync(localMarker)).toBe(false);
    expect(layers).toEqual(["local"]);
    expect(project.untrustedPlugins.map((c) => [c.layer, c.path])).toEqual([["local", path.join(userDataDir, "plugins", "l")]]);

    const all = await openProject(root, { env: {}, sdkPath, appDir, userDataDir });
    expect(existsSync(localMarker)).toBe(true);
    expect(all.untrustedPlugins).toEqual([]);
  });
});

describe("計算列", () => {
  const compute = () => ({ value: 1 });
  const plugin: Plugin = {
    name: "c",
    columns: [{ id: "c.len", kind: "computed", scope: "language", label: "長さ", compute, options: { a: 1 } }],
  };

  it("use で上書きしても compute を保ち、深い複製でも落とさない", async () => {
    const registry = new PluginRegistry();
    registry.register(plugin, { layer: "builtin" });
    const { columns, warnings } = resolveColumns(
      { languages: [], columns: [{ use: "c.len", id: "len", label: "文字数", options: { b: 2 } }, { id: "bad", kind: "computed", scope: "entry" }] },
      registry,
    );
    expect(columns[0]).toMatchObject({ id: "len", label: "文字数", options: { b: 2 } });
    expect(columns[0]!.compute).toBe(compute);
    expect(warnings.join("\n")).toContain("compute");
    expect(warnings.join("\n")).toContain('"bad"');

    await put(path.join(root, "loc-studio.project.json"), JSON.stringify({ languages: [{ id: "ja", label: "日本語" }], columns: [{ use: "c.len", id: "len" }] }));
    const project = await openProject(root, { builtins: [plugin], env: {}, sdkPath });
    const a = project.columns();
    const b = project.columns();
    expect(a[0]!.compute).toBe(compute);
    expect(a[0]).not.toBe(b[0]);
    a[0]!.options!.a = 99;
    expect(project.columns()[0]!.options!.a).toBe(1);
  });
});
