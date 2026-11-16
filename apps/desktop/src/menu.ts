import type { MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  newProject(): void;
  openProject(): void;
  openRecent(projectPath: string): void;
  openPluginsFolder(): void;
  openSettingsFolder(): void;
}

export interface MenuInput {
  platform: NodeJS.Platform;
  appName: string;
  recentProjects: readonly string[];
  actions: MenuActions;
}

/** 日本語のアプリケーションメニュー。role の項目も、既定の英語にならないように label を付ける。 */
export function buildMenuTemplate(input: MenuInput): MenuItemConstructorOptions[] {
  const { actions, platform } = input;
  const isMac = platform === "darwin";

  const recent: MenuItemConstructorOptions[] =
    input.recentProjects.length === 0
      ? [{ label: "（なし）", enabled: false }]
      : input.recentProjects.slice(0, 10).map((p) => ({ label: p, click: () => actions.openRecent(p) }));

  const file: MenuItemConstructorOptions = {
    label: "ファイル",
    submenu: [
      { label: "新しいプロジェクト…", accelerator: "CommandOrControl+N", click: () => actions.newProject() },
      { label: "プロジェクトを開く…", accelerator: "CommandOrControl+O", click: () => actions.openProject() },
      { label: "最近使ったプロジェクト", submenu: recent },
      { type: "separator" },
      { label: "再読み込み", role: "reload" },
      ...(isMac ? [] : ([{ type: "separator" }, { label: "終了", role: "quit" }] as MenuItemConstructorOptions[])),
    ],
  };

  const edit: MenuItemConstructorOptions = {
    label: "編集",
    submenu: [
      { label: "元に戻す", role: "undo" },
      { label: "やり直す", role: "redo" },
      { type: "separator" },
      { label: "切り取り", role: "cut" },
      { label: "コピー", role: "copy" },
      { label: "貼り付け", role: "paste" },
      { label: "すべて選択", role: "selectAll" },
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: "表示",
    submenu: [
      { label: "拡大", role: "zoomIn" },
      { label: "縮小", role: "zoomOut" },
      { label: "実際のサイズ", role: "resetZoom" },
      { type: "separator" },
      { label: "開発者ツール", role: "toggleDevTools" },
    ],
  };

  const help: MenuItemConstructorOptions = {
    label: "ヘルプ",
    submenu: [
      { label: "プラグインフォルダを開く", click: () => actions.openPluginsFolder() },
      { label: "設定フォルダを開く", click: () => actions.openSettingsFolder() },
    ],
  };

  const macApp: MenuItemConstructorOptions[] = isMac
    ? [{ label: input.appName, submenu: [{ label: `${input.appName} を隠す`, role: "hide" }, { label: "ほかを隠す", role: "hideOthers" }, { type: "separator" }, { label: `${input.appName} を終了`, role: "quit" }] }]
    : [];

  return [...macApp, file, edit, view, help];
}
