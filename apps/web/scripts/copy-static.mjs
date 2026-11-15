// next build のあと、standalone の server.js が静的ファイルを配れるように .next/static（と public）を中にコピーする。
import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
