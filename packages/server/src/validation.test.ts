/**
 * 検証の対象: 本文以外の列のセルと、リソース全体を見るバリデータ。
 * 本物のワークスペース（CSV と SQLite）に本物のバリデータを登録して、画面と CLI が使う読み出しの結果で確かめる。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateProject } from "@loc-studio/core";
import type { Plugin } from "@loc-studio/sdk";
import type { IssueInfo, ValidateIssue, Workspace } from "./api-types.js";
import { makeTestProject, UI } from "./testing.js";
import type { TestProject } from "./testing.js";

const DUP = "Assets/Text/dup.csv";
const DUP_CSV = ["ID,JP,EN,CN,KR,MaxLen", "A,はい,Yes,,네,", "B,はい,Yes,,예,", "C,いいえ,No,,아니요,x1", "D,いいえ,No,,아니요,3"].join("\n") + "\n";

/** リソース全体のバリデータが呼ばれた回数（結果を覚えているかの確認用）。 */
let resourceRuns: string[];
let failResource: boolean;

const plugin: Plugin = {
  name: "validation-test",
  validators: [
    {
      // リソースの中の列（上限）は、数字だけ。raw には列の値がそのまま入る。
      id: "v.digits",
      label: "数字だけ",
      version: "1",
      columns: ["maxLength"],
      validate: (ctx) => (ctx.value !== "" && !/^\d+$/.test(ctx.value) ? [{ code: "not-number", message: `数字ではありません: ${String(ctx.raw)}` }] : []),
    },
    {
      // 列ソースの列（ステータス）: 本文が空のまま確定にしない。同じ行の本文を row で読む。
      id: "v.doneNeedsText",
      label: "確定には本文が要る",
      version: "1",
      columns: ["textStatus"],
      severity: "warning",
      validate: (ctx) => (ctx.raw === "done" && (ctx.row.text(ctx.language!.id) ?? "") === "" ? [{ code: "done-empty", message: "本文が空のまま確定になっています" }] : []),
    },
    {
      // リソース全体: 同じ原文（ja）なのに訳（ko）が行によって違う。
      id: "v.consistent",
      label: "訳の揺れ",
      version: "1",
      severity: "warning",
      validateResource(ctx) {
        resourceRuns.push(ctx.resource.id);
        if (failResource) throw new Error("辞書を読めません");
        const groups = new Map<string, { key: string; ko: string }[]>();
        for (const { entry, row } of ctx.rows) {
          const ja = row.text("ja") ?? "";
          if (ja === "") continue;
          groups.set(ja, [...(groups.get(ja) ?? []), { key: entry.key, ko: row.text("ko") ?? "" }]);
        }
        const out = [];
        for (const [ja, rows] of groups) {
          if (new Set(rows.map((r) => r.ko)).size < 2) continue;
          for (const r of rows) out.push({ key: r.key, language: "ko", code: "inconsistent", message: `「${ja}」の訳が行によって違います` });
        }
        // 本文以外の列のセルにも問題を付けられる。セルを特定できない問題は捨てられる。
        for (const { entry, row } of ctx.rows) {
          if (row.get("textStatus", "ko") === "done" && row.get("maxLength") === "x1") {
            out.push({ key: entry.key, columnId: "maxLength", code: "bad-limit-on-done", message: "確定した行の上限が不正です", severity: "error" as const });
          }
        }
        // 言語ごとの、本文以外の列のセル。
        for (const { entry, row } of ctx.rows) {
          if (entry.key === "D" && row.get("textStatus", "ko") === "wip") out.push({ key: "D", columnId: "textStatus", language: "ko", code: "stuck", message: "作業中のまま" });
        }
        if (ctx.resource.id === DUP) out.push({ key: "NO_SUCH_ROW", language: "ko", code: "lost", message: "行がない" }, { key: "A", code: "lost", message: "言語がない" });
        return out;
      },
    },
  ],
};

let tp: TestProject;
let ws: Workspace;

beforeEach(async () => {
  resourceRuns = [];
  failResource = false;
  tp = await makeTestProject({ plugins: [plugin] });
  await tp.write(DUP, DUP_CSV);
  const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
  await tp.patchConfig({ columns: [...config.columns, { id: "maxLength", kind: "meta", scope: "entry", type: "string", label: "上限" }] });
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

/** 自分のバリデータ（v.*）の問題だけを、「セルの ID: コード」の形で取り出す。 */
const mine = (issues: IssueInfo[] | undefined): string[] => (issues ?? []).filter((i) => i.validatorId.startsWith("v.")).map((i) => i.code);
async function cellIssues(resourceId: string, key: string): Promise<Record<string, string[]>> {
  const { row } = await ws.rowDetail({ resourceId, key });
  const out: Record<string, string[]> = {};
  for (const [cellId, cell] of Object.entries(row.cells)) {
    const codes = mine(cell.issues);
    if (codes.length > 0) out[cellId] = codes;
  }
  return out;
}
const useValidators = async (...ids: string[]): Promise<void> => {
  await tp.patchConfig({ validators: ids });
  await ws.reloadPlugins();
};
const setStatus = (resourceId: string, key: string, value: string) => ws.setCell({ resourceId, key, cellId: "textStatus@ko", value });

describe("本文以外の列のセルの検証", () => {
  it("リソースの中の列: 問題はその列のセルに付き、値を直すと消える", async () => {
    await useValidators("v.digits");
    expect(await cellIssues(DUP, "C")).toEqual({ maxLength: ["not-number"] });
    expect(await cellIssues(DUP, "D")).toEqual({}); // 数字
    expect(await cellIssues(DUP, "A")).toEqual({}); // 空
    const { row } = await ws.rowDetail({ resourceId: DUP, key: "C" });
    expect(row.cells["maxLength"]!.issues).toEqual([{ validatorId: "v.digits", code: "not-number", message: "数字ではありません: x1", severity: "error" }]);
    await ws.setCell({ resourceId: DUP, key: "C", cellId: "maxLength", value: "12" });
    expect(await cellIssues(DUP, "C")).toEqual({});
    await ws.setCell({ resourceId: DUP, key: "A", cellId: "maxLength", value: "abc" });
    expect(await cellIssues(DUP, "A")).toEqual({ maxLength: ["not-number"] });
  });

  it("列ソースの列: 言語ごとのセルに付き、同じ行の本文（未保存の編集を含む）を読める", async () => {
    await useValidators("v.doneNeedsText");
    await tp.write(DUP, DUP_CSV.replace("A,はい,Yes,,네,", "A,はい,Yes,,,"));
    await ws.reloadResource({ resourceId: DUP });
    await setStatus(DUP, "A", "done");
    await setStatus(DUP, "B", "done");
    expect(await cellIssues(DUP, "A")).toEqual({ "textStatus@ko": ["done-empty"] });
    expect(await cellIssues(DUP, "B")).toEqual({});
    // ステータスを戻すと消える（値が変わったら確かめ直す）。
    await setStatus(DUP, "A", "wip");
    expect(await cellIssues(DUP, "A")).toEqual({});
  });

  it("バリデータが名指ししていない列と、設定で選んでいないバリデータは、検証しない", async () => {
    await useValidators("v.doneNeedsText");
    expect(await cellIssues(DUP, "C")).toEqual({});
    await useValidators();
    await setStatus(DUP, "A", "done");
    expect(await cellIssues(DUP, "C")).toEqual({});
  });

  it("絞り込み（問題あり）、統計、一括の検証にも、本文以外の列の問題が入る", async () => {
    await useValidators("v.digits");
    const filtered = await ws.rows({ resourceId: DUP, languages: ["ja"], offset: 0, limit: 10, onlyIssues: "error" });
    expect(filtered.rows.map((r) => r.key)).toEqual(["C"]);
    // warning 以上にしても、info や問題のない行は入らない。
    expect((await ws.rows({ resourceId: DUP, languages: ["ja"], offset: 0, limit: 10, onlyIssues: "warning" })).rows.map((r) => r.key)).toEqual(["C"]);
    expect((await ws.stats({ resourceIds: [DUP] }))[0]!.issues).toEqual({ error: 1, warning: 0, info: 0 });
    const result = await ws.validate({ resourceIds: [DUP] });
    expect(result.summary).toEqual({ error: 1, warning: 0, info: 0, cells: 1 });
    const issue = result.resources[0]!.issues[0] as ValidateIssue;
    expect(issue).toEqual({ validatorId: "v.digits", code: "not-number", message: "数字ではありません: x1", severity: "error", key: "C", cellId: "maxLength" });
    expect(issue).not.toHaveProperty("language"); // 行に 1 つの列
  });

  it("絞り込み（問題あり）: 言語ごとの列の問題は、表示中の言語のものだけ数える", async () => {
    await useValidators("v.doneNeedsText");
    await tp.write(DUP, DUP_CSV.replace("A,はい,Yes,,네,", "A,はい,Yes,,,"));
    await ws.reloadResource({ resourceId: DUP });
    await setStatus(DUP, "A", "done");
    const keys = async (languages: string[]) => (await ws.rows({ resourceId: DUP, languages, offset: 0, limit: 10, onlyIssues: "warning" })).rows.map((r) => r.key);
    expect(await keys(["ko"])).toEqual(["A"]);
    expect(await keys(["ja"])).toEqual([]);
  });
});

describe("リソース全体を見るバリデータ", () => {
  beforeEach(() => useValidators("v.consistent"));

  it("ほかの行と比べた問題が、それぞれの行の本文のセルに付く。未保存の編集で直れば消える", async () => {
    expect(await cellIssues(DUP, "A")).toEqual({ "text@ko": ["inconsistent"] });
    expect(await cellIssues(DUP, "B")).toEqual({ "text@ko": ["inconsistent"] });
    expect(await cellIssues(DUP, "C")).toEqual({}); // C と D は同じ訳
    const { row } = await ws.rowDetail({ resourceId: DUP, key: "A" });
    expect(row.cells["text@ko"]!.issues).toContainEqual({ validatorId: "v.consistent", code: "inconsistent", message: "「はい」の訳が行によって違います", severity: "warning" });
    await ws.setText({ resourceId: DUP, key: "B", language: "ko", value: "네" });
    expect(await cellIssues(DUP, "A")).toEqual({});
    expect(await cellIssues(DUP, "B")).toEqual({});
    await ws.discardDrafts({ resourceId: DUP });
    expect(await cellIssues(DUP, "A")).toEqual({ "text@ko": ["inconsistent"] });
  });

  it("本文以外の列のセルにも問題を付けられる。列ソースの値が変わると確かめ直す", async () => {
    expect(await cellIssues(DUP, "C")).toEqual({});
    await setStatus(DUP, "C", "done");
    expect(await cellIssues(DUP, "C")).toEqual({ maxLength: ["bad-limit-on-done"] });
    expect((await ws.stats({ resourceIds: [DUP] }))[0]!.issues).toMatchObject({ error: 1, warning: 2 });
    await setStatus(DUP, "C", "wip");
    expect(await cellIssues(DUP, "C")).toEqual({});
  });

  it("絞り込み（問題あり）: 言語ごとの列のセルの問題は、表示中の言語のものだけ数える", async () => {
    await setStatus(DUP, "D", "wip");
    expect(await cellIssues(DUP, "D")).toEqual({ "textStatus@ko": ["stuck"] });
    const keys = async (languages: string[]) => (await ws.rows({ resourceId: DUP, languages, offset: 0, limit: 10, onlyIssues: "warning" })).rows.map((r) => r.key);
    expect(await keys(["ko"])).toEqual(["A", "B", "D"]);
    // ko を表示していなければ、ko のセル（本文もステータスも）の問題では絞り込まれない。
    expect(await keys(["ja"])).toEqual([]);
  });

  it("何も変わっていなければ、結果を覚えていて呼び直さない。変わったら呼び直す", async () => {
    await cellIssues(DUP, "A");
    await cellIssues(DUP, "B");
    await ws.rows({ resourceId: DUP, languages: ["ko"], offset: 0, limit: 10 });
    expect(resourceRuns).toEqual([DUP]);
    await ws.setText({ resourceId: DUP, key: "B", language: "ko", value: "네" });
    await cellIssues(DUP, "A");
    expect(resourceRuns).toEqual([DUP, DUP]);
    // ほかのリソースは、開いたときに 1 回だけ。
    await cellIssues(UI, "UI_OK");
    await cellIssues(UI, "UI_CANCEL");
    expect(resourceRuns).toEqual([DUP, DUP, UI]);
  });

  it("セルを特定できない問題は捨てて、1 つの警告にまとめる。特定できた問題は残る", async () => {
    expect(await cellIssues(DUP, "A")).toEqual({ "text@ko": ["inconsistent"] });
    const warnings = (await ws.info()).warnings.filter((w) => w.includes("v.consistent"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2 件");
  });

  it("バリデータが失敗したら警告にして、セルごとの検証は続ける", async () => {
    await useValidators("v.consistent", "v.digits");
    failResource = true;
    expect(await cellIssues(DUP, "A")).toEqual({});
    expect(await cellIssues(DUP, "C")).toEqual({ maxLength: ["not-number"] });
    expect((await ws.info()).warnings.filter((w) => w.includes("辞書を読めません"))).toHaveLength(1);
  });

  it("設定の languages で絞ると、その言語のセルの問題だけ残る", async () => {
    await tp.patchConfig({ validators: [{ use: "v.consistent", languages: ["ja"] }] });
    await ws.reloadPlugins();
    expect(await cellIssues(DUP, "A")).toEqual({});
    await tp.patchConfig({ validators: [{ use: "v.consistent", languages: ["ko"], severity: "error" }] });
    await ws.reloadPlugins();
    const { row } = await ws.rowDetail({ resourceId: DUP, key: "A" });
    expect(row.cells["text@ko"]!.issues!.filter((i) => i.validatorId === "v.consistent").map((i) => i.severity)).toEqual(["error"]);
  });
});

describe("コマンドラインの validate（コアの validateProject）", () => {
  it("リソースの中の列とリソース全体の検証は含む。列ソースの列のセルごとの検証は含まない", async () => {
    await useValidators("v.digits", "v.doneNeedsText", "v.consistent");
    await tp.write(DUP, DUP_CSV.replace("A,はい,Yes,,네,", "A,はい,Yes,,,"));
    await ws.reloadResource({ resourceId: DUP });
    await setStatus(DUP, "A", "done");
    const [validated] = await validateProject(ws.project, { resources: [{ id: DUP, path: DUP, name: "dup.csv" }] });
    const found = validated!.results
      .flatMap((r) => r.issues.map((i) => `${r.target.entry.key}/${r.target.column.id}${r.target.language ? `@${r.target.language.id}` : ""}: ${i.code}`))
      .sort();
    expect(found).toEqual(["A/text@ko: inconsistent", "B/text@ko: inconsistent", "C/maxLength: not-number"]);
    // 対象のセル: 本文は 4 行 × 4 言語、上限は 4 行。ステータスの列は対象にしない。
    expect(validated!.results.map((r) => r.target.column.id).sort().join(",")).toBe([...Array(4).fill("maxLength"), ...Array(16).fill("text")].join(","));
  });
});
