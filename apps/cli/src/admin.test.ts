import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerConfig, openServerRuntime } from "@loc-studio/server";
import type { AuthService } from "@loc-studio/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./commands.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const sample = path.join(repoRoot, "examples", "sample-project");
const sdkPath = path.join(repoRoot, "packages", "sdk", "src", "index.ts");

let tmp: string;
let dataDir: string;
let project: string;

const writeConfig = (projects: unknown[] = [{ id: "p1", name: "P1", root: project }]) =>
  writeFile(path.join(dataDir, "server.json"), JSON.stringify({ projects, auth: { mode: "password" }, serverDb: { driver: "sqlite", path: path.join(dataDir, "server.db") } }));

async function cli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run([...args, "--data-dir", dataDir], {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    env: { LOC_STUDIO_SDK_PATH: sdkPath, ...(opts.env ?? {}) },
    cwd: repoRoot,
    ...(opts.stdin !== undefined ? { stdin: async () => opts.stdin as string } : {}),
  });
  return { code, stdout, stderr };
}

/** CLI が閉じたあとの DB を、サービス層で開いて確かめる。 */
async function withAuth<T>(fn: (auth: AuthService) => Promise<T>): Promise<T> {
  const rt = await openServerRuntime({ mode: "web", dataDir, env: {}, config: loadServerConfig(path.join(dataDir, "server.json"), {}), sdkPath });
  try {
    return await fn(rt.auth!);
  } finally {
    await rt.close();
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-studio-cli-admin-"));
  dataDir = path.join(tmp, "data");
  project = path.join(tmp, "p1");
  await mkdir(dataDir, { recursive: true });
  await cp(sample, project, { recursive: true });
  await writeConfig();
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("user", () => {
  it("add（stdin / 環境変数）、list、login、ハッシュは出ない", async () => {
    const a = await cli(["user", "add", "alice", "--admin", "--display-name", "アリス", "--password-stdin"], { stdin: "alice-password\n" });
    expect(a.code).toBe(0);
    const b = await cli(["user", "add", "bob", "--password-env", "BOB_PW"], { env: { BOB_PW: "bob-password" } });
    expect(b.code).toBe(0);
    const list = await cli(["user", "list"]);
    expect(list.stdout).toContain("alice  アリス  管理者  有効");
    expect(list.stdout).toContain("bob");
    expect(list.stdout).not.toMatch(/scrypt|hash/i);
    const j = JSON.parse((await cli(["user", "list", "--json"])).stdout) as { users: Record<string, unknown>[] };
    expect(j.users.map((u) => u["name"])).toEqual(expect.arrayContaining(["alice", "bob"]));
    expect(JSON.stringify(j)).not.toMatch(/scrypt/);
    await withAuth(async (auth) => {
      expect((await auth.login({ name: "alice", password: "alice-password", clientAddress: "127.0.0.1" })).user.admin).toBe(true);
      expect((await auth.login({ name: "bob", password: "bob-password", clientAddress: "127.0.0.1" })).user.admin).toBe(false);
    });
  });

  it("パスワードの指定なしは生成して 1 回だけ表示し、そのパスワードでログインできる", async () => {
    const r = await cli(["user", "add", "carol"]);
    expect(r.code).toBe(0);
    const m = /生成したパスワード: (\S+)/.exec(r.stdout);
    expect(m).not.toBeNull();
    const pw = m![1]!;
    expect(pw.length).toBeGreaterThanOrEqual(16);
    expect((await cli(["user", "list"])).stdout).not.toContain(pw);
    await withAuth(async (auth) => expect((await auth.login({ name: "carol", password: pw, clientAddress: "127.0.0.1" })).user.name).toBe("carol"));
  });

  it("引数でパスワードは渡せない・指定の誤りは 2", async () => {
    expect((await cli(["user", "add", "x", "--password", "secret123"])).code).toBe(2);
    expect((await cli(["user", "add", "x", "--password-stdin", "--password-env", "A"], { stdin: "pw-12345" })).code).toBe(2);
    expect((await cli(["user", "add", "x", "--password-stdin"])).code).toBe(2);
    expect((await cli(["user", "add", "x", "--password-env", "NOPE_UNSET"])).code).toBe(2);
    expect((await cli(["user", "add", "x", "--password-stdin"], { stdin: "short" })).code).toBe(2);
    expect((await cli(["user", "passwd", "x"])).code).toBe(2);
    expect((await cli(["user", "frob"])).code).toBe(2);
    expect((await cli(["user", "set", "x", "--admin", "--no-admin"])).code).toBe(2);
    expect((await cli(["user", "list", "--role", "viewer"])).code).toBe(2);
  });

  it("passwd: stdin / 環境変数 / --generate。古いパスワードとセッションは無効", async () => {
    await cli(["user", "add", "dave", "--password-stdin"], { stdin: "old-password" });
    const token = await withAuth(async (auth) => (await auth.login({ name: "dave", password: "old-password", clientAddress: "127.0.0.1" })).token);
    expect((await cli(["user", "passwd", "dave", "--password-stdin"], { stdin: "new-password\n" })).code).toBe(0);
    await withAuth(async (auth) => {
      expect(await auth.authenticate(token)).toBeUndefined();
      await expect(auth.login({ name: "dave", password: "old-password", clientAddress: "127.0.0.1" })).rejects.toMatchObject({ code: "unauthorized" });
      await auth.login({ name: "dave", password: "new-password", clientAddress: "127.0.0.1" });
    });
    expect((await cli(["user", "passwd", "dave", "--password-env", "PW"], { env: { PW: "env-password" } })).code).toBe(0);
    const g = await cli(["user", "passwd", "dave", "--generate"]);
    const pw = /生成したパスワード: (\S+)/.exec(g.stdout)![1]!;
    await withAuth(async (auth) => {
      await auth.login({ name: "dave", password: pw, clientAddress: "127.0.0.1" });
      // 生成したパスワードに置き換わったので、前のパスワードでは入れない。
      await expect(auth.login({ name: "dave", password: "env-password", clientAddress: "127.0.0.1" })).rejects.toMatchObject({ code: "unauthorized" });
    });
    expect((await cli(["user", "passwd", "nobody", "--generate"])).code).toBe(2);
  });

  it("set: 管理者・無効・表示名、logout", async () => {
    await cli(["user", "add", "root", "--admin", "--password-stdin"], { stdin: "root-password" });
    await cli(["user", "add", "erin", "--password-stdin"], { stdin: "erin-password" });
    const token = await withAuth(async (auth) => (await auth.login({ name: "erin", password: "erin-password", clientAddress: "127.0.0.1" })).token);
    expect((await cli(["user", "set", "erin", "--admin", "--display-name", "エリン"])).code).toBe(0);
    await withAuth(async (auth) => expect(await auth.getUser("erin")).toMatchObject({ admin: true, displayName: "エリン" }));
    expect((await cli(["user", "set", "erin", "--disable"])).code).toBe(0);
    await withAuth(async (auth) => expect((await auth.getUser("erin"))?.disabled).toBe(true));
    expect((await cli(["user", "set", "erin", "--enable", "--no-admin"])).code).toBe(0);
    await withAuth(async (auth) => expect(await auth.getUser("erin")).toMatchObject({ admin: false, disabled: false }));
    expect((await cli(["user", "set", "erin"])).code).toBe(2);
    expect((await cli(["user", "set", "ghost", "--admin"])).code).toBe(2);

    // 無効化でセッションは落ちる（仕様）。
    await withAuth(async (auth) => expect(await auth.authenticate(token)).toBeUndefined());
    const t2 = await withAuth(async (auth) => (await auth.login({ name: "erin", password: "erin-password", clientAddress: "127.0.0.1" })).token);
    expect((await cli(["user", "logout", "erin"])).code).toBe(0);
    await withAuth(async (auth) => expect(await auth.authenticate(t2)).toBeUndefined());
  });

  it("delete は --yes が必要", async () => {
    await cli(["user", "add", "root", "--admin", "--password-stdin"], { stdin: "root-password" });
    await cli(["user", "add", "frank", "--password-stdin"], { stdin: "frank-password" });
    expect((await cli(["user", "delete", "frank"])).code).toBe(2);
    expect((await cli(["user", "delete", "frank", "--yes"])).code).toBe(0);
    await withAuth(async (auth) => expect(await auth.getUser("frank")).toBeUndefined());
    expect((await cli(["user", "delete", "frank", "--yes"])).code).toBe(2);
  });

  it("最後の有効な管理者は、削除・無効化・解除できない", async () => {
    await cli(["user", "add", "root", "--admin", "--password-stdin"], { stdin: "root-password" });
    for (const args of [["delete", "root", "--yes"], ["set", "root", "--disable"], ["set", "root", "--no-admin"]]) {
      const r = await cli(["user", ...args]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("最後の有効な管理者");
    }
    await withAuth(async (auth) => expect(await auth.getUser("root")).toMatchObject({ admin: true, disabled: false }));
    // 別の管理者がいれば、できる。無効な管理者は数えない。
    await cli(["user", "add", "root2", "--admin", "--password-stdin"], { stdin: "root2-password" });
    expect((await cli(["user", "set", "root", "--disable"])).code).toBe(0);
    expect((await cli(["user", "set", "root2", "--no-admin"])).code).toBe(1);
    expect((await cli(["user", "delete", "root2", "--yes"])).code).toBe(1);
  });
});

describe("ユーザー名の規則", () => {
  it("大文字は小文字にそろえ、使えない名前は分かりやすく断る（2）", async () => {
    expect((await cli(["user", "add", "Alice", "--password-stdin"], { stdin: "alice-password" })).stdout).toContain("追加しました: alice  alice");
    expect((await cli(["user", "passwd", "ALICE", "--password-stdin"], { stdin: "alice-password2" })).code).toBe(0);
    expect((await cli(["user", "set", "Alice", "--display-name", "A"])).code).toBe(0);
    for (const args of [
      ["add", "bad name", "--password-stdin"],
      ["add", ".dot", "--password-stdin"],
      ["add", "名前", "--password-stdin"],
      ["add", "a".repeat(65), "--password-stdin"],
      ["passwd", "bad/name", "--generate"],
      ["set", "bad name", "--admin"],
      ["delete", "bad name", "--yes"],
      ["logout", "bad name"],
    ]) {
      const r = await cli(["user", ...args], { stdin: "some-password" });
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("は使えません");
      expect(r.stderr).toContain("1〜64 文字");
    }
    const m = await cli(["member", "set", "p1", "bad name", "--role", "viewer"]);
    expect(m.code).toBe(2);
    expect(m.stderr).toContain("は使えません");
    expect((await cli(["member", "remove", "p1", "bad name"])).code).toBe(2);
    expect((await cli(["help"])).stdout).toContain("1〜64 文字");
  });
});

describe("member", () => {
  it("set / list / remove が callContextFor に反映される", async () => {
    await cli(["user", "add", "gina", "--password-stdin"], { stdin: "gina-password" });
    expect((await cli(["member", "set", "p1", "gina", "--role", "translator", "--languages", "ko,ja"])).code).toBe(0);
    await withAuth(async (auth) => {
      const user = (await auth.getUser("gina"))!;
      expect(await auth.callContextFor(user, "p1")).toMatchObject({ role: "translator", languages: ["ko", "ja"] });
    });
    const list = await cli(["member", "list", "--project", "p1"]);
    expect(list.stdout).toContain("p1  gina  translator  言語: ko,ja");
    const j = JSON.parse((await cli(["member", "list", "--json"])).stdout) as { members: { user: string; role: string }[] };
    expect(j.members).toEqual([expect.objectContaining({ user: "gina", role: "translator" })]);
    // 言語の指定なしで置き換えると制限が外れる。
    expect((await cli(["member", "set", "p1", "gina", "--role", "viewer"])).code).toBe(0);
    await withAuth(async (auth) => {
      const ctx = await auth.callContextFor((await auth.getUser("gina"))!, "p1");
      expect(ctx?.role).toBe("viewer");
      expect(ctx?.languages).toBeUndefined();
    });
    expect((await cli(["member", "remove", "p1", "gina"])).code).toBe(0);
    await withAuth(async (auth) => expect(await auth.callContextFor((await auth.getUser("gina"))!, "p1")).toBeUndefined());
  });

  it("誤り: 役割、プロジェクト、ユーザー", async () => {
    await cli(["user", "add", "hank", "--password-stdin"], { stdin: "hank-password" });
    expect((await cli(["member", "set", "p1", "hank"])).code).toBe(2);
    expect((await cli(["member", "set", "p1", "hank", "--role", "boss"])).code).toBe(2);
    expect((await cli(["member", "set", "nope", "hank", "--role", "viewer"])).code).toBe(2);
    expect((await cli(["member", "set", "p1", "ghost", "--role", "viewer"])).code).toBe(2);
    expect((await cli(["member", "list", "--project", "nope"])).code).toBe(2);
  });
});

describe("server check", () => {
  it("正しい設定は 0、プロジェクトを一覧する", async () => {
    await cli(["user", "add", "root", "--admin", "--password-stdin"], { stdin: "root-password" });
    const r = await cli(["server", "check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("p1  P1");
    expect(r.stdout).toContain("OK");
    const j = JSON.parse((await cli(["server", "check", "--json"])).stdout) as { ok: boolean; projects: { ok: boolean }[]; users: { enabledAdmins: number } };
    expect(j).toMatchObject({ ok: true, users: { enabledAdmins: 1 } });
    expect(j.projects[0]!.ok).toBe(true);
  });

  it("管理者がいないのは問題", async () => {
    const r = await cli(["server", "check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("有効な管理者がいません");
  });

  it("プロジェクトのフォルダがない", async () => {
    await cli(["user", "add", "root", "--admin", "--password-stdin"], { stdin: "root-password" });
    await writeConfig([{ id: "p1", name: "P1", root: project }, { id: "gone", name: "Gone", root: path.join(tmp, "missing") }]);
    const r = await cli(["server", "check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/gone {2}Gone .* 開けません: フォルダがありません/);
    expect(r.stdout).toContain("p1  P1");
  });

  it("JSON が壊れている / 設定の誤り", async () => {
    await writeFile(path.join(dataDir, "server.json"), "{ not json");
    const r = await cli(["server", "check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("JSON が壊れています");
    await writeFile(path.join(dataDir, "server.json"), JSON.stringify({ projects: [{ id: "bad id!", root: "x" }] }));
    expect((await cli(["server", "check", "--json"])).code).toBe(1);
    // ユーザー管理のコマンドも、設定が壊れていれば失敗（1）
    expect((await cli(["user", "list"])).code).toBe(1);
  });

  it("サーバーと同じ開き方: データフォルダの plugins は読まず、プロジェクトとアプリのフォルダは読む", async () => {
    await cli(["user", "add", "root", "--admin", "--password-stdin"], { stdin: "root-password" });
    const broken = "export default { name: 'broken', validators: [ ;;; ";
    await mkdir(path.join(dataDir, "plugins"), { recursive: true });
    await writeFile(path.join(dataDir, "plugins", "broken-local.mjs"), broken);
    expect((await cli(["server", "check"])).code).toBe(0);

    await writeFile(path.join(project, "loc-studio-plugins", "broken-project.mjs"), broken);
    const p = await cli(["server", "check"]);
    expect(p.code).toBe(1);
    expect(p.stdout).toContain('プロジェクト "p1" のプラグインを読み込めません');
    expect(p.stdout).toContain("broken-project.mjs");
    await rm(path.join(project, "loc-studio-plugins", "broken-project.mjs"));
    expect((await cli(["server", "check"])).code).toBe(0);

    const appDir = path.join(tmp, "app");
    await mkdir(path.join(appDir, "plugins"), { recursive: true });
    await writeFile(path.join(appDir, "plugins", "broken-app.mjs"), broken);
    const a = await cli(["server", "check"], { env: { LOC_STUDIO_APP_DIR: appDir } });
    expect(a.code).toBe(1);
    expect(a.stdout).toContain("broken-app.mjs");
  });

  it("新しい設定項目: proxy の合言葉の環境変数がなければ問題、あれば OK（値は出さない）", async () => {
    await writeFile(
      path.join(dataDir, "server.json"),
      JSON.stringify({
        projects: [{ id: "p1", name: "P1", root: project, env: ["MY_VAR"] }],
        auth: { mode: "proxy", proxyHeader: "X-User", proxySecretHeader: "X-Secret", proxySecretEnv: "PROXY_SECRET_X", trustedProxyHops: 1, sessionMaxHours: 100 },
      }),
    );
    const bad = await cli(["server", "check"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("PROXY_SECRET_X");
    const ok = await cli(["server", "check"], { env: { PROXY_SECRET_X: "s3cr3t-value" } });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("x-secret");
    expect(ok.stdout).toContain("最長 100 時間");
    expect(ok.stdout).toContain("段数 1");
    expect(ok.stdout).toContain("MY_VAR");
    expect(ok.stdout).not.toContain("s3cr3t-value");
    expect((await cli(["server", "check", "--json"], { env: { PROXY_SECRET_X: "s3cr3t-value" } })).stdout).not.toContain("s3cr3t-value");
    // アカウント管理は合言葉の環境変数がなくても動く。
    expect((await cli(["user", "add", "zed", "--password-stdin"], { stdin: "zed-password" })).code).toBe(0);
    // 設定の誤り
    await writeFile(path.join(dataDir, "server.json"), JSON.stringify({ projects: [], auth: { proxySecretHeader: "X-S" } }));
    const half = await cli(["server", "check"]);
    expect(half.code).toBe(1);
    expect(half.stdout).toContain("proxySecretEnv");
  });

  it("--data-dir も設定の場所もなければ 2", async () => {
    let err = "";
    const code = await run(["user", "list"], { stdout: () => undefined, stderr: (s) => void (err += s), env: {}, cwd: repoRoot });
    expect(code).toBe(2);
    expect(err).toContain("--data-dir");
  });
});
