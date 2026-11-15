/**
 * ServerRuntime: Web モードで 2 人・2 プロジェクト、ローカルモード。
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthUser } from "./auth/service.js";
import { openServerRuntime } from "./runtime.js";
import type { ServerRuntime } from "./runtime.js";
import type { ServerConfig } from "./server-config.js";
import { SAMPLE_PROJECT, SDK_PATH, UI } from "./testing.js";

let tmp: string;
let rt: ServerRuntime | undefined;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-runtime-"));
  for (const id of ["p1", "p2"]) await cp(SAMPLE_PROJECT, path.join(tmp, id), { recursive: true });
  // p1 の設定にだけ、役割 lqa を足す。
  const p1Config = path.join(tmp, "p1", "loc-studio.project.json");
  const json = JSON.parse(await readFile(p1Config, "utf8")) as Record<string, unknown>;
  await writeFile(p1Config, JSON.stringify({ ...json, roles: { lqa: { label: "LQA", can: ["review"] } } }));
  // p1 のプロジェクトのフォルダに独自描画のプラグインを置く。
  await mkdir(path.join(tmp, "p1", "loc-studio-plugins", "bars"), { recursive: true });
  await writeFile(path.join(tmp, "p1", "loc-studio-plugins", "bars", "index.mjs"), `export default { name: "bars", renderers: [{ id: "bars.bar", module: "web/bar.mjs" }] };`);
  await mkdir(path.join(tmp, "p1", "loc-studio-plugins", "bars", "web"), { recursive: true });
  await writeFile(path.join(tmp, "p1", "loc-studio-plugins", "bars", "web", "bar.mjs"), `export default { render(el, ctx) { el.textContent = String(ctx.value); } };`);
});
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  await rm(tmp, { recursive: true, force: true });
});

const config = (): ServerConfig => ({
  projects: [
    { id: "p1", name: "Project 1", root: path.join(tmp, "p1") },
    { id: "p2", name: "Project 2", root: path.join(tmp, "p2") },
  ],
  auth: { mode: "password", sessionTtlHours: 24, proxyHeader: "x-forwarded-user", admins: [] },
  serverDb: { driver: "sqlite", path: path.join(tmp, "server", "server.db") },
});

async function openWeb(): Promise<ServerRuntime> {
  rt = await openServerRuntime({
    mode: "web",
    dataDir: path.join(tmp, "data"),
    env: { LOC_STUDIO_ADMIN_USER: "root", LOC_STUDIO_ADMIN_PASSWORD: "root-password" },
    config: config(),
    sdkPath: SDK_PATH,
    workspaceOptions: { revisionCheckIntervalMs: 0 },
  });
  return rt;
}

const result = <T>(r: unknown): T => {
  expect(r).toHaveProperty("result");
  return (r as { result: T }).result;
};

describe("Web モード", () => {
  it("2 人・2 プロジェクト: ログイン、権限、記録の名前、利用者ごとの設定", async () => {
    const r = await openWeb();
    const auth = r.auth!;
    const root = (await auth.login({ name: "root", password: "root-password", clientAddress: "127.0.0.1" })).user;
    await r.admin.createUser(root, { name: "alice", password: "alice-password" });
    await r.admin.createUser(root, { name: "bob", password: "bob-password" });
    await r.admin.setMembership(root, "p1", "alice", { role: "translator", languages: ["ko"] });
    await r.admin.setMembership(root, "p2", "bob", { role: "reviewer" });
    await expect(r.admin.setMembership(root, "nope", "bob", { role: "viewer" })).rejects.toMatchObject({ code: "not-found" });

    const alice = (await auth.authenticate((await auth.login({ name: "alice", password: "alice-password", clientAddress: "127.0.0.1" })).token)) as AuthUser;
    const bob = (await auth.login({ name: "bob", password: "bob-password", clientAddress: "127.0.0.1" })).user;
    // 割り当てられるのは、そのプロジェクトの役割だけ（p1 の設定にだけ lqa がある）。
    await expect(r.admin.setMembership(root, "p1", "bob", { role: "god" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("lqa") });
    await expect(r.admin.setMembership(root, "p2", "alice", { role: "lqa" })).rejects.toMatchObject({ code: "invalid" });
    await r.admin.setMembership(root, "p1", "bob", { role: "lqa" });
    expect(await r.projects(bob)).toEqual([
      { id: "p1", name: "Project 1", role: "lqa", roleLabel: "LQA" },
      { id: "p2", name: "Project 2", role: "reviewer", roleLabel: "レビュー" },
    ]);
    await r.admin.removeMembership(root, "p1", "bob");
    expect(await r.projects(alice)).toEqual([{ id: "p1", name: "Project 1", role: "translator", roleLabel: "翻訳", languages: ["ko"] }]);
    expect((await r.projects(root)).map((p) => [p.id, p.role])).toEqual([
      ["p1", "manager"],
      ["p2", "manager"],
    ]);

    expect(await r.handle({ projectId: "p1", method: "info", params: {} })).toMatchObject({ error: { code: "unauthorized" } });
    expect(await r.handle({ projectId: "p2", method: "info", params: {}, user: alice })).toMatchObject({ error: { code: "forbidden" } });
    expect(await r.handle({ projectId: "zzz", method: "info", params: {}, user: alice })).toMatchObject({ error: { code: "not-found" } });

    const info = result<{ permissions: unknown; user: unknown }>(await r.handle({ projectId: "p1", method: "info", params: {}, user: alice }));
    expect(info.permissions).toMatchObject({ role: "translator", languages: ["ko"] });
    expect(info.user).toEqual({ name: "alice", source: "enforce", locked: true });

    result(await r.handle({ projectId: "p1", method: "setText", params: { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" }, user: alice }));
    expect(await r.handle({ projectId: "p1", method: "setText", params: { resourceId: UI, key: "UI_OK", language: "ja", value: "x" }, user: alice })).toMatchObject({
      error: { code: "forbidden" },
    });
    result(await r.handle({ projectId: "p1", method: "save", params: { resourceId: UI }, user: alice }));
    const h = result<{ by: string }[]>(await r.handle({ projectId: "p1", method: "history", params: { resourceId: UI, key: "UI_OK" }, user: root }));
    expect(h[0]!.by).toBe("alice");

    const post = result<{ userName: string }>(
      await r.handle({ projectId: "p2", method: "postReview", params: { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ja", verdict: "ok", comment: "" }, user: bob }),
    );
    expect(post.userName).toBe("bob");
    expect(await r.handle({ projectId: "p2", method: "setText", params: { resourceId: UI, key: "UI_OK", language: "ja", value: "x" }, user: bob })).toMatchObject({
      error: { code: "forbidden" },
    });

    // 利用者ごとの設定は、サーバーの DB に利用者ごとに残る。
    result(await r.handle({ projectId: "p1", method: "setLocalSetting", params: { key: "ui.theme", value: "dark" }, user: alice }));
    const aliceInfo = result<{ localSettings: Record<string, unknown> }>(await r.handle({ projectId: "p1", method: "info", params: {}, user: alice }));
    const rootInfo = result<{ localSettings: Record<string, unknown> }>(await r.handle({ projectId: "p1", method: "info", params: {}, user: root }));
    expect(aliceInfo.localSettings["ui.theme"]).toBe("dark");
    expect(rootInfo.localSettings["ui.theme"]).toBe("light");
    expect(await auth.getUserSettings("alice")).toEqual({ "ui.theme": "dark" });

    // 管理の操作は管理者だけ。
    await expect(r.admin.listUsers(alice)).rejects.toMatchObject({ code: "forbidden" });
    expect((await r.admin.listUsers(root)).map((u) => u.name)).toEqual(["alice", "bob", "root"]);
    await expect(r.admin.deleteUser(root, "root")).rejects.toMatchObject({ code: "invalid" });
    await expect(r.admin.updateUser(root, "root", { admin: false })).rejects.toMatchObject({ code: "invalid" });
    expect(await r.admin.listMemberships(root, "p1")).toEqual([{ projectId: "p1", user: "alice", role: "translator", languages: ["ko"] }]);
    await r.admin.removeMembership(root, "p1", "alice");
    expect(await r.handle({ projectId: "p1", method: "info", params: {}, user: alice })).toMatchObject({ error: { code: "forbidden" } });
  });

  it("プロジェクトのプラグインは確認なしで読み込み、個人のフォルダは使わない。独自描画は開ける人にだけ返す", async () => {
    const r = await openWeb();
    const root = (await r.auth!.login({ name: "root", password: "root-password", clientAddress: "127.0.0.1" })).user;
    await r.admin.createUser(root, { name: "carol", password: "carol-password" });
    const carol = (await r.auth!.login({ name: "carol", password: "carol-password", clientAddress: "127.0.0.1" })).user;
    await mkdir(path.join(tmp, "data", "workspaces", "p1", "plugins"), { recursive: true });
    await writeFile(path.join(tmp, "data", "workspaces", "p1", "plugins", "mine.mjs"), `export default { name: "mine-local" };`);

    const plugins = result<{ plugins: { name: string }[]; untrusted: unknown[] }>(await r.handle({ projectId: "p1", method: "plugins", params: {}, user: root }));
    expect(plugins.plugins.map((p) => p.name)).toEqual(expect.arrayContaining(["mystudio-line-width", "studio-pack", "bars"]));
    expect(plugins.plugins.map((p) => p.name)).not.toContain("mine-local");
    expect(plugins.untrusted).toEqual([]);

    const info = result<{ renderers: { id: string; hash: string }[] }>(await r.handle({ projectId: "p1", method: "info", params: {}, user: root }));
    expect(info.renderers.map((x) => x.id)).toEqual(["bars.bar"]);
    const mod = await r.rendererModule({ projectId: "p1", id: "bars.bar", user: root });
    expect(mod).toMatchObject({ contentType: "text/javascript", hash: info.renderers[0]!.hash });
    expect(mod!.source).toContain("render(el, ctx)");
    expect(await r.rendererModule({ projectId: "p1", id: "bars.bar", user: carol })).toBeUndefined();
    expect(await r.rendererModule({ projectId: "p1", id: "bars.bar" })).toBeUndefined();
  });

  it("設定を省略すると、環境変数の場所の server.json を読む", async () => {
    await mkdir(path.join(tmp, "cfg"), { recursive: true });
    await writeFile(path.join(tmp, "cfg", "server.json"), JSON.stringify({ projects: [{ id: "p1", root: "../p1" }] }));
    rt = await openServerRuntime({ mode: "web", dataDir: path.join(tmp, "data"), env: { LOC_STUDIO_SERVER_CONFIG: path.join(tmp, "cfg", "server.json") }, sdkPath: SDK_PATH });
    expect(rt.config!.projects[0]!.root).toBe(path.join(tmp, "p1"));
    expect(rt.config!.serverDb).toEqual({ driver: "sqlite", path: path.join(tmp, "cfg", "server.db") });
    // 利用者がいないので、誰も開けない。
    expect(await rt.auth!.listUsers()).toEqual([]);
  });
});

describe("ローカルモード", () => {
  it("認証なしで、プロジェクトのフォルダを開いて従来どおり呼べる", async () => {
    rt = await openServerRuntime({ mode: "local", dataDir: path.join(tmp, "data"), env: {}, sdkPath: SDK_PATH, workspaceOptions: { pluginTrust: "always" } });
    expect(rt.auth).toBeUndefined();
    const info = result<{ name: string; permissions: { role: string } }>(await rt.handle({ projectId: path.join(tmp, "p1"), method: "info", params: {} }));
    expect(info.name).toBe("SampleGame");
    expect(info.permissions.role).toBe("manager");
    expect(await rt.handle({ projectId: "relative", method: "info" })).toMatchObject({ error: { code: "not-found" } });
    await expect(rt.admin.listUsers({ name: "x" } as AuthUser)).rejects.toMatchObject({ code: "forbidden" });
  });
});
