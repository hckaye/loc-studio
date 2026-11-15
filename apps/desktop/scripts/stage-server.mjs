// electron-builder に渡す前に、Web アプリの standalone 出力を apps/desktop/build/server にコピーする。
// ワークスペースのパッケージ（node_modules/@loc-studio/*）はシンボリックリンクなので、実体にして持ち込む
// （Windows や圧縮でリンクが壊れないように）。
import { cpSync, existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(desktopDir, "..", "web", ".next", "standalone");
const target = path.join(desktopDir, "build", "server");
const entry = path.join(standalone, "apps", "web", "launch.mjs");

if (!existsSync(entry) || !existsSync(path.join(standalone, "apps", "web", "server.js")) || !existsSync(path.join(standalone, "apps", "web", ".next", "static"))) {
  console.error(`standalone ビルド、launch.mjs、静的ファイルのどれかが見つかりません: ${standalone}\n先に npm run build:web を実行してください。`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(standalone, target, { recursive: true });

// cpSync はリンクを（絶対パスの）リンクのまま写すので、node_modules 直下（と @scope の下）のリンクを実体に置き換える。
function materialize(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (lstatSync(p).isSymbolicLink()) {
      const real = realpathSync(p);
      rmSync(p);
      cpSync(real, p, { recursive: true, dereference: true });
    } else if (name.startsWith("@")) {
      materialize(p);
    }
  }
}
materialize(path.join(target, "node_modules"));
console.log(`サーバーを配置しました: ${target}`);
