import { stat } from "node:fs/promises";
import path from "node:path";
import type { AuthUser, ServerRuntime } from "@loc-studio/server";
import { loadCore, loadServer } from "./runtime";
import { INTERNAL_HEADER, REMOTE_HEADER } from "@/lib/security/client-address";
import { effectiveHost, hostAllowed, isLoopbackBind, parseHost } from "@/lib/security/hosts";
import { parseMode, type Mode } from "@/lib/security/mode";
import { checkSameOrigin } from "@/lib/security/origin";
import { securitySettings } from "@/lib/security/server-settings";
import { constantTimeEqual, localCookieName, parseCookies, tokenSetting } from "@/lib/security/token";

/*
 * サーバー側の入口。サービス層の openServerRuntime を 1 つだけ開き（Next の開発サーバーの読み直しに備えて globalThis に置く）、
 * モード（local / web）、プロジェクトの指定、ログイン中の利用者を解決する。
 * - local: 認証なし。プロジェクトはフォルダの絶対パス（任意のフォルダを開ける）。プラグインは信頼の確認つき（pluginTrust: "prompt"）。
 * - web: 認証あり。プロジェクトはサーバーの設定（server.json）の id。
 */

export type { Mode } from "@/lib/security/mode";

const GLOBAL_KEY = Symbol.for("loc-studio.web.runtime");
type Holder = { runtime?: Promise<ServerRuntime>; opened: Set<string> };

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  let h = g[GLOBAL_KEY];
  if (!h) {
    h = { opened: new Set() };
    g[GLOBAL_KEY] = h;
  }
  return h;
}

/** モード。誤った値は例外（呼び出し側は 500。認証のないローカルモードには落とさない）。 */
export function currentMode(): Mode {
  return parseMode(process.env["LOC_STUDIO_MODE"]);
}

/** この起動で、同じオリジンの POST（RPC / 開く）で開いたプロジェクト。独自描画のモジュールはここに入っているものだけ返す。 */
export function markOpened(projectId: string): void {
  holder().opened.add(projectId);
}
export function isOpened(projectId: string): boolean {
  return holder().opened.has(projectId);
}

const env = () => process.env as Record<string, string | undefined>;

/** 既定のプロジェクト（ローカルモード）。 */
export function defaultProjectRoot(): string | undefined {
  const value = process.env["LOC_STUDIO_PROJECT"];
  return value ? path.resolve(value) : undefined;
}

export function userDataDir(): string | undefined {
  const value = process.env["LOC_STUDIO_USER_DATA_DIR"];
  return value ? path.resolve(value) : undefined;
}

/** ローカル設定やサーバーの設定の既定の置き場所。 */
export async function dataDir(): Promise<string> {
  const explicit = userDataDir();
  if (explicit) return explicit;
  const { localSettingsPath } = await loadCore();
  return path.dirname(localSettingsPath(env()));
}

export class ProjectOpenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProjectOpenError";
  }
}

export function getRuntime(): Promise<ServerRuntime> {
  const h = holder();
  if (!h.runtime) {
    const opening = (async () => {
      const { openServerRuntime } = await loadServer();
      const appDir = process.env["LOC_STUDIO_APP_DIR"];
      try {
        // ローカルモードでは pluginTrust を渡さない（既定の "prompt"）。"always" にはしない。
        return await openServerRuntime({
          mode: currentMode(),
          dataDir: await dataDir(),
          env: env(),
          ...(appDir ? { appDir: path.resolve(appDir) } : {}),
        });
      } catch (err) {
        throw new ProjectOpenError(`サーバーを起動できませんでした: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
    })();
    h.runtime = opening;
    opening.catch(() => {
      if (h.runtime === opening) h.runtime = undefined;
    });
  }
  return h.runtime;
}

/**
 * 要求のプロジェクトを、runtime の projectId にする。
 * local: フォルダの絶対パス（省略時は LOC_STUDIO_PROJECT）。web: サーバーの設定の id（そのまま）。
 */
export async function resolveProjectId(project: string | undefined): Promise<string> {
  if (currentMode() === "web") {
    if (!project) throw new ProjectOpenError("プロジェクトを選んでください。");
    return project;
  }
  const root = project && project.trim() !== "" ? path.resolve(project.trim()) : defaultProjectRoot();
  if (!root) throw new ProjectOpenError("プロジェクトが指定されていません。プロジェクトのフォルダを開いてください。");
  let info;
  try {
    info = await stat(root);
  } catch (err) {
    throw new ProjectOpenError(`プロジェクトのフォルダが見つかりません: ${root}`, { cause: err });
  }
  if (!info.isDirectory()) throw new ProjectOpenError(`フォルダではありません: ${root}`);
  return root;
}

// ---------------------------------------------------------------------------
// セッション（web モード）と要求の確かめ
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = "loc_studio_session";

export function sessionToken(request: Request): string | undefined {
  const t = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  return t && t !== "" ? t : undefined;
}

function hops(): number {
  try {
    return securitySettings().trustedProxyHops;
  } catch {
    return 0;
  }
}

/** HTTPS で来た要求か。X-Forwarded-Proto は前段のプロキシを信じる設定（trustedProxyHops > 0）のときだけ見る。 */
export function isHttps(request: Request): boolean {
  if (hops() > 0) {
    const proto = request.headers.get("x-forwarded-proto");
    if (proto) return proto.split(",")[0]!.trim().toLowerCase() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * セッションのクッキー。HttpOnly、SameSite=Lax（ほかのサイトのリンクから開いたときもログインのままにするため。
 * 状態を変える要求は Origin / Sec-Fetch-Site で別に確かめるので、Lax でも別のサイトからは使えない）。
 * Max-Age はセッションの期限（auth.sessionMaxHours を超えない）。
 */
export function sessionCookie(request: Request, token: string, expiresAt: string, maxHours: number): string {
  const untilExpiry = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
  const maxAge = Math.max(0, Math.min(untilExpiry, Math.floor(maxHours * 3600)));
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (isHttps(request)) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(request: Request): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isHttps(request)) parts.push("Secure");
  return parts.join("; ");
}

/** 接続元のアドレス（ログインの総当たり対策）。接続そのもののアドレスは起動の仕組みが合言葉つきのヘッダーで渡す。 */
export async function clientAddressOf(request: Request): Promise<string> {
  const { clientAddressFrom } = await loadServer();
  const secret = process.env["LOC_STUDIO_INTERNAL_SECRET"];
  const given = request.headers.get(INTERNAL_HEADER);
  const remote = secret && given && constantTimeEqual(given, secret) ? (request.headers.get(REMOTE_HEADER) ?? undefined) : undefined;
  // X-Forwarded-For は、サービス層の規則（trustedProxyHops > 0 のときだけ信じる）にそのまま渡す
  const forwardedFor = request.headers.get("x-forwarded-for") ?? undefined;
  return clientAddressFrom({ ...(remote ? { remoteAddress: remote } : {}), ...(forwardedFor ? { forwardedFor } : {}) }, hops());
}

/**
 * 要求の利用者（web モード）。password モードはクッキーのセッション、proxy モードは設定のヘッダー（と合言葉のヘッダー）。
 * password モードではプロキシのヘッダーを見ない（ブラウザから偽装されないように）。ローカルモードでは undefined。
 */
export async function currentUser(request: Request): Promise<AuthUser | undefined> {
  if (currentMode() !== "web") return undefined;
  const runtime = await getRuntime();
  const auth = runtime.auth;
  if (!auth) return undefined;
  if (auth.config.mode === "proxy") {
    const name = request.headers.get(auth.config.proxyHeader);
    if (!name) return undefined;
    const secretHeader = auth.config.proxySecretHeader;
    const secret = secretHeader ? (request.headers.get(secretHeader) ?? undefined) : undefined;
    return auth.authenticateProxyUser(name.trim(), secret !== undefined ? { secret } : {});
  }
  const token = sessionToken(request);
  return token ? auth.authenticate(token) : undefined;
}

/** ローカルモードの起動の合言葉のクッキーが正しいか（Proxy でも確かめるが、ルートでもう一度確かめる）。 */
export function localAuthenticated(request: Request): boolean {
  const env = process.env as Record<string, string | undefined>;
  const setting = tokenSetting(env);
  if (setting.kind === "off") return isLoopbackBind(env["LOC_STUDIO_BIND_HOST"] ?? "");
  if (setting.kind !== "token") return false;
  const host = effectiveHost(request.headers, hops());
  const cookie = parseCookies(request.headers.get("cookie"))[localCookieName(parseHost(host)?.port)];
  return cookie !== undefined && constantTimeEqual(cookie, setting.token);
}

export type GuardKind = "state" | "read" | "module";
export type Guarded = { ok: true; web: boolean; user?: AuthUser } | { ok: false; response: Response };

/**
 * ルートの最初に呼ぶ。本文を読む前に: 設定とモード → Host → 認証（ローカルは起動の合言葉、Web はセッション）→ オリジンの順に確かめる。
 * anonymous: ログインのように、認証の前に受ける要求。
 */
export async function guard(request: Request, kind: GuardKind, opts: { anonymous?: boolean } = {}): Promise<Guarded> {
  let s;
  try {
    s = securitySettings();
  } catch (err) {
    console.error(`[loc-studio] 要求を受け付けません: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, response: errorResponse({ code: "failed", message: "サーバーの設定に問題があるため動いていません。" }, 500) };
  }
  const host = effectiveHost(request.headers, s.trustedProxyHops);
  if (!hostAllowed(host, { extra: s.allowedHosts })) {
    return { ok: false, response: new Response("許可されていないホスト名です。", { status: 421, headers: { "Content-Type": "text/plain; charset=utf-8" } }) };
  }
  const web = s.mode === "web";
  let user: AuthUser | undefined;
  let authenticated = false;
  if (!web) {
    authenticated = localAuthenticated(request);
    if (!authenticated) return { ok: false, response: errorResponse({ code: "unauthorized", message: "起動したときに表示された URL（?token= 付き）から開き直してください。" }) };
  } else if (!opts.anonymous) {
    try {
      user = await currentUser(request);
    } catch (err) {
      return { ok: false, response: errorResponse(toErrorBody(err)) };
    }
    authenticated = user !== undefined;
    // 認証のない要求は、オリジンにかかわらず 401（状態は何も変えられない）
    if (!user) return { ok: false, response: errorResponse({ code: "unauthorized", message: "ログインしてください。" }) };
  }
  const verdict = checkSameOrigin({
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    host,
    authenticated,
    ...(opts.anonymous ? { allowAnonymous: true } : {}),
  });
  if (!verdict.ok) return { ok: false, response: errorResponse({ code: "forbidden", message: "ほかのサイトからの要求は受け付けません。" }, 403) };
  if (web && !opts.anonymous && !user) return { ok: false, response: errorResponse({ code: "unauthorized", message: "ログインしてください。" }) };
  return user ? { ok: true, web, user } : { ok: true, web };
}

/** サービス層のエラーの code → HTTP の状態。 */
export function statusFor(code: string | undefined): number {
  switch (code) {
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not-found":
      return 404;
    case "throttled":
      return 429;
    case "conflict":
    case "blocked":
    case "untrusted":
      return 409;
    case "invalid":
      return 400;
    case "locked":
      return 423;
    default:
      return 500;
  }
}

/** { error } の応答。throttled には Retry-After（秒、切り上げ）を付ける。 */
export function errorResponse(error: { code: string; message: string; data?: unknown }, status = statusFor(error.code)): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  const retry = (error.data as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  if (error.code === "throttled" && typeof retry === "number") headers["Retry-After"] = String(Math.max(1, Math.ceil(retry / 1000)));
  return Response.json({ error }, { status, headers });
}

/**
 * 例外を応答の形にする。サービス層の ApiError（利用者に見せる文言）とプロジェクトを開けない理由はそのまま、
 * それ以外（このルートのコードの失敗など）は一般的な文言と参照番号だけにして、詳細はサーバーのログに残す。
 */
export function toErrorBody(err: unknown): { code: string; message: string; data?: unknown } {
  if (err instanceof Error && err.name === "ApiError" && typeof (err as { code?: unknown }).code === "string") {
    const e = err as Error & { code: string; data?: unknown };
    return { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) };
  }
  // Web モードでは、原因つきの失敗（サーバーを起動できない、など）の文面にサーバーのパスや DB のエラーが入りうる。
  // ログインの前でも届く応答なので、参照番号だけを返して詳細はログに残す。ローカルモードは、起動した本人だけが見るのでそのまま返す。
  if (err instanceof ProjectOpenError && !(currentMode() === "web" && err.cause !== undefined)) return { code: "not-found", message: err.message };
  const ref = Math.random().toString(36).slice(2, 10).toUpperCase();
  console.error(`[loc-studio] 内部のエラー（参照番号 ${ref}）:`, err);
  return { code: "failed", message: `サーバーで問題が起きました（参照番号 ${ref}）。` };
}
