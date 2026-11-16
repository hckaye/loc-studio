/**
 * Web モードの権限と、呼び出しごとの利用者。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin } from "@loc-studio/sdk";
import { WORKSPACE_METHODS } from "./api-types.js";
import type { CallContext, ProjectInfo, Role, TreeNodeInfo, Workspace, WorkspaceApi } from "./api-types.js";
import { METHOD_CAPABILITIES } from "./permissions.js";
import { dispatch } from "./rpc.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

const as = (name: string, role: Role, languages?: string[]): CallContext => ({ user: { name }, role, ...(languages ? { languages } : {}) });

type Method = keyof WorkspaceApi;
/*
 * 役割ごとに「断られるメソッド」を、実装の表（METHOD_CAPABILITIES や役割の定義）から導かずに、ここに書き下す。
 * 実装の表から期待値を作ると、表を誤って書き換えてもテストが一緒に変わってしまい、権限が広がったことに気づけない。
 */
const EDIT: Method[] = ["setText", "discardDrafts", "save", "saveAll", "setCell", "setCells"];
const REVIEW: Method[] = ["postReview", "forwardReview"];
const RUN: Method[] = ["runAction", "generate", "cancelJob"];
const STRUCTURE: Method[] = ["editEntries", "createResource"];
const MANAGE: Method[] = ["updateProjectSettings", "setPluginSettings", "reloadPlugins"];
const LOCAL_ONLY: Method[] = ["trustPlugins", "untrustPlugins"];
const FORBIDDEN: Record<string, Method[]> = {
  viewer: [...EDIT, ...REVIEW, ...RUN, ...STRUCTURE, ...MANAGE, ...LOCAL_ONLY],
  translator: [...REVIEW, ...STRUCTURE, ...MANAGE, ...LOCAL_ONLY],
  reviewer: [...EDIT, ...STRUCTURE, ...MANAGE, ...LOCAL_ONLY],
  manager: [...LOCAL_ONLY],
};

const codeOf = (r: Awaited<ReturnType<typeof dispatch>>): string | undefined => ("error" in r ? r.error.code : undefined);
const resultOf = <T>(r: Awaited<ReturnType<typeof dispatch>>): T => {
  expect(r).toHaveProperty("result");
  return (r as { result: T }).result;
};
const resourceIds = (nodes: TreeNodeInfo[]): string[] => nodes.flatMap((n) => (n.kind === "resource" ? [n.resource!.id] : resourceIds(n.children ?? [])));

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
  query: { languages: ["ja"], where: "key = UI_OK" },
  exportQuery: { languages: ["ja"], format: "csv" },
  tokens: { resourceId: UI, texts: ["{a}"] },
  settings: {},
  plugins: {},
  pluginSettings: {},
  jobs: {},
  job: { id: "nope" },
  changes: { since: 0 },
  uiState: {},
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
  editEntries: { resourceId: UI, changes: [{ type: "rename", key: "NO_SUCH_ROW", newKey: "X" }] },
  createResource: { path: "not-in-tree/new.csv" },
  setLocalSetting: { key: "ui.theme", value: "dark" },
  setUiState: { state: { resourceId: UI } },
  updateProjectSettings: { patch: {} },
  setPluginSettings: { plugin: "perm-actions", values: {} },
  reloadPlugins: {},
  trustPlugins: { paths: [] },
  untrustPlugins: { paths: [] },
};

const markPlugin: Plugin = {
  name: "perm-actions",
  generators: [
    {
      id: "perm.echo",
      version: "1",
      cacheParams: () => ({}),
      input: (ctx) => (ctx.language ? { text: ctx.row.text(ctx.language.id) ?? "", language: ctx.language.id } : null),
      run: async (inputs) => inputs.map((i) => ({ value: i.text })),
    },
  ],
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

  for (const [role, forbidden] of Object.entries(FORBIDDEN)) {
    it(`同梱の役割 ${role}: 断られるメソッドは決まったものだけ`, async () => {
      const actual: string[] = [];
      for (const method of WORKSPACE_METHODS) {
        if (codeOf(await dispatch(ws, method, PARAMS[method], as(`u-${role}`, role))) === "forbidden") actual.push(method);
      }
      expect(actual.sort()).toEqual([...forbidden].sort());
    });
  }

  it("CallContext がなければ（ローカルモード）すべて呼べる", async () => {
    for (const method of WORKSPACE_METHODS) {
      const r = await dispatch(ws, method, PARAMS[method]);
      expect("error" in r ? r.error.code : undefined, method).not.toBe("forbidden");
    }
    const info = await ws.info();
    expect(info.permissions).toEqual({ role: "manager", can: { edit: true, review: true, run: true, structure: true, manage: true }, unrestricted: true });
    // ローカルモードでは、役割に絞り込みがあっても何も絞らない。
    expect(resourceIds(await ws.tree()).sort()).toEqual([CHAPTER, UI].sort());
  });

  it("info.permissions は呼び出した利用者のもの", async () => {
    const r = await dispatch(ws, "info", {}, as("t", "translator", ["ko"]));
    expect("result" in r && (r.result as { permissions: unknown }).permissions).toEqual({
      role: "translator",
      roleLabel: "翻訳",
      can: { edit: true, review: false, run: true, structure: false, manage: false },
      languages: ["ko"],
    });
    const v = await dispatch(ws, "info", {}, as("v", "viewer"));
    expect("result" in v && (v.result as { permissions: unknown }).permissions).toEqual({
      role: "viewer",
      roleLabel: "閲覧",
      can: { edit: false, review: false, run: false, structure: false, manage: false },
    });
  });

  it("不正な CallContext は invalid。設定にない役割は、見ることも含めてすべて forbidden", async () => {
    expect(await dispatch(ws, "info", {}, { user: { name: "" }, role: "viewer" })).toMatchObject({ error: { code: "invalid" } });
    expect(codeOf(await dispatch(ws, "info", {}, { user: { name: "x" }, role: "" }))).toBe("forbidden");
    for (const method of WORKSPACE_METHODS) {
      expect(codeOf(await dispatch(ws, method, PARAMS[method], as("x", "god"))), method).toBe("forbidden");
    }
    // Object.prototype の名前を役割に使っても、権限は付かない。
    for (const role of ["constructor", "__proto__", "toString"]) {
      expect(codeOf(await dispatch(ws, "info", {}, as("x", role))), role).toBe("forbidden");
    }
  });
});

describe("設定の roles で決めた役割", () => {
  const ECHO_COLUMN = { id: "echo", kind: "generated", scope: "language", generator: "perm.echo" };
  const ROLES = {
    // ステータスとレビューだけ触れる（本文は変えられない）。
    lqa: { label: "LQA", can: ["edit", "review"], editColumns: ["textStatus"], reviewColumns: ["reviewStatus"] },
    // system フォルダだけ見える外注先。アクションは 1 つも実行できず、生成は echo の列だけ。
    vendor: { can: ["edit", "run"], resources: ["Assets/Text/system/**"], actions: [], generators: ["echo"] },
    // 同梱の translator を置き換える（実行の権限を外す）。
    translator: { can: ["edit"] },
    // 書き方の誤った定義。
    broken: { can: ["edit", "fly"] },
  };
  const lqa = as("lqa", "lqa");
  const vendor = as("ven", "vendor");
  const manager = as("mgr", "manager");

  beforeEach(async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
    await tp.patchConfig({ roles: ROLES, columns: [...config.columns, ECHO_COLUMN] });
    await ws.reloadPlugins();
  });

  it("info.roles に同梱の役割と設定の役割が並び、permissions に役割の絞り込みが入る", async () => {
    const info = resultOf<ProjectInfo>(await dispatch(ws, "info", {}, lqa));
    expect(info.roles).toEqual([
      { id: "viewer", label: "閲覧" },
      { id: "translator", label: "translator" },
      { id: "reviewer", label: "レビュー" },
      { id: "manager", label: "管理" },
      { id: "lqa", label: "LQA" },
      { id: "vendor", label: "vendor" },
      { id: "broken", label: "broken" },
    ]);
    expect(info.permissions).toEqual({
      role: "lqa",
      roleLabel: "LQA",
      can: { edit: true, review: true, run: false, structure: false, manage: false },
      editColumns: ["textStatus"],
      reviewColumns: ["reviewStatus"],
    });
    expect(info.warnings.filter((w) => w.includes("roles.broken"))).toHaveLength(1);
  });

  it("editColumns: 書かれた列だけ変えられる。本文は変えられず、ほかの人のドラフトも保存しない", async () => {
    expect(codeOf(await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" }, lqa))).toBeUndefined();
    expect(codeOf(await dispatch(ws, "setCells", { resourceId: UI, keys: ["UI_OK"], cellId: "textStatus@ja", value: "wip" }, lqa))).toBeUndefined();
    expect(await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "x" }, lqa)).toMatchObject({
      error: { code: "forbidden", message: expect.stringContaining("textStatus") },
    });
    // manager のドラフトは、本文を変えられない lqa の save / saveAll / discardDrafts では動かない。
    await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" }, manager);
    expect(resultOf(await dispatch(ws, "save", { resourceId: UI }, lqa))).toEqual({ saved: 0, conflicts: [] });
    expect(resultOf(await dispatch(ws, "saveAll", {}, lqa))).toMatchObject({ saved: 0 });
    expect(resultOf(await dispatch(ws, "discardDrafts", { resourceId: UI }, lqa))).toEqual({ unsaved: 1 });
    expect(await tp.read(UI)).not.toContain("좋아");
  });

  it("reviewColumns: 書かれたレビュー列にだけ投稿できる", async () => {
    await tp.patchConfig({ roles: { ...ROLES, lqa: { ...ROLES.lqa, reviewColumns: [] } } });
    await ws.reloadPlugins();
    expect(codeOf(await dispatch(ws, "postReview", { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "ok", comment: "" }, lqa))).toBe("forbidden");
    await tp.patchConfig({ roles: ROLES });
    await ws.reloadPlugins();
    expect(resultOf(await dispatch(ws, "postReview", { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "ok", comment: "" }, lqa))).toMatchObject({
      verdict: "ok",
      userName: "lqa",
    });
  });

  it("actions / generators: 書かれたものだけ実行できる。置き換えた同梱の役割にも定義が効く", async () => {
    expect(await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: UI, keys: ["UI_OK"] }, vendor)).toMatchObject({
      error: { code: "forbidden", message: expect.stringContaining("perm.mark") },
    });
    expect(resultOf(await dispatch(ws, "generate", { columnId: "echo", scope: "resource", resourceId: UI, dryRun: true }, vendor))).toMatchObject({ toRun: 16 });
    await tp.patchConfig({ roles: { ...ROLES, vendor: { ...ROLES.vendor, generators: [] } } });
    await ws.reloadPlugins();
    expect(codeOf(await dispatch(ws, "generate", { columnId: "echo", scope: "resource", resourceId: UI, dryRun: true }, vendor))).toBe("forbidden");
    // 同梱の translator は run を持つが、設定で置き換えたので実行できない。
    expect(codeOf(await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: UI, keys: ["UI_OK"] }, as("t", "translator")))).toBe("forbidden");
    expect(resultOf(await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: UI, keys: ["UI_OK"] }, manager))).toMatchObject({ patched: 2 });
  });

  it("runAction の filter（条件に合う行）でも、役割の絞り込み（actions、resources）は同じに効く", async () => {
    const status = async (resourceId: string, key: string) =>
      resultOf<{ row: { cells: Record<string, { value: unknown }> } }>(await dispatch(ws, "rowDetail", { resourceId, key }, manager)).row.cells["textStatus@ko"]!.value;
    // 実行できないアクションは、条件で行を選んでも forbidden。
    expect(await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: UI, filter: { languages: ["ko"] } }, vendor)).toMatchObject({
      error: { code: "forbidden", message: expect.stringContaining("perm.mark") },
    });
    expect(await status(UI, "UI_OK")).toBe("todo");
    // アクションを実行できる役割でも、見えないリソースは「ない」。見えるリソースでは、条件に合う行だけに実行する。
    await tp.patchConfig({ roles: { ...ROLES, vendor: { ...ROLES.vendor, actions: ["perm.mark"] } } });
    await ws.reloadPlugins();
    expect(codeOf(await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: CHAPTER, filter: { languages: ["ko"] } }, vendor))).toBe("not-found");
    expect(await status(CHAPTER, "CH01_INTRO_001")).toBe("todo");
    expect(resultOf(await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: UI, filter: { languages: ["ko"], where: "key = UI_OK" } }, vendor))).toEqual({ patched: 2, matched: 1 });
    expect([await status(UI, "UI_OK"), await status(UI, "UI_CANCEL")]).toEqual(["wip", "todo"]);
  });

  it("resources: 見えないリソースは、どの読み出しでも「ない」ものとして扱う", async () => {
    await dispatch(ws, "setCell", { resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "wip" }, manager);
    expect(resourceIds(resultOf<TreeNodeInfo[]>(await dispatch(ws, "tree", {}, vendor)))).toEqual([UI]);
    const hidden: [Method, unknown][] = [
      ["rows", { resourceId: CHAPTER, languages: ["ja"], offset: 0, limit: 1 }],
      ["rowDetail", { resourceId: CHAPTER, key: "CH01_INTRO_001" }],
      ["stats", { resourceIds: [CHAPTER] }],
      ["history", { resourceId: CHAPTER, key: "CH01_INTRO_001" }],
      ["reviews", { resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "reviewStatus@ko" }],
      ["validateText", { resourceId: CHAPTER, key: "CH01_INTRO_001", language: "ko", value: "x" }],
      ["tokens", { resourceId: CHAPTER, texts: ["x"] }],
      ["reloadResource", { resourceId: CHAPTER }],
      ["setText", { resourceId: CHAPTER, key: "CH01_INTRO_001", language: "ko", value: "x" }],
      ["setCell", { resourceId: CHAPTER, key: "CH01_INTRO_001", cellId: "textStatus@ko", value: "done" }],
      ["setCells", { resourceId: CHAPTER, keys: ["CH01_INTRO_001"], cellId: "textStatus@ko", value: "done" }],
      ["save", { resourceId: CHAPTER }],
      ["discardDrafts", { resourceId: CHAPTER }],
      ["generate", { columnId: "echo", scope: "resource", resourceId: CHAPTER, dryRun: true }],
      ["query", { languages: ["ja"], resourceIds: [CHAPTER] }],
      ["exportQuery", { languages: ["ja"], format: "csv", resourceIds: [CHAPTER] }],
    ];
    for (const [method, params] of hidden) {
      // 存在しないリソースと同じ答え（あることを知らせない）。
      const r = await dispatch(ws, method, params, vendor);
      const missing = await dispatch(ws, method, { ...(params as object), resourceId: "nope.csv", resourceIds: ["nope.csv"] }, vendor);
      expect(codeOf(r), method).toBe("not-found");
      expect(codeOf(missing), method).toBe("not-found");
    }
    // 見えるリソースは、同じ呼び出しが通る。
    expect(codeOf(await dispatch(ws, "rows", { resourceId: UI, languages: ["ja"], offset: 0, limit: 1 }, vendor))).toBeUndefined();
    expect(codeOf(await dispatch(ws, "history", { resourceId: UI, key: "UI_OK" }, vendor))).toBeUndefined();
    // プロジェクト全体の操作も、見えるリソースだけを対象にする。
    const hits = resultOf<{ resourceId: string }[]>(await dispatch(ws, "search", { query: "CH01" }, vendor));
    expect(hits).toEqual([]);
    expect(resultOf<unknown[]>(await dispatch(ws, "search", { query: "CH01" }, manager)).length).toBeGreaterThan(0);
    // リソースをまたぐ問い合わせと書き出しも、見えるリソースだけを数える。
    const counted = resultOf<{ resources: { resourceId: string }[]; totalRows: number }>(await dispatch(ws, "query", { languages: ["ja"] }, vendor));
    expect(counted.resources.map((x) => x.resourceId)).toEqual([UI]);
    expect(counted.totalRows).toBe(4);
    const exported = resultOf<{ text: string; rows: number }>(await dispatch(ws, "exportQuery", { languages: ["ja"], format: "csv", cells: ["text@ja"] }, vendor));
    expect(exported.rows).toBe(4);
    expect(exported.text).not.toContain("CH01");
    expect(resultOf<{ totalRows: number }>(await dispatch(ws, "query", { languages: ["ja"] }, manager)).totalRows).toBe(12);
    const validated = resultOf<{ resources: { resourceId: string }[] }>(await dispatch(ws, "validate", {}, vendor));
    expect(validated.resources.map((x) => x.resourceId)).toEqual([UI]);
    expect(resultOf(await dispatch(ws, "generate", { columnId: "echo", scope: "project", dryRun: true }, vendor))).toMatchObject({ total: 16 });
  });

  it("resources: saveAll は見えるリソースだけを保存し、見えないリソースのドラフトは残す", async () => {
    await dispatch(ws, "setText", { resourceId: CHAPTER, key: "CH01_INTRO_001", language: "ko", value: "숨김" }, manager);
    await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" }, vendor);
    expect(resultOf(await dispatch(ws, "saveAll", {}, vendor))).toMatchObject({ resources: 1, saved: 1 });
    expect(await tp.read(UI)).toContain("좋아");
    expect(await tp.read(CHAPTER)).not.toContain("숨김");
    expect((await ws.rowDetail({ resourceId: CHAPTER, key: "CH01_INTRO_001" })).row.cells["text@ko"]).toMatchObject({ value: "숨김", draft: true });
  });

  it("書き方の誤った役割は、同梱の広い権限に戻らず、何も見えず何もできない", async () => {
    const broken = as("b", "broken");
    expect(resultOf<TreeNodeInfo[]>(await dispatch(ws, "tree", {}, broken))).toEqual([]);
    expect(codeOf(await dispatch(ws, "rows", { resourceId: UI, languages: ["ja"], offset: 0, limit: 1 }, broken))).toBe("not-found");
    expect(codeOf(await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "x" }, broken))).toBe("forbidden");
    // 同梱の役割の ID を誤った定義で置き換えた場合も同じ（同梱の translator に戻らない）。
    await tp.patchConfig({ roles: { translator: { can: "edit" } } });
    await ws.reloadPlugins();
    expect(codeOf(await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "x" }, as("t", "translator")))).toBe("forbidden");
    expect(resultOf<TreeNodeInfo[]>(await dispatch(ws, "tree", {}, as("t", "translator")))).toEqual([]);
  });

  it("サーバーの管理者は、役割の定義にかかわらずすべてできる", async () => {
    const admin: CallContext = { user: { name: "root" }, role: "vendor", admin: true };
    expect(resourceIds(resultOf<TreeNodeInfo[]>(await dispatch(ws, "tree", {}, admin))).sort()).toEqual([CHAPTER, UI].sort());
    expect(resultOf(await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: CHAPTER, keys: ["CH01_INTRO_001"] }, admin))).toMatchObject({ patched: 2 });
    expect(codeOf(await dispatch(ws, "postReview", { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "ok", comment: "" }, admin))).toBeUndefined();
  });

  it("役割の定義を変えられるのは管理者だけ。変えた定義は次の呼び出しから効く", async () => {
    const widened = { ...ROLES, vendor: { can: ["edit", "run", "manage"] } };
    expect(await dispatch(ws, "updateProjectSettings", { patch: { roles: widened } }, manager)).toMatchObject({ error: { code: "forbidden", data: { keys: ["roles"] } } });
    expect(resourceIds(resultOf<TreeNodeInfo[]>(await dispatch(ws, "tree", {}, vendor)))).toEqual([UI]);
    expect(codeOf(await dispatch(ws, "updateProjectSettings", { patch: { roles: widened } }, { ...manager, admin: true }))).toBeUndefined();
    expect(resourceIds(resultOf<TreeNodeInfo[]>(await dispatch(ws, "tree", {}, vendor))).sort()).toEqual([CHAPTER, UI].sort());
  });

  it("ほかの人のジョブを止められるのは、manage の権限がある役割（役割の名前ではなく権限で決まる）", async () => {
    await tp.patchConfig({ roles: { lead: { can: ["run", "manage"] }, manager: { can: ["edit", "run"] } } });
    await ws.reloadPlugins();
    const lines = ["ID,JP,EN,CN,KR,MaxLen", ...Array.from({ length: 25 }, (_, i) => `K${i},本文${i},t${i},,,`)];
    await tp.write("Assets/Text/big.csv", lines.join("\n") + "\n");
    const start = async (): Promise<string> =>
      resultOf<{ jobId: string }>(
        await dispatch(ws, "runAction", { actionId: "perm.mark", resourceId: "Assets/Text/big.csv", keys: lines.slice(1).map((l) => l.split(",")[0]) }, as("carol", "manager")),
      ).jobId;
    // manage を外した「manager」という名前の役割は、ほかの人のジョブを止められない。
    expect(codeOf(await dispatch(ws, "cancelJob", { id: await start() }, as("dave", "manager")))).toBe("forbidden");
    expect(codeOf(await dispatch(ws, "cancelJob", { id: await start() }, as("erin", "lead")))).toBeUndefined();
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
