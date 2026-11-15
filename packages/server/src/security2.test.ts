/**
 * 再テストでの指摘: N1（信頼したコードの依存先）、N2（未確認の設定ファイルからの環境変数の漏れ）、N4（伏せる範囲）。
 */
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "@loc-studio/sdk";
import type { CallContext } from "./api-types.js";
import { dispatch } from "./rpc.js";
import { openServerRuntime } from "./runtime.js";
import { makeTestProject, SDK_PATH, sleep, trustSettings, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

let tp: TestProject;
beforeEach(async () => {
  tp = await makeTestProject();
});
afterEach(async () => {
  await tp.cleanup();
});

/** 読まれた名前を記録する環境変数。 */
function recordingEnv(values: Record<string, string>): { env: Record<string, string | undefined>; reads: Set<string> } {
  const reads = new Set<string>();
  const env = new Proxy({ ...values } as Record<string, string | undefined>, {
    get(target, prop) {
      if (typeof prop === "string") reads.add(prop);
      return target[prop as string];
    },
  });
  return { env, reads };
}

describe("N2: 確認していない設定ファイルは、つながず、展開せず、何も作らない", () => {
  it("レビューの再現: 開いただけでは TCP の受け手に何も届かず、環境変数も読まない", async () => {
    let connections = 0;
    const server = net.createServer((s) => {
      connections++;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await tp.patchConfig({ storage: { driver: "postgres", url: `postgres://\${env:MY_SECRET_ENV}:x@127.0.0.1:${port}/db` } });
      const { env, reads } = recordingEnv({ MY_SECRET_ENV: "top-secret-value", LOC_STUDIO_SECRET_LLM_APIKEY: "sk-1" });
      const ws = await tp.open({ pluginTrust: "prompt", env });
      expect(ws.restricted).toBe(true);
      await sleep(200);
      expect(connections).toBe(0);
      expect(reads.has("MY_SECRET_ENV")).toBe(false);
      expect([...reads].some((r) => r.startsWith("LOC_STUDIO_SECRET_"))).toBe(false);
      const item = (await ws.plugins()).untrusted.find((u) => u.kind === "settings")!;
      expect(item).toMatchObject({ kind: "settings", layer: "project", path: path.join(tp.root, "loc-studio.project.json"), files: [path.join(tp.root, "loc-studio.project.json")] });
      const summary = JSON.stringify(item.summary);
      expect(summary).toContain("MY_SECRET_ENV");
      expect(summary).toContain(`127.0.0.1:${port}`);
      expect(summary).not.toContain("top-secret-value");
      expect(summary).toContain("builtin.globTree");
      await expect(ws.rows({ resourceId: UI, languages: ["ja"], offset: 0, limit: 1 })).rejects.toMatchObject({ code: "untrusted" });
    } finally {
      server.close();
    }
  });

  it("確認するまで生成器を作らず、秘密も読まない", async () => {
    const calls: string[] = [];
    const spyGen: Plugin = {
      name: "spy",
      generators: [
        {
          id: "spy.gen",
          version: "1",
          cacheParams: () => (calls.push("cacheParams"), {}),
          input: () => (calls.push("input"), null),
          run: async () => (calls.push("run"), []),
        },
      ],
    };
    const cfg = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
    await tp.patchConfig({
      columns: [...cfg.columns, { id: "g", kind: "generated", scope: "language", generator: "g" }],
      generators: { g: { use: "spy.gen", options: { endpoint: "https://attacker.example/v1", apiKeySecret: "llm.apiKey" } } },
    });
    const { env, reads } = recordingEnv({ LOC_STUDIO_SECRET_LLM_APIKEY: "sk-secret" });
    const ws = await tp.open({ pluginTrust: "prompt", env, extraBuiltins: [spyGen] });
    expect(ws.restricted).toBe(true);
    await ws.info();
    await ws.plugins();
    await ws.settings();
    expect(calls).toEqual([]);
    expect(reads.has("LOC_STUDIO_SECRET_LLM_APIKEY")).toBe(false);
    const summary = JSON.stringify((await ws.plugins()).untrusted[0]!.summary);
    expect(summary).toContain("https://attacker.example/v1");
    expect(summary).toContain("llm.apiKey");
    expect(summary).not.toContain("sk-secret");
  });

  it("manager の項目だけの変更では確認し直さず、基盤の項目をアプリの外で変えたら確認し直す（ドラフトは残る）", async () => {
    const ws = await tp.open({ pluginTrust: "prompt" });
    await trustSettings(ws);
    expect(ws.restricted).toBe(false);
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    // 言語を足す（manager の項目）だけなら、読み直しても確認は要らない。
    const cfg = JSON.parse(await tp.read("loc-studio.project.json")) as Record<string, unknown> & { languages: unknown[] };
    await tp.patchConfig({ languages: [...cfg.languages, { id: "fr", label: "フランス語", basedOn: "ja" }], name: "Renamed" });
    let info = await ws.reloadPlugins();
    expect(info.restricted).toBeUndefined();
    expect(info.languages.map((l) => l.id)).toContain("fr");
    // ツリーの設定（基盤の項目）をアプリの外で変えると、確認し直し。
    await tp.patchConfig({ tree: { use: "builtin.globTree", options: { include: ["**/*.csv"] } } });
    info = await ws.reloadPlugins();
    expect(info.restricted).toBe(true);
    // 確認すると戻り、ドラフトはその PC の DB に残っている。
    await trustSettings(ws);
    expect(ws.restricted).toBe(false);
    const d = await ws.rowDetail({ resourceId: UI, key: "UI_OK" });
    expect(d.row.cells["text@ko"]).toMatchObject({ value: "좋아", draft: true });
  });

  it("この PC でアプリから変えた基盤の項目は、同じ操作で信頼する（未確認の外の変更は信頼しない）", async () => {
    const ws = await tp.open({ pluginTrust: "prompt" });
    await trustSettings(ws);
    await ws.updateProjectSettings({ patch: { syntaxes: ["builtin.braces"] } });
    expect(ws.restricted).toBe(false);
    await ws.close();
    const ws2 = await tp.open({ pluginTrust: "prompt" });
    expect(ws2.restricted).toBe(false);
    // ほかで基盤の項目が変えられたあとにアプリで設定を変えても、その外の変更までは信頼しない。
    await tp.patchConfig({ pluginDirs: ["loc-studio-plugins", "../elsewhere"] });
    const info = await ws2.updateProjectSettings({ patch: { name: "x" } }).catch((e: unknown) => e);
    expect(ws2.restricted).toBe(true);
    void info;
  });

  it("予約された環境変数は ${env:} で使えず、プラグインのホストの env にも出さない", async () => {
    const ws = await tp.open({ env: { HOME: "/home/x", LOC_STUDIO_SECRET_LLM_APIKEY: "sk", LOC_STUDIO_LOCAL_TOKEN: "t", LOC_STUDIO_ADMIN_PASSWORD: "p" } });
    expect(ws.project.host.env).toEqual({ HOME: "/home/x" });
    expect(ws.project.host.secrets.get("llm.apiKey")).toBe("sk");
    await tp.patchConfig({ storage: { driver: "sqlite", path: "${env:LOC_STUDIO_LOCAL_TOKEN}/x.db" } });
    await expect(tp.open({ env: { LOC_STUDIO_LOCAL_TOKEN: "t" } })).rejects.toThrow(/LOC_STUDIO_LOCAL_TOKEN/);
  });
});

describe("N1: 信頼したコードの依存先を書き換えたら、確認し直すまで動かさない", () => {
  it("コードの設定の import 先（空白なしの書き方）を書き換えて読み直すと、確認待ちに戻り、書き換えたコードは動かない", async () => {
    const marker = path.join(tp.tmp, "helper-ran");
    await tp.write("helper.ts", `export const name: string = "H1";\n`);
    await tp.write("loc-studio.config.ts", `import{name}from"./helper.ts";\nexport default { name };\n`);
    const ws = await tp.open({ pluginTrust: "prompt" });
    const items = (await ws.plugins()).untrusted;
    const config = items.find((u) => u.kind === "config")!;
    // 一覧には import 先も出る。
    expect(config.files.map((f) => path.basename(f)).sort()).toEqual(["helper.ts", "loc-studio.config.ts"]);
    await ws.trustPlugins({ items: items.map((u) => ({ path: u.path, hash: u.hash })) });
    expect((await ws.info()).name).toBe("H1");
    await tp.write("helper.ts", `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport const name: string = "H2";\n`);
    const info = await ws.reloadPlugins();
    expect(existsSync(marker)).toBe(false);
    expect(info.name).not.toBe("H2");
    expect((await ws.plugins()).untrusted.map((u) => u.kind)).toContain("config");
  });
});

describe("N4: 管理者でない利用者には基盤の項目を見せない。開けないときの文言も伏せる", () => {
  it("settings().project から基盤の項目を除く（管理者には見せる）", async () => {
    await tp.patchConfig({ generators: { g: { use: "llm.translate", options: { endpoint: "https://internal.example/v1" } } } });
    const ws = await tp.open();
    const viewer: CallContext = { user: { name: "v" }, role: "viewer" };
    const r = (await dispatch(ws, "settings", {}, viewer)) as { result: { project: Record<string, unknown> } };
    expect(JSON.stringify(r.result)).not.toContain("internal.example");
    for (const k of ["storage", "tree", "formats", "syntaxes", "generators", "pluginDirs"]) expect(r.result.project[k]).toBeUndefined();
    expect(r.result.project.languages).toBeDefined();
    const a = (await dispatch(ws, "settings", {}, { ...viewer, role: "manager", admin: true })) as { result: { project: Record<string, unknown> } };
    expect(JSON.stringify(a.result)).toContain("internal.example");
  });

  it("ServerRuntime: プロジェクトを開けないときの詳細は、管理者でない利用者には参照番号だけ", async () => {
    await writeFile(path.join(tp.root, "loc-studio.project.json"), "{ broken");
    const rt = await openServerRuntime({
      mode: "web",
      dataDir: path.join(tp.tmp, "data"),
      env: { LOC_STUDIO_ADMIN_USER: "root", LOC_STUDIO_ADMIN_PASSWORD: "root-password" },
      config: {
        projects: [{ id: "p", name: "P", root: tp.root }],
        auth: { mode: "password", sessionTtlHours: 1, proxyHeader: "x-forwarded-user", admins: [] },
        serverDb: { driver: "sqlite", path: path.join(tp.tmp, "server.db") },
      },
      sdkPath: SDK_PATH,
    });
    try {
      const root = (await rt.auth!.login({ name: "root", password: "root-password", clientAddress: "127.0.0.1" })).user;
      await rt.admin.createUser(root, { name: "bob", password: "bob-password" });
      await rt.admin.setMembership(root, "p", "bob", { role: "viewer" });
      const bob = (await rt.auth!.login({ name: "bob", password: "bob-password", clientAddress: "127.0.0.1" })).user;
      const r = await rt.handle({ projectId: "p", method: "info", params: {}, user: bob });
      const message = (r as { error: { code: string; message: string } }).error.message;
      expect(message).toMatch(/参照番号/);
      expect(message).not.toContain(tp.root);
      const unauth = await rt.handle({ projectId: "p", method: "info", params: {} });
      expect(unauth).toMatchObject({ error: { code: "unauthorized" } });
      const asAdmin = await rt.handle({ projectId: "p", method: "info", params: {}, user: root });
      expect((asAdmin as { error: { message: string } }).error.message).toContain("loc-studio.project.json");
    } finally {
      await rt.close();
    }
    void readFile;
    void rm;
  });
});
