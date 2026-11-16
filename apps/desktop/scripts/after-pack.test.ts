import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { copyServer } = createRequire(import.meta.url)("./after-pack.cjs") as { copyServer(from: string, to: string): void };
interface Missing {
  name: string;
  from: string;
}
const deps = createRequire(import.meta.url)("../../../scripts/standalone-deps.cjs") as {
  resolveWithin(root: string, fromDir: string, name: string): string | undefined;
  missingDependencies(root: string): Missing[];
  completeDependencies(root: string, repoRoot: string): string[];
};

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

/** ファイルを置く。package.json は、名前だけの JSON にする（依存は pkg で書く）。 */
function put(root: string, rel: string, text = rel.endsWith("package.json") ? "{}" : rel): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** node_modules の中にパッケージを置く（dependencies つき）。 */
function pkg(root: string, rel: string, dependencies: Record<string, string> = {}, extra: Record<string, unknown> = {}): void {
  put(root, `${rel}/package.json`, JSON.stringify({ name: rel.split("node_modules/").pop(), dependencies, ...extra }));
  put(root, `${rel}/index.js`, `// ${rel}`);
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
    for (const rel of FILES) expect(readFileSync(path.join(to, rel), "utf8")).toBe(rel.endsWith("package.json") ? "{}" : rel);
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

describe("配布物の中だけで、サービス層の依存を解決できるか", () => {
  it("サービス層の依存が欠けていたら、欠けている依存と、それを使うパッケージを挙げて失敗する", () => {
    pkg(from, "node_modules/@loc-studio/core", { acorn: "^8.0.0", jiti: "^2.0.0" });
    expect(() => copyServer(from, to)).toThrow("解決できない依存があります: acorn（node_modules/@loc-studio/core が使う）");
  });

  it("依存がそろっていれば通る（依存の依存まで辿る）", () => {
    pkg(from, "node_modules/@loc-studio/core", { acorn: "^8.0.0" });
    pkg(from, "node_modules/@loc-studio/store", { "@loc-studio/core": "0.1.0", pg: "^8.0.0" });
    pkg(from, "node_modules/acorn");
    pkg(from, "node_modules/pg", { "pg-pool": "^3.0.0" });
    expect(() => copyServer(from, to)).toThrow("解決できない依存があります: pg-pool（node_modules/pg が使う）");
    pkg(from, "node_modules/pg-pool");
    copyServer(from, to);
    expect(existsSync(path.join(to, "node_modules", "pg-pool", "index.js"))).toBe(true);
  });

  it("上の階層の node_modules にあっても、そろっているとはみなさない（利用者の PC にはないため）", () => {
    pkg(from, "node_modules/@loc-studio/core", { acorn: "^8.0.0" });
    // サーバーの置き場より上（リポジトリの node_modules に当たる場所）
    pkg(tmp, "node_modules/acorn");
    pkg(path.join(tmp, "build"), "node_modules/acorn");
    expect(deps.missingDependencies(from)).toEqual([{ name: "acorn", from: "node_modules/@loc-studio/core" }]);
    expect(deps.resolveWithin(from, path.join(from, "node_modules", "@loc-studio", "core"), "acorn")).toBeUndefined();
  });

  it("入れ子の node_modules にある依存は、そのパッケージからだけ解決できる", () => {
    pkg(from, "node_modules/@loc-studio/core", { a: "1" });
    pkg(from, "node_modules/a", { b: "2" });
    pkg(from, "node_modules/a/node_modules/b");
    expect(deps.missingDependencies(from)).toEqual([]);
    expect(deps.resolveWithin(from, path.join(from, "node_modules", "a"), "b")).toBe(path.join(from, "node_modules", "a", "node_modules", "b"));
    // b は a の中にしかないので、ほかのパッケージからは見えない。
    pkg(from, "node_modules/@loc-studio/store", { b: "2" });
    expect(deps.missingDependencies(from)).toEqual([{ name: "b", from: "node_modules/@loc-studio/store" }]);
  });

  it("optionalDependencies は、なくても足りないとは数えない。あれば、その依存を辿る", () => {
    pkg(from, "node_modules/@loc-studio/core", {}, { optionalDependencies: { opt: "1" } });
    expect(deps.missingDependencies(from)).toEqual([]);
    pkg(from, "node_modules/opt", { inner: "1" });
    expect(deps.missingDependencies(from)).toEqual([{ name: "inner", from: "node_modules/opt" }]);
  });

  it("足りない依存を、リポジトリの node_modules から同じ場所に写す（依存の依存と、入れ子の版も）", () => {
    const repo = path.join(tmp, "repo");
    // リポジトリ: ワークスペースのパッケージは node_modules/@loc-studio/x にある（本物はリンク）。
    pkg(repo, "node_modules/@loc-studio/core", { acorn: "^8.0.0" });
    pkg(repo, "node_modules/@loc-studio/store", { pg: "^8.0.0" });
    pkg(repo, "node_modules/acorn");
    pkg(repo, "node_modules/pg", { "pg-pool": "^3.0.0", shared: "2" });
    pkg(repo, "node_modules/pg-pool", { shared: "1" });
    pkg(repo, "node_modules/shared");
    put(repo, "node_modules/shared/version.txt", "1");
    // pg だけ、別の版の shared を入れ子で持つ。
    pkg(repo, "node_modules/pg/node_modules/shared");
    put(repo, "node_modules/pg/node_modules/shared/version.txt", "2");
    pkg(repo, "node_modules/unrelated");
    // standalone: サービス層だけがあり、依存はない。
    pkg(from, "node_modules/@loc-studio/core", { acorn: "^8.0.0" });
    pkg(from, "node_modules/@loc-studio/store", { pg: "^8.0.0" });

    const copied = deps.completeDependencies(from, repo);
    expect([...copied].sort()).toEqual(["node_modules/acorn", "node_modules/pg", "node_modules/pg-pool", "node_modules/shared"]);
    expect(deps.missingDependencies(from)).toEqual([]);
    expect(readFileSync(path.join(from, "node_modules", "shared", "version.txt"), "utf8")).toBe("1");
    expect(readFileSync(path.join(from, "node_modules", "pg", "node_modules", "shared", "version.txt"), "utf8")).toBe("2");
    // 使われていないパッケージは写さない。
    expect(readdirSync(path.join(from, "node_modules")).sort()).toEqual(["@loc-studio", "acorn", "next", "pg", "pg-pool", "react", "jiti", "shared"].sort());
    // もう一度呼んでも、何も写さない。
    expect(deps.completeDependencies(from, repo)).toEqual([]);
  });

  it("リポジトリにもない依存は、名前を挙げて失敗する", () => {
    const repo = path.join(tmp, "repo");
    pkg(repo, "node_modules/@loc-studio/core", { gone: "1" });
    pkg(from, "node_modules/@loc-studio/core", { gone: "1" });
    expect(() => deps.completeDependencies(from, repo)).toThrow('node_modules/@loc-studio/core の依存 "gone" が、リポジトリの node_modules にありません');
  });
});
