/**
 * レビュー 3 回目: ジョブとセルのエラーの接続先を伏せる（3）、設定の自動の信頼の境目（5）。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "@loc-studio/sdk";
import type { CallContext, JobInfo } from "./api-types.js";
import { dispatch } from "./rpc.js";
import { makeTestProject, trustSettings, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

let tp: TestProject;
beforeEach(async () => {
  tp = await makeTestProject();
});
afterEach(async () => {
  await tp.cleanup();
});

const viewer: CallContext = { user: { name: "v" }, role: "viewer" };
const translator: CallContext = { user: { name: "t" }, role: "translator" };
const admin: CallContext = { user: { name: "root" }, role: "manager", admin: true };

describe("3: 管理者でない利用者には、エラーの文言の接続先を伏せる", () => {
  const plugin: Plugin = {
    name: "failing",
    generators: [
      {
        id: "fail.gen",
        version: "1",
        cacheParams: () => ({}),
        input: (c) => (c.language ? { text: "x" } : null),
        run: async () => {
          throw new Error("llm.translate: http://127.0.0.1:9/internal-v1/chat/completions への接続に失敗しました: fetch failed");
        },
      },
    ],
    columns: [
      {
        id: "net.check",
        kind: "computed",
        scope: "entry",
        compute: () => ({ value: null, error: "api.internal.example:8443 に届きません" }),
      },
    ],
    actions: [
      {
        id: "net.send",
        label: "送る",
        target: "row",
        run: async (ctx) => ({ patches: [{ resourceId: ctx.entry!.resource.id, entryKey: ctx.entry!.key, columnId: "nope", value: "http://10.0.0.5:8080/x" }] }),
      },
    ],
  };

  it("jobs / job のエラー、セルのエラー、アクションのエラーから URL とホスト:ポートを除く（管理者には残す）", async () => {
    const tp2 = await makeTestProject({ plugins: [plugin] });
    try {
      const cfg = JSON.parse(await tp2.read("loc-studio.project.json")) as { columns: unknown[] };
      await tp2.patchConfig({
        columns: [...cfg.columns, { id: "g", kind: "generated", scope: "language", generator: "fail.gen" }, { use: "net.check", id: "check" }],
        actions: ["net.send"],
      });
      const ws = await tp2.open();
      const started = await dispatch(ws, "generate", { columnId: "g", scope: "cell", resourceId: UI, keys: ["UI_OK"], languages: ["ja"] }, translator);
      const jobId = (started as { result: { jobId: string } }).result.jobId;
      await ws.waitForJob(jobId);
      const v = (await dispatch(ws, "jobs", {}, viewer)) as { result: JobInfo[] };
      expect(v.result[0]!.error).toContain("<接続先>");
      expect(JSON.stringify(v.result)).not.toContain("127.0.0.1");
      expect(JSON.stringify(v.result)).not.toContain("internal-v1");
      const one = (await dispatch(ws, "job", { id: jobId }, viewer)) as { result: JobInfo };
      expect(one.result.error).not.toContain("127.0.0.1");
      const a = (await dispatch(ws, "jobs", {}, admin)) as { result: JobInfo[] };
      expect(a.result[0]!.error).toContain("127.0.0.1:9");

      const rows = (await dispatch(ws, "rowDetail", { resourceId: UI, key: "UI_OK" }, viewer)) as { result: { row: { cells: Record<string, { error?: string }> } } };
      expect(rows.result.row.cells["check"]!.error).toBe("<接続先> に届きません");
      const rowsAdmin = (await dispatch(ws, "rowDetail", { resourceId: UI, key: "UI_OK" }, admin)) as { result: { row: { cells: Record<string, { error?: string }> } } };
      expect(rowsAdmin.result.row.cells["check"]!.error).toContain("api.internal.example:8443");

      const act = (await dispatch(ws, "runAction", { actionId: "net.send", resourceId: UI, keys: ["UI_OK"] }, translator)) as { result: { errors: string[] } };
      expect(act.result.errors.join(" ")).not.toContain("10.0.0.5");
    } finally {
      await tp2.cleanup();
    }
  });
});

describe("5: 設定の自動の信頼は、変える前の中身が信頼済みのときだけ", () => {
  it("解析できない設定ファイルは信頼済みとみなさず、書き込まず、何も信頼しない", async () => {
    const ws = await tp.open({ pluginTrust: "prompt" });
    await trustSettings(ws);
    const file = path.join(tp.root, "loc-studio.project.json");
    const settingsFile = path.join(tp.userDataDir, "settings.json");
    const trustBefore = await readFile(settingsFile, "utf8");
    await writeFile(file, '{ "languages": [ broken');
    await expect(ws.updateProjectSettings({ patch: { name: "x" } })).rejects.toMatchObject({ code: "failed" });
    expect(await readFile(file, "utf8")).toBe('{ "languages": [ broken');
    expect(await readFile(settingsFile, "utf8")).toBe(trustBefore);
  });

  it("基盤の項目も ${env:} もない設定ファイルは、確認なしで開き、変えても確認は要らない", async () => {
    await writeFile(path.join(tp.root, "loc-studio.project.json"), JSON.stringify({ languages: [{ id: "ja", label: "日本語" }] }));
    const ws = await tp.open({ pluginTrust: "prompt" });
    expect(ws.restricted).toBe(false);
    const info = await ws.updateProjectSettings({ patch: { name: "Plain" } });
    expect(info.name).toBe("Plain");
    expect(ws.restricted).toBe(false);
    // 基盤の項目をアプリで足すと、この PC の利用者の変更として信頼する。
    await ws.updateProjectSettings({ patch: { syntaxes: ["builtin.braces"] } });
    expect(ws.restricted).toBe(false);
  });
});
