import { describe, expect, it } from "vitest";
import type { ColumnDef, ProjectConfig, RoleDef } from "@loc-studio/sdk";
import { DEFAULT_ROLES, resolveRoles, roleSeesResource } from "./roles.js";

const config = (roles: unknown): ProjectConfig => ({ languages: [], roles } as unknown as ProjectConfig);

const COLUMNS: ColumnDef[] = [
  { id: "key", kind: "key", scope: "entry" },
  { id: "text", kind: "text", scope: "language" },
  { id: "status", kind: "meta", scope: "language", source: "builtin.db" },
  { id: "review", kind: "review", scope: "language", of: "text", source: "builtin.reviews" },
  { id: "mt", kind: "generated", scope: "language", generator: "g" },
];

describe("resolveRoles", () => {
  it("roles がなければ同梱の 4 つの役割。権限は、ここに書いた内容どおり", () => {
    const { roles, warnings } = resolveRoles({ languages: [] });
    expect(warnings).toEqual([]);
    // 同梱の役割の権限を変えたら、このテストも意図して書き換えること（Web モードの既存の割り当てに効く）。
    expect(Object.fromEntries(Object.entries(roles).map(([id, def]) => [id, [...def.can].sort()]))).toEqual({
      viewer: [],
      translator: ["edit", "run"],
      reviewer: ["review", "run"],
      manager: ["edit", "manage", "review", "run", "structure"],
    });
    for (const def of Object.values(roles)) {
      expect(Object.keys(def).sort()).toEqual(["can", "label"]); // 同梱の役割に絞り込みはない
    }
  });

  it("返した定義を書き換えても、同梱の役割は変わらない", () => {
    const { roles } = resolveRoles({ languages: [] });
    roles["viewer"]!.can.push("manage");
    expect(DEFAULT_ROLES["viewer"]!.can).toEqual([]);
    expect(resolveRoles({ languages: [] }).roles["viewer"]!.can).toEqual([]);
  });

  it("設定の役割は同梱の役割に足され、同じ ID は丸ごと置き換える（同梱の権限や名前を引き継がない）", () => {
    const { roles, warnings } = resolveRoles(
      config({
        lqa: { label: "LQA", can: ["edit", "review", "edit"], editColumns: ["status", "status"], resources: ["DLC/**"] },
        translator: { can: ["edit"] },
      }),
      COLUMNS,
    );
    expect(warnings).toEqual([]);
    expect(Object.keys(roles)).toEqual(["viewer", "translator", "reviewer", "manager", "lqa"]);
    expect(roles["lqa"]).toEqual({ label: "LQA", can: ["edit", "review"], editColumns: ["status"], resources: ["DLC/**"] });
    expect(roles["translator"]).toEqual({ can: ["edit"] });
    expect(roles["manager"]).toEqual(DEFAULT_ROLES["manager"]);
  });

  it.each([
    ["can が配列でない", { can: "edit" }],
    ["can に知らない権限", { can: ["edit", "admin"] }],
    ["can がない", { label: "x" }],
    ["絞り込みが配列でない", { can: ["edit"], editColumns: "text" }],
    ["絞り込みに空文字", { can: ["edit"], resources: [""] }],
    ["label が文字列でない", { can: [], label: 1 }],
    ["定義がオブジェクトでない", "viewer"],
    ["定義が null", null],
  ])("書き方の誤り（%s）: 何も見えず何もできない役割にして警告する", (_name, def) => {
    for (const id of ["custom", "manager"]) {
      const { roles, warnings } = resolveRoles(config({ [id]: def }));
      expect(roles[id]!.can).toEqual([]);
      expect(roleSeesResource(roles[id]!, "any/file.csv")).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`roles.${id}`);
    }
  });

  it("使えない ID の役割は登録しない。roles がオブジェクトでなければ同梱の役割だけ", () => {
    const bad = resolveRoles(config({ "bad id": { can: ["edit"] }, ["x".repeat(65)]: { can: [] } }));
    expect(Object.keys(bad.roles)).toEqual(["viewer", "translator", "reviewer", "manager"]);
    expect(bad.warnings).toHaveLength(2);
    const list = resolveRoles(config([{ can: ["manage"] }]));
    expect(Object.keys(list.roles)).toEqual(["viewer", "translator", "reviewer", "manager"]);
    expect(list.warnings).toHaveLength(1);
  });

  it("columns にない列を指す絞り込みは、定義は生かしたまま警告する", () => {
    const { roles, warnings } = resolveRoles(
      config({ r: { can: ["edit", "review", "run"], editColumns: ["status", "statsu"], reviewColumns: ["status"], generators: ["text"] } }),
      COLUMNS,
    );
    expect(roles["r"]!.editColumns).toEqual(["status", "statsu"]);
    // 警告は項目ごとに 1 つ。どの項目の、どの ID が見つからないかを書く（正しい "status" は挙げない）。
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/roles\.r の editColumns .*: statsu$/);
    expect(warnings[1]).toMatch(/roles\.r の reviewColumns.*: status$/);
    expect(warnings[2]).toMatch(/roles\.r の generators.*: text$/);
  });
});

describe("roleSeesResource", () => {
  const role = (resources?: string[]): RoleDef => ({ can: [], ...(resources ? { resources } : {}) });

  it("resources がなければすべて見え、空の配列なら何も見えない", () => {
    expect(roleSeesResource(role(), "a/b.csv")).toBe(true);
    expect(roleSeesResource(role([]), "a/b.csv")).toBe(false);
  });

  it("glob はリソースのパス全体に当てる（どれか 1 つに合えば見える。ドットで始まる名前にも合う）", () => {
    const r = role(["Assets/DLC/**", "*.csv"]);
    expect(roleSeesResource(r, "Assets/DLC/ch1/a.csv")).toBe(true);
    expect(roleSeesResource(r, "Assets/DLC/.hidden/a.csv")).toBe(true);
    expect(roleSeesResource(r, "top.csv")).toBe(true);
    expect(roleSeesResource(r, "Assets/Main/a.csv")).toBe(false);
    expect(roleSeesResource(r, "Other/Assets/DLC/a.csv")).toBe(false);
  });
});
