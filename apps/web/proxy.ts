import { NextResponse, type NextRequest } from "next/server";
import { apiCsp, baseSecurityHeaders, pageCsp } from "@/lib/security/headers";
import { effectiveHost, hostAllowed, isLoopbackBind, parseHost } from "@/lib/security/hosts";
import { localTokenPage, misconfiguredPage } from "@/lib/security/pages";
import { securitySettings } from "@/lib/security/server-settings";
import { constantTimeEqual, localCookieName, parseCookies, TOKEN_PARAM, tokenSetting } from "@/lib/security/token";

/*
 * すべての要求の入口（Next の Proxy。Node.js で動く）。ほかの処理の前に:
 * 1. モードと Web モードの設定を確かめる（誤りなら 500。認証のないローカルモードには落とさない）。
 * 2. Host を許可リストで確かめる（DNS リバインディング対策。違えば 421）。
 * 3. ローカルモードでは、起動ごとの合言葉のクッキーを確かめる（?token= を一度だけクッキーに換え、URL から消す）。
 * 4. 守りのヘッダー（CSP、X-Frame-Options など）を付ける。ページには nonce つきの CSP。
 */

let reportedMisconfig = false;

function withHeaders(res: Response | NextResponse, csp: string): Response {
  for (const [k, v] of Object.entries(baseSecurityHeaders())) res.headers.set(k, v);
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

function text(status: number, body: string, contentType = "text/plain; charset=utf-8"): Response {
  return withHeaders(new Response(body, { status, headers: { "Content-Type": contentType, "Cache-Control": "no-store" } }), apiCsp());
}

function jsonError(status: number, code: string, message: string): Response {
  return withHeaders(Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } }), apiCsp());
}

const isApi = (p: string) => p.startsWith("/api/");
const isPublicAsset = (p: string) => p.startsWith("/_next/static/") || p === "/favicon.ico";

export function proxy(request: NextRequest): Response {
  const env = process.env as Record<string, string | undefined>;
  let s;
  try {
    s = securitySettings(env);
  } catch (err) {
    if (!reportedMisconfig) {
      reportedMisconfig = true;
      console.error(`[loc-studio] 要求を受け付けません: ${err instanceof Error ? err.message : String(err)}`);
    }
    return text(500, misconfiguredPage(), "text/html; charset=utf-8");
  }

  const host = effectiveHost(request.headers, s.trustedProxyHops);
  if (!hostAllowed(host, { extra: s.allowedHosts })) {
    return text(421, "許可されていないホスト名です（Misdirected Request）。");
  }
  const path = request.nextUrl.pathname;

  if (s.mode === "local") {
    const setting = tokenSetting(env);
    if (setting.kind === "missing") {
      if (!reportedMisconfig) {
        reportedMisconfig = true;
        console.error("[loc-studio] LOC_STUDIO_LOCAL_TOKEN がありません。npm run start:web（scripts/launch.mjs）で起動してください。");
      }
      return text(500, misconfiguredPage(), "text/html; charset=utf-8");
    }
    if (setting.kind === "off" && !isLoopbackBind(env["LOC_STUDIO_BIND_HOST"] ?? "")) {
      return text(500, misconfiguredPage(), "text/html; charset=utf-8");
    }
    if (setting.kind === "token") {
      const port = parseHost(host)?.port;
      const cookieName = localCookieName(port);
      const given = request.nextUrl.searchParams.get(TOKEN_PARAM);
      if (given !== null && request.method === "GET" && !isApi(path)) {
        if (!constantTimeEqual(given, setting.token)) return text(401, localTokenPage(), "text/html; charset=utf-8");
        // 合言葉をクッキーに換え、アドレス欄から消す
        // （Next の Proxy は Location に絶対 URL を求める。Host は上で許可リストと照らした値）
        const url = request.nextUrl.clone();
        url.searchParams.delete(TOKEN_PARAM);
        const res = NextResponse.redirect(url, 303);
        res.headers.set("Cache-Control", "no-store");
        res.headers.set("Set-Cookie", `${cookieName}=${encodeURIComponent(setting.token)}; Path=/; HttpOnly; SameSite=Strict`);
        return withHeaders(res, apiCsp());
      }
      const cookie = parseCookies(request.headers.get("cookie"))[cookieName];
      const ok = cookie !== undefined && constantTimeEqual(cookie, setting.token);
      if (!ok && !isPublicAsset(path)) {
        if (isApi(path)) return jsonError(401, "unauthorized", "起動したときに表示された URL（?token= 付き）から開き直してください。");
        return text(401, localTokenPage(), "text/html; charset=utf-8");
      }
    }
  }

  if (isApi(path) || isPublicAsset(path)) return withHeaders(NextResponse.next(), apiCsp());

  // ページ: 要求ごとの nonce つきの CSP（Next が自分のスクリプトに nonce を付ける）
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = pageCsp(nonce, process.env.NODE_ENV === "development");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  return withHeaders(res, csp);
}

export const config = {
  matcher: "/:path*",
};
