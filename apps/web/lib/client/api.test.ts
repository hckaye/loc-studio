import { describe, expect, it, vi } from "vitest";
import { callRpc, createApi, isRpcError, RpcError } from "./api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("RPC クライアント", () => {
  it("POST /api/rpc/<method> に { project, params } を送り、result を返す", async () => {
    const fetch = vi.fn(async () => jsonResponse({ result: { name: "x" } }));
    const api = createApi({ project: "/p", fetch });
    await expect(api.info()).resolves.toEqual({ name: "x" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/rpc/info");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ project: "/p", params: {} });
  });

  it("{ error } をコード・メッセージ・data を持つ RpcError にする", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { code: "conflict", message: "ほかの人が先に変更しました", data: { current: { value: "done", version: 4 } } } }));
    const api = createApi({ fetch });
    const err = await api.setCell({ resourceId: "r", key: "k", cellId: "c", value: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(isRpcError(err, "conflict")).toBe(true);
    const e = err as RpcError;
    expect(e.message).toBe("ほかの人が先に変更しました");
    expect(e.data).toEqual({ current: { value: "done", version: 4 } });
    expect(e.method).toBe("setCell");
  });

  it("HTTP 400 の { error } もサーバーのメッセージを使う", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { code: "invalid", message: "本文が JSON ではありません" } }, 400));
    await expect(callRpc("info", {}, { fetch })).rejects.toMatchObject({ code: "invalid", message: "本文が JSON ではありません" });
  });

  it("403（ほかのオリジン）は forbidden", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { code: "forbidden", message: "拒否" } }, 403));
    await expect(callRpc("info", {}, { fetch })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("接続できないときは network", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(callRpc("tree", {}, { fetch })).rejects.toMatchObject({ code: "network" });
  });

  it("JSON でない応答や形の違う応答は bad-response", async () => {
    const html = vi.fn(async () => new Response("<html>", { status: 500 }));
    await expect(callRpc("tree", {}, { fetch: html })).rejects.toMatchObject({ code: "bad-response" });
    const odd = vi.fn(async () => jsonResponse({ foo: 1 }));
    await expect(callRpc("tree", {}, { fetch: odd })).rejects.toMatchObject({ code: "bad-response" });
  });

  it("result が null でも成功として返す", async () => {
    const fetch = vi.fn(async () => jsonResponse({ result: null }));
    await expect(callRpc("reloadResource", { resourceId: "r" }, { fetch })).resolves.toBeNull();
  });
});
