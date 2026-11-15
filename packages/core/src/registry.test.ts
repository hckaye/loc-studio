import { describe, expect, it } from "vitest";
import type { Format, Plugin, Validator } from "@loc-studio/sdk";
import { PluginRegistry } from "./registry.js";

const fakeFormat = (id: string, tag: string): Format => ({
  id,
  match: () => true,
  parse: () => ({ entries: [{ key: tag, text: {} }] }),
  apply: (b) => b,
});

const fakeValidator = (id: string): Validator => ({ id, label: id, version: "1", validate: () => [] });

describe("PluginRegistry", () => {
  it("種類ごとに登録して引ける", () => {
    const reg = new PluginRegistry();
    const plugin: Plugin = {
      name: "p",
      formats: [fakeFormat("csv", "a")],
      validators: [fakeValidator("v1")],
      syntaxes: [{ id: "s", tokenize: () => [] }],
      columns: [{ id: "c", kind: "meta", scope: "entry" }],
    };
    reg.register(plugin, { layer: "builtin" });
    const f: Format | undefined = reg.get("format", "csv");
    expect(f?.id).toBe("csv");
    expect(reg.require("validator", "v1").label).toBe("v1");
    expect(reg.get("syntax", "s")?.id).toBe("s");
    expect(reg.get("column", "c")?.kind).toBe("meta");
    expect(reg.get("format", "nope")).toBeUndefined();
    expect(reg.list("format")).toEqual([
      { id: "csv", pluginName: "p", origin: { layer: "builtin" }, value: plugin.formats![0] },
    ]);
    expect(reg.plugins()).toEqual([{ plugin, origin: { layer: "builtin" } }]);
    expect(reg.warnings).toEqual([]);
  });

  it("同じ id は後の登録が勝ち、両方のプラグイン名を警告に出す", () => {
    const reg = new PluginRegistry();
    reg.register({ name: "base", formats: [fakeFormat("csv", "old")] }, { layer: "builtin" });
    reg.register({ name: "studio", formats: [fakeFormat("csv", "new")] }, { layer: "project", path: "/x/studio.ts" });
    expect(reg.require("format", "csv").parse(new Uint8Array(), {} as never).entries[0]?.key).toBe("new");
    expect(reg.list("format")).toHaveLength(1);
    expect(reg.warnings).toHaveLength(1);
    expect(reg.warnings[0]).toContain('"base"');
    expect(reg.warnings[0]).toContain('"studio"');
    expect(reg.warnings[0]).toContain("csv");
  });

  it("deny の種類は登録せず、警告を出す", () => {
    const reg = new PluginRegistry();
    reg.register(
      { name: "mine", formats: [fakeFormat("f", "x")], validators: [fakeValidator("v")] },
      { layer: "local" },
      { deny: ["format"] },
    );
    expect(reg.get("format", "f")).toBeUndefined();
    expect(reg.get("validator", "v")).toBeDefined();
    expect(reg.warnings).toHaveLength(1);
    expect(reg.warnings[0]).toContain('"f"');
    expect(reg.warnings[0]).toContain("mine");
  });

  it("require は使える id を並べたエラーを投げる", () => {
    const reg = new PluginRegistry();
    reg.register({ name: "p", validators: [fakeValidator("a"), fakeValidator("b")] }, { layer: "builtin" });
    expect(() => reg.require("validator", "zzz")).toThrow(/"zzz".*"a", "b"/);
    expect(() => reg.require("tree", "t")).toThrow(/（なし）/);
  });
});
