/**
 * 画面の状態の保存（uiState / setUiState）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallContext, Workspace } from "./api-types.js";
import { dispatch } from "./rpc.js";
import { makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

let tp: TestProject;
let ws: Workspace;
beforeEach(async () => {
  tp = await makeTestProject();
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

const STATE = { resourceId: UI, filters: { where: "text@ko is empty" }, sort: { cellId: "key", dir: "desc" }, scroll: { top: 1200 } };

describe("uiState / setUiState", () => {
  it("保存したことがなければ null。保存した状態は、そのまま返る", async () => {
    expect(await ws.uiState()).toEqual({ state: null });
    expect(await ws.setUiState({ state: STATE })).toEqual({ saved: true });
    expect(await ws.uiState()).toEqual({ state: STATE });
  });

  it("ワークスペースを開き直しても残っている（アプリを起動し直したときに復元できる）", async () => {
    await ws.setUiState({ state: STATE });
    await ws.close();
    const reopened = await tp.open();
    expect(await reopened.uiState()).toEqual({ state: STATE });
  });

  it("null で消せる", async () => {
    await ws.setUiState({ state: STATE });
    await ws.setUiState({ state: null });
    expect(await ws.uiState()).toEqual({ state: null });
  });

  it("オブジェクトでない値と、大きすぎる状態は invalid で断り、前の状態を変えない", async () => {
    await ws.setUiState({ state: STATE });
    await expect(ws.setUiState({ state: [1, 2] as never })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.setUiState({ state: "x" as never })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.setUiState({} as never)).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.setUiState({ state: { big: "x".repeat(600_000) } })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("大きすぎます") });
    expect(await ws.uiState()).toEqual({ state: STATE });
  });

  it("Web モードでは利用者ごとに別の状態を持ち、ほかの人の状態は見えない。読むだけの役割でも自分の状態は保存できる", async () => {
    const as = (name: string, role: string): CallContext => ({ user: { name }, role });
    const result = async (method: "uiState" | "setUiState", params: unknown, call: CallContext): Promise<unknown> => {
      const r = await dispatch(ws, method, params, call);
      expect(r).not.toHaveProperty("error");
      return (r as { result: unknown }).result;
    };
    await result("setUiState", { state: { resourceId: "a" } }, as("alice", "viewer"));
    await result("setUiState", { state: { resourceId: "b" } }, as("bob", "translator"));
    expect(await result("uiState", {}, as("alice", "viewer"))).toEqual({ state: { resourceId: "a" } });
    expect(await result("uiState", {}, as("bob", "translator"))).toEqual({ state: { resourceId: "b" } });
    expect(await result("uiState", {}, as("carol", "manager"))).toEqual({ state: null });
    // ローカルモードの呼び出し（利用者なし）の状態とも別。
    expect(await ws.uiState()).toEqual({ state: null });
  });
});
