import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { IPC_OPEN_PATH, IPC_PICK_FOLDER } from "./ipc";
import { buildMenuTemplate } from "./menu";

const actions = { openProject: vi.fn(), openRecent: vi.fn(), openPluginsFolder: vi.fn(), openSettingsFolder: vi.fn() };
const labels = (items: readonly { label?: string; submenu?: unknown }[] | undefined) => (items ?? []).map((i) => i.label);

describe("buildMenuTemplate", () => {
  it("日本語のメニューを作り、最近の一覧から開ける", () => {
    const t = buildMenuTemplate({ platform: "win32", appName: "loc-studio", recentProjects: ["/p1", "/p2"], actions });
    expect(labels(t)).toEqual(["ファイル", "編集", "表示", "ヘルプ"]);
    const file = t[0]!.submenu as { label?: string; submenu?: { label?: string; click?: () => void }[] }[];
    expect(labels(file)).toEqual(expect.arrayContaining(["プロジェクトを開く…", "最近使ったプロジェクト", "再読み込み", "終了"]));
    const recent = file.find((i) => i.label === "最近使ったプロジェクト")!.submenu!;
    recent[1]!.click!();
    expect(actions.openRecent).toHaveBeenCalledWith("/p2");
    expect(labels(t[3]!.submenu as never)).toEqual(["プラグインフォルダを開く", "設定フォルダを開く"]);
    expect(labels(t[2]!.submenu as never)).toEqual(expect.arrayContaining(["拡大", "縮小", "開発者ツール"]));
  });
  it("最近の一覧が空なら無効な項目を出す。macOS はアプリメニューが先頭", () => {
    const t = buildMenuTemplate({ platform: "darwin", appName: "loc-studio", recentProjects: [], actions });
    expect(t[0]!.label).toBe("loc-studio");
    const file = t[1]!.submenu as { label?: string; submenu?: { enabled?: boolean }[] }[];
    expect(file.find((i) => i.label === "最近使ったプロジェクト")!.submenu![0]!.enabled).toBe(false);
  });
});

describe("preload", () => {
  it("IPC のチャンネル名が main 側と一致する", () => {
    const src = readFileSync(path.join(__dirname, "preload.ts"), "utf8");
    expect(src).toContain(`"${IPC_PICK_FOLDER}"`);
    expect(src).toContain(`"${IPC_OPEN_PATH}"`);
  });
});
