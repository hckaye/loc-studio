import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rendererModuleFile, rendererModuleProblem, validatePluginShape } from "./plugin-loader.js";
import { openProject } from "./project.js";

const sdkPath = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));
let tmp: string;
let root: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-renderer-"));
  root = path.join(tmp, "proj");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});
async function put(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe("独自描画（renderer）", () => {
  it("module は相対パスで、プラグインのフォルダの外を指さないこと", () => {
    expect(rendererModuleProblem("ui/cell.mjs")).toBeUndefined();
    expect(rendererModuleProblem("./a/../cell.js")).toBeUndefined();
    for (const bad of ["", "/abs/x.js", "C:\\x.js", "C:/x.js", "\\\\server\\x.js", "../x.js", "a/../../x.js", "https://e.com/x.js", ".", "a/.."]) {
      expect(rendererModuleProblem(bad), bad).toBeDefined();
    }
    expect(validatePluginShape({ name: "p", renderers: [{ id: "r", module: "../evil.js" }] }).join("\n")).toContain("外");
    expect(validatePluginShape({ name: "p", renderers: [{ id: "r" }] }).join("\n")).toContain("module");
    expect(validatePluginShape({ name: "p", renderers: [{ id: "r", module: "cell.mjs" }] })).toEqual([]);
  });

  it("登録し、モジュールの場所を 1 ファイル／フォルダのプラグインで解決する。未登録の renderer の列は警告", async () => {
    await put(
      path.join(root, "loc-studio.project.json"),
      JSON.stringify({
        languages: [{ id: "ja", label: "日本語" }],
        columns: [
          { id: "key", kind: "key", scope: "entry" },
          { id: "c", kind: "meta", scope: "entry", source: "file", renderer: "single.bar", display: "progress" },
          { id: "d", kind: "meta", scope: "entry", source: "file", renderer: "nope" },
        ],
      }),
    );
    await put(path.join(root, "loc-studio-plugins", "single.mjs"), `export default { name: "single", renderers: [{ id: "single.bar", module: "ui/bar.mjs" }] };`);
    await put(path.join(root, "loc-studio-plugins", "pack", "index.mjs"), `export default { name: "pack", renderers: [{ id: "pack.tag", module: "./web/tag.js" }] };`);
    await put(path.join(root, "loc-studio-plugins", "bad.mjs"), `export default { name: "bad", renderers: [{ id: "bad.r", module: "../../x.js" }] };`);
    const project = await openProject(root, { env: {}, sdkPath });
    const single = project.registry.list("renderer").find((e) => e.id === "single.bar")!;
    const pack = project.registry.list("renderer").find((e) => e.id === "pack.tag")!;
    expect(rendererModuleFile(single.origin, single.value.module)).toBe(path.join(root, "loc-studio-plugins", "ui", "bar.mjs"));
    expect(rendererModuleFile(pack.origin, pack.value.module)).toBe(path.join(root, "loc-studio-plugins", "pack", "web", "tag.js"));
    expect(rendererModuleFile({}, "x.js")).toBeUndefined();
    expect(project.registry.get("renderer", "bad.r")).toBeUndefined();
    expect(project.pluginErrors.map((e) => e.path)).toContain(path.join(root, "loc-studio-plugins", "bad.mjs"));
    expect(project.columns().find((c) => c.id === "c")).toMatchObject({ renderer: "single.bar", display: "progress" });
    expect(project.warnings.join("\n")).toContain('renderer "nope"');
    expect(project.warnings.join("\n")).not.toContain('renderer "single.bar"');
  });
});
