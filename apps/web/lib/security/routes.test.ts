import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guard, ProjectOpenError, toErrorBody } from "@/lib/server/host";
import { resetSecuritySettingsCache } from "./server-settings";
import { POST as rpcPost } from "@/app/api/rpc/[method]/route";
import { GET as rendererGet } from "@/app/api/renderer/[id]/route";
import { GET as sessionGet } from "@/app/api/session/route";
import { POST as createPost } from "@/app/api/session/create/route";
import { POST as inspectPost } from "@/app/api/session/inspect/route";

/* ルートの入口（本文を読む前の確かめ）。ローカルモード。 */

const TOKEN = "route-token-0123456789abcdef";
const COOKIE = `loc_studio_local_3000=${TOKEN}`;

function req(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Request(url, { method: init.method ?? "GET", headers: { host: new URL(url).host, ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: init.body } : {}) });
}

beforeEach(() => {
  resetSecuritySettingsCache();
  vi.stubEnv("LOC_STUDIO_MODE", "local");
  vi.stubEnv("LOC_STUDIO_LOCAL_TOKEN", TOKEN);
  vi.stubEnv("LOC_STUDIO_BIND_HOST", "127.0.0.1");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetSecuritySettingsCache();
});

describe("ルートの入口", () => {
  it("合言葉のクッキー、Host、オリジンの順に確かめる", async () => {
    expect((await guard(req("http://localhost:3000/api/x", { method: "POST" }), "state")).ok).toBe(false);
    const noCookie = await guard(req("http://localhost:3000/api/x", { method: "POST" }), "state");
    expect(!noCookie.ok && noCookie.response.status).toBe(401);
    const badHost = await guard(req("http://evil.example:3000/api/x", { method: "POST", headers: { cookie: COOKIE } }), "state");
    expect(!badHost.ok && badHost.response.status).toBe(421);
    const evil = await guard(req("http://localhost:3000/api/x", { method: "POST", headers: { cookie: COOKIE, origin: "http://evil.example" } }), "state");
    expect(!evil.ok && evil.response.status).toBe(403);
    const crossSite = await guard(req("http://localhost:3000/api/x", { method: "POST", headers: { cookie: COOKIE, "sec-fetch-site": "cross-site" } }), "state");
    expect(!crossSite.ok && crossSite.response.status).toBe(403);
    expect((await guard(req("http://localhost:3000/api/x", { method: "POST", headers: { cookie: COOKIE, origin: "http://localhost:3000", "sec-fetch-site": "same-origin" } }), "state")).ok).toBe(true);
    // ブラウザ以外の道具（どちらのヘッダーもない）は、合言葉のクッキーがあれば通す
    expect((await guard(req("http://localhost:3000/api/x", { method: "POST", headers: { cookie: COOKIE } }), "state")).ok).toBe(true);
    // X-Forwarded-Host は信じない（trustedProxyHops は 0）
    const fwd = await guard(req("http://localhost:3000/api/x", { method: "POST", headers: { cookie: COOKIE, "x-forwarded-host": "evil.example", origin: "http://evil.example" } }), "state");
    expect(!fwd.ok && fwd.response.status).toBe(403);
  });

  it("独自描画のモジュールは同じオリジンからだけ（アドレス欄から直接開く none も断る）", async () => {
    const none = await guard(req("http://localhost:3000/api/renderer/x", { headers: { cookie: COOKIE, "sec-fetch-site": "none" } }), "module");
    expect(!none.ok && none.response.status).toBe(403);
    expect((await guard(req("http://localhost:3000/api/renderer/x", { headers: { cookie: COOKIE, "sec-fetch-site": "same-origin" } }), "module")).ok).toBe(true);
  });

  it("GET /api/renderer は、この起動で開いていないプロジェクトには 404 を返し、ワークスペースを開かない", async () => {
    const g = globalThis as unknown as Record<symbol, { runtime?: unknown } | undefined>;
    const before = g[Symbol.for("loc-studio.web.runtime")]?.runtime;
    const res = await rendererGet(req("http://localhost:3000/api/renderer/demo.bar?project=/tmp", { headers: { cookie: COOKIE, "sec-fetch-site": "same-origin" } }), {
      params: Promise.resolve({ id: "demo.bar" }),
    });
    expect(res.status).toBe(404);
    expect(g[Symbol.for("loc-studio.web.runtime")]?.runtime).toBe(before);
    const noCookie = await rendererGet(req("http://localhost:3000/api/renderer/demo.bar?project=/tmp"), { params: Promise.resolve({ id: "demo.bar" }) });
    expect(noCookie.status).toBe(401);
  });

  it("GET /api/session も合言葉が必要", async () => {
    expect((await sessionGet(req("http://localhost:3000/api/session"))).status).toBe(401);
  });

  it("プロジェクトの作成とフォルダの確認も、合言葉と同じオリジンが必要（本文を読む前に断り、サービス層に触らない）", async () => {
    const g = globalThis as unknown as Record<symbol, { runtime?: unknown } | undefined>;
    const before = g[Symbol.for("loc-studio.web.runtime")]?.runtime;
    const body = JSON.stringify({ root: "/should/not/be/created", name: "X", languages: [{ id: "ja" }], path: "/should/not/be/read" });
    const json = { "content-type": "application/json" };
    for (const [name, post] of [
      ["create", createPost],
      ["inspect", inspectPost],
    ] as const) {
      const url = `http://localhost:3000/api/session/${name}`;
      expect((await post(req(url, { method: "POST", headers: json, body }))).status, `${name}: 合言葉なし`).toBe(401);
      expect((await post(req(url, { method: "POST", headers: { ...json, cookie: COOKIE, origin: "http://evil.example" }, body }))).status, `${name}: ほかのオリジン`).toBe(403);
      expect((await post(req(url, { method: "POST", headers: { ...json, cookie: COOKIE, "sec-fetch-site": "cross-site" }, body }))).status, `${name}: ほかのサイト`).toBe(403);
      expect((await post(req(url, { method: "POST", headers: { cookie: COOKIE, "content-type": "text/plain" }, body }))).status, `${name}: JSON 以外`).toBe(415);
    }
    expect(g[Symbol.for("loc-studio.web.runtime")]?.runtime).toBe(before);
  });

  it("Web モードでは、ログインしていなければ 401（プロジェクトの作成とフォルダの確認）", async () => {
    vi.stubEnv("LOC_STUDIO_MODE", "web");
    resetSecuritySettingsCache();
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    // サーバーの設定がない状態では、認証の確かめの時点で断る（401 か、設定の誤りの 500）。どちらでも、作成には進まない。
    const created = await createPost(req("http://localhost:3000/api/session/create", init));
    const inspected = await inspectPost(req("http://localhost:3000/api/session/inspect", init));
    expect([401, 500]).toContain(created.status);
    expect([401, 500]).toContain(inspected.status);
  });

  it("RPC: 知らないメソッドは 404、JSON 以外は 415、大きすぎる本文は 413（どれもワークスペースに触らない）", async () => {
    const h = { cookie: COOKIE, "content-type": "application/json" };
    const unknown = await rpcPost(req("http://localhost:3000/api/rpc/nope", { method: "POST", headers: h, body: "{}" }), { params: Promise.resolve({ method: "nope" }) });
    expect(unknown.status).toBe(404);
    const text = await rpcPost(req("http://localhost:3000/api/rpc/info", { method: "POST", headers: { cookie: COOKIE, "content-type": "text/plain" }, body: "{}" }), {
      params: Promise.resolve({ method: "info" }),
    });
    expect(text.status).toBe(415);
    const big = await rpcPost(req("http://localhost:3000/api/rpc/rows", { method: "POST", headers: h, body: JSON.stringify({ params: { x: "a".repeat(1024 * 1024 + 10) } }) }), {
      params: Promise.resolve({ method: "rows" }),
    });
    expect(big.status).toBe(413);
    const noAuth = await rpcPost(req("http://localhost:3000/api/rpc/info", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ method: "info" }) });
    expect(noAuth.status).toBe(401);
  });
});

describe("エラーの文面", () => {
  it("Web モードでは、原因つきの失敗（サーバーを起動できない、など）は参照番号だけにする。ローカルモードはそのまま", () => {
    const cause = new Error("ENOENT: no such file or directory, open '/srv/secret/projects/game/loc-studio.project.json'");
    const err = new ProjectOpenError(`サーバーを起動できませんでした: ${cause.message}`, { cause });
    expect(toErrorBody(err).message).toContain("/srv/secret");
    vi.stubEnv("LOC_STUDIO_MODE", "web");
    const body = toErrorBody(err);
    expect(body.code).toBe("failed");
    expect(body.message).toMatch(/^サーバーで問題が起きました（参照番号 [0-9A-Z]+）。$/);
    expect(JSON.stringify(body)).not.toContain("/srv/secret");
    // 原因のない案内（パスを含まない）はそのまま
    expect(toErrorBody(new ProjectOpenError("プロジェクトを選んでください。"))).toEqual({ code: "not-found", message: "プロジェクトを選んでください。" });
  });
});
