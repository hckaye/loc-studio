import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { resetSecuritySettingsCache } from "./server-settings";

/* Proxy（すべての要求の入口）: Host、モード、起動の合言葉、守りのヘッダー。 */

const TOKEN = "test-token-0123456789abcdef";

function req(url: string, h: Record<string, string> = {}) {
  return new NextRequest(url, { headers: { host: new URL(url).host, ...h } });
}

beforeEach(() => {
  resetSecuritySettingsCache();
  vi.stubEnv("LOC_STUDIO_MODE", "local");
  vi.stubEnv("LOC_STUDIO_LOCAL_TOKEN", TOKEN);
  vi.stubEnv("LOC_STUDIO_BIND_HOST", "127.0.0.1");
  vi.stubEnv("LOC_STUDIO_ALLOWED_HOSTS", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetSecuritySettingsCache();
});

describe("Proxy", () => {
  it("許可していない Host は 421（DNS リバインディング）", async () => {
    const res = proxy(req("http://evil.example:3000/api/session"));
    expect(res.status).toBe(421);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("LOC_STUDIO_ALLOWED_HOSTS の名前は通す", () => {
    vi.stubEnv("LOC_STUDIO_ALLOWED_HOSTS", "studio.lan");
    resetSecuritySettingsCache();
    const res = proxy(req(`http://studio.lan:3000/?token=${TOKEN}`));
    expect(res.status).toBe(303);
  });

  it("誤ったモードはすべての要求に 500（認証のないローカルモードに落とさない）", async () => {
    vi.stubEnv("LOC_STUDIO_MODE", "webb");
    resetSecuritySettingsCache();
    const res = proxy(req("http://localhost:3000/"));
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("動いていません");
  });

  it("Web モードで設定ファイルが読めなければ 500", () => {
    vi.stubEnv("LOC_STUDIO_MODE", "web");
    vi.stubEnv("LOC_STUDIO_SERVER_CONFIG", "/nonexistent/server.json");
    resetSecuritySettingsCache();
    expect(proxy(req("http://localhost:3000/")).status).toBe(500);
  });

  it("ローカルモードで合言葉が設定されていなければ 500", () => {
    vi.stubEnv("LOC_STUDIO_LOCAL_TOKEN", "");
    expect(proxy(req("http://localhost:3000/")).status).toBe(500);
  });

  it("?token= を一度だけ HttpOnly・SameSite=Strict のクッキーに換え、URL から消す", () => {
    const res = proxy(req(`http://127.0.0.1:4100/?token=${encodeURIComponent(TOKEN)}&project=x`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):4100\/\?project=x$/);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^loc_studio_local_4100=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(proxy(req("http://127.0.0.1:4100/?token=wrong")).status).toBe(401);
  });

  it("クッキーがなければ API は 401、ページは開き方の案内（401）。静的ファイルは通す", async () => {
    const api = proxy(req("http://localhost:3000/api/renderer/x?project=/tmp"));
    expect(api.status).toBe(401);
    const page = proxy(req("http://localhost:3000/"));
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("?token=");
    expect(proxy(req("http://localhost:3000/_next/static/chunks/a.js")).status).toBe(200);
    // 別のポートのクッキーでは通らない
    expect(proxy(req("http://localhost:3000/api/session", { cookie: `loc_studio_local_3001=${TOKEN}` })).status).toBe(401);
  });

  it("正しいクッキーなら通し、ページには nonce つきの CSP と守りのヘッダーを付ける", () => {
    const res = proxy(req("http://localhost:3000/", { cookie: `loc_studio_local_3000=${TOKEN}` }));
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toMatch(/default-src 'self'/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const api = proxy(req("http://localhost:3000/api/session", { cookie: `loc_studio_local_3000=${TOKEN}` }));
    expect(api.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
  });

  it("LOC_STUDIO_LOCAL_TOKEN=off はループバックにバインドしたときだけ", () => {
    vi.stubEnv("LOC_STUDIO_LOCAL_TOKEN", "off");
    expect(proxy(req("http://localhost:3000/api/session")).status).toBe(200);
    vi.stubEnv("LOC_STUDIO_BIND_HOST", "0.0.0.0");
    expect(proxy(req("http://localhost:3000/api/session")).status).toBe(500);
  });
});
