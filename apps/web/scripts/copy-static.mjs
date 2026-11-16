// next build のあと、standalone の server.js が静的ファイルを配れるように .next/static（と public）を中にコピーする。
// あわせて、サービス層（@loc-studio/*）の依存を standalone の中に足す（standalone だけを別の場所に置いても動くように）。
import { cpSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { completeDependencies, describeMissing, missingDependencies } = createRequire(import.meta.url)("../../../scripts/standalone-deps.cjs");

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneApp = path.join(appDir, ".next", "standalone", "apps", "web");
if (!existsSync(standaloneApp)) {
  console.error(`standalone の出力が見つかりません: ${standaloneApp}`);
  process.exit(1);
}
cpSync(path.join(appDir, ".next", "static"), path.join(standaloneApp, ".next", "static"), { recursive: true });
const pub = path.join(appDir, "public");
if (existsSync(pub)) cpSync(pub, path.join(standaloneApp, "public"), { recursive: true });
// 起動の仕組み（モード・アドレス・合言葉の確かめ）も standalone の中に置く。配布先では node launch.mjs で起動する
cpSync(path.join(appDir, "scripts", "launch.mjs"), path.join(standaloneApp, "launch.mjs"));
console.log(`静的ファイルと launch.mjs をコピーしました: ${standaloneApp}`);

// Next は、画面のコードが import するものだけを standalone に集める。サービス層は実行時に Node が読み込むので、
// その依存（acorn、pg など）は入らない。リポジトリの中では上の階層の node_modules で解決されて動くが、
// standalone をほかの場所に置く（デスクトップ版の配布物、サーバーへの配置）と「Cannot find package」で失敗する。
const standaloneRoot = path.join(appDir, ".next", "standalone");
const repoRoot = path.resolve(appDir, "..", "..");
const added = completeDependencies(standaloneRoot, repoRoot);
const still = missingDependencies(standaloneRoot);
if (still.length > 0) {
  console.error(`standalone の中で解決できない依存があります: ${describeMissing(still)}`);
  process.exit(1);
}
console.log(added.length > 0 ? `サービス層の依存を standalone に足しました: ${added.join(", ")}` : "サービス層の依存は、standalone の中にそろっています。");
