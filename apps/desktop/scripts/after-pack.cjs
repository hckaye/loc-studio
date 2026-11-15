// electron-builder の afterPack。梱包したアプリの resources に、サーバー（build/server）を丸ごとコピーする。
// extraResources に任せると、electron-builder が node_modules のフォルダを落とす（filter に書いても入らなかった）。
// node_modules には next、react と、プラグインを読み込む jiti が入っていて、ないとサーバーが起動しない。
const { cpSync, existsSync, rmSync } = require("node:fs");
const path = require("node:path");

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
