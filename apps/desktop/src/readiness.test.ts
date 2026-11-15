import { describe, expect, it } from "vitest";
import { waitForReady } from "./readiness";

const ok = () => Promise.resolve(new Response("{}", { status: 200 }));

describe("waitForReady", () => {
  it("失敗を繰り返したあと成功すれば返る", async () => {
    let n = 0;
    const fetchImpl = (() => (++n < 3 ? Promise.reject(new Error("ECONNREFUSED")) : ok())) as typeof fetch;
    await waitForReady("http://x/", { fetchImpl, intervalMs: 5 });
    expect(n).toBe(3);
  });
  it("HTTP エラーは再試行し、時間切れで最後の原因を含めて投げる", async () => {
    const fetchImpl = (() => Promise.resolve(new Response("", { status: 503 }))) as typeof fetch;
    await expect(waitForReady("http://x/", { fetchImpl, intervalMs: 5, timeoutMs: 40 })).rejects.toThrow(/HTTP 503/);
  });
  it("shouldAbort が理由を返したらすぐ諦める", async () => {
    const fetchImpl = (() => Promise.reject(new Error("no"))) as typeof fetch;
    await expect(waitForReady("http://x/", { fetchImpl, shouldAbort: () => "終了コード 1" })).rejects.toThrow(/終了コード 1/);
  });
  it("okStatuses に入れたステータス（401 など）は起動済みとみなす", async () => {
    const f401 = (() => Promise.resolve(new Response("", { status: 401 }))) as typeof fetch;
    await waitForReady("http://x/", { fetchImpl: f401, okStatuses: [401], intervalMs: 5 });
    const f500 = (() => Promise.resolve(new Response("", { status: 500 }))) as typeof fetch;
    await expect(waitForReady("http://x/", { fetchImpl: f500, okStatuses: [401], intervalMs: 5, timeoutMs: 30 })).rejects.toThrow(/HTTP 500/);
  });
});
