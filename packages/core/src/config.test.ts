import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandEnv, loadProjectConfig, validateProjectConfig } from "./config.js";

const sdkPath = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-config-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const put = (name: string, content: string) => writeFile(path.join(tmp, name), content);
const langs = [
  { id: "ja", label: "日本語" },
  { id: "en", label: "English", basedOn: "ja" },
];

describe("loadProjectConfig", () => {
  it("JSON だけを読む", async () => {
    await put("loc-studio.project.json", JSON.stringify({ name: "P", languages: langs }));
    const r = await loadProjectConfig(tmp);
    expect(r.config.name).toBe("P");
    expect(r.files).toEqual({ json: path.join(tmp, "loc-studio.project.json") });
    expect(r.fromCode).toEqual([]);
  });

  it("コードの設定の最上位のキーが JSON を置き換える", async () => {
    await put("loc-studio.project.json", JSON.stringify({ name: "json", languages: langs, syntaxes: ["a"] }));
    await put(
      "loc-studio.config.ts",
      `import { defineConfig } from "@loc-studio/sdk";
       export default () => defineConfig({ syntaxes: ["b", "c"], tree: { use: "t", options: { x: 1 } } } as any);`,
    );
    const r = await loadProjectConfig(tmp, { sdkPath });
    expect(r.config.name).toBe("json");
    expect(r.config.syntaxes).toEqual(["b", "c"]);
    expect(r.config.tree).toEqual({ use: "t", options: { x: 1 } });
    expect(r.config.languages).toEqual(langs);
    expect(r.fromCode.sort()).toEqual(["syntaxes", "tree"]);
    expect(r.files.code).toBe(path.join(tmp, "loc-studio.config.ts"));
  });

  it("コードだけでもよい（.mjs、非同期の関数）", async () => {
    await put("loc-studio.config.mjs", `export default async () => ({ languages: ${JSON.stringify(langs)} });`);
    const r = await loadProjectConfig(tmp);
    expect(r.config.languages).toHaveLength(2);
    expect(r.fromCode).toEqual(["languages"]);
    expect(r.files.json).toBeUndefined();
  });

  it("JSON の構文エラーはファイルのパスを含める", async () => {
    await put("loc-studio.project.json", "{ languages: ");
    await expect(loadProjectConfig(tmp)).rejects.toThrow(path.join(tmp, "loc-studio.project.json"));
  });

  it("設定ファイルがなければ分かるエラー", async () => {
    await expect(loadProjectConfig(tmp)).rejects.toThrow(/設定ファイル.*ありません/);
  });

  it("コードの設定が壊れていればパスを含める", async () => {
    await put("loc-studio.config.ts", `export default {{`);
    await expect(loadProjectConfig(tmp)).rejects.toThrow("loc-studio.config.ts");
  });

  it("検証に失敗すると問題を並べる", async () => {
    await put("loc-studio.project.json", JSON.stringify({ languages: [{ id: "ja", label: "a" }, { id: "ja", label: 1 }] }));
    await expect(loadProjectConfig(tmp)).rejects.toThrow(/重複[\s\S]*label/);
  });
});

describe("validateProjectConfig", () => {
  it("正しい設定は問題なし", () => {
    expect(validateProjectConfig({ languages: langs })).toEqual([]);
  });
  it("languages が空、または配列でない", () => {
    expect(validateProjectConfig({ languages: [] })[0]).toContain("languages");
    expect(validateProjectConfig({})[0]).toContain("languages");
  });
  it("id が空、basedOn の参照先がない", () => {
    const p = validateProjectConfig({ languages: [{ id: "", label: "x" }, { id: "en", label: "e", basedOn: "zz" }] });
    expect(p.join("\n")).toMatch(/id は空でない[\s\S]*"zz"/);
  });
  it("basedOn の循環", () => {
    const p = validateProjectConfig({
      languages: [
        { id: "a", label: "a", basedOn: "c" },
        { id: "b", label: "b", basedOn: "a" },
        { id: "c", label: "c", basedOn: "b" },
        { id: "d", label: "d", basedOn: "d" },
      ],
    });
    expect(p.filter((m) => m.includes("循環"))).toHaveLength(2);
  });
});

describe("expandEnv", () => {
  it("${env:NAME} を展開する", () => {
    expect(expandEnv("${env:HOME_DIR}/db/${env:N}.sqlite", { HOME_DIR: "/srv", N: "x" })).toBe("/srv/db/x.sqlite");
    expect(expandEnv("plain", {})).toBe("plain");
  });
  it("変数がなければ例外", () => {
    expect(() => expandEnv("${env:MISSING_ONE}", {})).toThrow("MISSING_ONE");
  });
});
