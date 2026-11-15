/**
 * 行の追加・削除・キーの変更（editEntries）と、新しいリソースの作成（createResource）。
 * 本物のワークスペース（CSV と SQLite）で、ファイルの中身と、キーに紐づく記録（ステータス、レビュー、履歴、未保存の編集）を確かめる。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { csvFormat } from "@loc-studio/builtin";
import type { Change, Plugin, TreeNode, WorkflowEvent } from "@loc-studio/sdk";
import type { CallContext, TreeNodeInfo, Workspace } from "./api-types.js";
import { dispatch } from "./rpc.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

const UI_ORIGINAL = ["ID,JP,EN,CN,KR,MaxLen", "UI_OK,決定,OK,确定,확인,4", "UI_CANCEL,キャンセル,Cancel,取消,취소,6", "UI_SAVE_CONFIRM,セーブしますか？,Save your progress?,要保存吗？,저장하시겠습니까?,12", "UI_GOLD,所持金：{gold} G,Gold: {gold} G,持有金：{gold} G,소지금: {gold} G,"];

let events: WorkflowEvent[];
let told: { source: string; resource: string; changes: Change[] }[];

const plugin: Plugin = {
  name: "structure-test",
  formats: [
    {
      // 行の変更を黙って無視するフォーマット（set だけ当てる）。
      id: "t.silent",
      match: () => false,
      parse: (input, ctx) => csvFormat.parse(input, ctx),
      apply: (original, changes, ctx) => csvFormat.apply(original, changes.filter((c) => c.type === "set"), ctx),
    },
  ],
  sources: [
    {
      // 行の変更を知らされたことを記録する列ソース。
      id: "t.memo",
      saveMode: "immediate",
      load: async () => [],
      save: async () => [],
      async onEntriesChanged(changes, resource, ctx) {
        told.push({ source: String(ctx.options["name"]), resource: resource.id, changes });
      },
    },
  ],
  hooks: [
    {
      id: "t.log",
      before: (event, ctx) => {
        events.push(event);
        return event.type === "entries.change" && event.changes.some((c) => c.type === "remove" && c.key === ctx.options["keep"]) ? "この行は消せません" : undefined;
      },
    },
  ],
  trees: [
    {
      // 作成に対応していないツリー（一覧と読み書きだけ）。
      id: "t.fixed",
      list: async (): Promise<TreeNode[]> => [],
      read: async () => new Uint8Array(),
      write: async () => undefined,
    },
  ],
};

let tp: TestProject;
let ws: Workspace;

beforeEach(async () => {
  events = [];
  told = [];
  tp = await makeTestProject({ plugins: [plugin] });
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

const lines = async (rel: string): Promise<string[]> => (await tp.read(rel)).replace(/\n$/, "").split("\n");
const keys = async (resourceId: string): Promise<string[]> => (await ws.rows({ resourceId, languages: ["ja"], offset: 0, limit: 100 })).rows.map((r) => r.key);
const cellsOf = async (resourceId: string, key: string) => (await ws.rowDetail({ resourceId, key })).row.cells;
const configure = async (patch: Record<string, unknown>): Promise<void> => {
  await tp.patchConfig(patch);
  await ws.reloadPlugins();
};
const resourceIds = (nodes: TreeNodeInfo[]): string[] => nodes.flatMap((n) => (n.kind === "resource" ? [n.resource!.id] : resourceIds(n.children ?? [])));

describe("editEntries: 行の追加", () => {
  it("指定した行の後ろ（省略時は末尾）に足し、ほかの行のバイトは変えない。足した行はすぐ表に出る", async () => {
    const r = await ws.editEntries({
      resourceId: UI,
      changes: [
        { type: "add", key: "UI_NEW", after: "UI_OK", text: { ja: "新規", ko: "신규" }, meta: { maxLength: "8" } },
        { type: "add", key: "UI_LAST" },
      ],
    });
    expect(r.entries).toBe(6);
    expect(await lines(UI)).toEqual([UI_ORIGINAL[0], UI_ORIGINAL[1], "UI_NEW,新規,,,신규,8", ...UI_ORIGINAL.slice(2), "UI_LAST,,,,,"]);
    expect(await keys(UI)).toEqual(["UI_OK", "UI_NEW", "UI_CANCEL", "UI_SAVE_CONFIRM", "UI_GOLD", "UI_LAST"]);
    const cells = await cellsOf(UI, "UI_NEW");
    expect(cells["text@ko"]).toMatchObject({ value: "신규" });
    expect(cells["textStatus@ko"]).toMatchObject({ value: "todo" });
  });

  it("すでにあるキー、ない行の後ろ、知らない言語は失敗し、リソースは変わらない", async () => {
    const before = await tp.read(UI);
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "add", key: "UI_OK" }] })).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("UI_OK") });
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "add", key: "X", after: "NOPE" }] })).rejects.toMatchObject({ code: "failed" });
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "add", key: "X", text: { xx: "?" } }] })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "add", key: "" }] })).rejects.toMatchObject({ code: "invalid" });
    // 途中で失敗する変更の並びは、1 つも当てない。
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "add", key: "X" }, { type: "remove", key: "NOPE" }] })).rejects.toMatchObject({ code: "failed" });
    expect(await tp.read(UI)).toBe(before);
  });
});

describe("editEntries: 行の削除", () => {
  it("行を消し、その行の未保存の編集を捨てる。共有 DB の記録は残し、同じキーを足し直すと戻る", async () => {
    await ws.setCell({ resourceId: UI, key: "UI_CANCEL", cellId: "textStatus@ko", value: "done" });
    await ws.setText({ resourceId: UI, key: "UI_CANCEL", language: "ko", value: "그만" });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    expect((await ws.editEntries({ resourceId: UI, changes: [{ type: "remove", key: "UI_CANCEL" }] })).entries).toBe(3);
    expect(await lines(UI)).toEqual([UI_ORIGINAL[0], UI_ORIGINAL[1], UI_ORIGINAL[3], UI_ORIGINAL[4]]);
    // 消した行のドラフトだけがなくなり、ほかの行のドラフトは残る。
    expect((await ws.tree()).flatMap((n) => resourceIdsWithUnsaved(n))).toEqual([[UI, 1]]);
    expect(await ws.save({ resourceId: UI })).toEqual({ saved: 1, conflicts: [] });
    await ws.editEntries({ resourceId: UI, changes: [{ type: "add", key: "UI_CANCEL", text: { ko: "취소" } }] });
    expect((await cellsOf(UI, "UI_CANCEL"))["textStatus@ko"]).toMatchObject({ value: "done" });
  });

  it("ない行は消せず、リソースは変わらない", async () => {
    const before = await tp.read(UI);
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "remove", key: "NOPE" }] })).rejects.toMatchObject({ code: "failed" });
    expect(await tp.read(UI)).toBe(before);
  });
});

function resourceIdsWithUnsaved(n: TreeNodeInfo): [string, number][] {
  if (n.kind === "resource") return n.unsaved ? [[n.resource!.id, n.unsaved]] : [];
  return (n.children ?? []).flatMap(resourceIdsWithUnsaved);
}

describe("editEntries: キーの変更", () => {
  it("キーだけを書き換え、ステータス、レビュー、履歴、未保存の編集、要再確認の記録が新しいキーに移る", async () => {
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    await ws.postReview({ resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "ok", comment: "よい" });
    // ko を保存して「基の本文の版」を記録してから、基の本文（ja）を変える → 要再確認になる。
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    await ws.save({ resourceId: UI });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ja", value: "けってい" });
    await ws.save({ resourceId: UI });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "zh-Hans", value: "好" });
    const before = await cellsOf(UI, "UI_OK");
    expect(before["text@ko"]).toMatchObject({ value: "좋아", needsRecheck: true });

    await ws.editEntries({ resourceId: UI, changes: [{ type: "rename", key: "UI_OK", newKey: "UI_CONFIRM" }] });
    expect((await lines(UI))[1]).toBe("UI_CONFIRM,けってい,OK,确定,좋아,4");
    expect(await keys(UI)).toEqual(["UI_CONFIRM", "UI_CANCEL", "UI_SAVE_CONFIRM", "UI_GOLD"]);
    const after = await cellsOf(UI, "UI_CONFIRM");
    expect(after["textStatus@ko"]).toMatchObject({ value: "done" });
    expect(after["reviewStatus@ko"]).toMatchObject({ value: "ok" });
    expect(after["text@ko"]).toMatchObject({ value: "좋아", needsRecheck: true });
    expect(after["text@zh-Hans"]).toMatchObject({ value: "好", draft: true, saved: "确定" });
    expect((await ws.reviews({ resourceId: UI, key: "UI_CONFIRM", cellId: "reviewStatus@ko" })).map((p) => p.comment)).toEqual(["よい"]);
    const history = await ws.history({ resourceId: UI, key: "UI_CONFIRM" });
    expect(history.map((h) => h.cellId).sort()).toEqual(["reviewStatus@ko", "text@ja", "text@ko", "textStatus@ko"]);
    // 古いキーには何も残らない。
    expect(await ws.history({ resourceId: UI, key: "UI_OK" })).toEqual([]);
    await expect(ws.rowDetail({ resourceId: UI, key: "UI_OK" })).rejects.toMatchObject({ code: "not-found" });
    // 移したドラフトは、新しいキーの行として保存できる。
    expect(await ws.save({ resourceId: UI })).toEqual({ saved: 1, conflicts: [] });
    expect((await lines(UI))[1]).toBe("UI_CONFIRM,けってい,OK,好,좋아,4");
  });

  it("すでにあるキー・同じキー・ない行への変更はできず、リソースも記録も変わらない", async () => {
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    const before = await tp.read(UI);
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "rename", key: "UI_OK", newKey: "UI_CANCEL" }] })).rejects.toMatchObject({ code: "failed" });
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "rename", key: "UI_OK", newKey: "UI_OK" }] })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "rename", key: "NOPE", newKey: "X" }] })).rejects.toMatchObject({ code: "failed" });
    expect(await tp.read(UI)).toBe(before);
    expect((await cellsOf(UI, "UI_OK"))["textStatus@ko"]).toMatchObject({ value: "done" });
    expect((await cellsOf(UI, "UI_CANCEL"))["textStatus@ko"]).toMatchObject({ value: "todo" });
  });

  it("変更は書いた順に当てる（足した行のキーを続けて変えられる）", async () => {
    await ws.editEntries({
      resourceId: UI,
      changes: [
        { type: "add", key: "TMP", after: "UI_OK", text: { ja: "仮" } },
        { type: "rename", key: "TMP", newKey: "UI_FINAL" },
        { type: "remove", key: "UI_GOLD" },
      ],
    });
    expect(await keys(UI)).toEqual(["UI_OK", "UI_FINAL", "UI_CANCEL", "UI_SAVE_CONFIRM"]);
  });
});

describe("editEntries: 列ソース・フック・フォーマットとのやりとり", () => {
  it("列ソースには、設定の名前ごとに 1 回ずつ、当てた変更をそのまま知らせる", async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
    await configure({
      sources: { memoA: { use: "t.memo", options: { name: "A" } }, memoB: { use: "t.memo", options: { name: "B" } } },
      columns: [
        ...config.columns,
        { id: "m1", kind: "meta", scope: "entry", source: "memoA", type: "string" },
        { id: "m2", kind: "meta", scope: "language", source: "memoA", type: "string" },
        { id: "m3", kind: "meta", scope: "entry", source: "memoB", type: "string" },
      ],
    });
    await ws.editEntries({ resourceId: UI, changes: [{ type: "rename", key: "UI_OK", newKey: "UI_X" }, { type: "remove", key: "UI_GOLD" }] });
    expect(told).toEqual([
      { source: "A", resource: UI, changes: [{ type: "rename", key: "UI_OK", newKey: "UI_X" }, { type: "remove", key: "UI_GOLD" }] },
      { source: "B", resource: UI, changes: [{ type: "rename", key: "UI_OK", newKey: "UI_X" }, { type: "remove", key: "UI_GOLD" }] },
    ]);
  });

  it("フック: entries.change の前 → resource.write の前、の順に呼ばれ、before で止めるとリソースは変わらない", async () => {
    await configure({ hooks: [{ use: "t.log", options: { keep: "UI_GOLD" } }] });
    const before = await tp.read(UI);
    await expect(ws.editEntries({ resourceId: UI, changes: [{ type: "remove", key: "UI_GOLD" }] })).rejects.toMatchObject({ code: "blocked", message: "この行は消せません" });
    expect(await tp.read(UI)).toBe(before);
    expect(events.map((e) => e.type)).toEqual(["entries.change"]);
    events = [];
    await ws.editEntries({ resourceId: UI, changes: [{ type: "remove", key: "UI_CANCEL" }] });
    expect(events.map((e) => e.type)).toEqual(["entries.change", "resource.write"]);
    expect(events[0]).toMatchObject({ resource: { id: UI }, changes: [{ type: "remove", key: "UI_CANCEL" }] });
  });

  it("行の変更を黙って無視するフォーマットでは、書かずに失敗にする", async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { formats: { options: unknown }[] };
    await configure({ formats: [{ use: "t.silent", match: "**/ui.csv", options: config.formats[0]!.options }, ...config.formats] });
    const before = await tp.read(UI);
    for (const change of [{ type: "add", key: "X" }, { type: "remove", key: "UI_OK" }, { type: "rename", key: "UI_OK", newKey: "X" }] as const) {
      await expect(ws.editEntries({ resourceId: UI, changes: [change] })).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("対応していません") });
    }
    expect(await tp.read(UI)).toBe(before);
    // ほかのリソース（CSV のフォーマット）は変えられる。
    await ws.editEntries({ resourceId: CHAPTER, changes: [{ type: "add", key: "CH01_X" }] });
    expect((await lines(CHAPTER)).at(-1)).toBe("CH01_X,,,,,");
  });
});

describe("安定 ID と行番号", () => {
  const SID = "Assets/Text/sid.csv";
  const HEADER = "ID,JP,EN,CN,KR,MaxLen,SID";

  beforeEach(async () => {
    await tp.write(SID, [HEADER, "S_A,あ,a,,아,,id-1", "S_B,い,b,,이,,id-2", "S_C,う,c,,우,,"].join("\n") + "\n");
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { formats: { options: Record<string, unknown> }[] };
    await configure({ formats: [{ ...config.formats[0], options: { ...config.formats[0]!.options, stableId: "SID" } }] });
  });

  it("行の情報に、リソースの中の行番号と安定 ID が入る", async () => {
    const { rows } = await ws.rows({ resourceId: SID, languages: ["ja"], offset: 0, limit: 10 });
    expect(rows.map((r) => [r.key, r.line, r.stableId])).toEqual([
      ["S_A", 2, "id-1"],
      ["S_B", 3, "id-2"],
      ["S_C", 4, undefined],
    ]);
  });

  it("外部でキーが書き換えられても、安定 ID が同じ行にはステータスと履歴が付いてくる", async () => {
    await ws.setCell({ resourceId: SID, key: "S_A", cellId: "textStatus@ko", value: "done" });
    await ws.setCell({ resourceId: SID, key: "S_C", cellId: "textStatus@ko", value: "done" });
    // アプリの外で、行の順を入れ替え、キーを変える（S_A → S_RENAMED、安定 ID のない S_C → S_C2）。
    await tp.write(SID, [HEADER, "S_B,い,b,,이,,id-2", "S_RENAMED,あ,a,,아,,id-1", "S_C2,う,c,,우,,"].join("\n") + "\n");
    await ws.reloadResource({ resourceId: SID });
    expect((await cellsOf(SID, "S_RENAMED"))["textStatus@ko"]).toMatchObject({ value: "done" });
    expect((await ws.history({ resourceId: SID, key: "S_RENAMED" })).map((h) => h.newValue)).toEqual(["done"]);
    expect(await ws.history({ resourceId: SID, key: "S_A" })).toEqual([]);
    // 安定 ID のない行は、別の行として扱う（記録は付いてこない）。
    expect((await cellsOf(SID, "S_C2"))["textStatus@ko"]).toMatchObject({ value: "todo" });
    expect((await cellsOf(SID, "S_B"))["textStatus@ko"]).toMatchObject({ value: "todo" });
  });

  it("古いキーの行が残っているなら、記録は動かさない（安定 ID を別の行に付け替えただけ）", async () => {
    await ws.setCell({ resourceId: SID, key: "S_A", cellId: "textStatus@ko", value: "done" });
    await tp.write(SID, [HEADER, "S_A,あ,a,,아,,", "S_B,い,b,,이,,id-2", "S_C,う,c,,우,,id-1"].join("\n") + "\n");
    await ws.reloadResource({ resourceId: SID });
    expect((await cellsOf(SID, "S_A"))["textStatus@ko"]).toMatchObject({ value: "done" });
    expect((await cellsOf(SID, "S_C"))["textStatus@ko"]).toMatchObject({ value: "todo" });
  });

  it("アプリを開き直したあとでも追従する（覚えは共有 DB に置く）。画面からのキーの変更とも食い違わない", async () => {
    await ws.setCell({ resourceId: SID, key: "S_B", cellId: "textStatus@ko", value: "done" });
    await ws.editEntries({ resourceId: SID, changes: [{ type: "rename", key: "S_B", newKey: "S_B2" }] });
    expect((await cellsOf(SID, "S_B2"))["textStatus@ko"]).toMatchObject({ value: "done" });
    await ws.close();
    await tp.write(SID, (await tp.read(SID)).replace("S_B2,", "S_B3,"));
    const ws2 = await tp.open();
    expect((await ws2.rowDetail({ resourceId: SID, key: "S_B3" })).row.cells["textStatus@ko"]).toMatchObject({ value: "done" });
  });
});

describe("createResource", () => {
  const NEW = "Assets/Text/dlc/new.csv";

  it("フォーマットの設定どおりの見出しだけのリソースを作り、ツリーに出て、行を足せる", async () => {
    expect(await ws.createResource({ path: NEW })).toEqual({ resource: { id: NEW, path: NEW, name: "new.csv" } });
    expect(await tp.read(NEW)).toBe("ID,JP,EN,CN,KR,MaxLen\n");
    expect(resourceIds(await ws.tree())).toContain(NEW);
    await ws.editEntries({ resourceId: NEW, changes: [{ type: "add", key: "DLC_1", text: { ja: "追加" } }] });
    expect(await tp.read(NEW)).toBe("ID,JP,EN,CN,KR,MaxLen\nDLC_1,追加,,,,\n");
  });

  it("すでにあるリソースは上書きしない。ツリーの対象外の場所、外に出るパス、フォーマットのない拡張子には作らない", async () => {
    const before = await tp.read(UI);
    await expect(ws.createResource({ path: UI })).rejects.toMatchObject({ code: "conflict" });
    expect(await tp.read(UI)).toBe(before);
    await expect(ws.createResource({ path: "Other/new.csv" })).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("include") });
    for (const escape of ["Assets/Text/../../../escape.csv", "../escape.csv", "/escape.csv", "C:/escape.csv", "Assets\\Text\\x.csv", "Assets//x.csv", "./x.csv"]) {
      await expect(ws.createResource({ path: escape }), escape).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(readFile(path.join(tp.tmp, "escape.csv"))).rejects.toThrow();
    await expect(ws.createResource({ path: "Assets/Text/new.txt" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("フォーマット") });
    await expect(ws.createResource({ path: "" })).rejects.toMatchObject({ code: "invalid" });
    await expect(tp.read("Other/new.csv")).rejects.toThrow();
    await expect(tp.read("Assets/Text/new.txt")).rejects.toThrow();
  });

  it("作成に対応していないツリーやフォーマットでは、理由つきで断る", async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { formats: { options: unknown }[] };
    await configure({ formats: [{ use: "t.silent", match: "**/silent/*.csv", options: config.formats[0]!.options }, ...config.formats] });
    await expect(ws.createResource({ path: "Assets/Text/silent/a.csv" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('"t.silent"') });
    await configure({ tree: "t.fixed" });
    await expect(ws.createResource({ path: NEW })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('"t.fixed"') });
  });

  it("フック: 作る前に resource.write の before が呼ばれ、止めると何も作らない", async () => {
    await configure({ hooks: ["t.log"] });
    await ws.createResource({ path: NEW });
    expect(events).toEqual([{ type: "resource.write", resource: { id: NEW, path: NEW, name: "new.csv" } }]);
  });
});

describe("権限（Web モード）", () => {
  const as = (name: string, role: string): CallContext => ({ user: { name }, role });
  const codeOf = (r: Awaited<ReturnType<typeof dispatch>>): string | undefined => ("error" in r ? r.error.code : undefined);

  it("structure の権限がある役割だけが、行を変え、リソースを作れる。見えないリソースや場所は対象にできない", async () => {
    await configure({ roles: { planner: { can: ["structure"], resources: ["Assets/Text/system/**"] } } });
    const change = { resourceId: UI, changes: [{ type: "add", key: "P_1" }] };
    expect(codeOf(await dispatch(ws, "editEntries", change, as("t", "translator")))).toBe("forbidden");
    expect(codeOf(await dispatch(ws, "createResource", { path: "Assets/Text/system/t.csv" }, as("t", "translator")))).toBe("forbidden");
    expect(codeOf(await dispatch(ws, "editEntries", change, as("p", "planner")))).toBeUndefined();
    expect(codeOf(await dispatch(ws, "editEntries", { resourceId: CHAPTER, changes: [{ type: "add", key: "P_2" }] }, as("p", "planner")))).toBe("not-found");
    expect(codeOf(await dispatch(ws, "createResource", { path: "Assets/Text/dlc/p.csv" }, as("p", "planner")))).toBe("forbidden");
    expect(codeOf(await dispatch(ws, "createResource", { path: "Assets/Text/system/p.csv" }, as("p", "planner")))).toBeUndefined();
    expect(await tp.read(CHAPTER)).not.toContain("P_2");
    await expect(tp.read("Assets/Text/dlc/p.csv")).rejects.toThrow();
    // 同梱の役割では manager だけ。
    expect(codeOf(await dispatch(ws, "editEntries", { resourceId: UI, changes: [{ type: "add", key: "M_1" }] }, as("m", "manager")))).toBeUndefined();
  });
});
