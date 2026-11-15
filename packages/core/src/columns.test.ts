import { describe, expect, it } from "vitest";
import type { ColumnDef, ColumnSource, ProjectConfig } from "@loc-studio/sdk";
import { columnAppliesTo, DEFAULT_COLUMNS, groupColumns, resolveColumns, resolveColumnSource } from "./columns.js";
import { PluginRegistry } from "./registry.js";

const source = (id: string): ColumnSource => ({ id, saveMode: "immediate", load: async () => [], save: async () => [] });

const statusDef: ColumnDef = {
  id: "p.status",
  kind: "meta",
  scope: "language",
  source: "p.db",
  label: "状態",
  type: { enum: [{ value: "a" }, { value: "b" }], default: "a" },
};
const reviewDef: ColumnDef = { id: "p.review", kind: "review", of: "text", scope: "language", source: "p.reviews" };

function registry(): PluginRegistry {
  const r = new PluginRegistry();
  r.register(
    {
      name: "p",
      sources: [source("p.db"), source("p.reviews")],
      columns: [statusDef, reviewDef, { id: "p.key", kind: "key", scope: "entry" }],
    },
    { layer: "builtin" },
  );
  return r;
}

const config = (columns?: ProjectConfig["columns"], extra: Partial<ProjectConfig> = {}): ProjectConfig => ({
  languages: [],
  ...(columns !== undefined ? { columns } : {}),
  ...extra,
});

describe("resolveColumns", () => {
  it("省略時はキーと本文", () => {
    const { columns, warnings } = resolveColumns(config(), registry());
    // 既定の列は、ここに書いたとおり（実装の定数と比べると、定数を誤って変えても気づけない）。
    expect(columns).toEqual([
      { id: "key", kind: "key", scope: "entry" },
      { id: "text", kind: "text", scope: "language" },
    ]);
    expect(columns).not.toBe(DEFAULT_COLUMNS);
    // 返した列を書き換えても、既定の定義は変わらない。
    columns[0]!.id = "changed";
    expect(DEFAULT_COLUMNS[0]!.id).toBe("key");
    expect(warnings).toEqual([]);
  });

  it("定義そのものと use を混ぜられる。use は登録された定義を上書きする", () => {
    const r = registry();
    const { columns, warnings } = resolveColumns(
      config([
        { use: "p.key" },
        { id: "text", kind: "text", scope: "language" },
        { use: "p.status", id: "status", type: { enum: [{ value: "x" }] }, label: undefined },
        { use: "p.review", id: "rev", of: "text", languages: ["ja"] },
      ]),
      r,
    );
    expect(warnings).toEqual([]);
    expect(columns).toEqual([
      { id: "p.key", kind: "key", scope: "entry" },
      { id: "text", kind: "text", scope: "language" },
      { ...statusDef, id: "status", type: { enum: [{ value: "x" }] } },
      { ...reviewDef, id: "rev", languages: ["ja"] },
    ]);
    // 登録された定義は変わらない。
    expect(r.get("column", "p.status")).toEqual(statusDef);
    (columns[2]!.type as { enum: unknown[] }).enum.push({ value: "y" });
    expect(statusDef.type).toEqual({ enum: [{ value: "a" }, { value: "b" }], default: "a" });
  });

  it("問題のある列は飛ばして警告する", () => {
    const { columns, warnings } = resolveColumns(
      config([
        { id: "text", kind: "text", scope: "language" },
        { use: "nope" },
        { id: "text", kind: "meta", scope: "entry" },
        { use: "p.review", id: "r1" }, // of: "text" は存在する
        { use: "p.review", id: "r2", of: "missing" },
        { id: "r3", kind: "review", scope: "language" },
        { id: "r4", kind: "review", scope: "language", of: "r4" },
        { id: "nokind", scope: "entry" } as unknown as ColumnDef,
        { id: "noscope", kind: "meta" } as unknown as ColumnDef,
        { kind: "meta", scope: "entry" } as unknown as ColumnDef,
      ]),
      registry(),
    );
    expect(columns.map((c) => c.id)).toEqual(["text", "r1"]);
    expect(warnings).toHaveLength(8);
    expect(warnings[0]).toContain('"nope"');
    expect(warnings.some((w) => w.includes("重なって"))).toBe(true);
    expect(warnings.some((w) => w.includes('"r2"') && w.includes('"missing"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"r3"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"r4"'))).toBe(true);
    expect(warnings.some((w) => w.includes('"nokind"') && w.includes("kind"))).toBe(true);
    expect(warnings.some((w) => w.includes('"noscope"') && w.includes("scope"))).toBe(true);
  });

  it("出所が見つからない列は出すが警告する", () => {
    const { columns, warnings } = resolveColumns(
      config([
        { id: "a", kind: "meta", scope: "entry", source: "unknown" },
        { id: "b", kind: "meta", scope: "entry", source: "file" },
      ]),
      registry(),
    );
    expect(columns.map((c) => c.id)).toEqual(["a", "b"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"unknown"');
  });
});

describe("resolveColumnSource", () => {
  const r = registry();
  const cfg = config(undefined, { sources: { shared: { use: "p.db", options: { namespace: "team" } }, plain: "p.reviews", broken: "nope" } });

  it("設定の sources の名前を先に、なければ登録された id で引く", () => {
    const named = resolveColumnSource({ id: "s", kind: "meta", scope: "language", source: "shared" }, cfg, r);
    expect(named?.source.id).toBe("p.db");
    expect(named?.options).toEqual({ namespace: "team" });
    expect(named?.name).toBe("shared");

    expect(resolveColumnSource({ id: "s", kind: "meta", scope: "language", source: "plain" }, cfg, r)?.source.id).toBe("p.reviews");
    const direct = resolveColumnSource({ id: "s", kind: "review", of: "text", scope: "language", source: "p.db" }, cfg, r);
    expect(direct).toMatchObject({ options: {}, name: "p.db" });
    expect(direct?.source.id).toBe("p.db");
  });

  it("列ソースを使わない列と、見つからない出所は undefined", () => {
    for (const kind of ["key", "text", "computed", "actions", "generated"] as const) {
      expect(resolveColumnSource({ id: "x", kind, scope: "entry", source: "p.db" }, cfg, r)).toBeUndefined();
    }
    expect(resolveColumnSource({ id: "x", kind: "meta", scope: "entry", source: "file" }, cfg, r)).toBeUndefined();
    expect(resolveColumnSource({ id: "x", kind: "meta", scope: "entry" }, cfg, r)).toBeUndefined();
    expect(resolveColumnSource({ id: "x", kind: "meta", scope: "entry", source: "broken" }, cfg, r)).toBeUndefined();
    expect(resolveColumnSource({ id: "x", kind: "meta", scope: "entry", source: "none" }, cfg, r)).toBeUndefined();
  });
});

describe("columnAppliesTo / groupColumns", () => {
  it("languages の指定で絞る", () => {
    const all: ColumnDef = { id: "a", kind: "meta", scope: "language" };
    const some: ColumnDef = { id: "b", kind: "meta", scope: "language", languages: ["ja"] };
    expect(columnAppliesTo(all, "en")).toBe(true);
    expect(columnAppliesTo(some, "ja")).toBe(true);
    expect(columnAppliesTo(some, "en")).toBe(false);
  });

  it("scope で分け、順番を保つ", () => {
    const cols: ColumnDef[] = [
      { id: "k", kind: "key", scope: "entry" },
      { id: "t", kind: "text", scope: "language" },
      { id: "n", kind: "meta", scope: "entry" },
      { id: "s", kind: "meta", scope: "language" },
    ];
    const { common, perLanguage } = groupColumns(cols);
    expect(common.map((c) => c.id)).toEqual(["k", "n"]);
    expect(perLanguage.map((c) => c.id)).toEqual(["t", "s"]);
  });
});
