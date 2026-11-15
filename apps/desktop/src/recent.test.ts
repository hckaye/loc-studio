import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRecentProjects } from "./recent";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "ls-recent-"));
  dirs.push(d);
  return d;
};

describe("readRecentProjects", () => {
  it("ファイルがなければ空（警告なし）", () => {
    const warns: string[] = [];
    expect(readRecentProjects(tmp(), (m) => warns.push(m))).toEqual([]);
    expect(warns).toEqual([]);
  });
  it("一覧を読む。文字列以外は除く", () => {
    const d = tmp();
    writeFileSync(path.join(d, "web-session.json"), JSON.stringify({ recentProjects: ["/a", 1, "/b"] }));
    expect(readRecentProjects(d)).toEqual(["/a", "/b"]);
  });
  it("壊れていたら空にして警告する", () => {
    const d = tmp();
    writeFileSync(path.join(d, "web-session.json"), "{oops");
    const warns: string[] = [];
    expect(readRecentProjects(d, (m) => warns.push(m))).toEqual([]);
    expect(warns[0]).toContain("web-session.json");
  });
});
