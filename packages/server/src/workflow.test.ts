/**
 * ワークフロー: フック（書き込みの前後）、選択肢の遷移の制限（from / roles）、プラグインがプロジェクトを読む窓口（host.project）。
 * どれも本物のワークスペース（一時フォルダのサンプルプロジェクト、SQLite、CSV）に、本物のプラグインを登録して確かめる。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Plugin, WorkflowEvent } from "@loc-studio/sdk";
import type { CallContext, Workspace } from "./api-types.js";
import { dispatch } from "./rpc.js";
import { CHAPTER, makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

const as = (name: string, role: string, extra: Partial<CallContext> = {}): CallContext => ({ user: { name }, role, ...extra });
const codeOf = (r: Awaited<ReturnType<typeof dispatch>>): string | undefined => ("error" in r ? r.error.code : undefined);
const resultOf = <T>(r: Awaited<ReturnType<typeof dispatch>>): T => {
  expect(r).toHaveProperty("result");
  return (r as { result: T }).result;
};

/** フックが受け取ったできごとの記録（「どのフックの、前後どちらで、何が」）。 */
let seen: { hook: string; phase: "before" | "after"; event: WorkflowEvent; user: { name: string; role: string | undefined } }[];
/** file 対象のアクションが読んだ行。 */
let exported: { key: string; ja: string | undefined; ko: string | undefined; status: unknown; max: unknown }[];
let readerSnapshot: { resources: string[]; rows: { key: string; ko: string | undefined; status: unknown }[]; role: string | undefined } | undefined;

const summary = () => seen.map((s) => `${s.hook}:${s.phase}:${s.event.type}`);

const plugin: Plugin = {
  name: "workflow-test",
  hooks: [
    {
      // すべてのできごとを記録する。
      id: "wf.log",
      before: (event, ctx) => void seen.push({ hook: "wf.log", phase: "before", event, user: { name: ctx.host.user.name, role: ctx.host.user.role } }),
      after: (event, ctx) => void seen.push({ hook: "wf.log", phase: "after", event, user: { name: ctx.host.user.name, role: ctx.host.user.role } }),
    },
    {
      // options.locked に並んだキーの行は、ステータスを変えさせない。
      id: "wf.guard",
      events: ["cells.set"],
      before(event, ctx) {
        if (event.type !== "cells.set") return "呼ばれるはずのないできごと";
        const locked = (ctx.options["locked"] as string[] | undefined) ?? [];
        const hit = event.changes.find((c) => locked.includes(c.cell.entryKey));
        return hit ? `${hit.cell.entryKey} は凍結されています` : undefined;
      },
    },
    {
      // 本文を保存したら、その言語のステータスを作業中に戻す。差し戻しのレビューでも戻す。
      id: "wf.reset",
      events: ["text.save", "review.post"],
      after(event) {
        if (event.type === "text.save") {
          return { patches: event.changes.map((c) => ({ resourceId: c.cell.resourceId, entryKey: c.cell.entryKey, columnId: "textStatus", language: c.cell.language!, value: "wip" })) };
        }
        if (event.type === "review.post" && event.verdict === "back") {
          return { patches: [{ resourceId: event.cell.resourceId, entryKey: event.cell.entryKey, columnId: "textStatus", language: event.cell.language!, value: "wip" }] };
        }
        return undefined;
      },
    },
    {
      // リソースを書く前の確認（チェックアウトできないリソースは書かせない）。
      id: "wf.checkout",
      events: ["resource.write"],
      before: (event, ctx) => (event.resource.path === ctx.options["readOnly"] ? `${event.resource.path} はチェックアウトできません` : undefined),
      // resource.write の after は変更点を返せない（返しても反映されず、警告になる）。
      after: (event) => ({ patches: [{ resourceId: event.resource.id, entryKey: "UI_OK", columnId: "textStatus", language: "ja", value: "done" }] }),
    },
    { id: "wf.throwBefore", events: ["cells.set"], before: () => { throw new Error("前で壊れた"); } },
    { id: "wf.throwAfter", events: ["cells.set"], after: () => { throw new Error("後で壊れた"); } },
    {
      // ホストの窓口でプロジェクトを読む。
      id: "wf.reader",
      events: ["cells.set"],
      async after(_event, ctx) {
        const resources = (await ctx.host.project.resources()).map((r) => r.id);
        const rows = await ctx.host.project.rows(UI, { keys: ["UI_OK", "UI_CANCEL"], columns: ["textStatus"] });
        readerSnapshot = {
          resources,
          rows: rows.map((r) => ({ key: r.entry.key, ko: r.row.text("ko"), status: r.row.get("textStatus", "ko") })),
          role: ctx.host.user.role,
        };
      },
    },
  ],
  actions: [
    {
      id: "wf.export",
      label: "書き出す",
      target: "file",
      async run(ctx) {
        exported = ctx.entries!.map((e, i) => ({
          key: e.key,
          ja: ctx.rows![i]!.text("ja"),
          ko: ctx.rows![i]!.text("ko"),
          status: ctx.rows![i]!.get("textStatus", "ko"),
          max: ctx.rows![i]!.get("maxLength"),
        }));
        return { message: `${exported.length} 行` };
      },
    },
    {
      id: "wf.markDone",
      label: "確定にする",
      target: "row",
      run: async (ctx) => ({ patches: [{ resourceId: ctx.entry!.resource.id, entryKey: ctx.entry!.key, columnId: "textStatus", language: "ko", value: "done" }] }),
    },
  ],
};

let tp: TestProject;
let ws: Workspace;

async function configure(patch: Record<string, unknown>): Promise<void> {
  await tp.patchConfig(patch);
  await ws.reloadPlugins();
}

beforeEach(async () => {
  seen = [];
  exported = [];
  readerSnapshot = undefined;
  tp = await makeTestProject({ plugins: [plugin] });
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

const status = async (key: string, language: string, resourceId = UI) =>
  (await ws.rowDetail({ resourceId, key })).row.cells[`textStatus@${language}`]!.value;

describe("フック: 呼ばれる順と受け取る値", () => {
  it("設定の hooks にないフックは呼ばれない。登録されていない ID は警告になる", async () => {
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" });
    expect(seen).toEqual([]);
    await configure({ hooks: ["wf.log", "wf.nope"] });
    expect((await ws.info()).warnings.filter((w) => w.includes("wf.nope"))).toHaveLength(1);
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    expect(summary()).toEqual(["wf.log:before:cells.set", "wf.log:after:cells.set"]);
  });

  it("cells.set: 前後に 1 回ずつ。変える前の値（なければ列の既定値）と新しい値、きっかけ、利用者を受け取る", async () => {
    await configure({ hooks: ["wf.log"], actions: ["wf.markDone"] });
    await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" }, as("kim", "translator"));
    expect(seen).toHaveLength(2);
    const [before, after] = seen;
    expect(before!.event).toMatchObject({
      type: "cells.set",
      resource: { id: UI },
      column: { id: "textStatus" },
      language: { id: "ko" },
      cause: "manual",
      changes: [{ cell: { resourceId: UI, entryKey: "UI_OK", columnId: "textStatus", language: "ko" }, oldValue: "todo", newValue: "wip" }],
    });
    expect(after!.event).toEqual(before!.event);
    expect(before!.user).toEqual({ name: "kim", role: "translator" });

    // 一括の変更は 1 回のできごとにまとまり、アクションの変更点はきっかけが action になる。
    seen = [];
    await ws.setCells({ resourceId: UI, keys: ["UI_OK", "UI_CANCEL"], cellId: "textStatus@ko", value: "done" });
    expect(seen.map((s) => (s.event.type === "cells.set" ? [s.phase, s.event.cause, s.event.changes.map((c) => `${c.cell.entryKey}:${String(c.oldValue)}>${String(c.newValue)}`)] : [])))
      .toEqual([
        ["before", "bulk", ["UI_OK:wip>done", "UI_CANCEL:todo>done"]],
        ["after", "bulk", ["UI_OK:wip>done", "UI_CANCEL:todo>done"]],
      ]);
    seen = [];
    await ws.runAction({ actionId: "wf.markDone", resourceId: UI, keys: ["UI_SAVE_CONFIRM"] });
    expect(seen.map((s) => (s.event.type === "cells.set" ? s.event.cause : s.event.type))).toEqual(["action", "action"]);
    // ローカルモード（呼び出しの利用者がない）では、役割は undefined。
    expect(seen[0]!.user).toEqual({ name: "tester", role: undefined });
  });

  it("本文の保存: text.save の前 → resource.write の前後 → text.save のあと、の順。下書き（setText）ではフックを呼ばない", async () => {
    await configure({ hooks: ["wf.log"] });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    await ws.setText({ resourceId: UI, key: "UI_CANCEL", language: "ja", value: "やめる" });
    expect(seen).toEqual([]);
    await ws.save({ resourceId: UI });
    expect(summary()).toEqual(["wf.log:before:text.save", "wf.log:before:resource.write", "wf.log:after:resource.write", "wf.log:after:text.save"]);
    const save = seen[0]!.event;
    expect(save.type === "text.save" && save.changes.map((c) => [c.cell.entryKey, c.cell.language, c.oldValue, c.newValue]).sort()).toEqual([
      ["UI_CANCEL", "ja", "キャンセル", "やめる"],
      ["UI_OK", "ko", "확인", "좋아"],
    ]);
    // 保存するものがなければ、何も呼ばない。
    seen = [];
    await ws.save({ resourceId: UI });
    expect(seen).toEqual([]);
  });

  it("events で受け取る種類を絞れる。フックは設定に書いた順に呼ぶ", async () => {
    await configure({ hooks: ["wf.guard", "wf.log", "wf.reset"] });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    await ws.save({ resourceId: UI });
    // wf.guard（cells.set だけ）は text.save では呼ばれないので、止める理由を返す分岐にも入らない。
    expect(await tp.read(UI)).toContain("좋아");
    await configure({ hooks: ["wf.log", "wf.guard"], actions: [] });
    seen = [];
    const r = await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ja", value: "wip" });
    expect(codeOf(r)).toBeUndefined();
    expect(summary()).toEqual(["wf.log:before:cells.set", "wf.log:after:cells.set"]);
  });
});

describe("フック: before で書き込みを止める", () => {
  it("理由を返すと blocked になり、値も履歴も変わらない。後ろのフックも after も呼ばれない", async () => {
    await configure({ hooks: [{ use: "wf.guard", options: { locked: ["UI_OK"] } }, "wf.log"] });
    const r = await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    expect(r).toMatchObject({ error: { code: "blocked", message: "UI_OK は凍結されています", data: { hook: "wf.guard" } } });
    expect(await status("UI_OK", "ko")).toBe("todo");
    expect(await ws.history({ resourceId: UI, key: "UI_OK" })).toEqual([]);
    expect(seen).toEqual([]);
    // 一括の変更は、1 行でも止められたら全体をやめる（半分だけ変わった状態を作らない）。
    expect(codeOf(await dispatch(ws, "setCells", { resourceId: UI, keys: ["UI_CANCEL", "UI_OK"], cellId: "textStatus@ko", value: "done" }))).toBe("blocked");
    expect(await status("UI_CANCEL", "ko")).toBe("todo");
    // 凍結されていない行は変えられる。
    expect(codeOf(await dispatch(ws, "setCell", { resourceId: UI, key: "UI_CANCEL", cellId: "textStatus@ko", value: "done" }))).toBeUndefined();
    expect(await status("UI_CANCEL", "ko")).toBe("done");
  });

  it("resource.write を止めると、リソースは変わらず、未保存の編集は残る。リソースの中の列の変更も止まる", async () => {
    const maxLength = { id: "maxLength", kind: "meta", scope: "entry", type: "string", label: "上限" };
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
    await configure({ columns: [...config.columns, maxLength], hooks: [{ use: "wf.checkout", options: { readOnly: UI } }] });
    const original = await tp.read(UI);
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    await expect(ws.save({ resourceId: UI })).rejects.toMatchObject({ code: "blocked", message: `${UI} はチェックアウトできません` });
    await expect(ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "maxLength", value: "9" })).rejects.toMatchObject({ code: "blocked" });
    expect(await tp.read(UI)).toBe(original);
    expect((await ws.rowDetail({ resourceId: UI, key: "UI_OK" })).row.cells["text@ko"]).toMatchObject({ value: "좋아", draft: true });
    expect(await ws.history({ resourceId: UI, key: "UI_OK" })).toEqual([]);
    // ほかのリソースは書ける。resource.write の after が返した変更点は反映されず、警告になる。
    await ws.setText({ resourceId: CHAPTER, key: "CH01_INTRO_001", language: "ko", value: "깼구나." });
    expect(await ws.save({ resourceId: CHAPTER })).toMatchObject({ saved: 1 });
    expect(await tp.read(CHAPTER)).toContain("깼구나.");
    expect(await status("UI_OK", "ja")).toBe("todo");
    expect((await ws.info()).warnings.filter((w) => w.includes("wf.checkout") && w.includes("resource.write"))).toHaveLength(1);
  });

  it("before が例外を投げたら、書き込みをやめて failed にする（決まりを確かめられないまま書かない）", async () => {
    await configure({ hooks: ["wf.throwBefore"] });
    const r = await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    expect(r).toMatchObject({ error: { code: "failed", message: expect.stringContaining("前で壊れた"), data: { hook: "wf.throwBefore" } } });
    expect(await status("UI_OK", "ko")).toBe("todo");
  });
});

describe("フック: after の変更点", () => {
  it("after が例外を投げても、書き込みは残り、警告になる", async () => {
    await configure({ hooks: ["wf.throwAfter"] });
    expect(codeOf(await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" }))).toBeUndefined();
    expect(await status("UI_OK", "ko")).toBe("done");
    expect((await ws.info()).warnings.filter((w) => w.includes("wf.throwAfter") && w.includes("後で壊れた"))).toHaveLength(1);
  });

  it("本文を保存すると、フックの変更点でステータスが戻る。履歴にはフックがきっかけと残り、その変更でフックは呼ばれない", async () => {
    await configure({ hooks: ["wf.reset", "wf.log"] });
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    seen = [];
    await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" }, as("kim", "translator"));
    await dispatch(ws, "save", { resourceId: UI }, as("kim", "translator"));
    expect(await status("UI_OK", "ko")).toBe("wip");
    expect(await status("UI_OK", "ja")).toBe("todo"); // 保存していない言語は変わらない
    const h = await ws.history({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko" });
    expect(h[0]).toMatchObject({ oldValue: "done", newValue: "wip", cause: "hook", causeRef: "wf.reset", by: "kim" });
    // フックの変更点（cells.set）では、フックは呼ばれない（呼び合って止まらなくなるのを防ぐ）。
    expect(summary().filter((s) => s.includes("cells.set"))).toEqual([]);
  });

  it("フックの変更点は、利用者の役割の絞り込みや選択肢の遷移の制限にかかわらず反映する", async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: { id?: string }[] };
    const columns = config.columns.map((c) =>
      c.id === "textStatus"
        ? {
            ...c,
            type: {
              default: "todo",
              enum: [{ value: "todo" }, { value: "wip", from: ["todo"], roles: ["manager"] }, { value: "done", complete: true }],
            },
          }
        : c,
    );
    await configure({ columns, hooks: ["wf.reset"], roles: { writer: { can: ["edit"], editColumns: ["text"] } } });
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    const writer = as("wri", "writer");
    // writer はステータスの列を変えられず、done → wip の遷移も選択肢の決まりでは許されない。
    expect(codeOf(await dispatch(ws, "setCell", { resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" }, writer))).toBe("forbidden");
    await dispatch(ws, "setText", { resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" }, writer);
    expect(resultOf(await dispatch(ws, "save", { resourceId: UI }, writer))).toMatchObject({ saved: 1 });
    expect(await status("UI_OK", "ko")).toBe("wip");
  });

  it("差し戻しのレビューで、フックがステータスを戻す。review.post は前に判定とコメント、あとに保存された投稿を受け取る", async () => {
    await configure({ hooks: ["wf.reset", "wf.log"] });
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    seen = [];
    const post = await ws.postReview({ resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "back", comment: "語尾を直す" });
    expect(await status("UI_OK", "ko")).toBe("wip");
    expect(summary()).toEqual(["wf.log:before:review.post", "wf.log:after:review.post"]);
    expect(seen[0]!.event).toMatchObject({ type: "review.post", verdict: "back", comment: "語尾を直す", previous: "none", cell: { entryKey: "UI_OK", language: "ko" } });
    expect(seen[0]!.event).not.toHaveProperty("review");
    expect(seen[1]!.event).toMatchObject({ review: { id: post.id, verdict: "back", userName: "tester" } });
    // 承認ではステータスを変えない。
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
    await ws.postReview({ resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "ok", comment: "" });
    expect(await status("UI_OK", "ko")).toBe("done");
  });
});

describe("選択肢の遷移の制限（from / roles）", () => {
  beforeEach(async () => {
    const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: { id?: string }[] };
    const columns = config.columns.map((c) => {
      if (c.id === "textStatus") {
        return {
          ...c,
          type: {
            default: "todo",
            enum: [
              { value: "todo", label: "未着手" },
              { value: "wip", label: "作業中" },
              { value: "done", label: "確定", complete: true, from: ["wip"], roles: ["reviewer", "lead"] },
            ],
          },
        };
      }
      if (c.id === "reviewStatus") {
        return {
          ...c,
          type: {
            default: "none",
            enum: [{ value: "none" }, { value: "doing" }, { value: "back", requireComment: true }, { value: "ok", label: "承認", complete: true, from: ["doing"], roles: ["lead"] }],
          },
        };
      }
      return c;
    });
    await configure({ columns, roles: { reviewer: { can: ["edit", "review"] }, lead: { can: ["edit", "review"] } } });
  });

  const set = (key: string, value: string, call?: CallContext) => dispatch(ws, "setCell", { resourceId: UI, key, cellId: "textStatus@ko", value }, call);

  it("from: 書かれた値からだけ変えられる。値のないセルは列の既定値として扱う。同じ値への変更は通す", async () => {
    // ローカルモードでは roles は効かず、from だけが効く。
    expect(await set("UI_OK", "done")).toMatchObject({
      error: { code: "blocked", message: expect.stringMatching(/「未着手」から「確定」には変えられません.*作業中/), data: { transition: { from: "todo", to: "done" } } },
    });
    expect(await status("UI_OK", "ko")).toBe("todo");
    expect(codeOf(await set("UI_OK", "wip"))).toBeUndefined();
    expect(codeOf(await set("UI_OK", "done"))).toBeUndefined();
    expect(codeOf(await set("UI_OK", "done"))).toBeUndefined();
    // from のない値には、どこからでも変えられる。
    expect(codeOf(await set("UI_OK", "todo"))).toBeUndefined();
  });

  it("roles: 書かれた役割だけがその値を選べる。サーバーの管理者とローカルモードには効かない", async () => {
    await set("UI_OK", "wip");
    await set("UI_CANCEL", "wip");
    await set("UI_GOLD", "wip");
    expect(await set("UI_OK", "done", as("t", "translator"))).toMatchObject({ error: { code: "blocked", message: expect.stringContaining("reviewer / lead") } });
    expect(await status("UI_OK", "ko")).toBe("wip");
    expect(codeOf(await set("UI_OK", "done", as("r", "reviewer")))).toBeUndefined();
    expect(codeOf(await set("UI_CANCEL", "done", as("root", "translator", { admin: true })))).toBeUndefined();
    expect(codeOf(await set("UI_GOLD", "done"))).toBeUndefined();
    // roles のない値は、列を変えられる役割なら誰でも選べる。
    expect(codeOf(await set("UI_OK", "todo", as("t", "translator")))).toBeUndefined();
  });

  it("一括の変更: 遷移できない行は飛ばして blocked に入れ、できる行だけ変える", async () => {
    await set("UI_OK", "wip");
    const r = await ws.setCells({ resourceId: UI, keys: ["UI_OK", "UI_CANCEL", "UI_GOLD"], cellId: "textStatus@ko", value: "done" });
    expect(r).toEqual({ updated: 1, blocked: ["UI_CANCEL", "UI_GOLD"] });
    expect([await status("UI_OK", "ko"), await status("UI_CANCEL", "ko"), await status("UI_GOLD", "ko")]).toEqual(["done", "todo", "todo"]);
  });

  it("アクションの変更点にも効く（反映できなかった理由が errors に出る）", async () => {
    await configure({ actions: ["wf.markDone"] });
    const r = await ws.runAction({ actionId: "wf.markDone", resourceId: UI, keys: ["UI_OK"] });
    expect(r).toMatchObject({ patched: 0, errors: [expect.stringContaining("変えられません")] });
    expect(await status("UI_OK", "ko")).toBe("todo");
  });

  it("レビューの判定にも効く（直前の判定がいまの値）", async () => {
    const post = (verdict: string, call?: CallContext) =>
      dispatch(ws, "postReview", { resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict, comment: "x" }, call);
    expect(await post("ok", as("l", "lead"))).toMatchObject({ error: { code: "blocked", data: { transition: { from: "none", to: "ok" } } } });
    expect(codeOf(await post("doing", as("r", "reviewer")))).toBeUndefined();
    expect(await post("ok", as("r", "reviewer"))).toMatchObject({ error: { code: "blocked", message: expect.stringContaining("lead") } });
    expect(await ws.reviews({ resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko" })).toHaveLength(1);
    expect(codeOf(await post("ok", as("l", "lead")))).toBeUndefined();
  });
});

describe("プラグインがプロジェクトを読む（host.project と、アクションの rows）", () => {
  it("file 対象のアクションは、rows から各行の本文（未保存の編集を含む）と列の値を読める", async () => {
    await configure({ actions: ["wf.export"] });
    await ws.setCell({ resourceId: UI, key: "UI_CANCEL", cellId: "textStatus@ko", value: "wip" });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    expect(await ws.runAction({ actionId: "wf.export", resourceId: UI })).toMatchObject({ message: "4 行" });
    expect(exported).toEqual([
      { key: "UI_OK", ja: "決定", ko: "좋아", status: "todo", max: "4" },
      { key: "UI_CANCEL", ja: "キャンセル", ko: "취소", status: "wip", max: "6" },
      { key: "UI_SAVE_CONFIRM", ja: "セーブしますか？", ko: "저장하시겠습니까?", status: "todo", max: "12" },
      { key: "UI_GOLD", ja: "所持金：{gold} G", ko: "소지금: {gold} G", status: "todo", max: "" },
    ]);
  });

  it("host.project: リソースの一覧と行を読める。Web モードでは、利用者に見えるリソースだけ", async () => {
    await configure({ hooks: ["wf.reader"], roles: { vendor: { can: ["edit"], resources: ["Assets/Text/system/**"] } } });
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    await dispatch(ws, "setCell", { resourceId: UI, key: "UI_CANCEL", cellId: "textStatus@ko", value: "wip" }, as("ven", "vendor"));
    expect(readerSnapshot).toEqual({
      resources: [UI],
      rows: [
        { key: "UI_OK", ko: "좋아", status: "todo" },
        { key: "UI_CANCEL", ko: "취소", status: "wip" },
      ],
      role: "vendor",
    });
    await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "wip" });
    expect(readerSnapshot!.resources.sort()).toEqual([CHAPTER, UI].sort());
    expect(readerSnapshot!.role).toBeUndefined();
  });
});
