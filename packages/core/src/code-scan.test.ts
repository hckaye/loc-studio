/**
 * N1: import の見つけ方は構文木で、決められないものは断る。解決は読み込み（jiti）と同じ。
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findImports, inspectConfigCode, inspectPluginCode, scanSource } from "./code-graph.js";
import { openProject } from "./project.js";

const sdkPath = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));
let tmp: string;
let root: string;
let plugins: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-scan-"));
  root = path.join(tmp, "proj");
  plugins = path.join(root, "loc-studio-plugins");
  await put(path.join(root, "loc-studio.project.json"), JSON.stringify({ languages: [{ id: "ja", label: "日本語" }] }));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});
async function put(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}
const rel = (base: string, files: string[]) => files.map((f) => path.relative(base, f).split(path.sep).join("/")).sort();

describe("見落としていた書き方", () => {
  it("空白なし、文字列の前のコメント、式のないテンプレートリテラル、TypeScript", () => {
    expect(findImports(`import{v as a}from"./_a.ts";import b from /* c */ "./_b.ts";await import(\`./_c.ts\`);export{x}from'./_x';`, "p.ts").sort()).toEqual(
      ["./_a.ts", "./_b.ts", "./_c.ts", "./_x"].sort(),
    );
    // 文字列やコメントの中の import は数えない。
    expect(findImports(`const s = 'import "./nope"'; // import "./nope2"\n/* require("./nope3") */\nconst r = /import "x"/;`)).toEqual([]);
  });

  it("CommonJS の require を見つけ、文字列でないものは断る", () => {
    expect(findImports(`const a = require("./a.cjs"); module.exports = require('./b');`, "x.cjs").sort()).toEqual(["./a.cjs", "./b"]);
    const s = scanSource(`const n = "./x"; require(n);`, "x.cjs");
    expect(s.problems[0]).toMatchObject({ line: 1 });
    expect(s.problems[0]!.message).toContain("require");
    expect(s.problems[0]!.message).toContain("静的な import");
  });

  it("決められない読み込みは行つきで断る", () => {
    const cases: [string, string][] = [
      [`import { createRequire } from "node:module";\ncreateRequire(import.meta.url)("./_d.cjs");`, "createRequire"],
      [`const m = await import(\`./\${name}.js\`);`, "import()"],
      [`import(name);`, "import()"],
      [`import.meta.resolve("./x");`, "import.meta.resolve"],
      [`import.meta.glob("./*.ts");`, "import.meta.glob"],
      [`import mod from "node:module";\nmod.register("./hooks.mjs");`, "node:module"],
      [`process.dlopen(module, "./x.node");`, "process.dlopen"],
      [`const r = require; r("./x");`, "require"],
      [`require.resolve(name);`, "require.resolve"],
    ];
    for (const [src, word] of cases) {
      const s = scanSource(src, "x.mjs");
      expect(s.problems.length, src).toBeGreaterThan(0);
      expect(s.problems.map((p) => p.message).join(" "), src).toContain(word);
    }
    // 解析できないファイルも断る。
    expect(scanSource(`import {`, "x.mjs").problems[0]!.message).toContain("解析できません");
    // 問題のない書き方。
    expect(scanSource(`import { isBuiltin } from "node:module"; const ok = { require: 1 }; obj.require; require.resolve("./x");`, "x.mjs").problems).toEqual([]);
  });
});

describe("解決は読み込みと同じで、ハッシュに入れるのは解決したファイル", () => {
  it("_g.ts と _g.js があれば、読み込まれる _g.js をハッシュに入れる", async () => {
    await put(path.join(plugins, "p.mjs"), `import "./_g";\nexport default { name: "p" };\n`);
    await put(path.join(plugins, "_g.ts"), `export const v = "ts";\n`);
    await put(path.join(plugins, "_g.js"), `export const v = "js";\n`);
    const r = await inspectPluginCode(path.join(plugins, "p.mjs"));
    expect(r.error).toBeUndefined();
    expect(rel(plugins, r.files)).toEqual(["_g.js", "p.mjs"]);
  });

  it("フォルダの package.json の main、JSON の import も一覧とハッシュに入る", async () => {
    await put(path.join(plugins, "p.mjs"), `import "./_dir";\nimport data from "./data.json" with { type: "json" };\nexport default { name: "p" + data.v };\n`);
    await put(path.join(plugins, "_dir", "package.json"), JSON.stringify({ main: "evil.js" }));
    await put(path.join(plugins, "_dir", "evil.js"), `export default 1;\n`);
    await put(path.join(plugins, "data.json"), `{"v":1}`);
    const r = await inspectPluginCode(path.join(plugins, "p.mjs"));
    expect(r.error).toBeUndefined();
    expect(rel(plugins, r.files)).toEqual(["_dir/evil.js", "data.json", "p.mjs"]);
    const before = r.hash;
    await put(path.join(plugins, "data.json"), `{"v":2}`);
    expect((await inspectPluginCode(path.join(plugins, "p.mjs"))).hash).not.toBe(before);
  });

  const traversal = `import "@loc-studio/sdk/../../../../../../../../../../../../tmp/outside.ts";\n`;

  it("SDK の名前のあとに .. を付けて外を指す import は断る（1 ファイル、フォルダ、コードの設定）", async () => {
    await put(path.join(plugins, "single.mjs"), `${traversal}export default { name: "s" };\n`);
    expect((await inspectPluginCode(path.join(plugins, "single.mjs"), undefined, { sdkPath })).error).toContain("@loc-studio/sdk/..");
    await put(path.join(plugins, "pack", "index.mjs"), `export default { name: "pack" };\n`);
    await put(path.join(plugins, "pack", "lib", "x.mjs"), traversal);
    expect((await inspectPluginCode(path.join(plugins, "pack"), path.join(plugins, "pack", "index.mjs"), { sdkPath })).error).toContain("@loc-studio/sdk/..");
    await put(path.join(root, "loc-studio.config.mjs"), `${traversal}export default {};\n`);
    expect((await inspectConfigCode(root, path.join(root, "loc-studio.config.mjs"), { sdkPath })).error).toContain("@loc-studio/sdk/..");
    // SDK そのものと組み込みは認める。SDK のほかの道（exports にない）は断る。
    await put(path.join(plugins, "ok.mjs"), `import { definePlugin } from "@loc-studio/sdk";\nimport fs from "fs";\nimport p from "node:path";\nexport default definePlugin({ name: "ok" });\n`);
    expect((await inspectPluginCode(path.join(plugins, "ok.mjs"), undefined, { sdkPath })).error).toBeUndefined();
    await put(path.join(plugins, "sub.mjs"), `import "@loc-studio/sdk/dist/index.js";\n`);
    expect((await inspectPluginCode(path.join(plugins, "sub.mjs"), undefined, { sdkPath })).error).toBeDefined();
    await put(path.join(plugins, "url.mjs"), `import "data:text/javascript,1";\n`);
    expect((await inspectPluginCode(path.join(plugins, "url.mjs"))).error).toContain("URL");
  });

  it("フォルダのプラグインは、入口からたどれないファイルも確かめる", async () => {
    await put(path.join(plugins, "pack", "index.mjs"), `export default { name: "pack" };\n`);
    await put(path.join(plugins, "pack", "unused.mjs"), `import "../../../outside.mjs";\n`);
    const r = await inspectPluginCode(path.join(plugins, "pack"), path.join(plugins, "pack", "index.mjs"));
    expect(r.error).toContain("unused.mjs");
  });

  it("確認のモードでは、問題のあるプラグインのコードを実行しない", async () => {
    const marker = path.join(tmp, "ran");
    await put(path.join(plugins, "p.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nconst n = "./x.mjs";\nawait import(n);\nexport default { name: "p" };\n`);
    const p = await openProject(root, { env: {}, sdkPath, trust: () => true });
    expect(existsSync(marker)).toBe(false);
    expect(p.pluginErrors[0]!.message).toMatch(/p\.mjs:4/);
  });
});
