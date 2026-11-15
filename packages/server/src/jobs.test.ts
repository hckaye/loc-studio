import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeneratorInput, Plugin } from "@loc-studio/sdk";
import type { Workspace } from "./api-types.js";
import { CHAPTER, makeTestProject, sleep, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

const gen = { calls: 0, inputs: [] as GeneratorInput[], failTimes: 0, delayMs: 0 };
const fakePlugin: Plugin = {
  name: "fake-jobs",
  generators: [
    {
      id: "fake.reverse",
      version: "1",
      batchSize: 2,
      retries: 2,
      cacheParams: (o) => ({ suffix: o.suffix }),
      input: (ctx) => {
        const text = ctx.language ? ctx.row.text(ctx.language.id) : undefined;
        return text ? { text, language: ctx.language!.id } : null;
      },
      async run(inputs, ctx) {
        gen.calls++;
        if (gen.delayMs > 0) await sleep(gen.delayMs);
        if (gen.failTimes > 0) {
          gen.failTimes--;
          throw new Error("一時的な失敗");
        }
        gen.inputs.push(...inputs);
        return inputs.map((i) => ({ value: `${[...i.text].reverse().join("")}${String(ctx.options.suffix ?? "")}` }));
      },
    },
  ],
  actions: [
    {
      id: "fake.upper",
      label: "大文字",
      target: "cell",
      columns: ["text"],
      async run(ctx) {
        return {
          patches: [
            { resourceId: ctx.entry!.resource.id, entryKey: ctx.entry!.key, columnId: "text", language: ctx.language!.id, value: String(ctx.value).toUpperCase() },
          ],
          message: `${ctx.entry!.key} を変えました`,
        };
      },
    },
    {
      id: "fake.mark",
      label: "作業中にする",
      target: "row",
      when: (ctx) => ctx.entry!.key !== "UI_CANCEL",
      async run(ctx) {
        return { patches: [{ resourceId: ctx.entry!.resource.id, entryKey: ctx.entry!.key, columnId: "textStatus", language: "ko", value: "wip" }] };
      },
    },
    {
      id: "fake.count",
      label: "数える",
      target: "selection",
      async run(ctx) {
        return { message: `${ctx.entries!.length} 行`, open: { url: "https://example.com/" } };
      },
    },
    {
      id: "fake.file",
      label: "ファイル",
      target: "file",
      async run(ctx) {
        return { message: `${ctx.entries!.length} 行`, patches: [{ resourceId: UI, entryKey: "UI_OK", columnId: "nope", value: 1 }] };
      },
    },
  ],
};

let tp: TestProject;
let ws: Workspace;
beforeEach(async () => {
  Object.assign(gen, { calls: 0, inputs: [], failTimes: 0, delayMs: 0 });
  tp = await makeTestProject({ plugins: [fakePlugin] });
  const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
  await tp.patchConfig({
    columns: [...config.columns, { id: "back", kind: "generated", scope: "language", generator: "backTr", languages: ["JaEnglish", "ko"] }],
    generators: { backTr: { use: "fake.reverse", options: { suffix: "!" } } },
    actions: ["fake.upper", "fake.mark", "fake.count", "fake.file"],
  });
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

describe("generate", () => {
  it("dryRun は件数だけ、生成のあとは fresh、2 回目はキャッシュ", async () => {
    const dry = await ws.generate({ columnId: "back", scope: "resource", resourceId: UI, dryRun: true });
    expect(dry).toEqual({ total: 8, cached: 0, toRun: 8 });
    expect(gen.calls).toBe(0);
    let r = await ws.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 1 });
    expect(r.rows[0]!.cells["back@ko"]).toEqual({ value: undefined, generated: "missing" });

    const run = await ws.generate({ columnId: "back", scope: "resource", resourceId: UI });
    expect(run).toMatchObject({ total: 8, cached: 0, toRun: 8 });
    const job = await ws.waitForJob(run.jobId!);
    expect(job).toMatchObject({ status: "done", done: 8, failed: 0, kind: "generate", startedBy: "tester" });
    expect(gen.calls).toBe(4); // batchSize 2
    r = await ws.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 1 });
    expect(r.rows[0]!.cells["back@ko"]).toEqual({ value: "인확!", generated: "fresh" });

    const again = await ws.generate({ columnId: "back", scope: "resource", resourceId: UI });
    expect(again).toEqual({ total: 8, cached: 8, toRun: 0 });
    expect(gen.calls).toBe(4);
    expect((await ws.jobs()).map((j) => j.id)).toContain(run.jobId);
    expect(await ws.job({ id: run.jobId! })).toMatchObject({ status: "done" });
  });

  it("入力が変わると stale、生成し直すと fresh", async () => {
    const run = await ws.generate({ columnId: "back", scope: "cell", resourceId: UI, keys: ["UI_OK"], languages: ["ko"] });
    expect(run.toRun).toBe(1);
    await ws.waitForJob(run.jobId!);
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    let c = (await ws.rowDetail({ resourceId: UI, key: "UI_OK" })).row.cells["back@ko"]!;
    expect(c).toEqual({ value: "인확!", generated: "stale", stale: true });
    const stale = await ws.rows({ resourceId: UI, languages: ["ko"], offset: 0, limit: 10, onlyStale: true });
    expect(stale.rows.map((x) => x.key)).toEqual(["UI_OK"]);
    // 元に戻すとキャッシュの結果がまた使える。
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "확인" });
    c = (await ws.rowDetail({ resourceId: UI, key: "UI_OK" })).row.cells["back@ko"]!;
    expect(c.generated).toBe("fresh");
    await ws.setText({ resourceId: UI, key: "UI_OK", language: "ko", value: "좋아" });
    const r2 = await ws.generate({ columnId: "back", scope: "selection", resourceId: UI, keys: ["UI_OK"], languages: ["ko"] });
    await ws.waitForJob(r2.jobId!);
    c = (await ws.rowDetail({ resourceId: UI, key: "UI_OK" })).row.cells["back@ko"]!;
    expect(c).toEqual({ value: "아좋!", generated: "fresh" });
  });

  it("失敗したら retries の回数まで試す", async () => {
    gen.failTimes = 2;
    const run = await ws.generate({ columnId: "back", scope: "cell", resourceId: UI, keys: ["UI_OK"], languages: ["ko"] });
    expect(await ws.waitForJob(run.jobId!)).toMatchObject({ status: "done", done: 1 });
    expect(gen.calls).toBe(3);
  });

  it("retries を超えて失敗したら failed（済んだ分は残る）", async () => {
    gen.failTimes = 100;
    const run = await ws.generate({ columnId: "back", scope: "cell", resourceId: UI, keys: ["UI_OK"], languages: ["ko"] });
    const job = await ws.waitForJob(run.jobId!);
    expect(job).toMatchObject({ status: "failed", done: 0, failed: 1 });
    expect(job.error).toContain("一時的な失敗");
  });

  it("cancelJob はバッチの合間に止める", async () => {
    gen.delayMs = 40;
    const run = await ws.generate({ columnId: "back", scope: "project" });
    expect(run.total).toBe(23); // 12 行 × 2 言語。空の本文（CH01_CHOICE_001B の ko）は入力なし
    await sleep(60);
    const c = await ws.cancelJob({ id: run.jobId! });
    expect(["running", "queued"]).toContain(c.status);
    const job = await ws.waitForJob(run.jobId!);
    expect(job.status).toBe("cancelled");
    expect(job.done).toBeGreaterThan(0);
    expect(job.done).toBeLessThan(23);
    // 済んだ分はキャッシュに残る。
    const dry = await ws.generate({ columnId: "back", scope: "project", dryRun: true });
    expect(dry.cached).toBe(job.done);
  });

  it("生成列でない列・知らない列", async () => {
    await expect(ws.generate({ columnId: "textStatus", scope: "project" })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.generate({ columnId: "nope", scope: "project" })).rejects.toMatchObject({ code: "not-found" });
    await expect(ws.cancelJob({ id: "nope" })).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("runAction", () => {
  it("cell: 行ごとに実行し、本文の変更点はドラフトに積む（cause: action）", async () => {
    const r = await ws.runAction({ actionId: "fake.upper", resourceId: UI, keys: ["UI_OK", "UI_CANCEL"], cellId: "text@JaEnglish" });
    expect(r).toMatchObject({ patched: 2, message: "UI_OK を変えました\nUI_CANCEL を変えました" });
    const rows = await ws.rows({ resourceId: UI, languages: ["JaEnglish"], offset: 0, limit: 2 });
    expect(rows.rows.map((x) => x.cells["text@JaEnglish"]!.value)).toEqual(["OK", "CANCEL"]);
    expect(rows.rows[1]!.cells["text@JaEnglish"]!.draft).toBe(true);
    await ws.save({ resourceId: UI });
    const h = await ws.history({ resourceId: UI, key: "UI_CANCEL" });
    expect(h[0]).toMatchObject({ cause: "action", causeRef: "fake.upper", newValue: "CANCEL" });
  });

  it("row: when が false の行は飛ばし、列の変更点は setCell と同じ規則で反映する", async () => {
    const r = await ws.runAction({ actionId: "fake.mark", resourceId: UI, keys: ["UI_OK", "UI_CANCEL"] });
    expect(r.patched).toBe(1);
    const d = await ws.rowDetail({ resourceId: UI, key: "UI_OK" });
    expect(d.row.cells["textStatus@ko"]).toMatchObject({ value: "wip", version: 1 });
    expect((await ws.rowDetail({ resourceId: UI, key: "UI_CANCEL" })).row.cells["textStatus@ko"]!.value).toBe("todo");
    expect((await ws.history({ resourceId: UI, key: "UI_OK" }))[0]).toMatchObject({ cause: "action", causeRef: "fake.mark" });
  });

  it("selection / file は 1 回だけ。反映できない変更点は errors に出す", async () => {
    const s = await ws.runAction({ actionId: "fake.count", resourceId: CHAPTER, keys: ["CH01_INTRO_001", "CH01_INTRO_002"] });
    expect(s).toEqual({ patched: 0, message: "2 行", open: { url: "https://example.com/" } });
    const f = await ws.runAction({ actionId: "fake.file", resourceId: CHAPTER });
    expect(f.message).toBe("8 行");
    expect(f.patched).toBe(0);
    expect(f.errors).toHaveLength(1);
  });

  it("20 行を超えるとジョブにする", async () => {
    const lines = ["ID,JP,EN,CN,KR,MaxLen", ...Array.from({ length: 30 }, (_, i) => `K${i},本文${i},text${i},,,`)];
    await tp.write("Assets/Text/big.csv", lines.join("\n") + "\n");
    const keys = Array.from({ length: 30 }, (_, i) => `K${i}`);
    const r = await ws.runAction({ actionId: "fake.upper", resourceId: "Assets/Text/big.csv", keys, cellId: "text@JaEnglish" });
    expect(r.patched).toBe(0);
    expect(r.jobId).toBeDefined();
    const job = await ws.waitForJob(r.jobId!);
    expect(job).toMatchObject({ kind: "action", status: "done", done: 30, total: 30 });
    expect((await ws.tree()).find((n) => n.unsaved)?.unsaved).toBe(30);
  });

  it("引数の誤り", async () => {
    await expect(ws.runAction({ actionId: "nope", resourceId: UI })).rejects.toMatchObject({ code: "not-found" });
    await expect(ws.runAction({ actionId: "fake.upper", resourceId: UI, keys: ["UI_OK"] })).rejects.toMatchObject({ code: "invalid" });
    await expect(ws.runAction({ actionId: "fake.upper", resourceId: UI, keys: ["UI_OK"], cellId: "textStatus@ko" })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(ws.runAction({ actionId: "fake.mark", resourceId: UI })).rejects.toMatchObject({ code: "invalid" });
  });
});
