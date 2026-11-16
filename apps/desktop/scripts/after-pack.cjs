// electron-builder の afterPack。梱包したアプリの resources に、サーバー（build/server）を丸ごとコピーする。
// extraResources に任せると、electron-builder が node_modules のフォルダを落とす（filter に書いても入らなかった）。
// node_modules には next、react と、プラグインを読み込む jiti が入っていて、ないとサーバーが起動しない。
const { cpSync, existsSync, rmSync } = require("node:fs");
const path = require("node:path");
const { describeMissing, missingDependencies } = require("../../../scripts/standalone-deps.cjs");

/** サーバーの起動と、プラグインの読み込みに要るもの。1 つでも欠けていたら、配布物を作らずに失敗させる。 */
const REQUIRED = [
  "apps/web/launch.mjs",
  "apps/web/server.js",
  "apps/web/.next/static",
  "node_modules/next/package.json",
  "node_modules/react/package.json",
  "node_modules/jiti/package.json",
  "node_modules/@loc-studio/sdk/package.json",
];

function copyServer(from, to) {
  if (!existsSync(from)) throw new Error(`サーバーの置き場がありません: ${from}\n先に npm run stage -w @loc-studio/desktop を実行してください。`);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, dereference: true });
  const missing = REQUIRED.filter((rel) => !existsSync(path.join(to, rel)));
  if (missing.length > 0) throw new Error(`配布物のサーバーに、起動に要るファイルがありません: ${missing.join(", ")}（${to}）`);
  // サービス層（@loc-studio/*）の依存が、配布物の中だけで解決できること。
  // 欠けていても、リポジトリの中で動かすと上の階層の node_modules で動いてしまい、利用者の PC でだけ失敗する。
  const unresolved = missingDependencies(to);
  if (unresolved.length > 0) {
    throw new Error(`配布物のサーバーの中で解決できない依存があります: ${describeMissing(unresolved)}（${to}）\n先に npm run build:web を実行し直してください（依存を standalone に足します）。`);
  }
}

/** resources のフォルダ。macOS は .app の中にある。 */
function resourcesDir(context) {
  if (context.electronPlatformName === "darwin" || context.electronPlatformName === "mas") {
    return path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  }
  return path.join(context.appOutDir, "resources");
}

exports.default = async function afterPack(context) {
  const from = path.join(context.packager.projectDir, "build", "server");
  const to = path.join(resourcesDir(context), "server");
  copyServer(from, to);
  console.log(`  • サーバーを配布物に入れました  ${to}`);
};
exports.copyServer = copyServer;
exports.REQUIRED = REQUIRED;
