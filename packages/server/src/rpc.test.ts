import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockTimeoutError } from "@loc-studio/core";
import { StoreConflictError } from "@loc-studio/sdk";
import { ApiError, WORKSPACE_METHODS } from "./api-types.js";
import type { Workspace, WorkspaceApi } from "./api-types.js";
import { dispatch, toRpcError } from "./rpc.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
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

describe("dispatch", () => {
  it("許可リストのメソッドを呼ぶ", async () => {
    const r = await dispatch(ws, "rows", { resourceId: UI, languages: ["ja"], offset: 0, limit: 1 });
    expect("result" in r && (r.result as { total: number }).total).toBe(4);
    const info = await dispatch(ws, "info", undefined);
    expect("result" in info).toBe(true);
    expect(WORKSPACE_METHODS).toContain("textVersion");
  });

  it("知らないメソッド、許可リストにないもの", async () => {
    expect(await dispatch(ws, "nope", {})).toMatchObject({ error: { code: "not-found" } });
    expect(await dispatch(ws, "close", {})).toMatchObject({ error: { code: "not-found" } });
    expect(await dispatch(ws, "waitForJob", {})).toMatchObject({ error: { code: "not-found" } });
    expect(await dispatch(ws, "constructor", {})).toMatchObject({ error: { code: "not-found" } });
  });

  it("ApiError を code / message / data にする", async () => {
    await ws.setCell({ resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "wip" });
    const r = await dispatch(ws, "setCell", { resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "done", expectedVersion: 0 });
    expect(r).toMatchObject({ error: { code: "conflict", data: { current: { value: "wip" } } } });
    expect(await dispatch(ws, "rows", { resourceId: "nope", languages: [], offset: 0, limit: 1 })).toMatchObject({ error: { code: "not-found" } });
  });

  it("StoreConflictError → conflict、LockTimeoutError → locked、その他 → failed", async () => {
    const fake = {
      info: async () => {
        throw new StoreConflictError([]);
      },
      tree: async () => {
        throw new LockTimeoutError("/x.lock", 10);
      },
      jobs: async () => {
        throw new Error("こわれた");
      },
      job: async () => {
        throw new ApiError("invalid", "だめ", { a: 1 });
      },
    } as unknown as WorkspaceApi;
    expect(await dispatch(fake, "info", {})).toMatchObject({ error: { code: "conflict" } });
    expect(await dispatch(fake, "tree", {})).toMatchObject({ error: { code: "locked", data: { lockPath: "/x.lock" } } });
    expect(await dispatch(fake, "jobs", {})).toEqual({ error: { code: "failed", message: "こわれた" } });
    expect(await dispatch(fake, "job", {})).toEqual({ error: { code: "invalid", message: "だめ", data: { a: 1 } } });
    expect(toRpcError("str")).toEqual({ code: "failed", message: "str" });
  });

  it("閉じたあとの呼び出しは failed", async () => {
    await ws.close();
    expect(await dispatch(ws, "info", {})).toMatchObject({ error: { code: "failed" } });
  });
});
