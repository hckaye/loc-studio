import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from "electron";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseProjectArg, userArgs } from "./args.js";
import { IPC_COMMAND, IPC_OPEN_PATH, IPC_PICK_FOLDER, IPC_PROJECTS_CHANGED } from "./ipc.js";
import { buildMenuTemplate } from "./menu.js";
import { resolveAppDir, resolveServerEntry, resolveWatchdog } from "./paths.js";
import { readRecentProjects } from "./recent.js";
import { redactToken } from "./redact.js";
import { ServerStartError, startServer, type ServerHandle } from "./server-launcher.js";
import { buildProjectUrl, isExternalUrl, isLocalUrl } from "./urls.js";

/*
 * デスクトップ版の殻。Next.js の standalone サーバーを Electron 自身の Node（ELECTRON_RUN_AS_NODE）で
 * 子プロセスとして起動し、127.0.0.1 の URL を BrowserWindow に表示する。
 * 子プロセスにする理由: サーバーの重い処理（SQLite、プラグインの実行）で UI を固めない、
 * 落ちても殻が生き残ってエラーを見せられる、終了時に確実に止められる。
 */

const devDir = path.resolve(__dirname, "..");
let server: ServerHandle | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;
let lastToken: string | undefined;
const safe = (text: string) => redactToken(text, lastToken);

function appDir(): string {
  return resolveAppDir({ isPackaged: app.isPackaged, platform: process.platform, exePath: app.getPath("exe"), devDir, env: process.env });
}

function pluginsDir(): string {
  return path.join(appDir(), "plugins");
}

/** プラグインフォルダを作る。読み取り専用の場所なら作れないが、それは異常ではない。 */
function ensurePluginsDir(): void {
  try {
    mkdirSync(pluginsDir(), { recursive: true });
  } catch (err) {
    console.warn(`プラグインフォルダを作れませんでした（${pluginsDir()}）: ${(err as Error).message}`);
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function recentProjects(): string[] {
  return readRecentProjects(app.getPath("userData"), (m) => console.warn(m));
}

function rebuildMenu(): void {
  const template = buildMenuTemplate({
    platform: process.platform,
    appName: app.getName(),
    recentProjects: recentProjects(),
    actions: {
      newProject: () => sendCommand({ type: "new" }),
      openProject: () => void pickAndOpenProject(),
      openRecent: (p) => openProjectInWindow(p),
      openPluginsFolder: () => void openFolder(pluginsDir(), true),
      openSettingsFolder: () => void openFolder(app.getPath("userData"), true),
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openFolder(target: string, create: boolean): Promise<void> {
  if (create) {
    try {
      mkdirSync(target, { recursive: true });
    } catch (err) {
      await dialog.showMessageBox({ type: "error", message: "フォルダを作れませんでした。", detail: `${target}\n${(err as Error).message}`, buttons: ["閉じる"] });
      return;
    }
  }
  const error = await shell.openPath(target);
  if (error) await dialog.showMessageBox({ type: "error", message: "フォルダを開けませんでした。", detail: `${target}\n${error}`, buttons: ["閉じる"] });
}

async function pickFolder(parent: BrowserWindow | undefined): Promise<string | null> {
  const options = { title: "プロジェクトのフォルダを選ぶ", properties: ["openDirectory" as const] };
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  return result.canceled || result.filePaths[0] === undefined ? null : result.filePaths[0];
}

async function pickAndOpenProject(): Promise<void> {
  const picked = await pickFolder(mainWindow);
  if (picked) openProjectInWindow(picked);
}

/**
 * 画面に操作を伝える（メニュー、2 つ目の起動）。ページは読み直さない。
 * 読み直すと、画面は起動時のプロジェクトを開き直してしまい、選んだプロジェクトが開かない。
 */
function sendCommand(command: { type: "open"; path: string } | { type: "new" }): void {
  if (!server || !mainWindow) return;
  mainWindow.webContents.send(IPC_COMMAND, command);
}

function openProjectInWindow(projectPath: string): void {
  sendCommand({ type: "open", path: projectPath });
}

/** レンダラーからの IPC は、ローカルサーバーのページからだけ受け付ける。 */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!server || !isLocalUrl(url, server.url)) throw new Error(`許可されていない呼び出し元です: ${url || "不明"}`);
}

function registerIpc(): void {
  ipcMain.handle(IPC_PICK_FOLDER, async (event) => {
    assertTrustedSender(event);
    return pickFolder(BrowserWindow.fromWebContents(event.sender) ?? undefined);
  });
  // プロジェクトを開いた・作ったあと: 最近の一覧が変わったので、メニューを作り直す。
  ipcMain.on(IPC_PROJECTS_CHANGED, (event) => {
    const url = event.senderFrame?.url ?? "";
    if (server && isLocalUrl(url, server.url)) rebuildMenu();
  });
  ipcMain.handle(IPC_OPEN_PATH, async (event, target: unknown) => {
    assertTrustedSender(event);
    if (typeof target !== "string" || target === "") throw new Error("開くパスが指定されていません。");
    const error = await shell.openPath(target);
    if (error) throw new Error(`開けませんでした（${target}）: ${error}`);
  });
}

function createWindow(baseUrl: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: "#ffffff",
    title: "loc-studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // タイトルはページ（document.title）に任せる
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const guardNavigation = (event: { preventDefault(): void }, url: string) => {
    if (isLocalUrl(url, baseUrl)) return;
    event.preventDefault();
    if (isExternalUrl(url)) void shell.openExternal(url);
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  // <webview> は使わない。付けようとしたものは拒否する
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  // ページを読み込んだら、最近の一覧をメニューに入れ直す（開いた・作ったときは、画面が IPC で知らせる）
  win.webContents.on("did-navigate-in-page", () => rebuildMenu());
  win.webContents.on("did-finish-load", () => rebuildMenu());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  return win;
}

async function showStartupError(err: unknown): Promise<void> {
  const output = safe(err instanceof ServerStartError ? err.output.trim() : "");
  const reason = safe(err instanceof Error ? err.message : String(err));
  await dialog.showMessageBox({
    type: "error",
    title: "loc-studio",
    message: "内部サーバーを起動できませんでした。",
    detail: `${reason}\n\n${output ? `サーバーの最後の出力:\n${output.slice(-2000)}` : "サーバーの出力はありません。"}`,
    buttons: ["終了"],
  });
}

function stopServerSync(): void {
  server?.killNow();
}

async function start(): Promise<void> {
  ensurePluginsDir();
  registerIpc();

  const cliProject = parseProjectArg(userArgs(process.argv, process.defaultApp === true), process.cwd());
  const remembered = recentProjects().find(isDirectory);
  const project = cliProject ?? remembered;

  const entryInput = { isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, devDir };
  try {
    server = await startServer({
      execPath: process.execPath,
      runAsNode: true,
      serverEntry: resolveServerEntry(entryInput),
      watchdog: resolveWatchdog(entryInput),
      appDir: appDir(),
      userDataDir: app.getPath("userData"),
      ...(project ? { project } : {}),
      onUnexpectedExit: ({ code, signal, output }) => {
        if (quitting) return;
        void showStartupError(new ServerStartError(`サーバーが予期せず終了しました（終了コード ${code ?? "なし"}${signal ? `、シグナル ${signal}` : ""}）。`, output)).finally(() => app.quit());
      },
    });
  } catch (err) {
    await showStartupError(err);
    app.exit(1);
    return;
  }

  lastToken = server.token;
  rebuildMenu();
  mainWindow = createWindow(server.url);
  // 最初だけ合言葉つきの URL で開く。画面側がクッキーに換えて、URL から消す。
  await mainWindow.loadURL(server.startUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, workingDirectory) => {
    // 2 つ目の起動は、既存のウィンドウを前に出し、フォルダが渡されていればそれを開く
    const project = parseProjectArg(userArgs(argv, process.defaultApp === true), workingDirectory);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    if (project && isDirectory(project)) openProjectInWindow(project);
  });

  app.on("before-quit", (event) => {
    quitting = true;
    if (!server) return;
    event.preventDefault();
    const s = server;
    server = undefined;
    void s.stop().finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (server && !mainWindow) {
      mainWindow = createWindow(server.url);
      void mainWindow.loadURL(buildProjectUrl(server.url));
    }
  });

  // メインが落ちる場合でも子プロセスを残さない（強制終了は watchdog が受け持つ）
  process.on("exit", stopServerSync);
  process.on("uncaughtException", (err) => {
    console.error(safe(err.stack ?? err.message));
    stopServerSync();
    dialog.showErrorBox("loc-studio", safe(`予期しないエラーが起きました。\n${err.stack ?? err.message}`));
    app.exit(1);
  });

  void app.whenReady().then(start).catch((err: unknown) => {
    stopServerSync();
    dialog.showErrorBox("loc-studio", safe(`起動に失敗しました。\n${err instanceof Error ? err.stack ?? err.message : String(err)}`));
    app.exit(1);
  });
}

