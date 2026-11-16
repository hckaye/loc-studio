// 梱包したデスクトップ版（electron-builder の出力）を実際に起動して確かめる。
// 見るのは、プロジェクトのない初めての起動から新しいプロジェクトを作れること、メニューの操作が画面に届くこと、
// サーバーが起動して画面が出ること、アプリを作り直さずにプラグインを後から足せること、終了でサーバーも止まること、
// 起動し直したときに前回の画面の状態（開いていたリソースと絞り込み）が戻ること。
// 使い方: npm run build:web && npm run dist:desktop のあと npm run check:desktop
//   アプリの場所は、環境変数 LOC_STUDIO_DESKTOP_APP（実行ファイルのパス）で指定できる。
//   見つからなければ、何も確かめずに終了コード 2 で終わる。画面を表示できる環境が要る。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "../..");
const sample = path.join(repoRoot, "examples", "sample-project");

/** 梱包したアプリの、写すフォルダと、その中の実行ファイル。 */
function findApp() {
  const fromEnv = process.env.LOC_STUDIO_DESKTOP_APP;
  if (fromEnv) return existsSync(fromEnv) ? { root: path.dirname(fromEnv), exe: path.basename(fromEnv) } : undefined;
  const release = path.join(desktopDir, "release");
  if (process.platform === "win32") {
    const root = path.join(release, "win-unpacked");
    return existsSync(path.join(root, "loc-studio.exe")) ? { root, exe: "loc-studio.exe" } : undefined;
  }
  if (process.platform === "darwin") {
    const dir = existsSync(release) ? readdirSync(release).find((n) => n.startsWith("mac") && existsSync(path.join(release, n, "loc-studio.app"))) : undefined;
    return dir ? { root: path.join(release, dir), exe: path.join("loc-studio.app", "Contents", "MacOS", "loc-studio") } : undefined;
  }
  const root = path.join(release, "linux-unpacked");
  return existsSync(path.join(root, "loc-studio")) ? { root, exe: "loc-studio" } : undefined;
}

const found = findApp();
if (!found) {
  console.error("梱包したアプリが見つからないため、確かめていません。先に npm run build:web と npm run dist:desktop を実行するか、LOC_STUDIO_DESKTOP_APP に実行ファイルの場所を指定してください。");
  process.exit(2);
}

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log(`  OK  ${label}`);
  else {
    failures++;
    console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.slice(0, 900) : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 利用者の手元と同じ形にする: アプリを別のフォルダに写し、プロジェクトと設定フォルダも一時のものにする。
const tmp = mkdtempSync(path.join(os.tmpdir(), "loc-studio-desktop-"));
const appRoot = path.join(tmp, "app");
const project = path.join(tmp, "project");
const userData = path.join(tmp, "user");
cpSync(found.root, appRoot, { recursive: true });
cpSync(sample, project, { recursive: true });
const exe = path.join(appRoot, found.exe);
// プラグインフォルダは、実行ファイル（macOS は .app）の隣。
const pluginsDir = path.join(process.platform === "darwin" ? appRoot : path.dirname(exe), "plugins");
const PLUGIN_FILE = path.join(pluginsDir, "after-install.ts");
// あとから置くプラグイン。TypeScript のままで、SDK を実行時に import する（アプリに入っている SDK に解決されること）。
const PLUGIN_SOURCE = `import { definePlugin } from "@loc-studio/sdk";

export default definePlugin({
  name: "after-install",
  version: "1.0.0",
  validators: [
    {
      id: "afterinstall.noOk",
      label: "あとから足したバリデータ",
      version: "1",
      severity: "warning",
      validate({ value }: { value: string }) {
        return value === "OK" ? [{ code: "after-install", message: "あとから足したプラグインが動いています" }] : [];
      },
    },
  ],
});
`;
{
  // 設定には、まだ入っていないバリデータを先に書いておく（プラグインを置くまでは「登録されていない」の警告になる）。
  const file = path.join(project, "loc-studio.project.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.validators.push("afterinstall.noOk");
  writeFileSync(file, JSON.stringify(config, null, 2));
}

/** いま動かしているアプリ（失敗したときに止めるため、覚えておく）。 */
let running;

/**
 * アプリを起動して、ウィンドウの中のページを DevTools のプロトコルで操作できるようにする。
 * 起動のたびに、内部サーバーは別のポートで動く。
 */
async function launch(opts = {}) {
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const args = ["--remote-debugging-port=0", `--user-data-dir=${opts.userData ?? userData}`];
  // inspectMain: メインプロセス（殻）にもつないで、アプリのメニューを押せるようにする。
  if (opts.inspectMain) args.unshift("--inspect=0");
  // project を null にすると、プロジェクトを渡さずに起動する（配布物をダブルクリックしたのと同じ）。
  if (opts.project !== null) args.push(opts.project ?? project);
  const app = spawn(exe, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const session = { app, log: "", exited: new Promise((resolve) => app.once("exit", resolve)) };
  running = session;
  app.stdout.on("data", (d) => (session.log += d));
  app.stderr.on("data", (d) => (session.log += d));

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`アプリが起動しませんでした: ${session.log.slice(-600)}`)), 60_000);
    const look = () => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(session.log);
      if (!m) return;
      clearTimeout(timer);
      resolve(m[1]);
    };
    app.stderr.on("data", look);
    app.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`アプリが終了しました（終了コード ${code}）: ${session.log.slice(-600)}`));
    });
  });
  const socket = new WebSocket(wsUrl);
  session.socket = socket;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  // ウィンドウは、内部サーバーが起動してから開く。ページが出るまで待つ。
  let target;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(250)) {
    const { targetInfos } = await send("Target.getTargets");
    target = targetInfos.find((t) => t.type === "page" && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url) && !t.url.includes("token="));
    if (target) break;
  }
  if (!target) throw new Error(`ウィンドウにページが出ませんでした: ${session.log.slice(-900)}`);
  const base = new URL(target.url).origin;
  const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`ページの中で失敗しました: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  session.evaluate = evaluate;
  const until = async (expression, label, timeout = 30_000) => {
    for (const deadline = Date.now() + timeout; Date.now() < deadline; await sleep(150)) {
      if (await evaluate(expression).catch(() => false)) return;
    }
    throw new Error(`待っても成り立ちませんでした: ${label}`);
  };
  // 画面と同じ口（/api/rpc）を、ページの中から呼ぶ（合言葉のクッキーはページが持っている）。
  // projectPath を省くと、起動のときに渡したプロジェクト。
  const rpc = async (method, params = {}, projectPath) => {
    const body = await evaluate(
      `fetch("/api/rpc/${method}", { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ ...(projectPath ? { project: projectPath } : {}), params }))}, cache: "no-store" }).then((r) => r.json())`,
    );
    if (body?.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
    return body.result;
  };
  /** ウィンドウを閉じて、アプリと内部サーバーが止まるのを待つ。 */
  const quit = async () => {
    // メインプロセスにつないだままだと、Node はデバッガーが離れるのを待って終了しない。先に離す。
    session.mainSocket?.close();
    await Promise.race([send("Browser.close").catch(() => undefined), sleep(5000)]);
    await Promise.race([session.exited, sleep(20_000)]);
    const exited = app.exitCode !== null;
    let serverAlive = true;
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(250)) {
      serverAlive = await fetch(`${base}/api/session`).then(
        () => true,
        () => false,
      );
      if (!serverAlive) break;
    }
    return { exited, serverAlive };
  };
  /** メインプロセスで式を評価する（inspectMain のときだけ）。メニューの項目を、利用者が押したのと同じ道筋で動かす。 */
  let mainEval;
  if (opts.inspectMain) {
    const m = /Debugger listening on (ws:\/\/\S+)/.exec(session.log);
    if (!m) throw new Error(`メインプロセスのデバッガーにつなげませんでした: ${session.log.slice(-600)}`);
    const mainSocket = new WebSocket(m[1]);
    session.mainSocket = mainSocket;
    await new Promise((resolve, reject) => {
      mainSocket.addEventListener("open", resolve, { once: true });
      mainSocket.addEventListener("error", reject, { once: true });
    });
    let mainId = 1;
    const mainPending = new Map();
    mainSocket.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const p = mainPending.get(msg.id);
      if (!p) return;
      mainPending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
    mainEval = (expression) =>
      new Promise((resolve, reject) => {
        const id = mainId++;
        mainPending.set(id, { resolve, reject });
        mainSocket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, includeCommandLineAPI: true } }));
      }).then((r) => {
        if (r.exceptionDetails) throw new Error(`メインプロセスで失敗しました: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
      });
  }
  if (mainEval) {
    // 内部サーバーの出力を覚えておく（確認が途中で止まったときに、サーバー側の理由を出すため）。
    await mainEval(
      `(() => { const child = process._getActiveHandles().find((h) => h && h.constructor && h.constructor.name === "ChildProcess"); if (!child) return false; globalThis.__serverLog = ""; const add = (d) => (globalThis.__serverLog = (globalThis.__serverLog + d.toString("utf8")).slice(-8000)); child.stdout?.on("data", add); child.stderr?.on("data", add); return true; })()`,
    );
    session.serverLog = () => mainEval(`globalThis.__serverLog ?? ""`);
  }
  /** 「ファイル」メニューの項目の名前の並び（区切りは "-"）。sub を渡すと、その項目の下のメニュー。 */
  const fileMenu = (sub) =>
    mainEval(
      `(() => { const { Menu } = require("electron"); let items = Menu.getApplicationMenu().items.find((i) => i.label === "ファイル").submenu.items; ${
        sub ? `items = items.find((i) => i.label === ${JSON.stringify(sub)}).submenu.items;` : ""
      } return items.map((i) => (i.type === "separator" ? "-" : i.label)); })()`,
    );
  /** 「ファイル」メニューの項目を押す。 */
  const clickFileMenu = (label, sub) =>
    mainEval(
      `(() => { const { Menu } = require("electron"); let items = Menu.getApplicationMenu().items.find((i) => i.label === "ファイル").submenu.items; ${
        sub ? `items = items.find((i) => i.label === ${JSON.stringify(sub)}).submenu.items;` : ""
      } const item = items.find((i) => i.label === ${JSON.stringify(label)}); if (!item) return false; item.click(); return true; })()`,
    );
  return { base, evaluate, until, rpc, quit, fileMenu, clickFileMenu };
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
/** ツリーのリソースの行（名前で探す）と、表のキーの並び。ページの中で評価する式。 */
const treeRow = (name) => `[...document.querySelectorAll(".tree-row.resource")].find((b) => b.textContent.includes(${JSON.stringify(name)}))`;
const KEYS = `[...document.querySelectorAll("[data-row] .k-key")].map((c) => c.textContent.trim()).join(",")`;
const SEARCH_BOX = `document.querySelector('input[type=search][aria-label="検索"]')`;

try {
  console.log("== はじめての起動（プロジェクトなし）と、新しいプロジェクト ==");
  {
    // 設定フォルダも、開いた記録もない状態で、プロジェクトを渡さずに起動する（配布物を初めてダブルクリックしたときと同じ）。
    const firstUser = path.join(tmp, "first-user");
    const fresh = path.join(tmp, "fresh-game");
    const second = path.join(tmp, "second-game");
    const NEW_BUTTON = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "新しいプロジェクトを作る…")`;
    const CREATE_BUTTON = `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "プロジェクトを作る")`;
    const PATH_FIELD = `document.querySelector("#new-project-path")`;
    const setInput = (finder, value) =>
      `(() => { const el = ${finder}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
    const run = await launch({ userData: firstUser, project: null, inspectMain: true });
    await run.until(`!!(${NEW_BUTTON}) && !(${NEW_BUTTON}).disabled`, "最初の画面に「新しいプロジェクトを作る…」が出る", 60_000);
    check(true, "プロジェクトを渡さずに起動すると（別にサーバーを立てなくても）、最初の画面に「新しいプロジェクトを作る…」が出る");
    check((await run.evaluate(`typeof window.locStudio?.pickFolder === "function" && typeof window.locStudio?.onCommand === "function"`)) === true, "画面から、フォルダを選ぶ窓とメニューの操作を使える");
    const menu = await run.fileMenu();
    check(menu.join("|") === "新しいプロジェクト…|プロジェクトを開く…|最近使ったプロジェクト|-|再読み込み|-|終了" || process.platform === "darwin", "「ファイル」メニューに「新しいプロジェクト…」がある", menu);

    // 画面のボタンから作る。
    await run.evaluate(`(${NEW_BUTTON}).click(), true`);
    await run.until(`!!${PATH_FIELD}`, "作成の画面");
    await run.evaluate(setInput(PATH_FIELD, fresh));
    await run.until(`!!(${CREATE_BUTTON}) && !(${CREATE_BUTTON}).disabled`, "作成のボタンが押せる");
    await run.evaluate(`(${CREATE_BUTTON}).click(), true`);
    await run.until(`!!(${treeRow("main.csv")})`, "作ったプロジェクトが開く", 60_000);
    check((await run.evaluate(`document.querySelectorAll('[role="dialog"]').length`)) === 0, "作ったプロジェクトは、信頼の確認なしで開く");
    check(
      existsSync(path.join(fresh, "loc-studio.project.json")) && readFileSync(path.join(fresh, "text", "main.csv"), "utf8") === "key,ja,en\n",
      "フォルダ、設定ファイル、最初のファイルができる",
    );
    check((await run.evaluate("document.title")) === "fresh-game - loc-studio", "ウィンドウのタイトルに、プロジェクトの名前が出る");
    await run.until(`(document.querySelector(".grid-empty")?.textContent ?? "").includes("まだ行がありません")`, "行の足し方の案内");
    // 梱包したアプリの中のサーバーで、行を足して本文を書ける。
    const madeTree = await run.rpc("tree", {}, fresh);
    const madeResource = madeTree.find((n) => n.kind === "folder")?.children?.[0]?.resource ?? madeTree[0]?.resource;
    await run.rpc("editEntries", { resourceId: madeResource?.id, changes: [{ type: "add", key: "TITLE", text: { ja: "はじめる" } }] }, fresh);
    check(readFileSync(path.join(fresh, "text", "main.csv"), "utf8") === "key,ja,en\nTITLE,はじめる,\n", "作ったプロジェクトに、行と本文を書ける", readFileSync(path.join(fresh, "text", "main.csv"), "utf8"));

    // メニューの「新しいプロジェクト…」: 開いているプロジェクトを離れて、作成の画面になる（ページは読み直さない）。
    check((await run.clickFileMenu("新しいプロジェクト…")) === true, "メニューの「新しいプロジェクト…」を押せる");
    await run.until(`!!${PATH_FIELD}`, "メニューから、作成の画面が出る");
    check((await run.evaluate("document.title")) === "loc-studio", "メニューの「新しいプロジェクト…」で、作成の画面になる");
    await run.evaluate(setInput(PATH_FIELD, second));
    await run.until(`!!(${CREATE_BUTTON}) && !(${CREATE_BUTTON}).disabled`, "作成のボタンが押せる");
    await run.evaluate(`(${CREATE_BUTTON}).click(), true`);
    await run.until(`document.title === "second-game - loc-studio"`, "2 つ目のプロジェクトが開く", 60_000);
    check(true, "メニューから、2 つ目のプロジェクトを作って開ける");

    // メニューの「最近使ったプロジェクト」: 選んだプロジェクトに切り替わる（起動時の状態に戻らない）。
    let recent = [];
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; await sleep(200)) {
      recent = await run.fileMenu("最近使ったプロジェクト");
      if (recent.length === 2) break;
    }
    check(recent.length === 2 && samePath(recent[0], second) && samePath(recent[1], fresh), "作ったプロジェクトが、メニューの「最近使ったプロジェクト」に新しい順で出る", recent);
    check((await run.clickFileMenu(recent[1], "最近使ったプロジェクト")) === true, "「最近使ったプロジェクト」の項目を押せる");
    await run.until(`document.title === "fresh-game - loc-studio"`, "選んだプロジェクトに切り替わる", 60_000);
    await run.until(`${KEYS} === "TITLE"`, "そのプロジェクトの行が出る");
    check(true, "メニューの「最近使ったプロジェクト」で、選んだプロジェクトに切り替わる");
    const stoppedFirst = await run.quit();
    check(stoppedFirst.exited && !stoppedFirst.serverAlive, "ウィンドウを閉じると、アプリと内部サーバーが止まる");

    // 次の起動では、何も渡さなくても、最後に開いたプロジェクトが開く。
    const again = await launch({ userData: firstUser, project: null });
    await again.until(`document.title === "fresh-game - loc-studio" && ${KEYS} === "TITLE"`, "最後に開いたプロジェクトが開く", 60_000);
    check(true, "次の起動では、最後に開いたプロジェクトが開く");
    const stoppedAgainFirst = await again.quit();
    check(stoppedAgainFirst.exited && !stoppedAgainFirst.serverAlive, "この起動も、ウィンドウを閉じると止まる");
  }

  console.log("== 起動 ==");
  const first = await launch();
  const { evaluate, until, rpc } = first;
  check(true, `内部サーバーが起動し、ウィンドウにページが出る（合言葉は URL から消えている）`);
  const versions = await evaluate("navigator.userAgent");
  console.log(`  ${/Electron\/\S+/.exec(versions)?.[0] ?? versions}  ${first.base}`);

  // 設定ファイルと、プロジェクトのプラグインを信頼する（画面では確認のダイアログで行う操作）。
  let info = await rpc("info");
  check(info.restricted === true, "開いた直後は、設定ファイルの信頼の確認を待っている");
  for (let i = 0; i < 3; i++) {
    const { untrusted } = await rpc("plugins");
    if (untrusted.length === 0) break;
    info = await rpc("trustPlugins", { items: untrusted.map((u) => ({ path: u.path, hash: u.hash })) });
  }
  check(info.restricted !== true && info.untrustedPlugins === 0, "設定ファイルとプロジェクトのプラグインを信頼すると、プロジェクトが開く", info);
  check(info.pluginErrors.length === 0, "プラグインの読み込みエラーがない", info.pluginErrors);
  check(
    info.validators.some((v) => v.id === "mystudio.lineWidth"),
    "プロジェクトのプラグインフォルダの TypeScript（loc-studio-plugins/line-width.ts）が、梱包したアプリで読み込まれる",
    info.validators.map((v) => v.id),
  );

  console.log("== プラグインをあとから足す ==");
  let plugins = await rpc("plugins");
  const appDirInfo = plugins.dirs.find((d) => d.layer === "app");
  check(appDirInfo !== undefined && samePath(appDirInfo.dir, pluginsDir) && appDirInfo.exists, "アプリの隣の plugins フォルダを探す対象にしていて、起動時に作ってある", plugins.dirs);
  const localDirInfo = plugins.dirs.find((d) => d.layer === "local");
  check(localDirInfo !== undefined && samePath(localDirInfo.dir, path.join(userData, "plugins")), "個人の設定フォルダの plugins も探す対象にしている", plugins.dirs);
  check(!plugins.plugins.some((p) => p.name === "after-install"), "置く前は、そのプラグインは一覧にない");
  check(
    info.warnings.some((w) => w.includes('"afterinstall.noOk" は登録されていません')),
    "置く前は、設定に書いたバリデータが登録されていないと警告する",
    info.warnings,
  );

  const tree = await rpc("tree");
  const resources = [];
  const walk = (nodes) => nodes.forEach((n) => (n.kind === "resource" ? resources.push(n.resource) : walk(n.children ?? [])));
  walk(tree);
  const ui = resources.find((r) => r.path.endsWith("system/ui.csv"));
  const textCol = info.columns.find((c) => c.kind === "text");
  const issuesOfOk = async () => {
    const { rows } = await rpc("rows", { resourceId: ui.id, languages: ["JaEnglish"], offset: 0, limit: 50 });
    const cell = rows.find((r) => r.key === "UI_OK")?.cells[`${textCol.id}@JaEnglish`];
    return { value: cell?.value, codes: (cell?.issues ?? []).map((i) => i.code) };
  };
  const before = await issuesOfOk();
  check(before.value === "OK" && !before.codes.includes("after-install"), "置く前は、その指摘は出ない", before);

  // アプリを動かしたまま、プラグインのファイルを置いて「再読み込み」する。
  writeFileSync(PLUGIN_FILE, PLUGIN_SOURCE);
  info = await rpc("reloadPlugins");
  check(info.pluginErrors.length === 0, "置いたあとの再読み込みで、読み込みエラーがない", info.pluginErrors);
  plugins = await rpc("plugins");
  const added = plugins.plugins.find((p) => p.name === "after-install");
  check(
    added !== undefined && added.layer === "app" && added.version === "1.0.0" && added.provides.validator.includes("afterinstall.noOk"),
    "置いた TypeScript のプラグインが、アプリを作り直さずに読み込まれる（SDK の import も解決される）",
    { added, errors: plugins.errors },
  );
  check(!info.warnings.some((w) => w.includes("afterinstall.noOk")), "「登録されていない」の警告が消える", info.warnings);
  check(plugins.untrusted.length === 0, "アプリの隣のプラグインは、信頼の確認なしで読み込む", plugins.untrusted);
  const after = await issuesOfOk();
  check(after.codes.includes("after-install"), "あとから足したバリデータが実際に呼ばれ、指摘が出る", after);

  console.log("== 画面 ==");
  await evaluate("location.reload(), true");
  await until(`document.readyState === "complete" && !!(${treeRow("ui.csv")})`, "ツリーにリソースが出る");
  check(true, "信頼したあとの画面に、プロジェクトのツリーが出る");
  // 条件式で、リソースをまたいで数えられる（集計と書き出しも、同じサーバーの処理を使う）。
  const counted = await rpc("query", { languages: ["ko"], where: "text@ko is empty or issues@ko >= error" });
  check(counted.matched.rows === 2 && counted.totalRows === 12, "条件式で、リソースをまたいで行を数えられる（韓国語が空か、エラーのある 2 行）", counted.matched);

  console.log("== 設定フォルダと終了 ==");
  // 開いているリソースと絞り込みを変えて、状態が保存されるのを待つ。
  await evaluate(`${treeRow("ui.csv")}.click(), true`);
  await until(`${KEYS}.startsWith("UI_OK")`, "ui.csv の行が出る");
  await evaluate(
    `(() => { const el = ${SEARCH_BOX}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "GOLD"); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
  );
  await until(`${KEYS} === "UI_GOLD"`, "検索で 1 行になる");
  let saved;
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; await sleep(200)) {
    saved = (await rpc("uiState")).state?.last;
    if (saved?.resourceId === ui.id && saved?.filters?.search === "GOLD") break;
  }
  check(saved?.resourceId === ui.id && saved?.filters?.search === "GOLD", "開いているリソースと絞り込みを、その PC の DB に保存する", saved);
  check(existsSync(path.join(userData, "web-session.json")), "個人の設定（最近開いたプロジェクト）を、指定した設定フォルダに書く");
  const stopped = await first.quit();
  check(stopped.exited, "ウィンドウを閉じると、アプリが終了する");
  check(!stopped.serverAlive, "アプリの終了で、内部サーバーも止まる（つながらなくなる）");

  console.log("== 起動し直したときの復元 ==");
  const second = await launch();
  // 起動のたびに、内部サーバーの接続先（ポート）は変わる。ブラウザの保存領域は接続先ごとなので、前の起動の分は読めない。
  console.log(`  ${second.base}（前の起動は ${first.base}）`);
  await second.until(`!!(${treeRow("ui.csv")}) && ${KEYS} !== ""`, "表が出る", 60_000);
  check((await second.rpc("info")).restricted !== true, "信頼の確認は、起動し直しても残っている（もう一度は出ない）");
  await second.until(`${KEYS} === "UI_GOLD"`, "前回の絞り込みで、行が出る");
  check(true, "起動し直すと、前回の絞り込みが戻る（検索で絞った 1 行だけが出る）");
  check((await second.evaluate(`${treeRow("ui.csv")}.classList.contains("selected")`)) === true, "前回開いていたリソースが開いている");
  check((await second.evaluate(`${SEARCH_BOX}.value`)) === "GOLD", "検索欄に、前回の検索の文字が入っている");
  const stoppedAgain = await second.quit();
  check(stoppedAgain.exited && !stoppedAgain.serverAlive, "2 回目も、ウィンドウを閉じるとアプリと内部サーバーが止まる");
} catch (err) {
  failures++;
  console.error(`\n確認の途中で失敗しました: ${err?.stack ?? err}`);
  if (running?.log.trim()) console.error(`アプリの出力（最後の部分）:\n${running.log.slice(-1500)}`);
  // 止まったときの画面の文字（何を待っていたかを調べる手がかり）。
  const shown = await running?.evaluate?.(`document.body.innerText.slice(0, 1500)`).catch(() => undefined);
  if (shown) console.error(`画面の文字（最初の部分）:\n${shown}`);
  const serverLog = await running?.serverLog?.().catch(() => undefined);
  if (serverLog) console.error(`内部サーバーの出力（最後の部分。起動の合言葉は伏せる）:\n${serverLog.replace(/token=[^\s&"']+/g, "token=[token]").slice(-3000)}`);
} finally {
  try {
    running?.socket?.close();
    running?.mainSocket?.close();
  } catch {
    // すでに閉じている。
  }
  if (running && running.app.exitCode === null) {
    running.app.kill();
    await Promise.race([running.exited, sleep(10_000)]);
  }
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  } catch (err) {
    console.error(`一時フォルダを消せませんでした。手で消してください: ${tmp}（${err?.message ?? err}）`);
  }
}

console.log(failures === 0 ? "\nすべての確認に成功しました。" : `\n${failures} 件の確認に失敗しました。`);
process.exit(failures === 0 ? 0 : 1);
