// ビルドした入口（dist/index.js）に実行権限を付ける。tsc は権限を付けないため、
// 付けないと Linux / macOS の node_modules/.bin/loc-studio が Permission denied になる。
// Windows にはファイルの実行権限がないので何もしない。
import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
  if (!existsSync(entry)) {
    console.error(`実行権限を付ける対象がありません: ${entry}（先に tsc でビルドしてください）`);
    process.exit(1);
  }
  chmodSync(entry, statSync(entry).mode | 0o111);
}
