import { describe, expect, it } from "vitest";
import { resolveAppDir, resolveServerEntry, resolveWatchdog } from "./paths";

const base = { isPackaged: true, devDir: "/repo/apps/desktop" };

describe("resolveAppDir", () => {
  it("開発時は apps/desktop", () => {
    expect(resolveAppDir({ ...base, isPackaged: false, platform: "linux", exePath: "/usr/bin/electron" })).toBe("/repo/apps/desktop");
  });
  it("Windows は exe のあるフォルダ", () => {
    expect(resolveAppDir({ ...base, platform: "win32", exePath: "C:\\Apps\\loc-studio\\loc-studio.exe" })).toBe("C:\\Apps\\loc-studio");
  });
  it("Windows のポータブル版は元の exe のフォルダ", () => {
    expect(resolveAppDir({ ...base, platform: "win32", exePath: "C:\\Temp\\x\\loc-studio.exe", env: { PORTABLE_EXECUTABLE_DIR: "D:\\Tools" } })).toBe("D:\\Tools");
  });
  it("macOS は .app を含むフォルダ", () => {
    expect(resolveAppDir({ ...base, platform: "darwin", exePath: "/Applications/Studio/loc-studio.app/Contents/MacOS/loc-studio" })).toBe("/Applications/Studio");
  });
  it("macOS で .app が見つからなければ exe のフォルダ", () => {
    expect(resolveAppDir({ ...base, platform: "darwin", exePath: "/opt/loc/bin/loc-studio" })).toBe("/opt/loc/bin");
  });
  it("Linux は exe のフォルダ。AppImage は本体のあるフォルダ", () => {
    expect(resolveAppDir({ ...base, platform: "linux", exePath: "/opt/loc-studio/loc-studio" })).toBe("/opt/loc-studio");
    expect(resolveAppDir({ ...base, platform: "linux", exePath: "/tmp/.mount_abc/loc-studio", env: { APPIMAGE: "/home/u/apps/loc-studio.AppImage" } })).toBe("/home/u/apps");
  });
});

describe("resolveServerEntry / resolveWatchdog", () => {
  it("配布版は resources、開発時はリポジトリの出力", () => {
    const r = { resourcesPath: "/app/resources", devDir: "/repo/apps/desktop" };
    expect(resolveServerEntry({ isPackaged: true, ...r }).replace(/\\/g, "/")).toBe("/app/resources/server/apps/web/launch.mjs");
    expect(resolveServerEntry({ isPackaged: false, ...r }).replace(/\\/g, "/")).toBe("/repo/apps/web/.next/standalone/apps/web/launch.mjs");
    expect(resolveWatchdog({ isPackaged: true, ...r }).replace(/\\/g, "/")).toBe("/app/resources/watchdog.cjs");
    expect(resolveWatchdog({ isPackaged: false, ...r }).replace(/\\/g, "/")).toBe("/repo/apps/desktop/resources/watchdog.cjs");
  });
});
