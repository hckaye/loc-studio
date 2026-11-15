import nodePath from "node:path";

type PathModule = typeof nodePath.posix;

export interface AppDirInput {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** app.getPath("exe") */
  exePath: string;
  /** 開発時の apps/desktop */
  devDir: string;
  /** process.env（APPIMAGE、PORTABLE_EXECUTABLE_DIR を見る） */
  env?: Record<string, string | undefined>;
}

function pathFor(platform: NodeJS.Platform): PathModule {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/**
 * プラグインフォルダ（<appDir>/plugins）の親。配布物の隣に置くので、実行ファイルのあるフォルダにする。
 * - macOS: .app バンドルを含むフォルダ
 * - AppImage: 実行ファイルは毎回違う一時マウント先にあるので、AppImage 本体のあるフォルダ
 * - Windows のポータブル版（nsis portable）: 展開先ではなく元の exe のあるフォルダ
 */
export function resolveAppDir(input: AppDirInput): string {
  if (!input.isPackaged) return input.devDir;
  const p = pathFor(input.platform);
  const env = input.env ?? {};
  if (input.platform === "darwin") {
    let dir = p.dirname(input.exePath);
    for (;;) {
      if (p.basename(dir).toLowerCase().endsWith(".app")) return p.dirname(dir);
      const parent = p.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return p.dirname(input.exePath);
  }
  if (input.platform === "linux" && env["APPIMAGE"]) return p.dirname(env["APPIMAGE"]);
  if (input.platform === "win32" && env["PORTABLE_EXECUTABLE_DIR"]) return env["PORTABLE_EXECUTABLE_DIR"];
  return p.dirname(input.exePath);
}

export interface ServerEntryInput {
  isPackaged: boolean;
  /** process.resourcesPath（配布版） */
  resourcesPath: string;
  /** 開発時の apps/desktop */
  devDir: string;
}

/** standalone ビルドの launch.mjs（モードと合言葉を確かめてから server.js を読み込む）。配布版は extraResources の server/、開発時はリポジトリの出力。 */
export function resolveServerEntry(input: ServerEntryInput): string {
  if (input.isPackaged) return nodePath.join(input.resourcesPath, "server", "apps", "web", "launch.mjs");
  return nodePath.join(input.devDir, "..", "web", ".next", "standalone", "apps", "web", "launch.mjs");
}

/** 親プロセスの終了を見張るスクリプト（resources/watchdog.cjs）。 */
export function resolveWatchdog(input: ServerEntryInput): string {
  if (input.isPackaged) return nodePath.join(input.resourcesPath, "watchdog.cjs");
  return nodePath.join(input.devDir, "resources", "watchdog.cjs");
}
