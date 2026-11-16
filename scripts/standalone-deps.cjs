// サーバーの standalone 出力（apps/web/.next/standalone と、それを写した配布物）が、
// その中だけでサービス層（node_modules/@loc-studio/*）の依存を解決できるかを確かめ、足りない依存を足す。
//
// Next の standalone は、画面のコードが import するものだけを集める。サービス層は実行時に Node が読み込むので
// （apps/web/lib/server/runtime.ts）、その依存（acorn、pg など）は集められない。リポジトリの中で動かすと、
// 上の階層の node_modules で解決されて動いてしまい、ほかの場所に置いた配布物でだけ
// 「Cannot find package」で失敗する。そのため、上の階層を見ない探し方で確かめる。
//
// CommonJS で書いてある（electron-builder の afterPack と、ESM のスクリプトの両方から使うため）。
const { cpSync, existsSync, readFileSync, readdirSync } = require("node:fs");
const path = require("node:path");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/**
 * fromDir から上へ、root までの node_modules で name を探す（Node の探し方と同じ。root より上は見ない）。
 * 見つかったパッケージのフォルダを返す。なければ undefined。
 */
function resolveWithin(root, fromDir, name) {
  const top = path.resolve(root);
  let dir = path.resolve(fromDir);
  if (dir !== top && !dir.startsWith(top + path.sep)) return undefined;
  for (;;) {
    // フォルダの名前が node_modules のところでは、その中の node_modules は見ない（Node と同じ）。
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", ...name.split("/"));
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    if (dir === top) return undefined;
    dir = path.dirname(dir);
  }
}

/**
 * root/node_modules/@loc-studio/* から辿れる依存（dependencies。推移的に）のうち、root の中で解決できないもの。
 * optionalDependencies は、あれば辿り、なくても足りないとは数えない。
 */
function missingDependencies(root) {
  const scope = path.join(root, "node_modules", "@loc-studio");
  const missing = [];
  const seen = new Set();
  const visit = (pkgDir) => {
    const key = path.resolve(pkgDir);
    if (seen.has(key)) return;
    seen.add(key);
    const pkg = readJson(path.join(pkgDir, "package.json"));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const found = resolveWithin(root, pkgDir, name);
      if (found) visit(found);
      else missing.push({ name, from: path.relative(root, pkgDir).split(path.sep).join("/") });
    }
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
      const found = resolveWithin(root, pkgDir, name);
      if (found) visit(found);
    }
  };
  if (existsSync(scope)) for (const name of readdirSync(scope).sort()) visit(path.join(scope, name));
  return missing;
}

/**
 * 足りない依存を、リポジトリの node_modules から root の同じ場所に写す（推移的に。入れ子の場所も保つ）。
 * 写したパッケージの場所（root からの相対パス）を返す。リポジトリにもなければ例外。
 */
function completeDependencies(root, repoRoot) {
  const copied = [];
  for (let round = 0; round < 100; round++) {
    const missing = missingDependencies(root);
    if (missing.length === 0) return copied;
    for (const m of missing) {
      // root の中の依存元と同じ場所を、リポジトリで探す（node_modules/@loc-studio/x は、リポジトリではワークスペースへのリンク）。
      const source = resolveWithin(repoRoot, path.join(repoRoot, ...m.from.split("/")), m.name);
      if (!source) throw new Error(`${m.from} の依存 "${m.name}" が、リポジトリの node_modules にありません。npm install を実行してください。`);
      const rel = path.relative(repoRoot, source);
      const dest = path.join(root, rel);
      if (existsSync(path.join(dest, "package.json"))) continue;
      cpSync(source, dest, { recursive: true, dereference: true });
      copied.push(rel.split(path.sep).join("/"));
    }
  }
  throw new Error(`依存を足しても、解決できないものが残りました: ${missingDependencies(root).map((m) => `${m.name}（${m.from}）`).join(", ")}`);
}

/** 足りない依存を、読める文にする。 */
function describeMissing(missing) {
  return missing.map((m) => `${m.name}（${m.from} が使う）`).join(", ");
}

module.exports = { resolveWithin, missingDependencies, completeDependencies, describeMissing };
