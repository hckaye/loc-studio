/**
 * セキュリティレビューの指摘（C1 / C3 / C4 / C5 / C8 / C10）のうち、ワークスペースと RPC の層のもの。
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "@loc-studio/sdk";
import type { CallContext, Workspace } from "./api-types.js";
import { jobLimits } from "./jobs.js";
import { dispatch } from "./rpc.js";
import { openServerRuntime } from "./runtime.js";
import { CHAPTER, makeTestProject, SDK_PATH, sleep, trustSettings, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

let tp: TestProject;
beforeEach(async () => {
  tp = await makeTestProject();
});
afterEach(async () => {
  await tp.cleanup();
});

const marker = () => path.join(tp.tmp, "config-ran");
const configSource = (extra = "") =>
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(path.join(path.sep === "\\" ? "" : "", "PLACEHOLDER"))}, "ran");\nexport default { name: "FromCode"${extra} };\n`;
const writeConfig = async (extra = "") => tp.write("loc-studio.config.mjs", configSource(extra).replace(JSON.stringify("PLACEHOLDER"), JSON.stringify(marker())));
const result = <T>(r: unknown): T => {
  expect(r).toHaveProperty("result");
  return (r as { result: T }).result;
};

describe("C1: コードの設定も信頼するまで実行しない", () => {
  it("JSON があれば JSON だけで開き、コードの設定を確認待ちに出す。信頼すると読み込む", async () => {
    await writeConfig();
    const ws = await tp.open({ pluginTrust: "prompt" });
    expect(existsSync(marker())).toBe(false);
    // 設定ファイルとコードの設定が 1 つの一覧に並ぶ。設定ファイルを信頼すると、JSON だけで開く。
    expect((await ws.plugins()).untrusted.map((u) => u.kind)).toEqual(["settings", "config"]);
    await trustSettings(ws);
    expect(existsSync(marker())).toBe(false);
    expect(ws.restricted).toBe(false);
    const info = await ws.info();
    expect(info.name).toBe("SampleGame");
    const pending = (await ws.plugins()).untrusted.find((u) => u.kind === "config")!;
    expect(pending).toMatchObject({ kind: "config", path: path.join(tp.root, "loc-studio.config.mjs"), files: [path.join(tp.root, "loc-studio.config.mjs")] });
    // 設定の変更や読み直しでも実行しない。
    await ws.updateProjectSettings({ patch: { languageSets: { a: ["ja"] } } });
    await ws.reloadPlugins();
    expect(existsSync(marker())).toBe(false);
    const after = await ws.trustPlugins({ items: [{ path: pending.path, hash: pending.hash }] });
    expect(after.name).toBe("FromCode");
    expect(existsSync(marker())).toBe(true);
  });

  it("JSON だけでは開けなければ制限された状態で開き、信頼すると同じオブジェクトのまま普通の状態になる", async () => {
    await writeConfig(`, languages: [{ id: "ja", label: "日本語" }], tree: { use: "builtin.globTree", options: { include: ["Assets/Text/**/*.csv"] } }, formats: [{ use: "builtin.csv", match: "**/*.csv", options: { key: "ID", text: { ja: "JP" } } }]`);
    await rm(path.join(tp.root, "loc-studio.project.json"));
    const ws = await tp.open({ pluginTrust: "prompt" });
    expect(ws.restricted).toBe(true);
    expect(existsSync(marker())).toBe(false);
    const info = await ws.info();
    expect(info).toMatchObject({ restricted: true, untrustedPlugins: 1, languages: [] });
    expect((await ws.settings()).projectFile).toBe(path.join(tp.root, "loc-studio.project.json"));
    await expect(ws.rows({ resourceId: UI, languages: ["ja"], offset: 0, limit: 1 })).rejects.toMatchObject({ code: "untrusted" });
    await expect(ws.updateProjectSettings({ patch: {} })).rejects.toMatchObject({ code: "untrusted" });
    expect(() => ws.project).toThrow();
    const pending = (await ws.plugins()).untrusted[0]!;
    // 確認したあとで変わっていたら conflict。
    await expect(ws.trustPlugins({ items: [{ path: pending.path, hash: "0".repeat(64) }] })).rejects.toMatchObject({ code: "conflict" });
    expect(existsSync(marker())).toBe(false);
    const opened = await ws.trustPlugins({ items: [{ path: pending.path, hash: pending.hash }] });
    expect(opened.restricted).toBeUndefined();
    expect(ws.restricted).toBe(false);
    expect(opened.name).toBe("FromCode");
    expect((await ws.rows({ resourceId: UI, languages: ["ja"], offset: 0, limit: 1 })).totalAll).toBe(4);
    // 開き直しても信頼は残る。書き換えたら、また制限された状態。
    await ws.close();
    const ws2 = await tp.open({ pluginTrust: "prompt" });
    expect(ws2.restricted).toBe(false);
    await rm(marker());
    await writeConfig(`, languages: [{ id: "ja", label: "日本語" }] /* edited */`);
    const reloaded = await ws2.reloadPlugins();
    expect(reloaded.restricted).toBe(true);
    expect(ws2.restricted).toBe(true);
    expect(existsSync(marker())).toBe(false);
  });

  it("always モードは従来どおり実行する", async () => {
    await writeConfig();
    const ws = await tp.open({ pluginTrust: "always" });
    expect(existsSync(marker())).toBe(true);
    expect((await ws.info()).name).toBe("FromCode");
  });
});

describe("C4: Web モードの manager は基盤の設定を変えられない", () => {
  const manager: CallContext = { user: { name: "mgr" }, role: "manager" };
  const admin: CallContext = { user: { name: "root" }, role: "manager", admin: true };

  for (const key of ["storage", "pluginDirs", "tree", "formats", "syntaxes", "sources", "generators", "actions", "review"]) {
    it(`${key} は管理者だけ`, async () => {
      const ws = await tp.open();
      const r = await dispatch(ws, "updateProjectSettings", { patch: { [key]: null } }, manager);
      expect(r).toMatchObject({ error: { code: "forbidden", data: { keys: [key] } } });
    });
  }

  it("manager が変えられる項目は変えられ、知らない項目は invalid。管理者は基盤の項目も変えられる", async () => {
    const ws = await tp.open();
    expect(result<{ name: string }>(await dispatch(ws, "updateProjectSettings", { patch: { name: "Renamed" } }, manager)).name).toBe("Renamed");
    expect(await dispatch(ws, "updateProjectSettings", { patch: { name: "x", generators: {} } }, manager)).toMatchObject({ error: { code: "forbidden" } });
    expect(await dispatch(ws, "updateProjectSettings", { patch: { bogus: 1 } }, manager)).toMatchObject({ error: { code: "invalid" } });
    expect((await ws.info()).name).toBe("Renamed");
    expect(await dispatch(ws, "updateProjectSettings", { patch: { syntaxes: ["builtin.braces"] } }, admin)).toHaveProperty("result");
  });
});

describe("C5: Web モードの環境変数・プラグインのフォルダ・伏せる処理", () => {
  const viewer: CallContext = { user: { name: "v" }, role: "viewer" };

  it("プロジェクトの設定の ${env:NAME} は、サーバーの設定で許した名前だけ。プラグインのホストの env も同じ", async () => {
    await tp.patchConfig({ storage: { driver: "sqlite", path: "${env:SECRET_DIR}/x.db" } });
    const env = { SECRET_DIR: path.join(tp.tmp, "db"), OTHER_SECRET: "s" };
    await expect(tp.open({ env, webMode: { allowedEnv: [], pluginDirRoots: [tp.root] } })).rejects.toThrow(/SECRET_DIR/);
    const ws = await tp.open({ env, webMode: { allowedEnv: ["SECRET_DIR"], pluginDirRoots: [tp.root] } });
    expect(ws.project.host.env).toEqual({ SECRET_DIR: env.SECRET_DIR });
    // ローカルモードは従来どおり。
    const local = await tp.open({ env });
    expect(local.project.host.env.OTHER_SECRET).toBe("s");
  });

  it("project 層のプラグインのフォルダは、プロジェクトかアプリのフォルダの中だけ", async () => {
    await tp.write("../elsewhere/evil.mjs", `export default { name: "evil-dir" };\n`);
    await tp.patchConfig({ pluginDirs: ["loc-studio-plugins", "../elsewhere"] });
    const ws = await tp.open({ webMode: { allowedEnv: [], pluginDirRoots: [tp.root] } });
    const names = (await ws.plugins()).plugins.map((p) => p.name);
    expect(names).toContain("studio-pack");
    expect(names).not.toContain("evil-dir");
    expect((await ws.info()).warnings.join("\n")).toContain("elsewhere");
  });

  it("管理者でない利用者には、サーバーのパスと接続先と内部のエラーを伏せる", async () => {
    const logged: string[] = [];
    const ws = await tp.open();
    const base = ws.redaction();
    const withLog = Object.assign(Object.create(ws) as Workspace, { redaction: () => ({ paths: base.paths, log: (m: string) => logged.push(m) }) });
    const info = result<{ root: string; storage: { path: string } }>(await dispatch(withLog, "info", {}, viewer));
    expect(info.root).toBe("");
    expect(info.storage.path).toBe("");
    const s = result<{ projectFile: string; localFile: string }>(await dispatch(withLog, "settings", {}, viewer));
    expect(s).toMatchObject({ projectFile: "", localFile: "" });
    const plugins = result<unknown>(await dispatch(withLog, "plugins", {}, viewer));
    expect(JSON.stringify(plugins)).not.toContain(tp.root);
    expect(JSON.stringify(plugins)).toContain("<project>");
    // 内部のエラーは参照番号だけ。詳細はサーバーのログに。
    const failing = Object.assign(Object.create(withLog) as Workspace, {
      rows: async () => {
        throw new Error(`読めませんでした: ${tp.root}/secret.csv`);
      },
    });
    const err = await dispatch(failing, "rows", {}, viewer);
    expect(err).toMatchObject({ error: { code: "failed" } });
    const message = (err as { error: { message: string } }).error.message;
    expect(message).not.toContain(tp.root);
    expect(message).toMatch(/参照番号: [0-9a-f]{8}/);
    expect(logged.join("\n")).toContain("secret.csv");
    // not-found などのエラーはパスだけ伏せる。
    const nf = await dispatch(withLog, "rowDetail", { resourceId: UI, key: "NOPE" }, viewer);
    expect(nf).toMatchObject({ error: { code: "not-found" } });
    // 管理者には伏せない。
    const adminInfo = result<{ root: string }>(await dispatch(withLog, "info", {}, { ...viewer, admin: true, role: "manager" }));
    expect(adminInfo.root).toBe(tp.root);
  });

  it("ServerRuntime は最初の管理者の環境変数を消し、合言葉の環境変数がなければ開かない", async () => {
    const env: Record<string, string | undefined> = { LOC_STUDIO_ADMIN_USER: "root", LOC_STUDIO_ADMIN_PASSWORD: "root-password" };
    const config = {
      projects: [{ id: "p", name: "P", root: tp.root }],
      auth: { mode: "password" as const, sessionTtlHours: 1, proxyHeader: "x-forwarded-user", admins: [] },
      serverDb: { driver: "sqlite" as const, path: path.join(tp.tmp, "server.db") },
    };
    const rt = await openServerRuntime({ mode: "web", dataDir: path.join(tp.tmp, "data"), env, config, sdkPath: SDK_PATH });
    try {
      expect(env.LOC_STUDIO_ADMIN_PASSWORD).toBeUndefined();
      expect(env.LOC_STUDIO_ADMIN_USER).toBeUndefined();
      expect(await rt.auth!.getUser("root")).toMatchObject({ admin: true });
    } finally {
      await rt.close();
    }
    await expect(
      openServerRuntime({
        mode: "web",
        dataDir: path.join(tp.tmp, "data2"),
        env: {},
        config: { ...config, auth: { ...config.auth, mode: "proxy", proxySecretHeader: "x-proxy-secret", proxySecretEnv: "PROXY_SECRET" }, serverDb: { driver: "sqlite", path: path.join(tp.tmp, "s2.db") } },
        sdkPath: SDK_PATH,
      }).finally(() => {
        // 設定の誤りは DB を開く前に断る（開いたままのファイルを残さない）。
        expect(existsSync(path.join(tp.tmp, "s2.db"))).toBe(false);
      }),
    ).rejects.toThrow(/PROXY_SECRET/);
  });
});

describe("C8: 繰り返しで仕事を増やせない、ジョブの上限", () => {
  it("validate と stats は同じリソースの重複を除く", async () => {
    const ws = await tp.open();
    expect((await ws.validate({ resourceIds: [UI, UI, UI, UI] })).resources).toHaveLength(1);
    expect(await ws.stats({ resourceIds: [UI, UI, CHAPTER, UI] })).toHaveLength(2);
    expect((await ws.rows({ resourceId: UI, languages: ["ja", "ja", "ja"], offset: 0, limit: 10_000 })).rows).toHaveLength(4);
  });

  it("待っている・実行中のジョブは利用者ごとに上限がある（throttled）", async () => {
    const slow: Plugin = {
      name: "slow",
      generators: [
        {
          id: "slow.gen",
          version: "1",
          cacheParams: () => ({}),
          input: (c) => (c.language ? { text: `${c.entry.key}${c.language.id}` } : null),
          run: async (inputs) => {
            await sleep(200);
            return inputs.map((i) => ({ value: i.text }));
          },
        },
      ],
    };
    const tp2 = await makeTestProject({ plugins: [slow] });
    try {
      const cfg = JSON.parse(await tp2.read("loc-studio.project.json")) as { columns: unknown[] };
      await tp2.patchConfig({ columns: [...cfg.columns, { id: "g", kind: "generated", scope: "language", generator: "slow.gen" }] });
      const ws = await tp2.open();
      const call: CallContext = { user: { name: "u" }, role: "translator" };
      const keys = ["UI_OK", "UI_CANCEL", "UI_SAVE_CONFIRM", "UI_GOLD"];
      for (let i = 0; i < jobLimits.perUser; i++) {
        expect(await dispatch(ws, "generate", { columnId: "g", scope: "cell", resourceId: UI, keys: [keys[i]], languages: ["ja"] }, call)).toHaveProperty("result");
      }
      expect(await dispatch(ws, "generate", { columnId: "g", scope: "cell", resourceId: UI, keys: [keys[3]], languages: ["ja"] }, call)).toMatchObject({
        error: { code: "throttled" },
      });
      // ほかの利用者は始められる。
      expect(await dispatch(ws, "generate", { columnId: "g", scope: "cell", resourceId: UI, keys: [keys[3]], languages: ["ja"] }, { ...call, user: { name: "other" } })).toHaveProperty(
        "result",
      );
      for (const j of await ws.jobs()) await ws.waitForJob(j.id);
    } finally {
      await tp2.cleanup();
    }
  });
});

describe("C10: forwardReview は設定 review.targets のアクションだけ", () => {
  it("登録されていても review.targets にないアクションは not-found", async () => {
    const plugin: Plugin = {
      name: "rt",
      actions: [
        { id: "rt.listed", label: "listed", target: "review", run: async () => ({ links: [{ label: "L", url: "https://l.example/" }] }) },
        { id: "rt.unlisted", label: "unlisted", target: "review", run: async () => ({ links: [{ label: "U", url: "https://u.example/" }] }) },
      ],
    };
    const tp2 = await makeTestProject({ plugins: [plugin] });
    try {
      await tp2.patchConfig({ review: { targets: ["rt.listed"] } });
      const ws = await tp2.open();
      const base = { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko" };
      const post = await ws.postReview({ ...base, verdict: "doing", comment: "" });
      await expect(ws.forwardReview({ ...base, reviewId: post.id, actionId: "rt.unlisted" })).rejects.toMatchObject({ code: "not-found" });
      expect((await ws.forwardReview({ ...base, reviewId: post.id, actionId: "rt.listed" })).links).toHaveLength(1);
    } finally {
      await tp2.cleanup();
    }
  });
});
