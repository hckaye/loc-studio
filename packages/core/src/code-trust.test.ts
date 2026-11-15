/**
 * 信頼の確認の対象（C1: コードの設定、C3: ハッシュの範囲と、外に出る import）。
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findImports, inspectConfigCode, inspectPluginCode } from "./code-graph.js";
import { loadProjectConfig, UntrustedConfigError } from "./config.js";
import { discoverPluginEntries } from "./plugin-loader.js";
import type { PluginCandidate } from "./plugin-loader.js";
import { openProject } from "./project.js";
import { canSymlink } from "./testing/symlinks.js";

const sdkPath = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));
let tmp: string;
let root: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-codetrust-"));
  root = path.join(tmp, "proj");
  await put(path.join(root, "loc-studio.project.json"), JSON.stringify({ languages: [{ id: "ja", label: "日本語" }] }));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});
async function put(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}
const marker = (name: string) => path.join(tmp, `marker-${name}`);
const sideEffect = (name: string) => `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker(name))}, "ran");\n`;
const never = () => false;

describe("findImports", () => {
  it("静的 import、export from、require、文字列リテラルの import() を見つける", () => {
    const src = `import a from "./a.js";\nimport "./side";\nexport * from "../up.mjs";\nexport { x } from 'pkg/sub';\nconst r = require("./r.cjs");\nawait import("./d.mjs");\nimport type { T } from "./types";\nconst dyn = import(name);`;
    // import type は型の除去で消える（実行されない）。
    expect(findImports(src, "x.ts").sort()).toEqual(["../up.mjs", "./a.js", "./d.mjs", "./r.cjs", "./side", "pkg/sub"].sort());
  });
});

describe("コードの設定（C1）", () => {
  it("信頼されていないコードの設定は import せず、JSON だけを使い、確認待ちに出す", async () => {
    await put(path.join(root, "loc-studio.config.mjs"), `${sideEffect("config")}export default { name: "FromCode" };\n`);
    const seen: PluginCandidate[] = [];
    const loaded = await loadProjectConfig(root, { sdkPath, trustConfig: (c) => (seen.push(c), false) });
    expect(existsSync(marker("config"))).toBe(false);
    expect(loaded.config.name).toBeUndefined();
    expect(loaded.untrustedCode).toMatchObject({ kind: "config", layer: "project", path: path.join(root, "loc-studio.config.mjs") });
    expect(loaded.untrustedCode!.files).toEqual([path.join(root, "loc-studio.config.mjs")]);
    expect(seen).toHaveLength(1);

    // 信頼すれば読み込む。
    const ok = await loadProjectConfig(root, { sdkPath, trustConfig: (c) => c.hash === seen[0]!.hash });
    expect(ok.config.name).toBe("FromCode");
    expect(existsSync(marker("config"))).toBe(true);
  });

  it("openProject も同じ。JSON だけで開けなければ UntrustedConfigError（コードは実行しない）", async () => {
    await put(path.join(root, "loc-studio.config.mjs"), `${sideEffect("config2")}export default { languages: [{ id: "en", label: "English" }] };\n`);
    const p = await openProject(root, { env: {}, sdkPath, trust: never });
    expect(p.untrustedPlugins.map((c) => c.kind)).toEqual(["config"]);
    expect(p.languages.map((l) => l.id)).toEqual(["ja"]);
    await rm(path.join(root, "loc-studio.project.json"));
    const err = await openProject(root, { env: {}, sdkPath, trust: never }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UntrustedConfigError);
    expect((err as UntrustedConfigError).candidate?.kind).toBe("config");
    // reload でも実行しない。
    await expect(p.reload()).rejects.toBeInstanceOf(UntrustedConfigError);
    expect(existsSync(marker("config2"))).toBe(false);
  });

  it("コードの設定の import はプロジェクトの中だけ。外に出る import はエラーにして読み込まない", async () => {
    await put(path.join(tmp, "outside.mjs"), sideEffect("outside") + "export default {};\n");
    await put(path.join(root, "lib", "helper.mjs"), `export const name = "H";\n`);
    await put(path.join(root, "loc-studio.config.mjs"), `import { name } from "./lib/helper.mjs";\nimport "../outside.mjs";\nexport default { name };\n`);
    const r = await inspectConfigCode(root, path.join(root, "loc-studio.config.mjs"));
    expect(r.error).toContain("outside.mjs");
    const loaded = await loadProjectConfig(root, { sdkPath, trustConfig: () => true });
    expect(loaded.codeError).toContain("outside.mjs");
    expect(loaded.config.name).toBeUndefined();
    expect(existsSync(marker("outside"))).toBe(false);
  });
});

describe("プラグインのハッシュの範囲（C3）", () => {
  it("1 ファイルのプラグインは推移的な相対 import を含み、import 先が変わるとハッシュが変わる", async () => {
    const dir = path.join(root, "loc-studio-plugins");
    await put(path.join(dir, "p.mjs"), `import { v } from "./lib/a.mjs";\nexport default { name: "p" + v };\n`);
    await put(path.join(dir, "lib", "a.mjs"), `export { v } from "./b.mjs";\n`);
    await put(path.join(dir, "lib", "b.mjs"), `export const v = 1;\n`);
    const r1 = await inspectPluginCode(path.join(dir, "p.mjs"));
    expect(r1.error).toBeUndefined();
    expect(r1.files.map((f) => path.relative(dir, f).split(path.sep).join("/"))).toEqual(["lib/a.mjs", "lib/b.mjs", "p.mjs"]);
    await put(path.join(dir, "lib", "b.mjs"), `export const v = 2;\n`);
    expect((await inspectPluginCode(path.join(dir, "p.mjs"))).hash).not.toBe(r1.hash);
  });

  it("フォルダの外に出る相対 import と、外のパッケージは、確認のときに読み込みエラー", async () => {
    const dir = path.join(root, "loc-studio-plugins");
    await put(path.join(tmp, "evil.mjs"), sideEffect("evil") + "export default {};\n");
    await put(path.join(dir, "esc.mjs"), `import "../../evil.mjs";\nexport default { name: "esc" };\n`);
    await put(path.join(dir, "bare.mjs"), `import x from "left-pad";\nexport default { name: "bare" };\n`);
    await put(path.join(dir, "ok.mjs"), `import fs from "node:fs";\nimport path from "path";\nimport { definePlugin } from "@loc-studio/sdk";\nexport default definePlugin({ name: "ok" });\n`);
    const p = await openProject(root, { env: {}, sdkPath, trust: () => true });
    const byPath = (name: string) => p.pluginErrors.find((e) => e.path === path.join(dir, name))?.message ?? "";
    expect(byPath("esc.mjs")).toContain("外");
    expect(byPath("bare.mjs")).toContain("left-pad");
    expect(p.registry.plugins().map((x) => x.plugin.name)).toEqual(["ok"]);
    expect(existsSync(marker("evil"))).toBe(false);
    // trust を渡さない（コマンドライン）ときは従来どおり（確かめない）。
    const all = await openProject(root, { env: {}, sdkPath });
    expect(all.registry.plugins().map((x) => x.plugin.name)).toContain("esc");
  });

  it.skipIf(!canSymlink)("フォルダのプラグインの中の、外を指すシンボリックリンクは、確認のときに読み込みエラー（リンク先のコードは動かさない）", async () => {
    const dir = path.join(root, "loc-studio-plugins");
    await put(path.join(tmp, "evil.mjs"), sideEffect("evil") + "export default {};\n");
    await put(path.join(dir, "linked", "index.mjs"), `export default { name: "linked" };\n`);
    await symlink(path.join(tmp, "evil.mjs"), path.join(dir, "linked", "helper.mjs"));
    const p = await openProject(root, { env: {}, sdkPath, trust: () => true });
    expect(p.pluginErrors.find((e) => e.path === path.join(dir, "linked"))?.message ?? "").toContain("外");
    expect(p.registry.plugins().map((x) => x.plugin.name)).toEqual([]);
    expect(existsSync(marker("evil"))).toBe(false);
  });

  it("plugin.json の main はフォルダの中であること（信頼のモードによらず）", async () => {
    const dir = path.join(root, "loc-studio-plugins");
    await put(path.join(tmp, "elsewhere.mjs"), sideEffect("main") + "export default { name: 'x' };\n");
    await put(path.join(dir, "pack", "plugin.json"), JSON.stringify({ main: "../../../elsewhere.mjs" }));
    const entries = await discoverPluginEntries(dir);
    expect(entries.find((e) => e.root.endsWith("pack"))?.error).toContain("外");
    await openProject(root, { env: {}, sdkPath });
    expect(existsSync(marker("main"))).toBe(false);
  });

  it.skipIf(!canSymlink)("plugin.json の main が、外を指すシンボリックリンクでも読み込まない", async () => {
    const dir = path.join(root, "loc-studio-plugins");
    await put(path.join(tmp, "elsewhere.mjs"), sideEffect("main") + "export default { name: 'x' };\n");
    await put(path.join(dir, "pack2", "plugin.json"), JSON.stringify({ main: "entry.mjs" }));
    await symlink(path.join(tmp, "elsewhere.mjs"), path.join(dir, "pack2", "entry.mjs"));
    const entries = await discoverPluginEntries(dir);
    expect(entries.find((e) => e.root.endsWith("pack2"))?.error).toContain("外");
    await openProject(root, { env: {}, sdkPath });
    expect(existsSync(marker("main"))).toBe(false);
  });

  it("読み込みの途中で書き換えられたプラグインは、読み込んだものを捨てて確認待ちに戻す", async () => {
    const file = path.join(root, "loc-studio-plugins", "self.mjs");
    await put(file, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(file)}, "// changed\\n");\nexport default { name: "self", validators: [{ id: "self.v", label: "v", version: "1", validate: () => [] }] };\n`);
    const p = await openProject(root, { env: {}, sdkPath, trust: () => true });
    expect(p.registry.get("validator", "self.v")).toBeUndefined();
    expect(p.untrustedPlugins.map((c) => c.path)).toEqual([file]);
    expect(p.pluginErrors.map((e) => e.message).join("\n")).toContain("書き換えられた");
  });

  it("Web モード: project 層のプラグインのフォルダはプロジェクトかアプリのフォルダの中だけ", async () => {
    const outside = path.join(tmp, "outside-plugins");
    await put(path.join(outside, "o.mjs"), sideEffect("dirs") + "export default { name: 'o' };\n");
    await put(path.join(root, "loc-studio.project.json"), JSON.stringify({ languages: [{ id: "ja", label: "日本語" }], pluginDirs: ["../outside-plugins", "loc-studio-plugins"] }));
    const p = await openProject(root, { env: {}, sdkPath, pluginDirRoots: [root] });
    expect(existsSync(marker("dirs"))).toBe(false);
    expect(p.warnings.join("\n")).toContain("outside-plugins");
  });
});
