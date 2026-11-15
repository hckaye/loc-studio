/**
 * サーバー管理のコマンド（user / member / server check）。
 * サーバーの DB を直接開くので、管理者の権限で動く。認証サービスを直接使い、
 * 最後の有効な管理者を守る規則は AdminApi と同じ考え方でここでも守る。
 * パスワードのハッシュとトークンは出力しない。
 */
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ApiError, ROLES, loadServerConfig, normalizeUserName, openServerRuntime, serverConfigPath } from "@loc-studio/server";
import type { AuthService, AuthUser, ServerConfig, ServerRuntime } from "@loc-studio/server";
import { UsageError } from "./args.js";
import type { CliOptions } from "./args.js";
import type { CliIO } from "./commands.js";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const json = (io: CliIO, value: unknown): void => io.stdout(JSON.stringify(value, null, 2) + "\n");

/** 管理者の環境変数（最初の管理者の自動作成）は、管理コマンドでは使わない。 */
const ADMIN_ENV = ["LOC_STUDIO_ADMIN_USER", "LOC_STUDIO_ADMIN_PASSWORD"];

interface Location {
  dataDir: string;
  configFile: string;
  env: Record<string, string | undefined>;
}

function locate(opts: CliOptions, io: CliIO): Location {
  const env: Record<string, string | undefined> = { ...io.env };
  for (const k of ADMIN_ENV) delete env[k];
  if (opts.dataDir !== undefined) env["LOC_STUDIO_USER_DATA_DIR"] = path.resolve(io.cwd, opts.dataDir);
  const dataDirRaw = env["LOC_STUDIO_USER_DATA_DIR"];
  let configFile: string;
  if (opts.serverConfig !== undefined) configFile = path.resolve(io.cwd, opts.serverConfig);
  else if (dataDirRaw || env["LOC_STUDIO_SERVER_CONFIG"]) configFile = path.resolve(io.cwd, serverConfigPath(env, dataDirRaw ?? io.cwd));
  else throw new UsageError("--data-dir <dir>（または --server-config <file>）を指定してください。");
  const dataDir = path.resolve(io.cwd, dataDirRaw ?? path.dirname(configFile));
  return { dataDir, configFile, env };
}

async function withRuntime<T>(
  loc: Location,
  io: CliIO,
  config: ServerConfig,
  fn: (rt: ServerRuntime, auth: AuthService) => Promise<T>,
): Promise<T> {
  // Web の層と同じく、アプリのフォルダ（LOC_STUDIO_APP_DIR）と SDK の場所を渡す。
  const appDir = io.env["LOC_STUDIO_APP_DIR"];
  const sdkPath = io.env["LOC_STUDIO_SDK_PATH"];
  const rt = await openServerRuntime({
    mode: "web",
    dataDir: loc.dataDir,
    env: loc.env,
    config,
    ...(appDir ? { appDir: path.resolve(io.cwd, appDir) } : {}),
    ...(sdkPath ? { sdkPath } : {}),
  });
  try {
    if (!rt.auth) throw new Error("サーバーの認証サービスを開けませんでした。");
    return await fn(rt, rt.auth);
  } finally {
    await rt.close();
  }
}

// ---------------------------------------------------------------------------
// パスワード
// ---------------------------------------------------------------------------

async function readPassword(opts: CliOptions, io: CliIO): Promise<string | undefined> {
  if (opts.passwordStdin) {
    if (!io.stdin) throw new UsageError("--password-stdin は、標準入力を読めない環境では使えません。");
    const text = (await io.stdin()).replace(/\r?\n$/, "");
    if (text === "") throw new UsageError("標準入力のパスワードが空です。");
    return text;
  }
  if (opts.passwordEnv !== undefined) {
    const v = io.env[opts.passwordEnv];
    if (v === undefined || v === "") throw new UsageError(`環境変数 ${opts.passwordEnv} が設定されていません。`);
    return v;
  }
  return undefined;
}

/**
 * ログイン名をサーバーと同じ規則でそろえる（規則はサービス層の normalizeUserName が持つ）。
 * 使えない名前は、DB を開く前に分かりやすく断る（終了コード 2）。
 */
function normName(raw: string): string {
  const n = normalizeUserName(raw);
  if (n === undefined) {
    throw new UsageError(
      `ユーザー名 "${raw}" は使えません。英数字で始まり、英数字と . _ @ - だけの 1〜64 文字にしてください（大文字小文字は区別せず、小文字にそろえます）。`,
    );
  }
  return n;
}

const generatePassword = (): string => randomBytes(18).toString("base64url");

// ---------------------------------------------------------------------------
// 最後の管理者を守る
// ---------------------------------------------------------------------------

async function assertNotLastAdmin(auth: AuthService, target: AuthUser, what: string): Promise<void> {
  if (!target.admin || target.disabled) return;
  const enabled = (await auth.listUsers()).filter((u) => u.admin && !u.disabled);
  if (enabled.length <= 1) {
    throw new ApiError(
      "failed",
      `"${target.name}" は最後の有効な管理者なので、${what}できません。先に別の管理者を追加（user add --admin）または有効化してください。`,
    );
  }
}

async function requireUser(auth: AuthService, name: string): Promise<AuthUser> {
  const u = await auth.getUser(name);
  if (!u) throw new ApiError("not-found", `ユーザー "${name}" はありません。`);
  return u;
}

// ---------------------------------------------------------------------------
// user
// ---------------------------------------------------------------------------

const userLine = (u: AuthUser): string =>
  `${u.name}  ${u.displayName}  ${u.admin ? "管理者" : "一般"}  ${u.disabled ? "無効" : "有効"}  パスワード${u.hasPassword ? "あり" : "なし"}`;

async function cmdUser(auth: AuthService, opts: CliOptions, io: CliIO): Promise<number> {
  const name = opts.sub === "list" ? "" : normName(opts.args[0] as string);
  switch (opts.sub) {
    case "list": {
      const users = await auth.listUsers();
      if (opts.json) json(io, { users });
      else io.stdout(users.length === 0 ? "ユーザーはいません。\n" : users.map(userLine).join("\n") + "\n");
      return 0;
    }
    case "add": {
      let password = await readPassword(opts, io);
      const generated = password === undefined;
      if (generated) password = generatePassword();
      const user = await auth.createUser({
        name,
        password: password as string,
        admin: opts.admin,
        ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
      });
      if (opts.json) json(io, { user, ...(generated ? { generatedPassword: password } : {}) });
      else {
        io.stdout(`追加しました: ${userLine(user)}\n`);
        if (generated) io.stdout(`生成したパスワード: ${password}\n（表示はこの 1 回だけです。控えてください）\n`);
      }
      return 0;
    }
    case "passwd": {
      await requireUser(auth, name);
      let password = await readPassword(opts, io);
      if (password === undefined) {
        if (!opts.generate) throw new UsageError("user passwd には --password-stdin、--password-env <VAR>、--generate のどれかが必要です。");
        password = generatePassword();
        await auth.setPassword(name, password);
        await auth.logoutAll(name);
        if (opts.json) json(io, { name, generatedPassword: password });
        else io.stdout(`パスワードを変更しました: ${name}\n生成したパスワード: ${password}\n（表示はこの 1 回だけです。控えてください）\n`);
        return 0;
      }
      await auth.setPassword(name, password);
      await auth.logoutAll(name);
      if (opts.json) json(io, { name, changed: true });
      else io.stdout(`パスワードを変更しました: ${name}（ログイン中のセッションは無効にしました）\n`);
      return 0;
    }
    case "set": {
      const patch: { displayName?: string; admin?: boolean; disabled?: boolean } = {};
      if (opts.admin) patch.admin = true;
      if (opts.noAdmin) patch.admin = false;
      if (opts.enable) patch.disabled = false;
      if (opts.disable) patch.disabled = true;
      if (opts.displayName !== undefined) patch.displayName = opts.displayName;
      if (Object.keys(patch).length === 0) {
        throw new UsageError("user set には --admin / --no-admin / --enable / --disable / --display-name のどれかが必要です。");
      }
      const target = await requireUser(auth, name);
      if (patch.admin === false) await assertNotLastAdmin(auth, target, "管理者から外すことが");
      if (patch.disabled === true) await assertNotLastAdmin(auth, target, "無効にすることが");
      const user = await auth.updateUser(name, patch);
      if (opts.json) json(io, { user });
      else io.stdout(`更新しました: ${userLine(user)}\n`);
      return 0;
    }
    case "delete": {
      if (!opts.yes) throw new UsageError(`user delete は --yes が必要です（"${name}" を削除します。元に戻せません）。`);
      const target = await requireUser(auth, name);
      await assertNotLastAdmin(auth, target, "削除することが");
      await auth.deleteUser(name);
      if (opts.json) json(io, { deleted: name });
      else io.stdout(`削除しました: ${name}\n`);
      return 0;
    }
    case "logout": {
      await requireUser(auth, name);
      await auth.logoutAll(name);
      if (opts.json) json(io, { loggedOut: name });
      else io.stdout(`セッションをすべて無効にしました: ${name}\n`);
      return 0;
    }
  }
  throw new UsageError(`不明なサブコマンドです: user ${opts.sub ?? ""}`);
}

// ---------------------------------------------------------------------------
// member
// ---------------------------------------------------------------------------

function requireProject(config: ServerConfig, id: string): void {
  if (!config.projects.some((p) => p.id === id)) {
    throw new ApiError("not-found", `プロジェクト "${id}" はサーバーの設定にありません（${config.projects.map((p) => p.id).join(", ") || "なし"}）。`);
  }
}

async function cmdMember(auth: AuthService, config: ServerConfig, opts: CliOptions, io: CliIO): Promise<number> {
  switch (opts.sub) {
    case "list": {
      if (opts.project !== undefined) requireProject(config, opts.project);
      const members = await auth.listMemberships(opts.project !== undefined ? { projectId: opts.project } : {});
      if (opts.json) json(io, { members });
      else {
        io.stdout(
          members.length === 0
            ? "割り当てはありません。\n"
            : members.map((m) => `${m.projectId}  ${m.user}  ${m.role}${m.languages ? `  言語: ${m.languages.join(",")}` : ""}`).join("\n") + "\n",
        );
      }
      return 0;
    }
    case "set": {
      const [projectId, rawUser] = opts.args as [string, string];
      const user = normName(rawUser);
      if (opts.role === undefined) throw new UsageError("member set には --role <viewer|translator|reviewer|manager> が必要です。");
      if (!(ROLES as readonly string[]).includes(opts.role)) {
        throw new UsageError(`--role は ${ROLES.join(" / ")} のどれかを指定してください: ${opts.role}`);
      }
      requireProject(config, projectId);
      await requireUser(auth, user);
      const m = await auth.setMembership(projectId, user, {
        role: opts.role as (typeof ROLES)[number],
        ...(opts.languages ? { languages: opts.languages } : {}),
      });
      if (opts.json) json(io, { member: m });
      else io.stdout(`設定しました: ${m.projectId}  ${m.user}  ${m.role}${m.languages ? `  言語: ${m.languages.join(",")}` : ""}\n`);
      return 0;
    }
    case "remove": {
      const [projectId, rawUser] = opts.args as [string, string];
      const user = normName(rawUser);
      requireProject(config, projectId);
      await auth.removeMembership(projectId, user);
      if (opts.json) json(io, { removed: { projectId, user } });
      else io.stdout(`外しました: ${projectId}  ${user}\n`);
      return 0;
    }
  }
  throw new UsageError(`不明なサブコマンドです: member ${opts.sub ?? ""}`);
}

// ---------------------------------------------------------------------------
// server check
// ---------------------------------------------------------------------------

async function cmdServerCheck(loc: Location, opts: CliOptions, io: CliIO): Promise<number> {
  const problems: string[] = [];
  const projects: { id: string; name: string; root: string; ok: boolean; error?: string; warnings: string[] }[] = [];
  let users: { total: number; admins: number; enabledAdmins: number } | undefined;
  let config: ServerConfig | undefined;
  try {
    config = loadServerConfig(loc.configFile, loc.env);
  } catch (err) {
    problems.push(errText(err));
  }

  if (config) {
    // Web サーバーと同じ入口（openServerRuntime）で開く。プロジェクトも runtime.workspace で、
    // サーバーと同じオプション（local プラグインなし、${env:} は projects[].env だけ、プラグインのフォルダはプロジェクトとアプリのフォルダ内だけ）で開く。
    let rt: ServerRuntime | undefined;
    const appDir = io.env["LOC_STUDIO_APP_DIR"];
    const sdkPath = io.env["LOC_STUDIO_SDK_PATH"];
    try {
      rt = await openServerRuntime({
        mode: "web",
        dataDir: loc.dataDir,
        env: loc.env,
        config,
        ...(appDir ? { appDir: path.resolve(io.cwd, appDir) } : {}),
        ...(sdkPath ? { sdkPath } : {}),
      });
    } catch (err) {
      problems.push(`サーバーを開けませんでした（設定の auth と serverDb を確かめてください）: ${errText(err)}`);
    }
    if (rt) {
      try {
        const list = await rt.auth!.listUsers();
        users = {
          total: list.length,
          admins: list.filter((u) => u.admin).length,
          enabledAdmins: list.filter((u) => u.admin && !u.disabled).length,
        };
        if (config.auth.mode === "password" && users.enabledAdmins === 0) {
          problems.push("有効な管理者がいません（user add <name> --admin で作成できます）。");
        }
      } catch (err) {
        problems.push(`アカウントを読めませんでした: ${errText(err)}`);
      }
      for (const p of config.projects) {
        const entry: (typeof projects)[number] = { id: p.id, name: p.name, root: p.root, ok: true, warnings: [] };
        try {
          if (!existsSync(p.root) || !statSync(p.root).isDirectory()) throw new Error(`フォルダがありません: ${p.root}`);
          const ws = await rt.workspace(p.id);
          const info = await ws.info();
          const plugins = await ws.plugins();
          const warnings = [...new Set([...info.warnings, ...plugins.warnings])];
          entry.warnings = warnings;
          const errors = [...info.pluginErrors, ...plugins.errors];
          const seen = new Set<string>();
          for (const e of errors) {
            const line = `${e.path}: ${e.message}`;
            if (seen.has(line)) continue;
            seen.add(line);
            problems.push(`プロジェクト "${p.id}" のプラグインを読み込めません: ${line}`);
          }
        } catch (err) {
          entry.ok = false;
          entry.error = errText(err);
          problems.push(`プロジェクト "${p.id}" を開けません: ${entry.error}`);
        }
        projects.push(entry);
      }
      await rt.close();
    }
  }

  const ok = problems.length === 0;
  if (opts.json) {
    json(io, {
      ok,
      configFile: loc.configFile,
      dataDir: loc.dataDir,
      problems,
      projects,
      ...(config ? { auth: { ...config.auth, ...(config.auth.proxySecretEnv ? { proxySecretEnv: config.auth.proxySecretEnv } : {}) } } : {}),
      ...(users ? { users } : {}),
    });
    return ok ? 0 : 1;
  }
  const out: string[] = [`設定ファイル: ${loc.configFile}`, `データフォルダ: ${loc.dataDir}`];
  if (config) {
    const a = config.auth;
    out.push(`認証: ${a.mode}  サーバー DB: ${config.serverDb.driver === "sqlite" ? config.serverDb.path : "postgres"}`);
    out.push(
      `セッション: 最後の利用から ${a.sessionTtlHours} 時間 / ログインから最長 ${a.sessionMaxHours ?? "-"} 時間` +
        (a.mode === "proxy"
          ? `  プロキシ: ヘッダー ${a.proxyHeader}、段数 ${a.trustedProxyHops ?? 0}、合言葉 ${a.proxySecretHeader !== undefined ? `${a.proxySecretHeader}（環境変数 ${a.proxySecretEnv}）` : "なし"}`
          : ""),
    );
    if (users) out.push(`ユーザー: ${users.total}（管理者 ${users.admins}、有効な管理者 ${users.enabledAdmins}）`);
    out.push("プロジェクト:");
    if (projects.length === 0) out.push("  (なし)");
    for (const p of projects) {
      out.push(`  ${p.id}  ${p.name}  ${p.root}  ${p.ok ? "OK" : `開けません: ${p.error}`}`);
      for (const w of p.warnings) out.push(`    警告: ${w}`);
    }
    for (const p of config.projects) {
      out.push(`    (${p.id} の \${env:} で使える環境変数: ${p.env && p.env.length > 0 ? p.env.join(", ") : "なし"})`);
    }
  }
  if (ok) out.push("問題は見つかりませんでした。");
  else {
    out.push("問題:");
    for (const p of problems) out.push(`  - ${p.replace(/\n/g, "\n    ")}`);
  }
  io.stdout(out.join("\n") + "\n");
  return ok ? 0 : 1;
}

/** サーバー管理のコマンドを実行する。 */
export async function runAdminCommand(opts: CliOptions, io: CliIO): Promise<number> {
  const loc = locate(opts, io);
  if (opts.command === "server") return cmdServerCheck(loc, opts, io);
  // 入力の誤り（パスワードの指定など）は DB を開く前に確かめるため、コマンド側で先に読む箇所もあるが、
  // 設定の読み込みの失敗は通常の失敗（終了コード 1）として扱う。
  const config = loadServerConfig(loc.configFile, loc.env);
  // アカウントの管理は DB だけを使う。プロキシの合言葉の環境変数がこのシェルになくても動くよう、合言葉は外して開く。
  const { proxySecretEnv: _e, proxySecretHeader: _h, ...authRest } = config.auth;
  void _e;
  void _h;
  return withRuntime(loc, io, { ...config, auth: authRest }, async (_rt, auth) =>
    opts.command === "user" ? cmdUser(auth, opts, io) : cmdMember(auth, config, opts, io),
  );
}
