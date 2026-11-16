import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "@loc-studio/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./commands.js";

/* init: 新しいプロジェクトを作る。一時フォルダに作り、できたものを本物のコマンドとワークスペースで確かめる。 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const sdkPath = path.join(repoRoot, "packages", "sdk", "src", "index.ts");

let tmp: string;
let project: string;
let userDataDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-studio-cli-init-"));
  project = path.join(tmp, "game");
  userDataDir = path.join(tmp, "user");
  await mkdir(userDataDir, { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function cli(args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run([...args, "--project", project, "--user-data-dir", userDataDir], {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    env: { LOC_STUDIO_SDK_PATH: sdkPath, LOC_STUDIO_SETTINGS: path.join(userDataDir, "settings.json") },
    cwd: tmp,
  });
  return { code, stdout, stderr };
}

const configFile = () => path.join(project, "loc-studio.project.json");
const readConfig = async () => JSON.parse(await readFile(configFile(), "utf8")) as Record<string, unknown>;

describe("init", () => {
  it("フォルダと設定ファイルと最初のファイルを作り、tree と entry add がそのまま動く", async () => {
    const r = await cli(["init", "--languages", "ja=日本語,en=English,ko", "--name", "My Game", "--resource", "text/main.csv"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`プロジェクトを作りました: ${project}`);
    expect(r.stdout).toContain("最初のファイル: text/main.csv");
    // 案内のパスは、そのまま貼れる形（Windows の区切りを二重にしない）。
    expect(r.stdout).toContain(`loc-studio tree --project "${project}" で`);
    expect(await readConfig()).toEqual({
      name: "My Game",
      languages: [
        { id: "ja", label: "日本語", pinned: true },
        { id: "en", label: "English", basedOn: "ja" },
        { id: "ko", label: "ko", basedOn: "ja" },
      ],
      columns: [
        { use: "builtin.key", id: "key" },
        { use: "builtin.text", id: "text" },
        { use: "builtin.textStatus", id: "textStatus" },
        { use: "builtin.reviewStatus", id: "reviewStatus", of: "text" },
      ],
      validators: ["builtin.whitespace", "builtin.untranslated"],
    });
    expect(await readFile(path.join(project, "text", "main.csv"), "utf8")).toBe("key,ja,en,ko\n");
    expect((await cli(["tree"])).stdout).toContain("main.csv  0 件");
    expect((await cli(["entry", "add", "TITLE", "--resource", "text/main.csv", "--text", "ja=はじめる"])).code).toBe(0);
    expect(await readFile(path.join(project, "text", "main.csv"), "utf8")).toBe("key,ja,en,ko\nTITLE,はじめる,,\n");
  });

  it("名前を省くとフォルダの名前になり、--no-* で列と検証を外せる。--json は作った設定を返す", async () => {
    const r = await cli(["init", "--languages", "ja", "--no-status", "--no-review", "--no-validators", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { project: string; configFile: string; config: unknown; resource?: string };
    expect(out.project).toBe(project);
    expect(out.configFile).toBe(configFile());
    expect(out.resource).toBeUndefined();
    expect(out.config).toEqual({ name: "game", languages: [{ id: "ja", label: "ja", pinned: true }] });
    expect(await readConfig()).toEqual({ name: "game", languages: [{ id: "ja", label: "ja", pinned: true }] });
    expect(await readdir(project)).toEqual(["loc-studio.project.json"]);
  });

  it("すでにある CSV の列を対応させると、その本文を読めて、画面と同じ開き方でも確認を待たない", async () => {
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "ui.csv"), "Note,ID,JP,EN\nmemo,OK,はい,Yes\n");
    const r = await cli(["init", "--languages", "ja=日本語,en=English", "--key-column", "ID", "--text-columns", "ja=JP,en=EN"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect((await readConfig()).formats).toEqual([
      { use: "builtin.csv", match: "**/*.csv", options: { key: "ID", text: { ja: "JP", en: "EN" } } },
      { use: "builtin.tsv", match: "**/*.tsv", options: { key: "ID", text: { ja: "JP", en: "EN" } } },
    ]);
    const q = await cli(["query", "--where", "text@en = Yes", "--json"]);
    expect(q.code).toBe(0);
    expect((JSON.parse(q.stdout) as { matched: { rows: number } }).matched.rows).toBe(1);
    // 画面と同じ開き方（設定の基盤の項目は、確認したものだけを使う）。
    const ws = await createWorkspace({ projectRoot: project, userDataDir, env: {}, sdkPath });
    try {
      expect((await ws.info()).restricted).not.toBe(true);
    } finally {
      await ws.close();
    }
  });

  it("すでにプロジェクトのあるフォルダには作らず（終了コード 1）、設定ファイルを変えない", async () => {
    expect((await cli(["init", "--languages", "ja"])).code).toBe(0);
    const before = await readFile(configFile(), "utf8");
    const r = await cli(["init", "--languages", "en", "--name", "Other"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("すでにプロジェクトの設定ファイル（loc-studio.project.json）があります");
    expect(await readFile(configFile(), "utf8")).toBe(before);
  });

  it("使い方や入力の誤りは 2 で、何も作らない", async () => {
    const none = await cli(["init"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("--languages が必要です");
    const badId = await cli(["init", "--languages", "ja jp"]);
    expect(badId.code).toBe(2);
    expect(badId.stderr).toContain('言語の ID "ja jp" は使えません');
    const dup = await cli(["init", "--languages", "ja,ja"]);
    expect(dup.code).toBe(2);
    expect(dup.stderr).toContain("重複");
    const badMap = await cli(["init", "--languages", "ja", "--text-columns", "ja"]);
    expect(badMap.code).toBe(2);
    expect(badMap.stderr).toContain("--text-columns は <言語 ID>=<見出し>");
    const badResource = await cli(["init", "--languages", "ja", "--resource", "../x.csv"]);
    expect(badResource.code).toBe(2);
    expect(badResource.stderr).toContain("相対的な書き方");
    const otherCommand = await cli(["tree", "--name", "x"]);
    expect(otherCommand.code).toBe(2);
    expect(otherCommand.stderr).toContain("--name は tree コマンドでは使えません");
    expect(await readdir(tmp)).toEqual(["user"]);
  });
});
