import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "./api-types.js";
import { buildProjectConfig, createProject, inspectProjectFolder } from "./new-project.js";
import type { NewProjectInput } from "./new-project.js";
import { SAMPLE_PROJECT, SDK_PATH } from "./testing.js";
import { createWorkspace } from "./workspace.js";

/*
 * 新しいプロジェクトの作成。一時フォルダに本物のファイルを作り、できた設定で本物のワークスペースを開いて確かめる。
 * 期待する設定は、実装の定数からではなく、ここに書き下す。
 */

let tmp: string;
let userDataDir: string;
let localSettingsFile: string;
const opened: Workspace[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-server-new-"));
  userDataDir = path.join(tmp, "user");
  await mkdir(userDataDir, { recursive: true });
  localSettingsFile = path.join(userDataDir, "settings.json");
  await writeFile(localSettingsFile, JSON.stringify({ "user.name": "tester" }));
});

afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.close();
  await rm(tmp, { recursive: true, force: true });
});

/** 画面と同じ開き方（プラグインと設定は、確認したものだけを使う）。 */
async function openLikeScreen(root: string): Promise<Workspace> {
  const ws = await createWorkspace({ projectRoot: root, userDataDir, env: {}, sdkPath: SDK_PATH, revisionCheckIntervalMs: 0 });
  opened.push(ws);
  return ws;
}

const JA_EN = [
  { id: "ja", label: "日本語", pinned: true },
  { id: "en", label: "英語", basedOn: "ja" },
];

const input = (root: string, extra: Partial<NewProjectInput> = {}): NewProjectInput => ({ root, name: "MyGame", languages: JA_EN, ...extra });

const rejects = async (run: () => Promise<unknown> | unknown, code: string, message: string): Promise<void> => {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, "例外になるはず").toBeInstanceOf(Error);
  expect((caught as { code?: string }).code).toBe(code);
  expect((caught as Error).message).toContain(message);
};

describe("inspectProjectFolder（作る前にフォルダを確かめる）", () => {
  it("まだないフォルダは、失敗にせず「ない」と答える", async () => {
    const root = path.join(tmp, "not-yet");
    expect(await inspectProjectFolder({ root })).toEqual({ root, exists: false, resources: [], totalResources: 0 });
  });

  it("空のフォルダは、ファイルも設定もないと答える", async () => {
    const root = path.join(tmp, "empty");
    await mkdir(root);
    expect(await inspectProjectFolder({ root })).toEqual({ root, exists: true, resources: [], totalResources: 0 });
  });

  it("すでにある CSV と TSV を探し、見出しの行を読む（空の行と BOM は飛ばす）", async () => {
    const root = path.join(tmp, "has-files");
    await mkdir(path.join(root, "text", "sub"), { recursive: true });
    await writeFile(path.join(root, "text", "a.csv"), "\uFEFF\r\nID,JP,\"EN, US\"\r\nK1,こんにちは,Hello\r\n");
    await writeFile(path.join(root, "text", "sub", "b.tsv"), "key\tja\ten\nK2\tはい\tYes\n");
    await writeFile(path.join(root, "readme.txt"), "ignored");
    // ツリーに出ない場所（.loc-studio、node_modules）は数えない。
    await mkdir(path.join(root, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "x", "c.csv"), "a,b\n");
    const got = await inspectProjectFolder({ root });
    expect(got).toEqual({
      root,
      exists: true,
      totalResources: 2,
      resources: [
        { path: "text/sub/b.tsv", headers: ["key", "ja", "en"] },
        { path: "text/a.csv", headers: ["ID", "JP", "EN, US"] },
      ],
    });
  });

  it("UTF-8 として読めないファイルは、理由を添えて返し、文字コードを指定すると読める", async () => {
    const root = path.join(tmp, "sjis");
    await mkdir(root);
    // "ID,日本語" の Shift_JIS
    await writeFile(path.join(root, "s.csv"), Buffer.from([0x49, 0x44, 0x2c, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x0a]));
    const auto = await inspectProjectFolder({ root });
    expect(auto.resources).toHaveLength(1);
    expect(auto.resources[0]!.headers).toBeUndefined();
    expect(auto.resources[0]!.error).toContain("UTF-8");
    const sjis = await inspectProjectFolder({ root, encoding: "shift_jis" });
    expect(sjis.resources).toEqual([{ path: "s.csv", headers: ["ID", "日本語"] }]);
  });

  it("見出しを読むのは先頭の 30 個までで、数はすべて数える", async () => {
    const root = path.join(tmp, "many");
    await mkdir(root);
    for (let i = 0; i < 32; i++) await writeFile(path.join(root, `f${String(i).padStart(2, "0")}.csv`), `key,ja\n`);
    const got = await inspectProjectFolder({ root });
    expect(got.totalResources).toBe(32);
    expect(got.resources.map((r) => r.path)).toEqual(Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, "0")}.csv`));
  });

  it("すでにプロジェクトのあるフォルダは、設定ファイルの名前を返す", async () => {
    const got = await inspectProjectFolder({ root: SAMPLE_PROJECT });
    expect(got.configFile).toBe("loc-studio.project.json");
    expect(got.totalResources).toBe(2);
  });

  it("コードの設定ファイルだけのフォルダも、プロジェクトがあると答える", async () => {
    const root = path.join(tmp, "code");
    await mkdir(root);
    await writeFile(path.join(root, "loc-studio.config.mjs"), "export default {};\n");
    expect((await inspectProjectFolder({ root })).configFile).toBe("loc-studio.config.mjs");
  });

  it("フォルダでないもの、相対パス、不明な文字コードは断る", async () => {
    const file = path.join(tmp, "file.txt");
    await writeFile(file, "x");
    await rejects(() => inspectProjectFolder({ root: file }), "invalid", "フォルダではありません");
    await rejects(() => inspectProjectFolder({ root: "relative/path" }), "invalid", "絶対パス");
    await rejects(() => inspectProjectFolder({ root: "  " }), "invalid", "フォルダを指定してください");
    await rejects(() => inspectProjectFolder({ root: tmp, encoding: "euc-jp" }), "invalid", "文字コード");
  });
});

describe("buildProjectConfig（雛形の設定）", () => {
  it("言語と、同梱の列と検証を選んだ設定になる（基盤の項目は書かない）", () => {
    expect(buildProjectConfig(input("/x"))).toEqual({
      name: "MyGame",
      languages: [
        { id: "ja", label: "日本語", pinned: true },
        { id: "en", label: "英語", basedOn: "ja" },
      ],
      columns: [
        { use: "builtin.key", id: "key" },
        { use: "builtin.text", id: "text" },
        { use: "builtin.textStatus", id: "textStatus" },
        { use: "builtin.reviewStatus", id: "reviewStatus", of: "text" },
      ],
      validators: ["builtin.whitespace", "builtin.untranslated"],
    });
  });

  it("列と検証を外すと、その項目を書かない", () => {
    expect(buildProjectConfig(input("/x", { statusColumn: false, reviewColumn: false, validators: false }))).toEqual({
      name: "MyGame",
      languages: [
        { id: "ja", label: "日本語", pinned: true },
        { id: "en", label: "英語", basedOn: "ja" },
      ],
    });
  });

  it("進捗の列だけ、レビューの列だけも選べる", () => {
    expect(buildProjectConfig(input("/x", { reviewColumn: false })).columns).toEqual([
      { use: "builtin.key", id: "key" },
      { use: "builtin.text", id: "text" },
      { use: "builtin.textStatus", id: "textStatus" },
    ]);
    expect(buildProjectConfig(input("/x", { statusColumn: false })).columns).toEqual([
      { use: "builtin.key", id: "key" },
      { use: "builtin.text", id: "text" },
      { use: "builtin.reviewStatus", id: "reviewStatus", of: "text" },
    ]);
  });

  it("名前と表示名の前後の空白は落とし、表示名が空なら ID を使う", () => {
    const config = buildProjectConfig({ root: "/x", name: "  My Game  ", languages: [{ id: " ja ", label: "  " }, { id: "en" }] });
    expect(config.name).toBe("My Game");
    expect(config.languages).toEqual([
      { id: "ja", label: "ja" },
      { id: "en", label: "en" },
    ]);
  });

  it("列の対応は、CSV と TSV のフォーマットのオプションになる（言語 ID と同じ見出しは書かない）", () => {
    const config = buildProjectConfig(input("/x", { mapping: { key: "ID", text: { ja: "JP", en: "en" }, encoding: "shift_jis" } }));
    expect(config.formats).toEqual([
      { use: "builtin.csv", match: "**/*.csv", options: { key: "ID", text: { ja: "JP" }, encoding: "shift_jis" } },
      { use: "builtin.tsv", match: "**/*.tsv", options: { key: "ID", text: { ja: "JP" }, encoding: "shift_jis" } },
    ]);
  });

  it("対応が既定と同じなら、formats を書かない", () => {
    expect(buildProjectConfig(input("/x", { mapping: { text: { ja: "ja", en: "" }, encoding: "auto" } })).formats).toBeUndefined();
    expect(buildProjectConfig(input("/x", { mapping: {} })).formats).toBeUndefined();
  });

  it("誤った入力は、何が誤りかを添えて断る", async () => {
    const bad = (extra: Partial<NewProjectInput>, message: string) => rejects(() => buildProjectConfig(input("/x", extra)), "invalid", message);
    await bad({ name: "   " }, "名前を入力してください");
    await bad({ name: "x".repeat(201) }, "200 文字まで");
    await bad({ languages: [] }, "言語を 1 つ以上");
    await bad({ languages: [{ id: "" }] }, "1 番目の言語の ID が空です");
    await bad({ languages: [{ id: "ja jp" }] }, '言語の ID "ja jp" は使えません');
    await bad({ languages: [{ id: "日本語" }] }, "半角の英数字で始め");
    await bad({ languages: [{ id: "ja@x" }] }, "使えません");
    await bad({ languages: [{ id: "any" }] }, "どれかの言語");
    await bad({ languages: [{ id: "ALL" }] }, "すべての言語");
    await bad({ languages: [{ id: "ja" }, { id: "ja" }] }, '言語の ID "ja" が重複しています');
    await bad({ languages: [{ id: "ja", basedOn: "ja" }] }, "その言語自身は指定できません");
    await bad({ languages: [{ id: "ja", basedOn: "fr" }] }, '翻訳元 "fr" という言語はありません');
    await bad({ languages: [{ id: "a", basedOn: "b" }, { id: "b", basedOn: "a" }] }, "循環");
    await bad({ mapping: { text: { fr: "FR" } } }, '"fr" という言語はありません');
    await bad({ mapping: { key: "ID", text: { ja: "ID" } } }, "列「ID」を、キーと言語 \"ja\" の本文の両方に使っています");
    await bad({ mapping: { text: { ja: "T", en: "T" } } }, "列「T」を");
    await bad({ mapping: { encoding: "euc-jp" } }, "文字コード");
  });
});

describe("createProject（設定ファイルを書く）", () => {
  it("フォルダがなければ作り、設定ファイルだけを書く", async () => {
    const root = path.join(tmp, "deep", "new-game");
    const result = await createProject(input(root, { firstResource: "text/main.csv" }));
    expect(result.root).toBe(root);
    expect(result.configFile).toBe(path.join(root, "loc-studio.project.json"));
    expect(result.firstResource).toBe("text/main.csv");
    expect(result.trusted).toBe(false);
    expect(await readdir(root)).toEqual(["loc-studio.project.json"]);
    const text = await readFile(result.configFile, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      name: "MyGame",
      languages: [
        { id: "ja", label: "日本語", pinned: true },
        { id: "en", label: "英語", basedOn: "ja" },
      ],
      columns: [
        { use: "builtin.key", id: "key" },
        { use: "builtin.text", id: "text" },
        { use: "builtin.textStatus", id: "textStatus" },
        { use: "builtin.reviewStatus", id: "reviewStatus", of: "text" },
      ],
      validators: ["builtin.whitespace", "builtin.untranslated"],
    });
  });

  it("作ったプロジェクトは、確認なしで開けて、ファイルと行を足して本文を書ける", async () => {
    const root = path.join(tmp, "fresh");
    const result = await createProject(input(root, { firstResource: "text/main.csv" }), { localSettingsFile });
    // 基盤の項目がないので、信頼の記録は要らない。
    expect(result.trusted).toBe(false);
    const ws = await openLikeScreen(root);
    const info = await ws.info();
    expect(info.restricted).not.toBe(true);
    expect(info.name).toBe("MyGame");
    expect(info.languages.map((l) => l.id)).toEqual(["ja", "en"]);
    expect(info.columns.map((c) => c.id)).toEqual(["key", "text", "textStatus", "reviewStatus"]);
    expect(info.warnings).toEqual([]);

    const { resource } = await ws.createResource({ path: result.firstResource! });
    expect(await readFile(path.join(root, "text", "main.csv"), "utf8")).toBe("key,ja,en\n");
    await ws.editEntries({ resourceId: resource.id, changes: [{ type: "add", key: "TITLE", text: { ja: "はじめる", en: "Start" } }] });
    expect(await readFile(path.join(root, "text", "main.csv"), "utf8")).toBe("key,ja,en\nTITLE,はじめる,Start\n");
    const rows = await ws.rows({ resourceId: resource.id, languages: ["ja", "en"], offset: 0, limit: 10 });
    expect(rows.total).toBe(1);
    expect(rows.rows[0]!.key).toBe("TITLE");
  });

  it("すでにある CSV に列を対応させたプロジェクトは、確認なしで開けて、その本文を読める", async () => {
    const root = path.join(tmp, "existing");
    await mkdir(path.join(root, "Text"), { recursive: true });
    await writeFile(path.join(root, "Text", "ui.csv"), "Note,ID,JP,EN\nmemo,OK,はい,Yes\n");
    const result = await createProject(input(root, { mapping: { key: "ID", text: { ja: "JP", en: "EN" } } }), { localSettingsFile });
    expect(result.trusted).toBe(true);
    const ws = await openLikeScreen(root);
    const info = await ws.info();
    expect(info.restricted).not.toBe(true);
    const rows = await ws.rows({ resourceId: "Text/ui.csv", languages: ["ja", "en"], offset: 0, limit: 10 });
    expect(rows.rows.map((r) => r.key)).toEqual(["OK"]);
    const cells = rows.rows[0]!.cells;
    expect(cells["text@ja"]!.value).toBe("はい");
    expect(cells["text@en"]!.value).toBe("Yes");
    // 既存のファイルは、作成では変えない。
    expect(await readFile(path.join(root, "Text", "ui.csv"), "utf8")).toBe("Note,ID,JP,EN\nmemo,OK,はい,Yes\n");
  });

  it("確認済みの記録を書かなければ、列を対応させたプロジェクトは確認を待つ（記録が効いていることの裏づけ）", async () => {
    const root = path.join(tmp, "untrusted");
    await mkdir(root);
    await writeFile(path.join(root, "ui.csv"), "ID,JP\nOK,はい\n");
    const result = await createProject(input(root, { mapping: { text: { ja: "JP" } } }));
    expect(result.trusted).toBe(false);
    const ws = await openLikeScreen(root);
    expect((await ws.info()).restricted).toBe(true);
  });

  it("確認済みの記録は、書いた設定ファイルの中身にだけ効く（あとで基盤の項目を変えたら、また確認を待つ）", async () => {
    const root = path.join(tmp, "changed");
    await mkdir(root);
    await writeFile(path.join(root, "ui.csv"), "ID,JP\nOK,はい\n");
    const result = await createProject(input(root, { mapping: { text: { ja: "JP" } } }), { localSettingsFile });
    const stored = JSON.parse(await readFile(localSettingsFile, "utf8")) as Record<string, unknown>;
    // もとの個人の設定は残したまま、このプロジェクトのこのファイルだけを記録する。
    expect(stored["user.name"]).toBe("tester");
    const trust = stored["plugins.trust"] as Record<string, Record<string, string>>;
    expect(Object.keys(trust)).toEqual([root]);
    expect(Object.keys(trust[root]!)).toEqual([result.configFile]);
    expect(trust[root]![result.configFile]).toMatch(/^[0-9a-f]{64}$/);

    const config = JSON.parse(await readFile(result.configFile, "utf8")) as Record<string, unknown>;
    config.tree = { use: "builtin.globTree", options: { include: ["**/*.csv"] } };
    await writeFile(result.configFile, JSON.stringify(config, null, 2));
    const ws = await openLikeScreen(root);
    expect((await ws.info()).restricted).toBe(true);
  });

  it("すでにプロジェクトのあるフォルダには作らず、設定ファイルを変えない", async () => {
    const root = path.join(tmp, "taken");
    await mkdir(root);
    const file = path.join(root, "loc-studio.project.json");
    await writeFile(file, '{"name":"Old","languages":[{"id":"ja","label":"日本語"}]}');
    await rejects(() => createProject(input(root), { localSettingsFile }), "conflict", "すでにプロジェクトの設定ファイル（loc-studio.project.json）があります");
    expect(await readFile(file, "utf8")).toBe('{"name":"Old","languages":[{"id":"ja","label":"日本語"}]}');
    expect(JSON.parse(await readFile(localSettingsFile, "utf8"))).toEqual({ "user.name": "tester" });
  });

  it("コードの設定ファイルがあるフォルダにも作らない", async () => {
    const root = path.join(tmp, "code");
    await mkdir(root);
    await writeFile(path.join(root, "loc-studio.config.ts"), "export default {};\n");
    await rejects(() => createProject(input(root)), "conflict", "loc-studio.config.ts");
    expect(await readdir(root)).toEqual(["loc-studio.config.ts"]);
  });

  it("入力が誤っていたら、フォルダも設定ファイルも作らない", async () => {
    const root = path.join(tmp, "invalid");
    await rejects(() => createProject(input(root, { languages: [{ id: "ja" }, { id: "ja" }] })), "invalid", "重複");
    await rejects(() => createProject(input(root, { firstResource: "../out.csv" })), "invalid", "相対的な書き方");
    await rejects(() => createProject(input(root, { firstResource: "C:/x.csv" })), "invalid", "相対的な書き方");
    await rejects(() => createProject(input(root, { firstResource: "text\\main.csv" })), "invalid", "相対的な書き方");
    await rejects(() => createProject(input(root, { firstResource: "text/main.txt" })), "invalid", ".csv か .tsv");
    await rejects(() => createProject(input("relative")), "invalid", "絶対パス");
    expect(await readdir(tmp)).toEqual(["user"]);
  });

  it("フォルダの場所にファイルがあれば断る", async () => {
    const file = path.join(tmp, "file.txt");
    await writeFile(file, "x");
    await rejects(() => createProject(input(file)), "invalid", "フォルダではありません");
    expect(await readFile(file, "utf8")).toBe("x");
  });
});
