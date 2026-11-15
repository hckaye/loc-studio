import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { copyServer } = createRequire(import.meta.url)("./after-pack.cjs") as { copyServer(from: string, to: string): void };

/** サーバーの置き場（build/server）に要るファイル。期待値として、ここに書き下す。 */
const FILES = [
  "apps/web/launch.mjs",
  "apps/web/server.js",
  "apps/web/.next/static/chunk.js",
  "node_modules/next/package.json",
  "node_modules/react/package.json",
  "node_modules/jiti/package.json",
  "node_modules/@loc-studio/sdk/package.json",
];

let tmp: string;
let from: string;
let to: string;

function put(root: string, rel: string, text = rel): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "loc-studio-after-pack-"));
  from = path.join(tmp, "build", "server");
  to = path.join(tmp, "out", "resources", "server");
  for (const rel of FILES) put(from, rel);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("afterPack のサーバーのコピー", () => {
  it("node_modules を含めて、サーバーを丸ごとコピーする", () => {
    copyServer(from, to);
    for (const rel of FILES) expect(readFileSync(path.join(to, rel), "utf8")).toBe(rel);
  });

  it("コピー先に前の中身が残っていたら、消してから入れる", () => {
    put(to, "old/stale.js");
    copyServer(from, to);
    expect(existsSync(path.join(to, "old", "stale.js"))).toBe(false);
    expect(existsSync(path.join(to, "apps", "web", "launch.mjs"))).toBe(true);
  });

  it.each([
    ["プラグインを読み込む jiti", "node_modules/jiti/package.json"],
    ["プラグインが import する SDK", "node_modules/@loc-studio/sdk/package.json"],
    ["next", "node_modules/next/package.json"],
    ["起動の入口", "apps/web/launch.mjs"],
  ])("%s が欠けていたら、欠けているファイルを挙げて失敗する", (_name, rel) => {
    rmSync(path.join(from, rel));
    expect(() => copyServer(from, to)).toThrow(`起動に要るファイルがありません: ${rel}`);
  });

  it("サーバーの置き場がなければ、先にすることを添えて失敗する", () => {
    rmSync(from, { recursive: true });
    expect(() => copyServer(from, to)).toThrow("npm run stage -w @loc-studio/desktop");
    expect(existsSync(to)).toBe(false);
  });
});
