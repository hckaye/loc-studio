import { describe, expect, it } from "vitest";
import { PluginRegistry, resolveColumns, resolveColumnSource } from "@loc-studio/core";
import type { ProjectConfig } from "@loc-studio/sdk";
import { builtinColumns, lengthColumn, reviewStatusColumn, textStatusColumn } from "./default-columns.js";
import { builtinPlugin } from "./index.js";

const registry = () => {
  const r = new PluginRegistry();
  r.register(builtinPlugin, { layer: "builtin" });
  return r;
};

describe("default columns", () => {
  it("builtin.length はコードポイント数を返す計算列で、use で選べる", () => {
    expect(lengthColumn).toMatchObject({ kind: "computed", scope: "language", label: "文字数" });
    const row = { text: () => undefined, get: () => undefined };
    const entry = { key: "k", resource: { id: "r", path: "r", name: "r" } };
    expect(lengthColumn.compute!({ entry, text: "a😀あ", row, options: {} })).toEqual({ value: 3 });
    expect(lengthColumn.compute!({ entry, row, options: {} })).toEqual({ value: 0 });
    const { columns, warnings } = resolveColumns({ languages: [], columns: [{ use: "builtin.length", id: "length" }] }, registry());
    expect(warnings).toEqual([]);
    expect(columns[0]!.id).toBe("length");
    expect(typeof columns[0]!.compute).toBe("function");
  });

  it("5 つの列を登録する", () => {
    expect(builtinColumns.map((c) => c.id)).toEqual(["builtin.key", "builtin.text", "builtin.textStatus", "builtin.reviewStatus", "builtin.length"]);
    expect(textStatusColumn).toMatchObject({ kind: "meta", scope: "language", source: "builtin.db", basis: "text" });
    expect(reviewStatusColumn).toMatchObject({ kind: "review", of: "text", scope: "language", source: "builtin.reviews" });
    const review = reviewStatusColumn.type as { enum: { value: string; requireComment?: boolean; complete?: boolean }[]; default?: string };
    expect(review.enum.map((o) => o.value)).toEqual(["none", "doing", "back", "ok"]);
    expect(review.enum.find((o) => o.requireComment)?.value).toBe("back");
    expect(review.enum.find((o) => o.complete)?.value).toBe("ok");
    expect(review.default).toBe("none");
  });

  it("プロジェクトは use で選び、短い id を付け、type を上書きできる。列ソースも解決できる", () => {
    const config: ProjectConfig = {
      languages: [],
      columns: [
        { use: "builtin.key", id: "key" },
        { use: "builtin.text", id: "text" },
        { use: "builtin.textStatus", id: "textStatus", type: { enum: [{ value: "a" }, { value: "b", complete: true }], default: "a" } },
        { use: "builtin.reviewStatus", id: "reviewStatus", of: "text" },
      ],
    };
    const r = registry();
    const { columns, warnings } = resolveColumns(config, r);
    expect(warnings).toEqual([]);
    expect(columns.map((c) => c.id)).toEqual(["key", "text", "textStatus", "reviewStatus"]);
    expect(columns[2]).toMatchObject({ label: "テキスト", source: "builtin.db", type: { enum: [{ value: "a" }, { value: "b", complete: true }] } });
    expect(resolveColumnSource(columns[2]!, config, r)?.source.id).toBe("builtin.db");
    expect(resolveColumnSource(columns[3]!, config, r)?.source.id).toBe("builtin.reviews");
    expect(resolveColumnSource(columns[1]!, config, r)).toBeUndefined();
  });
});
