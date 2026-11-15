/**
 * Web モードの権限と、呼び出しごとの利用者。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "@loc-studio/sdk";
import { WORKSPACE_METHODS } from "./api-types.js";
import type { CallContext, Role, Workspace, WorkspaceApi } from "./api-types.js";
import { METHOD_CAPABILITIES, roleCan } from "./permissions.js";
import { dispatch } from "./rpc.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

const ROLES: Role[] = ["viewer", "translator", "reviewer", "manager"];
const as = (name: string, role: Role, languages?: string[]): CallContext => ({ user: { name }, role, ...(languages ? { languages } : {}) });

/** 各メソッドの、それらしい引数（権限の確認の先まで進むように）。 */
const PARAMS: Record<keyof WorkspaceApi, unknown> = {
  info: {},
  tree: {},
  stats: { resourceIds: [UI] },
  rows: { resourceId: UI, languages: ["ja"], offset: 0, limit: 1 },
  rowDetail: { resourceId: UI, key: "UI_OK" },
  history: { resourceId: UI, key: "UI_OK" },
  reviews: { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko" },
  textVersion: { hash: "0".repeat(64) },
  validateText: { resourceId: UI, key: "UI_OK", language: "ko", value: "x" },
  search: { query: "OK" },
  settings: {},
  plugins: {},
  jobs: {},
  job: { id: "nope" },
  changes: { since: 0 },
  validate: { resourceIds: [UI] },
  reloadResource: { resourceId: UI },
  setText: { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" },
  discardDrafts: { resourceId: UI },
  save: { resourceId: UI },
  saveAll: {},
  setCell: { resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" },
  setCells: { resourceId: UI, keys: ["UI_OK"], cellId: "textStatus@ko", value: "wip" },
  postReview: { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "doing", comment: "" },
  forwardReview: { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", reviewId: "nope", actionId: "nope" },
  runAction: { actionId: "nope", resourceId: UI },
  generate: { columnId: "nope", scope: "project" },
  cancelJob: { id: "nope" },
  setLocalSetting: { key: "ui.theme", value: "dark" },
  updateProjectSettings: { patch: {} },
  reloadPlugins: {},
  trustPlugins: { paths: [] },
  untrustPlugins: { paths: [] },
};

const markPlugin: Plugin = {
  name: "perm-actions",
  actions: [
    {
      id: "perm.mark",
      label: "作業中にする",
      target: "row",
      async run(ctx) {
        return {
          patches: ["ja", "ko"].map((language) => ({ resourceId: ctx.entry!.resource.id, entryKey: ctx.entry!.key, columnId: "textStatus", language, value: "wip" })),
        };
      },
    },
  ],
};

let tp: TestProject;
let ws: Workspace;
beforeEach(async () => {
  tp = await makeTestProject({ plugins: [markPlugin] });
  await tp.patchConfig({ actions: ["perm.mark"] });
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

describe("権限の表", () => {
  it("すべてのメソッドに必要な権限がある", () => {
    expect(Object.keys(METHOD_CAPABILITIES).sort()).toEqual([...WORKSPACE_METHODS].sort());
  });

  for (const role of ROLES) {
    it(`役割 ${role}: 各メソッドを呼べるか`, async () => {
      for (const method of WORKSPACE_METHODS) {
        const cap = METHOD_CAPABILITIES[method];
        const allowed = cap !== "local-only" && roleCan(role, cap);
        const r = await dispatch(ws, method, PARAMS[method], as(`u-${role}`, role));
        const code = "error" in r ? r.error.code : undefined;
        if (allowed) expect(code, `${role} ${method}`).not.toBe("forbidden");
        else expect(code, `${role} ${method}`).toBe("forbidden");
      }
    });
  }

  it("CallContext がなければ（ローカルモード）すべて呼べる", async () => {
    for (const method of WORKSPACE_METHODS) {
      const r = await dispatch(ws, method, PARAMS[method]);
      expect("error" in r ? r.error.code : undefined, method).not.toBe("forbidden");
    }
    const info = await ws.info();
    expect(info.permissions).toEqual({ role: "manager", can: { edit: true, review: true, run: true, manage: true } });
  });

  it("info.permissions は呼び出した利用者のもの", async () => {
    const r = await dispatch(ws, "info", {}, as("t", "translator", ["ko"]));
    expect("result" in r && (r.result as { permissions: unknown }).permissions).toEqual({
      role: "translator",
      can: { edit: true, review: false, run: true, manage: false },
      languages: ["ko"],
    });
    const v = await dispatch(ws, "info", {}, as("v", "viewer"));
    expect("result" in v && (v.result as { permissions: unknown }).permissions).toEqual({
      role: "viewer",
      can: { edit: false, review: false, run: false, manage: false },
    });
  });

  it("不正な CallContext は invalid", async () => {
    expect(await dispatch(ws, "info", {}, { user: { name: "" }, role: "viewer" })).toMatchObject({ error: { code: "invalid" } });
    expect(await dispatch(ws, "info", {}, { user: { name: "x" }, role: "god" as Role })).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("言語の制限", () => {
  const ko = as("kim", "translator", ["ko"]);
  const reviewerKo = as("rev", "reviewer", ["ko"]);

  it("setText / setCell / setCells は割り当てられた言語だけ。entry スコープの列は制限しない", async () => {
    expect(await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ja", value: "x" }, ko)).toMatchObject({ error: { code: "forbidden" } });
    expect(await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" }, ko)).toHaveProperty("result");
    expect(await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ja", value: "wip" }, ko)).toMatchObject({ error: { code: "forbidden" } });
    expect(await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" }, ko)).toHaveProperty("result");
    // setCells は 1 つの言語のセルなので、全体を断る。
    expect(await dispatch(ws, "setCells", { resourceId: UI, keys: ["UI_OK", "UI_CANCEL"], cellId: "textStatus@ja", value: "wip" }, ko)).toMatchObject({
      error: { code: "forbidden" },
    });
  });

  it("discardDrafts と save は自分の言語のドラフトだけを扱い、ほかは残す", async () => {
    await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ja", value: "決定！" }, as("m", "manager"));
    await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" }, ko);
    let r = await dispatch(ws, "save", { resourceId: UI }, ko);
    expect("result" in r && r.result).toEqual({ saved: 1, conflicts: [] });
    expect(await tp.read(UI)).toContain("좋아");
    expect(await tp.read(UI)).not.toContain("決定！");
    await dispatch(ws, "setText", { resourceId: UI, key: "UI_CANCEL", language: "ko", value: "아니" }, ko);
    r = await dispatch(ws, "discardDrafts", { resourceId: UI }, ko);
    expect("result" in r && r.result).toEqual({ unsaved: 1 });
    const d = await ws.rowDetail({ resourceId: UI, key: "UI_OK" });
    expect(d.row.cells["text@ja"]).toMatchObject({ value: "決定！", draft: true, draftBy: "m" });
  });

  it("レビューも割り当てられた言語だけ", async () => {
    expect(await dispatch(ws, "postReview", { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ja", verdict: "ok", comment: "" }, reviewerKo)).toMatchObject({
      error: { code: "forbidden" },
    });
    expect(await dispatch(ws, "postReview", { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "ok", comment: "" }, reviewerKo)).toHaveProperty(
      "result",
    );
  });

  it("アクションの変更点も同じ規則（許されない言語の変更点は errors、reviewer は編集できない）", async () => {
    let r = await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: UI, keys: ["UI_OK"] }, ko);
    expect("result" in r && r.result).toMatchObject({ patched: 1, errors: [expect.stringContaining("ja")] });
    r = await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: UI, keys: ["UI_CANCEL"] }, reviewerKo);
    expect("result" in r && (r.result as { patched: number }).patched).toBe(0);
  });

  it("Web モードでは user.name と secrets は変えられない。プラグインの信頼も変えられない", async () => {
    const m = as("m", "manager");
    expect(await dispatch(ws, "setLocalSetting", { key: "user.name", value: "x" }, m)).toMatchObject({ error: { code: "forbidden" } });
    expect(await dispatch(ws, "setLocalSetting", { key: "secrets.llm.apiKey", value: "x" }, m)).toMatchObject({ error: { code: "forbidden" } });
    expect(await dispatch(ws, "trustPlugins", { paths: [] }, m)).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("呼び出しごとの利用者", () => {
  it("履歴・セルの値・レビュー・ドラフトに呼び出した人の名前が残る", async () => {
    const alice = as("alice", "manager");
    const bob = as("bob", "manager");
    await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" }, alice);
    let d = await ws.rowDetail({ resourceId: UI, key: "UI_OK" });
    expect(d.row.cells["text@ko"]!.draftBy).toBe("alice");
    await dispatch(ws, "save", { resourceId: UI }, bob);
    const c = await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" }, alice);
    expect("result" in c && c.result).toMatchObject({ updatedBy: "alice" });
    const p = await dispatch(ws, "postReview", { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "ok", comment: "" }, bob);
    expect("result" in p && p.result).toMatchObject({ userName: "bob" });
    const h = await ws.history({ resourceId: UI, key: "UI_OK" });
    expect(h.map((x) => [x.cellId, x.by]).sort()).toEqual([
      ["reviewStatus@ko", "bob"],
      ["text@ko", "bob"],
      ["textStatus@ko", "alice"],
    ]);
    // 呼び出しの外（ローカルの利用者）は従来どおり。
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ja", value: "wip" });
    d = await ws.rowDetail({ resourceId: UI, key: "UI_OK" });
    expect(d.row.cells["textStatus@ja"]!.updatedBy).toBe("tester");
  });

  it("ジョブは開始した人の名前で残り、ほかの人（manager 以外）は止められない", async () => {
    const lines = ["ID,JP,EN,CN,KR,MaxLen", ...Array.from({ length: 25 }, (_, i) => `K${i},本文${i},t${i},,,`)];
    await tp.write("Assets/Text/big.csv", lines.join("\n") + "\n");
    const carol = as("carol", "translator");
    const r = await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: "Assets/Text/big.csv", keys: lines.slice(1).map((l) => l.split(",")[0]) }, carol);
    const jobId = "result" in r ? (r.result as { jobId: string }).jobId : "";
    expect(jobId).toBeTruthy();
    expect(await dispatch(ws, "cancelJob", { id: jobId }, as("dave", "translator"))).toMatchObject({ error: { code: "forbidden" } });
    const job = await ws.waitForJob(jobId);
    expect(job).toMatchObject({ startedBy: "carol", status: "done" });
    const h = await ws.history({ resourceId: "Assets/Text/big.csv", key: "K24", cellId: "textStatus@ko" });
    expect(h[0]).toMatchObject({ by: "carol", cause: "action" });
    const logged = await ws.project.host.db.log("core.jobs").list({ limit: 1 });
    expect(logged[0]!.by).toBe("carol");
  });

  it("同じセルを 2 人が編集したら、あとの人に競合を知らせる（baseValue）", async () => {
    const alice = as("alice", "translator");
    const bob = as("bob", "translator");
    const base = "확인";
    expect(await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아", baseValue: base }, alice)).toHaveProperty("result");
    const r = await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "오케이", baseValue: base }, bob);
    expect(r).toMatchObject({ error: { code: "conflict", data: { value: "좋아", by: "alice" } } });
    // 同じ値にするだけなら競合にしない。いまの値を基にすれば通る。
    expect(await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아", baseValue: base }, bob)).toHaveProperty("result");
    expect(await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "오케이", baseValue: "좋아" }, bob)).toHaveProperty("result");
    // 保存したあとは、保存した人が競合の相手として出る。
    await dispatch(ws, "save", { resourceId: UI }, bob);
    const r2 = await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "x", baseValue: "좋아" }, alice);
    expect(r2).toMatchObject({ error: { code: "conflict", data: { value: "오케이", by: "bob" } } });
    // baseValue を渡さなければ従来どおり上書きする。
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "로컬" });
    expect((await ws.rowDetail({ resourceId: UI, key: "UI_OK" })).row.cells["text@ko"]).toMatchObject({ value: "로컬", draftBy: "tester" });
  });
});

describe("利用者ごとの設定", () => {
  it("userSettings があれば利用者ごとに分かれ、user.name はアカウント名で固定", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const ws2 = await tp.open({
      userSettings: { get: async (n) => ({ ...(store.get(n) ?? {}) }), set: async (n, v) => void store.set(n, v) },
    });
    await dispatch(ws2, "setLocalSetting", { key: "ui.theme", value: "dark" }, as("alice", "viewer"));
    const a = await dispatch(ws2, "info", {}, as("alice", "viewer"));
    const b = await dispatch(ws2, "info", {}, as("bob", "viewer"));
    expect("result" in a && (a.result as { localSettings: Record<string, unknown> }).localSettings).toMatchObject({ "ui.theme": "dark", "user.name": "alice" });
    expect("result" in b && (b.result as { localSettings: Record<string, unknown> }).localSettings).toMatchObject({ "ui.theme": "light", "user.name": "bob" });
    expect("result" in a && (a.result as { user: unknown }).user).toEqual({ name: "alice", source: "enforce", locked: true });
    expect(store.get("alice")).toEqual({ "ui.theme": "dark" });
    const s = await dispatch(ws2, "settings", {}, as("alice", "viewer"));
    expect("result" in s && (s.result as { localFile: string }).localFile).toBe("");
    // ローカルの設定ファイルは変わらない。
    expect((await ws2.info()).localSettings["ui.theme"]).toBe("light");
  });
});
