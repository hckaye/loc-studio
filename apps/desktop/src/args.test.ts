import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseProjectArg, userArgs } from "./args";

describe("args", () => {
  it("フラグを飛ばして最初のパスを絶対パスにする", () => {
    const cwd = path.resolve("/work");
    expect(parseProjectArg(["--no-sandbox", "proj"], cwd)).toBe(path.resolve(cwd, "proj"));
    expect(parseProjectArg([], cwd)).toBeUndefined();
    expect(parseProjectArg(["--x"], cwd)).toBeUndefined();
  });
  it("開発時はアプリのパスも除く", () => {
    expect(userArgs(["electron", ".", "p"], true)).toEqual(["p"]);
    expect(userArgs(["loc-studio", "p"], false)).toEqual(["p"]);
  });
});
