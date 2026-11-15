/**
 * 1 ファイルのプラグインとコードの設定での厳しい確認（createRequire と同じことができる書き方を断る）。
 * フォルダのプラグインでは断らない（フォルダの中のすべてのファイルがハッシュに入るため）。
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectPluginCode, scanSource } from "./code-graph.js";
import { loadProjectConfig } from "./config.js";
import { openProject } from "./project.js";

const sdkPath = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));
let tmp: string;
let root: string;
let plugins: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-strict-"));
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

/** レビューの書き方（どれも、ほかのファイルを import の外から読み込む）。 */
const FORMS: Record<string, string> = {
  arguments: `(function(){})(); const a = arguments; a[1]("./_x.cjs");`,
  eval: `eval("require")("./_x.cjs");`,
  moduleComputed: `(module as any)["req"+"uire"]("./_x.cjs");`,
  getBuiltinModule: `const m: any = process.getBuiltinModule("node:module"); m["create"+"Require"](import.meta.filename)("./_x.cjs");`,
  newFunction: `new Function("p", "return process.getBuiltinModule('node:module')['createRequire'](p)")(import.meta.filename)("./_x.cjs");`,
  vm: `import vm from "node:vm"; import { readFileSync } from "node:fs"; vm.runInThisContext(readFileSync(new URL("./_x.cjs", import.meta.url), "utf8"));`,
  worker: `import { Worker } from "node:worker_threads"; new Worker(new URL("./_w.cjs", import.meta.url));`,
  childProcess: `import { execFileSync } from "child_process"; execFileSync(process.execPath, [new URL("./_w.cjs", import.meta.url).pathname]);`,
  globalThisComputed: `(globalThis as any)["req" + "uire"]("./_x.cjs");`,
};

const markerCode = (marker: string) => `import { writeFileSync as __w } from "node:fs";\n__w(${JSON.stringify(marker)}, "ran");\n`;

describe("厳しい確認: 1 ファイルのプラグイン", () => {
  for (const [name, form] of Object.entries(FORMS)) {
    it(`${name} は断り、何も動かさない`, async () => {
      const marker = path.join(tmp, `ran-${name}`);
      await put(path.join(plugins, `${name}.ts`), `${markerCode(marker)}${form}\nexport default { name: "${name}" };\n`);
      await put(path.join(plugins, "_x.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker + "-x")}, "x");\n`);
      await put(path.join(plugins, "_w.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker + "-w")}, "w");\n`);
      const p = await openProject(root, { env: {}, sdkPath, trust: () => true });
      const err = p.pluginErrors.find((e) => e.path === path.join(plugins, `${name}.ts`));
      expect(err?.message, name).toContain("plugin.json のあるフォルダ");
      expect(err?.message).toMatch(new RegExp(`${name}\\.ts:\\d+`));
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(marker + "-x")).toBe(false);
      expect(existsSync(marker + "-w")).toBe(false);
    });
  }
});

describe("厳しい確認: コードの設定", () => {
  for (const [name, form] of Object.entries(FORMS)) {
    it(`${name} は断り、何も動かさない`, async () => {
      const marker = path.join(tmp, `cfg-${name}`);
      await put(path.join(root, "loc-studio.config.ts"), `${markerCode(marker)}${form}\nexport default { name: "C" };\n`);
      await put(path.join(root, "_x.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker + "-x")}, "x");\n`);
      await put(path.join(root, "_w.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker + "-w")}, "w");\n`);
      const loaded = await loadProjectConfig(root, { sdkPath, trustConfig: () => true });
      expect(loaded.codeError, name).toContain("plugin.json のあるフォルダ");
      expect(loaded.config.name).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(marker + "-x")).toBe(false);
    });
  }
});

describe("厳しい確認は、ローカルの名前と取り違えない", () => {
  it("引数や変数の eval / Function / arguments、関数の中の arguments、module.exports は断らない", () => {
    const ok = [
      `function f(eval2, args) { return arguments.length; }`,
      `function g() { const Function = 1; return Function; }`,
      `const h = (x) => { let eval_ = x; return eval_; };`,
      `function k(Function) { return new Function(); }`,
      `module.exports = { a: 1 }; module.id;`,
      `try {} catch (arguments2) {}`,
      `const o = { eval: 1, Function: 2 }; o.eval; o.Function;`,
    ];
    for (const src of ok) expect(scanSource(src, "x.cjs", { strict: true }).problems, src).toEqual([]);
    // 外側で宣言されていない名前は、迷ったら断る。
    expect(scanSource(`if (x) { const Function = 1 } new Function("")`, "x.mjs", { strict: true }).problems.length).toBeGreaterThan(0);
    expect(scanSource(`const f = () => arguments[0];`, "x.cjs", { strict: true }).problems.length).toBeGreaterThan(0);
    expect(scanSource(`x instanceof Function`, "x.mjs", { strict: true }).problems.length).toBeGreaterThan(0);
    // 関数の中で宣言した module という名前の変数は、CommonJS の module ではない
    expect(scanSource(`function h() { const module = { a: 1 }; return module; } export default h;`, "x.mjs", { strict: true }).problems).toEqual([]);
    expect(scanSource(`const m = module; export default m;`, "x.cjs", { strict: true }).problems.length).toBeGreaterThan(0);
    // 厳しくない確認（フォルダのプラグイン）では断らない。
    expect(scanSource(`new Function("return 1")(); eval("1");`, "x.mjs").problems).toEqual([]);
  });
});

describe("フォルダのプラグインは、フォルダの中のコードなら new Function や worker_threads を使える", () => {
  it("読み込め、worker のファイルもハッシュに入る", async () => {
    const dir = path.join(plugins, "pack");
    await put(path.join(dir, "plugin.json"), JSON.stringify({ main: "index.mjs" }));
    await put(
      path.join(dir, "index.mjs"),
      `import { Worker } from "node:worker_threads";\nconst f = new Function("return 41 + 1");\nexport const startWorker = () => new Worker(new URL("./worker.mjs", import.meta.url));\nexport default { name: "pack-" + f() };\n`,
    );
    await put(path.join(dir, "worker.mjs"), `import { parentPort } from "node:worker_threads";\nparentPort?.postMessage("hi");\n`);
    const r = await inspectPluginCode(dir, path.join(dir, "index.mjs"));
    expect(r.error).toBeUndefined();
    expect(r.files.map((f) => path.basename(f)).sort()).toEqual(["index.mjs", "plugin.json", "worker.mjs"]);
    const p = await openProject(root, { env: {}, sdkPath, trust: () => true });
    expect(p.registry.plugins().map((x) => x.plugin.name)).toContain("pack-42");
  });
});

describe("node:module と危ない組み込みに、動的な import や再エクスポートで届かない（レビュー 4 回目の 1）", () => {
  const MODULE_FORMS: Record<string, string> = {
    dyn4: `const { createRequire: cr } = await import("node:module"); cr(import.meta.url)("./_x.cjs");`,
    dyn2: `const m = await import("node:module"); const { createRequire: cr } = m; cr(import.meta.url)("./_x.cjs");`,
    dyn5: `import("node:module").then(({ Module }: any) => Module._load("./_x.cjs"));`,
    reflect: `const cr: any = Reflect.get(await import("module"), "create" + "Require"); cr(import.meta.url)("./_x.cjs");`,
    namespace: `import * as m from "node:module"; (m as any).createRequire(import.meta.url)("./_x.cjs");`,
    defaultImport: `import m from "module"; const k = "createRequire"; (m as any)[k](import.meta.url)("./_x.cjs");`,
    exportAll: `export * from "node:module";`,
    exportNamed: `export { createRequire } from "node:module";`,
  };
  const STRICT_BUILTIN_FORMS: Record<string, string> = {
    dynVm: `const vm = await import("node:vm"); vm.runInThisContext("1");`,
    dynWorker: `const { Worker } = await import("worker_threads"); new Worker(new URL("./_w.cjs", import.meta.url));`,
    exportChild: `export * from "node:child_process";`,
    exportWorker: `export { Worker } from "worker_threads";`,
  };

  for (const [name, form] of Object.entries({ ...MODULE_FORMS, ...STRICT_BUILTIN_FORMS })) {
    it(`1 ファイルのプラグイン: ${name} は断り、何も動かさない`, async () => {
      const marker = path.join(tmp, `dyn-${name}`);
      await put(path.join(plugins, `${name}.ts`), `${markerCode(marker)}${form}\nexport default { name: "${name}" };\n`);
      await put(path.join(plugins, "_x.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker + "-x")}, "x");\n`);
      await put(path.join(plugins, "_w.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker + "-w")}, "w");\n`);
      const p = await openProject(root, { env: {}, sdkPath, trust: () => true });
      expect(p.pluginErrors.find((e) => e.path === path.join(plugins, `${name}.ts`))?.message, name).toMatch(new RegExp(`${name}\\.ts:\\d+`));
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(marker + "-x")).toBe(false);
      expect(existsSync(marker + "-w")).toBe(false);
    });
  }

  for (const [name, form] of Object.entries(MODULE_FORMS)) {
    it(`コードの設定とフォルダのプラグインでも: ${name} は断る`, async () => {
      expect(scanSource(form, "c.ts", { strict: true }).problems.length, name).toBeGreaterThan(0);
      // フォルダのプラグイン（厳しくない確認）でも node:module は断る（フォルダの外に届くため）。
      expect(scanSource(form, "c.ts").problems.length, name).toBeGreaterThan(0);
    });
  }

  it("名前を指定した builtinModules / isBuiltin の import はよい", () => {
    expect(scanSource(`import { builtinModules, isBuiltin } from "node:module"; export const b = isBuiltin("fs") && builtinModules.length;`, "x.mjs", { strict: true }).problems).toEqual([]);
    expect(scanSource(`import "node:module";`, "x.mjs", { strict: true }).problems).toEqual([]);
  });

  it("フォルダのプラグインで import(\"node:module\") を使うと読み込まない", async () => {
    const dir = path.join(plugins, "pack");
    await put(path.join(dir, "index.mjs"), `const { createRequire } = await import("node:module");\nexport default { name: "pack" };\n`);
    const r = await inspectPluginCode(dir, path.join(dir, "index.mjs"));
    expect(r.error).toContain("node:module");
  });
});
