import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "@loc-studio/server";
import type { Workspace } from "@loc-studio/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./commands.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const sample = path.join(repoRoot, "examples", "sample-project");
const sdkPath = path.join(repoRoot, "packages", "sdk", "src", "index.ts");

const UI = "Assets/Text/system/ui.csv";
const CHAPTER = "Assets/Text/chapter01.csv";

const FAKE_PLUGIN = `
import { appendFileSync, existsSync } from "node:fs";
export default {
  name: "fake-batch",
  generators: [{
    id: "fake.reverse",
    version: "1",
    cacheParams: () => ({}),
    input: (ctx) => {
      const text = ctx.language ? ctx.row.text(ctx.language.id) : undefined;
      return text ? { text, language: ctx.language.id } : null;
    },
    async run(inputs, ctx) {
      appendFileSync(ctx.options.counter, "x");
      if (ctx.options.delayMs) await new Promise((r) => setTimeout(r, ctx.options.delayMs));
      if (ctx.options.failFile && existsSync(ctx.options.failFile)) throw new Error("生成に失敗");
      return inputs.map((i) => ({ value: [...i.text].reverse().join("") }));
    },
  }],
  actions: [
    {
      id: "fake.mark",
      label: "作業中にする",
      target: "cell",
      columns: ["textStatus"],
      async run(ctx) {
        return { patches: [{ resourceId: ctx.entry.resource.id, entryKey: ctx.entry.key, columnId: "textStatus", language: ctx.language.id, value: "wip" }] };
      },
    },
    {
      id: "fake.count",
      label: "数える",
      target: "file",
      async run(ctx) { return { message: ctx.entries.length + " 行あります" }; },
    },
  ],
};
`;

let tmp: string;
let project: string;
let userDataDir: string;
let counter: string;
let failFile: string;
const opened: Workspace[] = [];

async function cli(args: string[], extra: string[] = []) {
  let stdout = "";
  let stderr = "";
  const code = await run([...args, "--project", project, "--user-data-dir", userDataDir, ...extra], {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    env: { LOC_STUDIO_SDK_PATH: sdkPath, LOC_STUDIO_SETTINGS: path.join(tmp, "none", "settings.json") },
    cwd: repoRoot,
  });
  return { code, stdout, stderr };
}

const openWs = async (): Promise<Workspace> => {
  const ws = await createWorkspace({ projectRoot: project, userDataDir, env: {}, sdkPath, pluginTrust: "always" });
  opened.push(ws);
  return ws;
};

const calls = async (): Promise<number> => (await readFile(counter, "utf8").catch(() => "")).length;

interface StatusJson {
  resources: {
    path: string;
    entries: number;
    unsaved: number;
    issues: { error: number; warning: number; info: number };
    progress: Record<string, Record<string, { complete: number; total: number; percent: number }>>;
  }[];
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-studio-cli-batch-"));
  project = path.join(tmp, "project");
  userDataDir = path.join(tmp, "user");
  counter = path.join(tmp, "calls.txt");
  failFile = path.join(tmp, "fail.flag");
  await cp(sample, project, { recursive: true });
  await writeFile(path.join(project, "loc-studio-plugins", "fake-batch.mjs"), FAKE_PLUGIN);
  const file = path.join(project, "loc-studio.project.json");
  const config = JSON.parse(await readFile(file, "utf8")) as { columns: unknown[] };
  config.columns.push({ id: "back", kind: "generated", scope: "language", generator: "backTr", languages: ["JaEnglish", "ko"] });
  Object.assign(config, {
    generators: { backTr: { use: "fake.reverse", options: { counter, failFile } } },
    actions: ["fake.mark", "fake.count"],
  });
  await writeFile(file, JSON.stringify(config, null, 2));
});

afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("status", () => {
  it("JSON の形と件数", async () => {
    const r = await cli(["status", "--json"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout) as StatusJson;
    expect(data.resources.map((x) => x.path).sort()).toEqual([CHAPTER, UI]);
    const ui = data.resources.find((x) => x.path === UI)!;
    expect(ui.entries).toBe(4);
    expect(ui.unsaved).toBe(0);
    expect(ui.issues).toEqual(expect.objectContaining({ error: expect.any(Number), warning: expect.any(Number), info: expect.any(Number) }));
    expect(ui.progress["textStatus"]!["ko"]).toEqual({ complete: 0, total: 4, percent: 0 });
    expect(Object.keys(ui.progress["reviewStatus"]!)).toContain("ja");
  });

  it("--resources と --languages で絞り、テキストにも進捗が出る", async () => {
    const r = await cli(["status"], ["--resources", "**/ui.csv", "--languages", "ko"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(UI);
    expect(r.stdout).not.toContain("chapter01.csv");
    expect(r.stdout).toMatch(/textStatus: ko 0\/4 \(0%\)/);
    expect(r.stdout).not.toMatch(/ja \d/);
    expect(r.stdout).not.toContain("数えています");
  });

  it("grid.progressUnit が characters なら、進捗を原文の文字数で出し、その旨を示す", async () => {
    const file = path.join(project, "loc-studio.project.json");
    const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...config, grid: { progressUnit: "characters" } }, null, 2));
    expect((await cli(["set", "textStatus@ko", "done"], ["--resource", UI, "--keys", "UI_OK"])).code).toBe(0);
    const text = await cli(["status"], ["--resources", "**/ui.csv", "--languages", "ko"]);
    expect(text.stdout).toContain("進捗は、原文の文字数で数えています。");
    // ui.csv の原文（ja）は合計 27 文字。「決定」は 2 文字。
    expect(text.stdout).toMatch(/textStatus: ko 2\/27 \(7\.4%\)/);
    const data = JSON.parse((await cli(["status"], ["--resources", "**/ui.csv", "--json"])).stdout) as { progressUnit: string };
    expect(data.progressUnit).toBe("characters");
  });
});

describe("set", () => {
  it("値を設定すると status の進捗が進み、履歴に --user の名前が残る", async () => {
    const r = await cli(["set", "textStatus@ko", "done"], ["--resource", UI, "--keys", "UI_OK,UI_CANCEL", "--user", "batch-bot"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("更新 2");

    const data = JSON.parse((await cli(["status", "--json", "--resources", "**/ui.csv"])).stdout) as StatusJson;
    expect(data.resources[0]!.progress["textStatus"]!["ko"]).toEqual({ complete: 2, total: 4, percent: 50 });

    const ws = await openWs();
    const h = await ws.history({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko" });
    expect(h[0]).toMatchObject({ by: "batch-bot", newValue: "done", cause: "bulk" });
  });

  it("必須オプションがない・リソースがない・列がない", async () => {
    expect((await cli(["set", "textStatus@ko", "done"], ["--keys", "UI_OK"])).code).toBe(2);
    expect((await cli(["set", "textStatus@ko", "done"], ["--resource", UI])).code).toBe(2);
    expect((await cli(["set", "textStatus@ko", "done"], ["--resource", "none.csv", "--keys", "A"])).code).toBe(2);
    const bad = await cli(["set", "nope@ko", "done"], ["--resource", UI, "--keys", "UI_OK"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).not.toBe("");
    expect((await cli(["set", "textStatus@ko"], [])).code).toBe(2);
  });
});

describe("save", () => {
  it("ドラフトを書き込み、再実行は 0 件", async () => {
    const ws = await openWs();
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "JaEnglish", value: "Okay" });
    expect((await ws.tree()).some((n) => JSON.stringify(n).includes('"unsaved"'))).toBe(true);
    const r = await cli(["save", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ resources: 1, saved: 1, conflicts: 0, conflictList: [] });
    expect(await readFile(path.join(project, ...UI.split("/")), "utf8")).toContain("Okay");
    const again = await cli(["save"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("セル 0");
  });
});

describe("save の競合", () => {
  it("競合のセルを一覧に出して終了コード 1", async () => {
    const ws = await openWs();
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "JaEnglish", value: "Mine" });
    const file = path.join(project, ...UI.split("/"));
    await writeFile(file, (await readFile(file, "utf8")).replace("UI_OK,決定,OK,", "UI_OK,決定,Theirs,"));
    const r = await cli(["save"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${UI}  UI_OK  JaEnglish`);
  });
});

describe("generate", () => {
  it("ドライランは生成器を呼ばず件数だけ", async () => {
    const r = await cli(["generate", "back", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    const d = JSON.parse(r.stdout) as { total: number; cached: number; toRun: number };
    expect(d.total).toBe(23);
    expect(d).toMatchObject({ cached: 0, toRun: 23 });
    expect(await calls()).toBe(0);
    const text = await cli(["generate", "back", "--dry-run", "--resources", "**/ui.csv", "--languages", "ko"]);
    expect(text.stdout).toContain("全体 4 / キャッシュ済み 0 / 実行する分 4");
  });

  it("実行 → 2 回目は全部キャッシュ", async () => {
    const first = await cli(["generate", "back", "--json"]);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ total: 23, cached: 0, generated: 23, failed: 0 });
    const n = await calls();
    expect(n).toBeGreaterThan(0);

    const second = await cli(["generate", "back", "--json"]);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ total: 23, cached: 23, generated: 0, failed: 0 });
    expect(await calls()).toBe(n);

    const ws = await openWs();
    const rows = await ws.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 1 });
    expect(rows.rows[0]!.cells["back@ko"]).toMatchObject({ value: "인확", generated: "fresh" });
  });

  it("--resources は 1 リソースずつジョブにし、stderr に進捗、テキストの要約", async () => {
    const r = await cli(["generate", "back"], ["--resources", "**/ui.csv", "--languages", "ko"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("生成 4");
    const ws = await openWs();
    const rows = await ws.rows({ resourceId: CHAPTER, languages: ["ko"], offset: 0, limit: 1 });
    expect(rows.rows[0]!.cells["back@ko"]!.generated).toBe("missing");
  });

  it("6 リソースでも、ジョブの上限（1 人 3 つ）に当たらず、全部生成して 0", async () => {
    const file = path.join(project, "loc-studio.project.json");
    const config = JSON.parse(await readFile(file, "utf8")) as { generators: { backTr: { options: Record<string, unknown> } } };
    config.generators.backTr.options["delayMs"] = 200;
    await writeFile(file, JSON.stringify(config, null, 2));
    const uiText = await readFile(path.join(project, ...UI.split("/")), "utf8");
    for (const n of ["a", "b", "c", "d"]) await writeFile(path.join(project, "Assets", "Text", `extra-${n}.csv`), uiText);
    const r = await cli(["generate", "back", "--json"], ["--resources", "**/*.csv"]);
    expect(r.stderr).not.toContain("上限");
    expect(r.code).toBe(0);
    // 同じ入力のリソース（コピー）は、先に済んだ分がキャッシュになる。
    const d = JSON.parse(r.stdout) as { total: number; cached: number; generated: number; failed: number };
    expect(d.total).toBe(23 + 32);
    expect(d.failed).toBe(0);
    expect(d.generated + d.cached).toBe(d.total);
    const ws = await openWs();
    for (const id of [UI, "Assets/Text/extra-d.csv", CHAPTER]) {
      const rows = await ws.rows({ resourceId: id, languages: ["ko"], offset: 0, limit: 1 });
      expect(rows.rows[0]!.cells["back@ko"]!.generated).toBe("fresh");
    }
  });

  it("失敗は終了コード 1", async () => {
    await writeFile(failFile, "1");
    const r = await cli(["generate", "back", "--json"]);
    expect(r.code).toBe(1);
    const d = JSON.parse(r.stdout) as { failed: number; generated: number; errors: string[] };
    expect(d.failed).toBe(23);
    expect(d.generated).toBe(0);
    expect(d.errors[0]).toContain("生成に失敗");
  });

  it("生成列でない列・ない列・ない言語・一致しない glob", async () => {
    expect((await cli(["generate", "textStatus"])).code).toBe(2);
    expect((await cli(["generate", "nope"])).code).toBe(2);
    expect((await cli(["generate", "back"], ["--languages", "xx"])).code).toBe(2);
    expect((await cli(["generate", "back"], ["--resources", "**/none.csv"])).code).toBe(2);
    expect((await cli(["generate"])).code).toBe(2);
  });
});

describe("run", () => {
  it("cell 対象: 列 × 言語のセルごとに全行へ。status の進捗が変わり、履歴の causeRef がアクション", async () => {
    const r = await cli(["run", "fake.mark", "--json"], ["--resources", "**/ui.csv", "--languages", "ko"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ actionId: "fake.mark", patched: 4, failed: 0 });
    const ws = await openWs();
    const d = await ws.rowDetail({ resourceId: UI, key: "UI_OK" });
    expect(d.row.cells["textStatus@ko"]!.value).toBe("wip");
    expect(d.row.cells["textStatus@ja"]!.value).toBe("todo");
    const h = await ws.history({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko" });
    expect(h[0]).toMatchObject({ cause: "action", causeRef: "fake.mark" });
  });

  it("--keys で行を絞る", async () => {
    const r = await cli(["run", "fake.mark"], ["--resources", "**/ui.csv", "--languages", "ko", "--keys", "UI_OK,NOPE"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("反映 1");
  });

  it("file 対象: リソースごとに 1 回、メッセージを表示", async () => {
    const r = await cli(["run", "fake.count"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("4 行あります");
    expect(r.stdout).toContain("8 行あります");
  });

  it("ないアクション・列指定なし・ない言語は 2", async () => {
    expect((await cli(["run", "nope"])).code).toBe(2);
    expect((await cli(["run", "fake.mark"], ["--languages", "xx"])).code).toBe(2);
    expect((await cli(["run", "fake.count"], ["--resources", "**/none.csv"])).code).toBe(2);
    expect((await cli(["run", "fake.mark"], ["--column", "nope"])).code).toBe(2);
  });

  it("アクションが失敗したら 1", async () => {
    const plugin = path.join(project, "loc-studio-plugins", "fake-batch.mjs");
    await writeFile(plugin, (await readFile(plugin, "utf8")).replace("return { message: ctx.entries.length", "throw new Error('壊れた'); return { message: ctx.entries.length"));
    const r = await cli(["run", "fake.count"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("壊れた");
  });
});

describe("entry（行の追加・削除・キーの変更）", () => {
  const lines = async (rel: string): Promise<string[]> => (await readFile(path.join(project, ...rel.split("/")), "utf8")).replace(/\n$/, "").split("\n");

  it("add: 指定した行の後ろに、本文つきで足す（--text は言語ごとに繰り返せ、本文に = があってもよい）", async () => {
    const r = await cli(["entry", "add", "UI_NEW"], ["--resource", UI, "--after", "UI_OK", "--text", "ja=新規", "--text", "ko=a=b"]);
    expect(r).toMatchObject({ code: 0, stderr: "" });
    expect(r.stdout).toBe(`${UI}: 行 UI_NEW を追加（5 行）\n`);
    expect((await lines(UI)).slice(1, 3)).toEqual(["UI_OK,決定,OK,确定,확인,4", "UI_NEW,新規,,,a=b,"]);
    // --after を省くと末尾。--json は当てた変更と行数を返す。
    const j = await cli(["entry", "add", "UI_LAST", "--json"], ["--resource", UI]);
    expect(JSON.parse(j.stdout)).toEqual({ resource: UI, changes: [{ type: "add", key: "UI_LAST" }], entries: 6 });
    expect((await lines(UI)).at(-1)).toBe("UI_LAST,,,,,");
  });

  it("rename: キーを変え、ステータスと履歴が新しいキーに付いてくる", async () => {
    await cli(["set", "textStatus@ko", "done"], ["--resource", UI, "--keys", "UI_OK"]);
    const r = await cli(["entry", "rename", "UI_OK", "UI_CONFIRM"], ["--resource", UI]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${UI}: キー UI_OK を UI_CONFIRM に変更（4 行）\n`);
    expect((await lines(UI))[1]).toBe("UI_CONFIRM,決定,OK,确定,확인,4");
    const ws = await openWs();
    expect((await ws.rowDetail({ resourceId: UI, key: "UI_CONFIRM" })).row.cells["textStatus@ko"]).toMatchObject({ value: "done" });
    expect(await ws.history({ resourceId: UI, key: "UI_CONFIRM", cellId: "textStatus@ko" })).toHaveLength(1);
  });

  it("remove: --keys の行をまとめて消す", async () => {
    const r = await cli(["entry", "remove"], ["--resource", UI, "--keys", "UI_OK,UI_GOLD"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${UI}: 2 行を削除（UI_OK, UI_GOLD）（2 行）\n`);
    expect((await lines(UI)).map((l) => l.split(",")[0])).toEqual(["ID", "UI_CANCEL", "UI_SAVE_CONFIRM"]);
  });

  it("使い方の誤りは 2、当てられない変更は 1 で、どちらもリソースを変えない", async () => {
    const before = await readFile(path.join(project, ...UI.split("/")), "utf8");
    // 使い方の誤り: 引数やオプションが足りない、知らないサブコマンド、ないリソース、--text の形。
    expect((await cli(["entry", "add"], ["--resource", UI])).code).toBe(2);
    expect((await cli(["entry", "add", "X"], [])).code).toBe(2);
    expect((await cli(["entry", "remove"], ["--resource", UI])).code).toBe(2);
    expect((await cli(["entry", "rename", "UI_OK"], ["--resource", UI])).code).toBe(2);
    expect((await cli(["entry", "move", "UI_OK"], ["--resource", UI])).code).toBe(2);
    expect((await cli(["entry", "add", "X"], ["--resource", "none.csv"])).code).toBe(2);
    expect((await cli(["entry", "add", "X"], ["--resource", UI, "--text", "ja"])).code).toBe(2);
    expect((await cli(["entry", "add", "X"], ["--resource", UI, "--text", "xx=y"])).code).toBe(2); // プロジェクトにない言語
    expect((await cli(["entry", "remove"], ["--resource", UI, "--keys", "A", "--after", "B"])).code).toBe(2); // ほかのサブコマンドのオプション
    // 当てられない変更（すでにあるキー、ない行）は、理由を出して 1。
    const dup = await cli(["entry", "add", "UI_OK"], ["--resource", UI]);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("UI_OK");
    expect((await cli(["entry", "remove"], ["--resource", UI, "--keys", "NOPE"])).code).toBe(1);
    expect((await cli(["entry", "rename", "NOPE", "X"], ["--resource", UI])).code).toBe(1);
    expect(await readFile(path.join(project, ...UI.split("/")), "utf8")).toBe(before);
  });
});

describe("resource create", () => {
  const NEW = "Assets/Text/dlc/new.csv";

  it("見出しだけのリソースを作り、tree に出て、行を足せる", async () => {
    const r = await cli(["resource", "create", NEW]);
    expect(r).toMatchObject({ code: 0, stdout: `リソースを作りました: ${NEW}\n` });
    expect(await readFile(path.join(project, ...NEW.split("/")), "utf8")).toBe("ID,JP,EN,CN,KR,MaxLen\n");
    expect((await cli(["tree"])).stdout).toContain("new.csv  0 件");
    expect((await cli(["entry", "add", "DLC_1"], ["--resource", NEW, "--text", "ja=追加"])).code).toBe(0);
    expect(await readFile(path.join(project, ...NEW.split("/")), "utf8")).toBe("ID,JP,EN,CN,KR,MaxLen\nDLC_1,追加,,,,\n");
  });

  it("すでにあるリソースは 1、場所の書き方の誤りやフォーマットのない拡張子は 2 で、何も作らない", async () => {
    const before = await readFile(path.join(project, ...UI.split("/")), "utf8");
    expect((await cli(["resource", "create", UI])).code).toBe(1);
    expect(await readFile(path.join(project, ...UI.split("/")), "utf8")).toBe(before);
    expect((await cli(["resource", "create", "../escape.csv"])).code).toBe(2);
    expect((await cli(["resource", "create", "Assets/Text/new.txt"])).code).toBe(2);
    expect((await cli(["resource", "create"])).code).toBe(2);
    await expect(readFile(path.join(tmp, "escape.csv"))).rejects.toThrow();
    await expect(readFile(path.join(project, "Assets", "Text", "new.txt"))).rejects.toThrow();
  });
});

describe("query", () => {
  it("条件に合う行を、リソースごとに数える。原文の量も出す", async () => {
    const r = await cli(["query"], ["--where", "issues >= error"]);
    expect(r).toMatchObject({
      code: 0,
      stdout: ["条件に合う行: 5 / 12 行（原文 43 文字 / 6 語）", `  ${UI}: 1 / 4`, `  ${CHAPTER}: 4 / 8`, ""].join("\n"),
    });
    // 条件がなければ、すべての行。合う行のないリソースは並べない。
    expect((await cli(["query"])).stdout).toContain("条件に合う行: 12 / 12 行");
    const none = await cli(["query"], ["--where", "key = NOPE"]);
    expect(none.stdout).toBe("条件に合う行: 0 / 12 行（原文 0 文字 / 0 語）\n");
  });

  it("--resources と --languages で対象を絞る（式の、言語を省いた欄は、対象の言語のどれか）", async () => {
    const r = await cli(["query"], ["--where", "text is empty", "--resources", "**/chapter01.csv"]);
    expect(r.stdout).toBe(`条件に合う行: 1 / 8 行（原文 8 文字 / 1 語）\n  ${CHAPTER}: 1 / 8\n`);
    // 日本語には、空の本文がない。
    expect((await cli(["query"], ["--where", "text is empty", "--languages", "ja"])).stdout).toContain("条件に合う行: 0 / 12 行");
  });

  it("--group-by で、欄の値ごとの行数と原文の量を出す（選択式の列は、選択肢の順と表示名）", async () => {
    await cli(["set", "textStatus@ko", "done"], ["--resource", UI, "--keys", "UI_OK"]);
    const r = await cli(["query"], ["--group-by", "textStatus@ko"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(["", "集計（textStatus@ko）:", "  未着手: 11 行（127 文字 / 14 語）", "  確定: 1 行（2 文字 / 1 語）", ""].join("\n"));
  });

  it("--limit で行を出し、--columns で出すセルを選ぶ", async () => {
    const r = await cli(["query"], ["--where", 'key ~ "UI_"', "--limit", "1", "--columns", "text@ja,text@ko"]);
    expect(r.stdout).toBe(
      ["条件に合う行: 4 / 12 行（原文 27 文字 / 5 語）", `  ${UI}: 4 / 4`, "", "行:", `  ${UI}  UI_OK`, "    text@ja: 決定", "    text@ko: 확인", "  …（4 行のうち 1 行。--limit で増やせます）", ""].join("\n"),
    );
  });

  it("--format csv で、条件に合う行を CSV にして標準出力に出す", async () => {
    const r = await cli(["query"], ["--where", 'key ~ "UI_"', "--format", "csv", "--columns", "text@ja,text@JaEnglish"]);
    expect(r).toMatchObject({
      code: 0,
      stdout: ["resource,key,text@ja,text@JaEnglish", `${UI},UI_OK,決定,OK`, `${UI},UI_CANCEL,キャンセル,Cancel`, `${UI},UI_SAVE_CONFIRM,セーブしますか？,Save your progress?`, `${UI},UI_GOLD,所持金：{gold} G,Gold: {gold} G`, ""].join("\r\n"),
    });
  });

  it("--out でファイルに書き、--bom で先頭に BOM を付ける。--group-by があれば集計を書き出す", async () => {
    const out = path.join(tmp, "result.tsv");
    const r = await cli(["query"], ["--where", "key = UI_OK", "--format", "tsv", "--columns", "text@ja", "--out", out, "--bom"]);
    expect(r).toMatchObject({ code: 0, stdout: `1 行を書き出しました: ${out}\n` });
    expect(await readFile(out, "utf8")).toBe(`\uFEFFresource\tkey\ttext@ja\r\n${UI}\tUI_OK\t決定\r\n`);
    const groups = await cli(["query"], ["--format", "csv", "--group-by", "resource"]);
    expect(groups.stdout).toBe(["resource,rows,characters,words", `${CHAPTER},8,102,10`, `${UI},4,27,5`, ""].join("\r\n"));
  });

  it("--json は、数、集計、行をそのまま出す", async () => {
    const r = await cli(["query", "--json"], ["--where", "issues >= error", "--group-by", "resource", "--limit", "2", "--columns", "text@ja"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout) as { matched: { rows: number }; totalRows: number; groups: { values: unknown[]; rows: number }[]; rows: { path: string; key: string }[] };
    expect(data.matched.rows).toBe(5);
    expect(data.totalRows).toBe(12);
    expect(data.groups.map((g) => [g.values[0], g.rows])).toEqual([
      [CHAPTER, 4],
      [UI, 1],
    ]);
    expect(data.rows.map((x) => [x.path, x.key])).toEqual([
      [UI, "UI_SAVE_CONFIRM"],
      [CHAPTER, "CH01_CHOICE_001A"],
    ]);
  });

  it("式や引数の誤りは終了コード 2 で、何が違うかを出す", async () => {
    const bad = await cli(["query"], ["--where", "nope = 1"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('条件式の "nope" に当たる列がありません');
    const syntax = await cli(["query"], ["--where", "text@ko ="]);
    expect(syntax.code).toBe(2);
    expect(syntax.stderr).toContain("条件式の 10 文字目");
    expect((await cli(["query"], ["--languages", "xx"])).code).toBe(2);
    expect((await cli(["query"], ["--resources", "nope/**"])).stderr).toContain("--resources に合うリソースがありません");
    expect((await cli(["query"], ["--format", "xlsx"])).stderr).toContain("--format は csv か tsv");
    expect((await cli(["query"], ["--out", "x.csv"])).stderr).toContain("--format csv か --format tsv と一緒に");
    expect((await cli(["query", "--json"], ["--format", "csv"])).code).toBe(2);
    expect((await cli(["query"], ["--limit", "-1"])).code).toBe(2);
    expect((await cli(["query"], ["--group-by", "textStatus"])).code).toBe(2);
  });
});
