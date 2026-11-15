import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSqliteExperimentalWarning } from "./warnings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const entry = path.join(here, "..", "dist", "index.js");

describe("SQLite の実験的警告だけを捨てる", () => {
  it("判定", () => {
    expect(isSqliteExperimentalWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning")).toBe(true);
    const e = new Error("SQLite is an experimental feature");
    e.name = "ExperimentalWarning";
    expect(isSqliteExperimentalWarning(e)).toBe(true);
    expect(isSqliteExperimentalWarning("Something else", "ExperimentalWarning")).toBe(false);
    expect(isSqliteExperimentalWarning("SQLite thing", "DeprecationWarning")).toBe(false);
  });

  // dist があるときだけ（tsc -p apps/cli 済み）。ビルドした入口を実際に動かす。
  it.skipIf(!existsSync(entry))("ビルドした CLI は stderr に警告を出さず、--json の stdout は JSON だけ", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "loc-studio-cli-warn-"));
    try {
      const project = path.join(tmp, "p");
      await cp(path.join(repoRoot, "examples", "sample-project"), project, { recursive: true });
      const r = spawnSync(process.execPath, [entry, "status", "--json", "--project", project, "--user-data-dir", path.join(tmp, "u")], {
        encoding: "utf8",
        env: { ...process.env, LOC_STUDIO_SDK_PATH: path.join(repoRoot, "packages", "sdk", "src", "index.ts"), LOC_STUDIO_SETTINGS: path.join(tmp, "none.json") },
      });
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("SQLite");
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
