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
