import { afterEach, describe, expect, it, vi } from "vitest";
import { readJsonBody, rpcLimit, LIMITS } from "./body";
import { clientAddressFrom } from "@loc-studio/server";
import { effectiveHost, hostAllowed, isLoopbackBind, parseHost, parseHostList } from "./hosts";
import { parseMode } from "./mode";
import { checkSameOrigin } from "./origin";
import { constantTimeEqual, localCookieName, tokenSetting } from "./token";
import { safeHttpUrl } from "@/lib/client/url";

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

describe("Host の許可リスト", () => {
  it("ループバックの名前はどのポートでも通し、ほかは許可リストにあるものだけ", () => {
    for (const h of ["localhost", "localhost:3000", "127.0.0.1:9", "[::1]:3000", "LOCALHOST:1"]) expect(hostAllowed(h, { extra: [] })).toBe(true);
    for (const h of ["evil.example", "evil.example:3000", "127.0.0.1.evil.example", "localhost.evil.example", "", "a b", "user@localhost", null]) {
      expect(hostAllowed(h, { extra: [] })).toBe(false);
    }
    // ループバックは localhost、127.0.0.0/8 の数字、[::1] だけ。*.localhost、末尾の点、範囲外の数字は通さない
    for (const h of ["127.1.2.3:80", "127.255.255.255"]) expect(hostAllowed(h, { extra: [] })).toBe(true);
    for (const h of ["app.localhost", "evil.localhost:3000", "localhost.", "localhost.:3000", "127.0.0.1.", "127.0.0.256", "127.1", "0.0.0.0", "[::]", "[::ffff:127.0.0.1]", "localhost:3000:1", "localhost/x", "localhost#x"]) {
      expect(hostAllowed(h, { extra: [] })).toBe(false);
    }
    expect(hostAllowed("loc.example.com:443", { extra: parseHostList("loc.example.com, other.example") })).toBe(true);
    expect(hostAllowed("evil.example", { extra: parseHostList("loc.example.com") })).toBe(false);
    expect(parseHost("Example.COM:8080")).toEqual({ hostname: "example.com", port: "8080" });
  });

  it("X-Forwarded-Host は trustedProxyHops > 0 のときだけ使う", () => {
    const h = headers({ host: "localhost:3000", "x-forwarded-host": "evil.example" });
    expect(effectiveHost(h, 0)).toBe("localhost:3000");
    expect(effectiveHost(h, 1)).toBe("evil.example");
  });

  it("バインドのアドレスのループバックの判定（0.0.0.0 は違う）", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("localhost")).toBe(true);
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("192.168.1.2")).toBe(false);
    expect(isLoopbackBind("")).toBe(false);
  });
});

describe("同じオリジンの判定（Origin / Sec-Fetch-Site）", () => {
  const base = { host: "localhost:3000", authenticated: false };
  it("Sec-Fetch-Site が same-origin 以外なら、認証があっても断る", () => {
    for (const site of ["cross-site", "same-site", "none"]) expect(checkSameOrigin({ ...base, authenticated: true, origin: null, secFetchSite: site }).ok).toBe(false);
    expect(checkSameOrigin({ ...base, origin: null, secFetchSite: "same-origin" }).ok).toBe(true);
  });
  it("Origin があれば、確かめた Host と同じであること", () => {
    expect(checkSameOrigin({ ...base, origin: "http://localhost:3000", secFetchSite: null }).ok).toBe(true);
    expect(checkSameOrigin({ ...base, origin: "http://evil.example", secFetchSite: null, authenticated: true }).ok).toBe(false);
    expect(checkSameOrigin({ ...base, origin: "null", secFetchSite: null, authenticated: true }).ok).toBe(false);
    expect(checkSameOrigin({ ...base, origin: "http://localhost:3001", secFetchSite: "same-origin" }).ok).toBe(false);
  });
  it("どちらのヘッダーもない（ブラウザ以外の道具）ときは、認証のクッキーがあるか、ログインのときだけ通す", () => {
    expect(checkSameOrigin({ ...base, origin: null, secFetchSite: null }).ok).toBe(false);
    expect(checkSameOrigin({ ...base, origin: null, secFetchSite: null, authenticated: true }).ok).toBe(true);
    expect(checkSameOrigin({ ...base, origin: null, secFetchSite: null, allowAnonymous: true }).ok).toBe(true);
  });
});

describe("起動の合言葉", () => {
  it("一定時間で比べる（長さが違っても例外にならない）", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });
  it("設定の読み方とクッキーの名前（ポートごと）", () => {
    expect(tokenSetting({})).toEqual({ kind: "missing" });
    expect(tokenSetting({ LOC_STUDIO_LOCAL_TOKEN: "off" })).toEqual({ kind: "off" });
    expect(tokenSetting({ LOC_STUDIO_LOCAL_TOKEN: "t" })).toEqual({ kind: "token", token: "t" });
    expect(localCookieName("3000")).toBe("loc_studio_local_3000");
    expect(localCookieName(undefined)).toBe("loc_studio_local_default");
    expect(localCookieName("x;y")).toBe("loc_studio_local_default");
  });
});

describe("本文の上限", () => {
  const req = (body: BodyInit | null, h: Record<string, string>) => new Request("http://localhost/api/x", { method: "POST", body, headers: h, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
  it("JSON 以外は 415、壊れた JSON は 400、正しければ値", async () => {
    expect(await readJsonBody(req("{}", { "content-type": "text/plain" }), 100)).toMatchObject({ ok: false, status: 415 });
    expect(await readJsonBody(req("{", { "content-type": "application/json" }), 100)).toMatchObject({ ok: false, status: 400 });
    expect(await readJsonBody(req("[1]", { "content-type": "application/json" }), 100)).toMatchObject({ ok: false, status: 400 });
    expect(await readJsonBody(req('{"a":1}', { "content-type": "application/json; charset=utf-8" }), 100)).toEqual({ ok: true, value: { a: 1 } });
  });
  it("Content-Length が上限を超えたら読まずに 413", async () => {
    expect(await readJsonBody(req('{"a":1}', { "content-type": "application/json", "content-length": "5000" }), 100)).toMatchObject({ ok: false, status: 413 });
  });
  it("長さを言わない本文も、上限を超えたところで読むのをやめて 413", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 1000) return c.close();
        c.enqueue(new Uint8Array(64).fill(32));
      },
    });
    expect(await readJsonBody(req(stream, { "content-type": "application/json" }), 1000)).toMatchObject({ ok: false, status: 413 });
    expect(pulled).toBeLessThan(40); // 全部は読まない
  });
  it("本文を運ぶメソッドだけ上限が大きい", () => {
    expect(rpcLimit("setText")).toBe(LIMITS.rpcText);
    expect(rpcLimit("setCells")).toBe(LIMITS.rpcText);
    expect(rpcLimit("updateProjectSettings")).toBe(LIMITS.rpcText);
    expect(rpcLimit("rows")).toBe(LIMITS.rpc);
  });
});

describe("モード", () => {
  it("local（または未設定）と web だけ。ほかは例外（ローカルモードに落とさない）", () => {
    expect(parseMode(undefined)).toBe("local");
    expect(parseMode("")).toBe("local");
    expect(parseMode("local")).toBe("local");
    expect(parseMode("web")).toBe("web");
    for (const v of ["Web", "WEB", "webb", "remote", " web"]) expect(() => parseMode(v)).toThrow(/LOC_STUDIO_MODE/);
  });
});

describe("URL の形式", () => {
  it("http / https で正しく読めるものだけ", () => {
    expect(safeHttpUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "JAVASCRIPT:alert(1)", "ftp://x", "//evil.example", "https://", "file:///etc/passwd", " ", 42]) {
      expect(safeHttpUrl(bad)).toBeUndefined();
    }
  });
});

describe("接続元のアドレス（サービス層の clientAddressFrom を使う）", () => {
  it("trustedProxyHops が 0 なら X-Forwarded-For を信じない", () => {
    expect(clientAddressFrom({ remoteAddress: "10.0.0.1", forwardedFor: "1.2.3.4" }, 0)).toBe("10.0.0.1");
    expect(clientAddressFrom({ remoteAddress: "10.0.0.1", forwardedFor: "6.6.6.6, 1.2.3.4" }, 1)).toBe("1.2.3.4");
    expect(clientAddressFrom({}, 0)).toBe("unknown");
  });
});

afterEach(() => vi.unstubAllEnvs());
