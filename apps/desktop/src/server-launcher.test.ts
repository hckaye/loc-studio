import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServerCommand, buildServerEnv, generateToken, startServer, ServerStartError } from "./server-launcher";

const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const serverEntry = path.join(repoRoot, "apps", "web", ".next", "standalone", "apps", "web", "launch.mjs");
const watchdog = path.join(desktopDir, "resources", "watchdog.cjs");

describe("generateToken", () => {
  it("32 バイト以上の base64url で、毎回違う", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(generateToken()).not.toBe(a);
  });
});

describe("buildServerEnv / buildServerCommand", () => {
  const input = { port: 4321, appDir: "/app", userDataDir: "/ud", token: "t".repeat(43) };
  it("必要な環境変数を設定する", () => {
    const env = buildServerEnv({ ...input, project: "/proj", runAsNode: true, baseEnv: { PATH: "/bin" } });
    expect(env).toMatchObject({ PORT: "4321", LOC_STUDIO_MODE: "local", LOC_STUDIO_LOCAL_TOKEN: input.token, LOC_STUDIO_DESKTOP: "1", LOC_STUDIO_APP_DIR: "/app", LOC_STUDIO_USER_DATA_DIR: "/ud", LOC_STUDIO_PROJECT: "/proj", ELECTRON_RUN_AS_NODE: "1", PATH: "/bin", NODE_ENV: "production" });
  });
  it("利用者の環境の設定を引き継がない（許可リスト）", () => {
    const env = buildServerEnv({
      ...input,
      baseEnv: {
        PATH: "/bin", SystemRoot: "C:\\Windows", LC_ALL: "ja_JP.UTF-8", LOC_STUDIO_SECRET_LLM_APIKEY: "k", LOC_STUDIO_PLUGIN_DIRS: "/p",
        LOC_STUDIO_MODE: "web", LOC_STUDIO_HOST: "0.0.0.0", LOC_STUDIO_ALLOW_REMOTE_LOCAL: "1", LOC_STUDIO_SERVER_CONFIG: "/c.json",
        LOC_STUDIO_ALLOWED_HOSTS: "evil", LOC_STUDIO_INTERNAL_SECRET: "s", LOC_STUDIO_BIND_HOST: "0.0.0.0", LOC_STUDIO_ADMIN_USER: "a",
        LOC_STUDIO_ADMIN_PASSWORD: "p", LOC_STUDIO_PROJECT: "/old", LOC_STUDIO_LOCAL_TOKEN: "off", HOSTNAME: "0.0.0.0", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect",
      },
    });
    expect(env["LOC_STUDIO_MODE"]).toBe("local");
    expect(env["LOC_STUDIO_LOCAL_TOKEN"]).toBe(input.token);
    for (const k of ["LOC_STUDIO_HOST", "LOC_STUDIO_ALLOW_REMOTE_LOCAL", "LOC_STUDIO_SERVER_CONFIG", "LOC_STUDIO_ALLOWED_HOSTS", "LOC_STUDIO_INTERNAL_SECRET", "LOC_STUDIO_BIND_HOST", "LOC_STUDIO_ADMIN_USER", "LOC_STUDIO_ADMIN_PASSWORD", "LOC_STUDIO_PROJECT", "HOSTNAME", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env).toMatchObject({ PATH: "/bin", SystemRoot: "C:\\Windows", LC_ALL: "ja_JP.UTF-8", LOC_STUDIO_SECRET_LLM_APIKEY: "k", LOC_STUDIO_PLUGIN_DIRS: "/p" });
  });
  it("watchdog は --require で先に読み込む", () => {
    expect(buildServerCommand({ execPath: "node", serverEntry: "s.js", watchdog: "w.cjs" })).toEqual({ command: "node", args: ["--require", "w.cjs", "s.js"] });
    expect(buildServerCommand({ execPath: "node", serverEntry: "s.js" }).args).toEqual(["s.js"]);
  });
});

describe("startServer の失敗", () => {
  it("server.js がなければ、ビルドの案内つきで投げる", async () => {
    await expect(startServer({ execPath: process.execPath, serverEntry: "/no/such/server.js", appDir: "/a", userDataDir: "/u" })).rejects.toThrow(/npm run build:web/);
  });
  it("すぐ終了するサーバーは、出力つきの ServerStartError になる", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ls-bad-"));
    try {
      const bad = path.join(dir, "bad.cjs");
      (await import("node:fs")).writeFileSync(bad, 'console.error("boom-出力"); process.exit(3);');
      const err = await startServer({ execPath: process.execPath, serverEntry: bad, appDir: dir, userDataDir: dir, readyTimeoutMs: 10000 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServerStartError);
      expect((err as ServerStartError).output).toContain("boom-出力");
      expect((err as Error).message).toContain("終了コード 3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("watchdog", () => {
  it("標準入力が閉じたら（親が消えたら）プロセスが終了する", async () => {
    const child = spawn(process.execPath, ["--require", watchdog, "-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "ignore", "ignore"] });
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    child.stdin.end();
    expect(await exited).toBe(0);
  });
});

const hasBuild = existsSync(serverEntry);
describe.skipIf(!hasBuild)("standalone サーバーの起動（結合）", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "ls-desktop-"));
    cpSync(path.join(repoRoot, "examples", "sample-project"), path.join(tmp, "project"), { recursive: true });
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("合言葉つきで起動し、クッキーなしは 401、交換したクッキーで 200。環境の MODE / HOST は届かない。停止できる", async () => {
    const project = path.join(tmp, "project");
    const handle = await startServer({
      execPath: process.execPath,
      serverEntry,
      watchdog,
      appDir: path.join(tmp, "app"),
      userDataDir: path.join(tmp, "ud"),
      project,
      readyTimeoutMs: 90000,
      baseEnv: { ...process.env, LOC_STUDIO_MODE: "web", LOC_STUDIO_HOST: "0.0.0.0", LOC_STUDIO_ALLOW_REMOTE_LOCAL: "1", LOC_STUDIO_LOCAL_TOKEN: "off" },
    });
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(handle.token.length).toBeGreaterThanOrEqual(43);
      expect(handle.startUrl).toBe(`${handle.url}/?token=${handle.token}`);

      // クッキーなし: 401（起動はしている）
      expect((await fetch(`${handle.url}/api/session`)).status).toBe(401);
      // 間違った合言葉は通らない
      expect((await fetch(`${handle.url}/?token=wrong`, { redirect: "manual" })).status).toBe(401);

      // 合言葉をクッキーに換える
      const exchange = await fetch(handle.startUrl, { redirect: "manual" });
      expect(exchange.status).toBe(303);
      expect(exchange.headers.get("location")).not.toContain("token=");
      const setCookie = exchange.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
      const cookie = setCookie.split(";")[0]!;

      const res = await fetch(`${handle.url}/api/session`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const session = (await res.json()) as { defaultProject?: string; desktop: boolean };
      expect(session.defaultProject).toBe(path.resolve(project));
      expect(session.desktop).toBe(true);

      // 子プロセスはループバックだけで待ち受ける（環境の LOC_STUDIO_HOST=0.0.0.0 は届いていない）
      const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4");
      if (lan) await expect(fetch(`http://${lan.address}:${handle.port}/api/session`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();

      // 出力に合言葉が残っていない
      expect(handle.output()).not.toContain(handle.token);
      expect(handle.output()).toContain("loc-studio:");
    } finally {
      await handle.stop();
    }
    expect(handle.child.exitCode !== null || handle.child.signalCode !== null).toBe(true);
    await expect(fetch(`${handle.url}/api/session`)).rejects.toThrow();
  }, 120000);
});

if (!hasBuild) console.warn(`[desktop] 結合テストを省略: ${serverEntry} がありません。npm run build:web を先に実行してください。`);
