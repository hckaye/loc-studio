// 画面を本物のブラウザ（ヘッドレスの Chrome / Edge）で操作して確かめる。
// コンポーネントのテスト（jsdom）では分からない、本番ビルドの画面とサーバーをつないだ動きを見る。
// 使い方: npm run build:web && npm run check:browser
//   ブラウザの場所は環境変数 LOC_STUDIO_CHROME で指定できる。見つからなければ、何も確かめずに終了コード 2 で終わる。
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "../..");
const sample = path.join(repoRoot, "examples", "sample-project");

function findBrowser() {
  const candidates = [
    process.env.LOC_STUDIO_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p) => p && existsSync(p));
}

const browserPath = findBrowser();
if (!browserPath) {
  console.error("ブラウザ（Chrome / Edge / Chromium）が見つからないため、確かめていません。LOC_STUDIO_CHROME に場所を指定してください。");
  process.exit(2);
}

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log(`  OK  ${label}`);
  else {
    failures++;
    console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`.slice(0, 600) : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

// ---- 一時のプロジェクト（サンプルの写し）。確かめたい設定を足す。
const tmp = mkdtempSync(path.join(os.tmpdir(), "loc-studio-browser-"));
const project = path.join(tmp, "project");
const userData = path.join(tmp, "user");
cpSync(sample, project, { recursive: true });
const UI_FILE = path.join(project, "Assets", "Text", "system", "ui.csv");
{
  const file = path.join(project, "loc-studio.project.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  // 「確定」にできるのは「作業中」からだけ。編集画面の長さは幅で数える。
  config.columns = config.columns.map((c) =>
    c.id === "textStatus"
      ? { ...c, type: { default: "todo", enum: [{ value: "todo", label: "未着手" }, { value: "wip", label: "作業中" }, { value: "done", label: "確定", complete: true, from: ["wip"] }] } }
      : c,
  );
  config.editor = { count: { unit: "width" } };
  // 日付の列（共有 DB に持つ、行に 1 つの列）。進捗は、原文の文字数で数える。
  config.columns.push({ id: "due", kind: "meta", scope: "entry", type: "date", source: "builtin.db", label: "期日" });
  config.grid = { progressUnit: "characters" };
  // 行が対象のアクション（「一括アクション」の確認に使う）。韓国語のステータスを「作業中」にする。
  config.actions = ["check.mark", "check.echo"];
  // 設定を宣言したプラグイン（入口が関数の形）。アクションが、設定の値を読んで結果の文言にする。
  writeFileSync(
    path.join(project, "loc-studio-plugins", "check-settings.mjs"),
    `export default (setup) => ({
  name: "browser-check-settings",
  version: "1.0.0",
  settings: [
    { key: "prefix", label: "接頭辞", description: "アクションの結果の先頭に付ける文字です。", type: "string", default: "既定" },
    { key: "limit", label: "上限", type: "number", default: 3 },
    { key: "mode", label: "やり方", type: "enum", options: [{ value: "strict", label: "きびしく" }, { value: "loose", label: "ゆるく" }], default: "strict" },
    { key: "enabled", label: "使う", type: "boolean", default: true },
  ],
  actions: [{
    id: "check.echo",
    label: "設定を読む",
    target: "row",
    async run() {
      return { message: "接頭辞: " + setup.settings.get("prefix") + " / 上限: " + setup.settings.get("limit") + " / " + setup.settings.get("mode") };
    },
  }],
});
`,
  );
  writeFileSync(
    path.join(project, "loc-studio-plugins", "check-actions.mjs"),
    `export default {
  name: "browser-check-actions",
  actions: [{
    id: "check.mark",
    label: "作業中にする",
    target: "row",
    async run(ctx) {
      return { patches: [{ resourceId: ctx.entry.resource.id, entryKey: ctx.entry.key, columnId: "textStatus", language: "ko", value: "wip" }] };
    },
  }],
};
`,
  );
  writeFileSync(file, JSON.stringify(config, null, 2));
}
const CONFIG_FILE = path.join(project, "loc-studio.project.json");
const readConfig = () => JSON.parse(readFileSync(CONFIG_FILE, "utf8"));

// ---- サーバー（本番ビルド）
const standalone = path.join(appDir, ".next", "standalone", "apps", "web", "server.js");
if (!existsSync(standalone)) {
  console.error("画面の本番ビルドがありません。先に npm run build:web を実行してください。");
  process.exit(2);
}
const launcher = existsSync(path.join(path.dirname(standalone), "launch.mjs")) ? path.join(path.dirname(standalone), "launch.mjs") : path.join(appDir, "scripts", "launch.mjs");
const TOKEN = "browser-check-token";
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [launcher], {
  env: { ...process.env, NODE_ENV: "production", PORT: String(port), LOC_STUDIO_MODE: "local", LOC_STUDIO_LOCAL_TOKEN: TOKEN, LOC_STUDIO_PROJECT: project, LOC_STUDIO_USER_DATA_DIR: userData },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

// ---- ブラウザ（DevTools のプロトコルで操作する）
const profile = path.join(tmp, "chrome-profile");
const browser = spawn(browserPath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--window-size=1600,1000", "about:blank"], {
  stdio: ["ignore", "ignore", "pipe"],
});
const wsUrl = await new Promise((resolve, reject) => {
  let err = "";
  const timer = setTimeout(() => reject(new Error(`ブラウザが起動しませんでした: ${err.slice(0, 300)}`)), 30_000);
  browser.stderr.on("data", (d) => {
    err += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
});

const socket = new WebSocket(wsUrl);
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

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);

/** ページの中で式を評価して、値を返す。 */
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(`ページの中で例外: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 200)}`);
  return r.result.value;
}

// ページの中で使う小さな道具（名前でボタンを探す、React の入力欄に値を入れる、など）。
const HELPERS = `
window.__t = {
  name: (el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\\s+/g, " ").trim(),
  all: (selector, root) => [...(root ?? document).querySelectorAll(selector)],
  button: (re, root) => __t.all("button", root).find((b) => re.test(__t.name(b))),
  dialog: (re) => __t.all('[role="dialog"]').find((d) => re.test(d.getAttribute("aria-label") ?? d.querySelector("h2, h1, .dialog-title")?.textContent ?? d.textContent ?? "")),
  setValue: (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  select: (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  },
  labeled: (label, root) => (root ?? document).querySelector('[aria-label="' + label + '"]'),
  keys: () => __t.all("[data-row] .k-key").map((c) => c.textContent.trim()),
  toasts: () => __t.all(".toast-msg").map((t) => t.textContent),
};
true`;

async function until(expression, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await evaluate(expression);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`待っても起きませんでした: ${what}`);
    await sleep(100);
  }
}
const click = (finder, what) => until(`(() => { const el = ${finder}; if (!el || el.disabled) return false; el.click(); return true; })()`, `${what} を押す`);
const fileHas = (text) => readFileSync(UI_FILE, "utf8").includes(text);
const untilFile = async (cond, what) => {
  const deadline = Date.now() + 20_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`待っても起きませんでした: ${what}`);
    await sleep(100);
  }
};

/** Web モードのサーバーと、役割を絞った利用者を用意する（アカウントと割り当てはコマンドラインで作る）。 */
function prepareWebMode() {
  const wproject = path.join(tmp, "web-project");
  cpSync(sample, wproject, { recursive: true });
  const file = path.join(wproject, "loc-studio.project.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  // ステータスだけ変えられる役割。本文、行の構成、リソースの作成はできない。
  config.roles = { lqa: { label: "LQA", can: ["edit", "review"], editColumns: ["textStatus"] } };
  writeFileSync(file, JSON.stringify(config, null, 2));
  const data = path.join(tmp, "web-data");
  const serverConfig = path.join(tmp, "server.json");
  writeFileSync(serverConfig, JSON.stringify({ projects: [{ id: "sample", name: "Sample", root: wproject }], auth: { mode: "password" }, serverDb: { driver: "sqlite", path: path.join(tmp, "server.db") } }));
  const cli = (args, env = {}) => {
    const r = spawnSync(process.execPath, [path.join(repoRoot, "apps", "cli", "dist", "index.js"), ...args, "--data-dir", data, "--server-config", serverConfig], {
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`コマンドラインが失敗しました（${args.join(" ")}）: ${r.stderr || r.stdout}`);
  };
  cli(["user", "add", "lqa1", "--password-env", "LQA_PASSWORD"], { LQA_PASSWORD: "lqa-pass-1234" });
  cli(["member", "set", "sample", "lqa1", "--role", "lqa"]);
  return { data, serverConfig };
}

let webServer;
let firstServer;
let llmServer;
let mockLlm;
let exitCode = 1;
try {
  // サーバーが答えるまで待つ。
  for (let i = 0; ; i++) {
    try {
      await fetch(base);
      break;
    } catch {
      if (i > 100) throw new Error(`サーバーが起動しませんでした:\n${serverLog.slice(-500)}`);
      await sleep(300);
    }
  }
  console.log(`ブラウザ: ${browserPath}\nサーバー: ${base}\n`);

  await send("Page.navigate", { url: `${base}/?token=${TOKEN}` }, sessionId);
  await until("document.readyState === 'complete'", "ページの読み込み");
  await evaluate(HELPERS);

  console.log("== 開く（設定とプラグインの信頼の確認） ==");
  // 信頼の確認のボタンを押していき、表が出て、確認を待っているものがなくなるまで待つ。
  // （プラグインを読み込まなくても表は出るので、表が出たことだけでは、確認が済んだか分からない。）
  await until(
    `(async () => {
      const b = __t.button(/^(信頼して開く|信頼して読み込む)$/);
      if (b) {
        if (!b.disabled) b.click();
        return false;
      }
      if (!document.querySelector('[data-row="0"] .k-key')) return false;
      const info = await fetch("/api/rpc/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) }).then((r) => r.json());
      return info.result?.restricted !== true && info.result?.untrustedPlugins === 0;
    })()`,
    "信頼の確認を済ませて、表が出る",
    60_000,
  );
  check(true, "設定とプラグインを信頼すると、表が出る");

  console.log("== ツリーと並べ替え ==");
  await click(`__t.all(".tree-row.resource").find((b) => /ui\\.csv/.test(b.textContent))`, "ツリーの ui.csv");
  await until(`__t.keys()[0] === "UI_OK"`, "ui.csv の行が出る");
  check((await evaluate(`__t.keys().join(",")`)) === "UI_OK,UI_CANCEL,UI_SAVE_CONFIRM,UI_GOLD", "リソースの中の順で行が並ぶ");
  // ui.csv の原文（日本語）は 2 + 5 + 8 + 12 = 27 文字。進捗の列（レビュー）は 4 言語にあるので、27 × 4 = 108。
  const uiProgress = `__t.all(".tree-row.resource").find((b) => /ui\\.csv/.test(b.textContent))?.querySelector(".tree-progress")?.title.split("\\n")[0]`;
  await until(`!!(${uiProgress})`, "ツリーに ui.csv の進捗が出る");
  check((await evaluate(uiProgress)) === "合計 0 / 108 文字（原文）（0%）", "ツリーの進捗を、設定の単位（原文の文字数）で数え、単位を示す", await evaluate(uiProgress));
  await click(`__t.button(/^キー で並べ替え/)`, "キーの見出し");
  await until(`__t.keys()[0] === "UI_CANCEL"`, "キーの昇順になる");
  check((await evaluate(`__t.keys().join(",")`)) === "UI_CANCEL,UI_GOLD,UI_OK,UI_SAVE_CONFIRM", "見出しを押すと、キーの昇順になる");
  await click(`__t.button(/^キー で並べ替え/)`, "キーの見出し（2 回目）");
  await until(`__t.keys()[0] === "UI_SAVE_CONFIRM"`, "キーの降順になる");
  check(true, "もう一度押すと、降順になる");
  await click(`__t.button(/^キー で並べ替え/)`, "キーの見出し（3 回目）");
  await until(`__t.keys()[0] === "UI_OK"`, "リソースの中の順に戻る");
  check(true, "3 回目で、リソースの中の順に戻る");

  console.log("== 行の追加・キーの変更・削除 ==");
  const selectRow = (i) => evaluate(`document.querySelector('[data-row="${i}"] .k-key').dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
  // 本物のマウスの操作（右クリック、Ctrl / Shift を押しながらのクリック）。メニューや選択は、ブラウザのイベントの順で決まるため。
  const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const centerOf = (finder) => evaluate(`(() => { const el = ${finder}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 }; })()`);
  const mouseClick = async (finder, { button = "left", modifiers = 0 } = {}) => {
    const at = await centerOf(finder);
    if (!at) throw new Error(`押す場所が見つかりません: ${finder}`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, modifiers }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button, buttons: button === "right" ? 2 : 1, clickCount: 1, modifiers }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button, buttons: 0, clickCount: 1, modifiers }, sessionId);
  };
  const cellMenu = `document.querySelector('[role="menu"][aria-label="セルと行の操作"]')`;
  const menuItems = () => evaluate(`__t.all('[role="menuitem"]', ${cellMenu}).map((b) => b.querySelector("span").textContent)`);
  const menuItem = (name) => `__t.all('[role="menuitem"]', ${cellMenu}).find((b) => b.querySelector("span").textContent === ${JSON.stringify(name)})`;
  /** セルを右クリックして、メニューが出るのを待つ。 */
  const rightClick = async (finder) => {
    await mouseClick(finder, { button: "right" });
    await until(`!!${cellMenu}`, "右クリックのメニューが出る");
  };
  await selectRow(0);
  await click(`__t.button(/^＋ 行を追加$/)`, "＋ 行を追加");
  await until(`!!__t.all('[role="dialog"] input')[0]`, "行を追加のダイアログ");
  await evaluate(`__t.setValue(__t.all('[role="dialog"] input')[0], "UI_BROWSER"), true`);
  await click(`__t.button(/^追加する$/)`, "追加する");
  await untilFile(() => fileHas("UI_BROWSER"), "リソースに行が書かれる");
  const lines = readFileSync(UI_FILE, "utf8").split("\n");
  check(lines[1].startsWith("UI_OK,") && lines[2].startsWith("UI_BROWSER,"), "選んだ行の後ろに、行がリソースへ書かれる", lines.slice(0, 4));
  await until(`__t.keys()[1] === "UI_BROWSER"`, "表に足した行が出る");
  check(true, "足した行が、表にも出る");

  // キーの変更は、右クリックのメニューから（ダブルクリックでも開ける）。
  await rightClick(`document.querySelector('[data-row="1"] .k-key')`);
  check((await menuItems()).includes("キーを変更…"), "キーのセルの右クリックのメニューに、キーの変更がある", await menuItems());
  await click(menuItem("キーを変更…"), "メニューの「キーを変更…」");
  await until(`__t.all('[role="dialog"] input')[0]?.value === "UI_BROWSER"`, "キーを変更のダイアログに、いまのキーが入っている");
  await evaluate(`__t.setValue(__t.all('[role="dialog"] input')[0], "UI_RENAMED"), true`);
  await click(`__t.button(/^変更する$/)`, "変更する");
  await untilFile(() => fileHas("UI_RENAMED") && !fileHas("UI_BROWSER"), "キーが書き換わる");
  await until(`__t.keys()[1] === "UI_RENAMED"`, "表のキーが変わる");
  check(true, "キーを変えると、リソースと表の両方が変わる");

  await selectRow(1);
  check((await evaluate(`__t.button(/^行を削除/).disabled`)) === false, "行を選ぶと、「行を削除」を押せる");
  await click(`__t.button(/^行を削除/)`, "行を削除");
  await click(`__t.button(/^削除する$/)`, "削除する");
  await untilFile(() => !fileHas("UI_RENAMED"), "行が消える");
  await until(`__t.keys().join(",") === "UI_OK,UI_CANCEL,UI_SAVE_CONFIRM,UI_GOLD"`, "表から行が消える");
  check(true, "行を消すと、リソースと表の両方から消える");

  console.log("== 絞り込み ==");
  check((await evaluate(`!document.querySelector('select[aria-label="問題の重さ"]')`)) === true, "「問題あり」を押すまで、重さの選択は出ない");
  await click(`__t.button(/^問題あり$/)`, "問題あり");
  await until(`document.querySelector('select[aria-label="問題の重さ"]')?.value === "warning"`, "重さの選択が出る");
  check(true, "「問題あり」を押すと、重さを選べる（既定は警告以上）");
  await click(`__t.button(/^問題あり$/)`, "問題あり（解除）");
  await until(`__t.keys().length === 4`, "絞り込みを外すと全行が出る");

  console.log("== 選択肢の遷移の制限 ==");
  await click(`__t.all('[data-row="0"] .k-enum button')[0]`, "ステータスのセル");
  await until(`!!document.querySelector('[role="listbox"]')`, "選択肢が開く");
  const options = await evaluate(`__t.all('[role="listbox"] [role="option"]').map((o) => [o.textContent.trim(), o.getAttribute("aria-disabled"), o.title])`);
  check(
    JSON.stringify(options) === JSON.stringify([["未着手", "false", ""], ["作業中", "false", ""], ["確定", "true", "「確定」には、作業中 からだけ変えられます"]]),
    "いまの値から変えられない選択肢は、理由つきで選べない",
    options,
  );
  await evaluate(`__t.all('[role="listbox"] [role="option"]')[2].click(), true`);
  await sleep(300);
  check((await evaluate(`__t.all('[data-row="0"] .k-enum button')[0].textContent.trim()`)).startsWith("未着手"), "選べない選択肢を押しても、値は変わらない");
  await evaluate(`__t.all('[role="listbox"] [role="option"]')[1]?.click(), true`);
  await until(`__t.all('[data-row="0"] .k-enum button')[0].textContent.trim().startsWith("作業中")`, "作業中に変わる");
  check(true, "選べる選択肢は、押すと変わる");

  console.log("== 日付の列 ==");
  const dueCell = `document.querySelector('[data-row="0"] .k-string')`;
  await evaluate(`${dueCell}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
  await until(`!!${dueCell}.querySelector("input")`, "日付のセルが編集の状態になる");
  check((await evaluate(`${dueCell}.querySelector("input").type`)) === "date", "日付の列のセルは、日付の入力欄で編集する");
  await evaluate(`(() => { const el = ${dueCell}.querySelector("input"); __t.setValue(el, "2026-11-15"); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return true; })()`);
  await until(`!${dueCell}.querySelector("input") && ${dueCell}.textContent.includes("2026-11-15")`, "日付がセルに出る");
  check(true, "日付を入れて Enter で、値が保存されて表に出る");
  // 読み直しても残っている（共有 DB に書かれた）。
  await click(`__t.all(".tree-row.resource").find((b) => /chapter01\\.csv/.test(b.textContent))`, "ツリーの chapter01.csv");
  await until(`__t.keys()[0] !== "UI_OK" && __t.keys().length > 0`, "別のリソースの行が出る");
  await click(`__t.all(".tree-row.resource").find((b) => /ui\\.csv/.test(b.textContent))`, "ツリーの ui.csv");
  await until(`__t.keys()[0] === "UI_OK"`, "ui.csv の行が出る");
  check((await evaluate(`${dueCell}.textContent.trim()`)) === "2026-11-15", "リソースを開き直しても、日付が残っている", await evaluate(`${dueCell}.textContent.trim()`));

  console.log("== 編集モーダル（参照の変数、長さの数え方） ==");
  // UI_GOLD（4 行目）の、2 つ目の言語（日本語を基にする言語）の本文を開く。
  await evaluate(`__t.all('[data-row="3"] .k-text')[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
  await until(`!!document.querySelector("#edit-textarea")`, "編集モーダルが開く");
  await until(`!!__t.button(/^\\{gold\\} を本文に入れる$/)`, "原文の変数のボタンが出る");
  check((await evaluate(`__t.all('[aria-label="参照"] [data-token]').map((e) => e.getAttribute("data-token") + ":" + e.textContent).join(",")`)) === "variable:{gold}", "参照の本文の変数に、種類の印が付く");
  await evaluate(`__t.setValue(document.querySelector("#edit-textarea"), "Gold: "), true`);
  await until(`__t.button(/^\\{gold\\} を本文に入れる$/).className.includes("missing")`, "本文にない変数が目立つ");
  check(true, "本文から変数を消すと、ボタンが「まだない」の見た目になる");
  check((await evaluate(`document.querySelector("[data-count-unit]").textContent.replace(/\\s+/g, " ").trim()`)) === "6 幅", "長さを、設定の数え方（幅）で出す");
  await evaluate(`(() => { const ta = document.querySelector("#edit-textarea"); ta.focus(); ta.setSelectionRange(6, 6); return true; })()`);
  await click(`__t.button(/^\\{gold\\} を本文に入れる$/)`, "変数のボタン");
  await until(`document.querySelector("#edit-textarea").value === "Gold: {gold}"`, "変数が本文に入る");
  check(true, "ボタンを押すと、変数がカーソルの位置に入る");
  await click(`__t.button(/^キャンセル/)`, "キャンセル");
  await click(`__t.button(/^破棄して閉じる$/)`, "破棄して閉じる");
  await until(`!document.querySelector("#edit-textarea")`, "編集モーダルが閉じる");

  console.log("== リソースの作成 ==");
  await click(`__t.button(/^リソースを作成$/)`, "リソースを作成");
  await until(`__t.all('[role="dialog"] input')[0]?.value === "Assets/Text/system/"`, "選んでいるリソースと同じフォルダが入っている");
  check(true, "場所の初期値は、選んでいるリソースと同じフォルダ");
  await evaluate(`__t.setValue(__t.all('[role="dialog"] input')[0], "Assets/Text/system/new.csv"), true`);
  await click(`__t.button(/^作成する$/)`, "作成する");
  const created = path.join(project, "Assets", "Text", "system", "new.csv");
  await untilFile(() => existsSync(created), "リソースのファイルができる");
  check(readFileSync(created, "utf8") === "ID,JP,EN,CN,KR,MaxLen\n", "見出しだけのリソースができる", readFileSync(created, "utf8"));
  await until(`__t.all(".tree-row.resource").some((b) => /new\\.csv/.test(b.textContent))`, "ツリーに出る");
  check(true, "作ったリソースが、ツリーに出る");

  console.log("== 条件で絞り込む、ツリーの件数、検索結果の表示、列の表示、状態の復元 ==");
  const treeRow = (name) => `__t.all(".tree-row.resource").find((b) => /${name}/.test(b.textContent))`;
  const matchLabel = (name) => `${treeRow(name)}?.querySelector(".tree-match")?.getAttribute("aria-label")`;
  await click(treeRow("chapter01\\.csv"), "ツリーの chapter01.csv");
  await until(`__t.keys()[0] === "CH01_INTRO_001"`, "chapter01.csv の行が出る");
  check((await evaluate(`!document.querySelector(".tree-match")`)) === true, "絞り込んでいないあいだは、ツリーに件数を出さない");
  // 欄、言語、比べ方を選んで条件を組み立てる（式は書かない）。
  await click(`__t.button(/^条件/)`, "条件");
  await until(`!!__t.labeled("条件 1 の欄")`, "条件の窓が開く");
  await evaluate(`__t.select(__t.labeled("条件 1 の欄"), "text"), true`);
  await until(`!!__t.labeled("条件 1 の言語")`, "言語を選ぶ欄が出る");
  await evaluate(`__t.select(__t.labeled("条件 1 の言語"), "ko"), __t.select(__t.labeled("条件 1 の比べ方"), "empty"), true`);
  await until(`document.querySelector(".query-preview .mono")?.textContent === "text@ko is empty"`, "組み立てた式が出る");
  check(true, "欄、言語、比べ方を選ぶと、式が組み立てられる（text@ko is empty）");
  await click(`__t.button(/^この条件で絞り込む$/)`, "この条件で絞り込む");
  await until(`__t.keys().join(",") === "CH01_CHOICE_001B"`, "韓国語の本文が空の行だけになる");
  check(true, "組み立てた条件で、表が絞り込まれる（韓国語の本文が空の 1 行）");
  // ツリーに、条件に合う行の数が出る。
  await until(`${matchLabel("chapter01\\.csv")} === "条件に合う行 1 件" && ${matchLabel("ui\\.csv")} === "条件に合う行 0 件"`, "ツリーに件数が出る");
  check(true, "ツリーのリソースに、条件に合う行の数が出る（chapter01.csv 1 件、ui.csv 0 件）");
  check((await evaluate(`document.querySelector(".tree-match-head strong")?.textContent`)) === "1 行", "ツリーの上に、合計が出る", await evaluate(`document.querySelector(".tree-match-head")?.textContent`));
  await click(`document.querySelector(".tree-match-head input[type=checkbox]")`, "該当ありだけ");
  await until(`!(${treeRow("ui\\.csv")}) && !!(${treeRow("chapter01\\.csv")})`, "合う行のないリソースが隠れる");
  check(true, "「該当ありだけ」で、合う行のないリソースをツリーから隠せる");
  await click(`document.querySelector(".tree-match-head input[type=checkbox]")`, "該当ありだけ（解除）");
  await until(`!!(${treeRow("ui\\.csv")})`, "すべてのリソースが出る");

  // カスタムクエリ（式で書く）。入力に合わせて候補が出て、選んで入れられる。
  await click(`__t.button(/^条件/)`, "条件（2 回目）");
  await click(`__t.button(/^カスタムクエリ$/)`, "カスタムクエリ");
  await until(`__t.labeled("条件式")?.value === "text@ko is empty"`, "組み立てた条件の式から書き始められる");
  check(true, "「カスタムクエリ」に切り替えると、選んで作った条件の式が入っている");
  const typeQuery = (text) => evaluate(`(() => { const el = __t.labeled("条件式"); el.focus(); __t.setValue(el, ${JSON.stringify(text)}); el.setSelectionRange(el.value.length, el.value.length); return true; })()`);
  const suggestions = `__t.all("#query-suggestions [role=option] .mono").map((o) => o.textContent)`;
  // 候補の一覧は、条件の窓に切り取られず、最後の候補まで選べる（一覧は窓の下にはみ出す位置に出る）。
  await typeQuery("");
  await until(`__t.all("#query-suggestions [role=option]").length > 5`, "欄の候補が並ぶ");
  const listShown = await evaluate(`(() => {
    const list = document.querySelector("#query-suggestions");
    const r = list.getBoundingClientRect();
    const hit = (y) => list.contains(document.elementFromPoint(r.left + 20, y));
    return { top: hit(r.top + 4), bottom: hit(r.bottom - 4), inView: r.bottom <= window.innerHeight, height: Math.round(r.height) };
  })()`);
  check(listShown.top && listShown.bottom && listShown.inView, "式の候補の一覧は、条件の窓に切り取られずに、下の端まで出る", listShown);
  const candidateCount = await evaluate(`__t.all("#query-suggestions [role=option]").length`);
  for (let i = 0; i < candidateCount - 1; i++) await evaluate(`__t.labeled("条件式").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })), true`);
  const lastCandidate = await evaluate(`(() => {
    const list = document.querySelector("#query-suggestions");
    const items = [...list.querySelectorAll("[role=option]")];
    const active = list.querySelector('[aria-selected="true"]');
    const r = active.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    return { count: items.length, isLast: active === items[items.length - 1], inside: r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1, hit: active.contains(document.elementFromPoint(r.left + 20, r.top + r.height / 2)), label: active.querySelector(".mono").textContent };
  })()`);
  check(lastCandidate.isLast && lastCandidate.inside && lastCandidate.hit, "↓ で最後の候補まで進むと、その候補が見える位置に出ていて、押せる", lastCandidate);
  await evaluate(`document.querySelector('#query-suggestions [aria-selected="true"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })), true`);
  await until(`__t.labeled("条件式").value.startsWith(${JSON.stringify(lastCandidate.label)})`, "最後の候補が入る");
  check(true, "最後の候補も、押して入れられる");
  await typeQuery("text@ko is empty or iss");
  await until(`${suggestions}.join(",") === "issues@,issueCode@"`, "欄の候補が出る");
  check(true, "欄を書く場所で、入力に合う欄の候補が出る（issues@、issueCode@）");
  await evaluate(`__t.labeled("条件式").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })), true`);
  await until(`__t.labeled("条件式").value === "text@ko is empty or issues@"`, "候補が入る");
  await until(`${suggestions}.includes("issues@ko")`, "続けて言語の候補が出る");
  check(true, "Enter で候補が入り、続けて言語の候補が出る");
  await typeQuery("text@ko is empty or issues@ko >= ");
  await until(`${suggestions}.join(",") === "none,info,warning,error"`, "値の候補が出る");
  check(true, "比べ方のあとで、値の候補が出る（問題の重さ）");
  // 誤った式は、当てる前にサーバーが断る。
  await typeQuery("text@ko is empty or nope = 1");
  await click(`__t.button(/^この条件で絞り込む$/)`, "誤った式を当てる");
  await until(`/"nope" に当たる列がありません/.test(document.querySelector(".query-panel [role=alert]")?.textContent ?? "")`, "誤りの説明が出る");
  check((await evaluate(`__t.keys().join(",")`)) === "CH01_CHOICE_001B", "誤った式は、説明を出して当てない（表は前の条件のまま）");
  await typeQuery("text@ko is empty or issues@ko >= error");
  await click(`__t.button(/^この条件で絞り込む$/)`, "式を当てる");
  await until(`__t.keys().join(",") === "CH01_CHOICE_001A,CH01_CHOICE_001B"`, "式で絞り込まれる");
  check(true, "「または」を含む式で絞り込める（空の本文、またはエラーのある行）");

  // お気に入りに保存する。
  await click(`__t.button(/お気に入り/)`, "お気に入り");
  await until(`!!__t.labeled("お気に入りの名前")`, "お気に入りの窓が開く");
  await evaluate(`__t.setValue(__t.labeled("お気に入りの名前"), "韓国語の残り"), true`);
  await click(`__t.button(/^保存$/, __t.dialog(/^お気に入りの条件$/))`, "お気に入りを保存");
  await until(`__t.toasts().includes("お気に入り「韓国語の残り」を保存しました")`, "保存の通知が出る");
  check(true, "いまの条件を、名前を付けてお気に入りに保存できる");
  await evaluate(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);

  // 検索結果の表示: プロジェクト全体の結果、集計、CSV への書き出し、行へ移る。
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(tmp, "downloads") });
  await click(`__t.button(/^全体$/)`, "検索の範囲を「全体」にする");
  const view = `document.querySelector('[role="region"][aria-label="検索結果の表示"]')`;
  await until(`(${view}?.querySelector(".search-view-summary")?.textContent ?? "").startsWith("2 行（全 12 行のうち。1 / 3 個のリソース）")`, "検索結果の表示に件数が出る");
  check(true, "検索結果の表示に、プロジェクト全体で条件に合う行の数が出る（2 行、3 個のリソースのうち 1 個）");
  const resultKeys = `__t.all('table[aria-label="結果の表"] tbody tr.search-row').map((r) => r.children[1].textContent)`;
  check((await evaluate(`${resultKeys}.join(",")`)) === "CH01_CHOICE_001A,CH01_CHOICE_001B", "結果の表に、条件に合う行が並ぶ", await evaluate(resultKeys));
  await evaluate(`__t.select(__t.labeled("集計の区切り"), "issues@ko"), true`);
  const groupRows = `__t.all('table[aria-label="集計の表"] tbody tr').map((r) => [...r.children].slice(0, 2).map((c) => c.textContent).join(":"))`;
  await until(`${groupRows}.join(",") === "warning:1,error:1"`, "集計が出る");
  check(true, "集計の区切り（韓国語の問題の重さ）を選ぶと、値ごとの行数が出る");
  await click(`__t.button(/^結果を CSV に保存$/)`, "結果を CSV に保存");
  const csvFile = path.join(tmp, "downloads", "loc-studio-search.csv");
  await untilFile(() => existsSync(csvFile), "CSV のファイルができる");
  const csv = readFileSync(csvFile);
  const csvText = csv.subarray(3).toString("utf8");
  check(csv[0] === 0xef && csv[1] === 0xbb && csv[2] === 0xbf, "CSV の先頭に BOM が付いている");
  check(csvText.startsWith("resource,key,") && csvText.split("\r\n").filter((l) => l.startsWith("Assets/Text/chapter01.csv,CH01_CHOICE_001")).length === 2, "CSV に、見出しと、条件に合う 2 行が入っている", csvText.slice(0, 300));
  // 一括アクション: 条件に合う行すべて（プロジェクト全体）に、アクションを実行する。
  const rpc = (method, params) =>
    evaluate(`fetch("/api/rpc/${method}", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: ${JSON.stringify(params)} }) }).then((r) => r.json()).then((b) => b.result ?? null)`);
  const koStatus = async (key) => (await rpc("rowDetail", { resourceId: "Assets/Text/chapter01.csv", key }))?.row?.cells?.["textStatus@ko"]?.value;
  check((await koStatus("CH01_CHOICE_001A")) === "todo" && (await koStatus("CH01_INTRO_001")) === "todo", "（前提）アクションの前は、韓国語のステータスが「未着手」");
  await click(`__t.button(/^一括アクション ▾$/, ${view})`, "検索結果の表示の一括アクション");
  await click(`__t.all('[role="menuitem"]', ${view}).find((b) => b.textContent.trim() === "作業中にする")`, "作業中にする");
  const bulkDialog = `__t.dialog(/^一括アクション: 作業中にする$/)`;
  await until(`(${bulkDialog}?.textContent ?? "").includes("プロジェクト全体の、絞り込みに合う 2 行に実行します")`, "確かめる窓に、対象の行数が出る");
  check((await koStatus("CH01_CHOICE_001A")) === "todo", "一括アクションは、確かめるまで実行しない（対象の行数を先に見せる）");
  await click(`__t.button(/^2 行に実行$/, ${bulkDialog})`, "2 行に実行");
  await until(`(${bulkDialog}?.querySelector('[role="status"]')?.textContent ?? "").includes("終わりました。")`, "実行が終わる");
  const bulkResult = await evaluate(`${bulkDialog}.querySelector('[role="status"]').textContent`);
  check(bulkResult.includes("リソース 1 / 1") && bulkResult.includes("条件に合った行 2 / 反映した変更 2 / エラー 0 件"), "終わると、条件に合った行と、反映した変更の数が出る", bulkResult);
  await click(`__t.all("button", ${bulkDialog}).filter((b) => __t.name(b) === "閉じる").at(-1)`, "閉じる");
  check((await koStatus("CH01_CHOICE_001A")) === "wip" && (await koStatus("CH01_CHOICE_001B")) === "wip", "条件に合う 2 行に、アクションが実行される（韓国語のステータスが「作業中」になる）");
  check((await koStatus("CH01_INTRO_001")) === "todo", "条件に合わない行には、実行しない");
  await click(`${resultKeys.replace(".map((r) => r.children[1].textContent)", "")}[1]`, "結果の 2 行目");
  await until(`!${view} && __t.keys().join(",") === "CH01_CHOICE_001A,CH01_CHOICE_001B"`, "表に戻る");
  await until(`document.querySelector(".grid-scroll")?.getAttribute("aria-activedescendant")?.startsWith("gc-1-")`, "選んだ行が選択される");
  check(true, "結果の行を押すと、絞り込みを保ったまま表に戻り、その行が選ばれる");

  // 列を隠し、並べ替えて、横にスクロールする。
  const enumCells = `document.querySelectorAll('[data-row="0"] .k-enum').length`;
  const enumBefore = await evaluate(enumCells);
  await click(`__t.button(/^表示する列を選ぶ/)`, "列");
  await click(`__t.all('[role="dialog"][aria-label="表示する列"] label.check').find((l) => l.textContent.trim().startsWith("テキスト"))?.querySelector("input")`, "ステータスの列のチェック");
  await until(`${enumCells} === 0`, "ステータスの列が消える");
  check(enumBefore > 0, "列の表示を切り替えると、その列が表から消える（ステータスの列）", enumBefore);
  await evaluate(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
  await click(`__t.button(/^キー で並べ替え/)`, "キーの見出し");
  await click(`__t.button(/^キー で並べ替え/)`, "キーの見出し（2 回目）");
  await until(`__t.keys().join(",") === "CH01_CHOICE_001B,CH01_CHOICE_001A"`, "キーの降順になる");
  // ツリーのフォルダをたたむ（開き直したあとも、たたんだままであること）。
  const systemFolder = `__t.all(".tree-row.folder").find((b) => b.querySelector(".tree-name")?.textContent === "system")`;
  await click(systemFolder, "ツリーの system フォルダ");
  await until(`!(${treeRow("ui\\.csv")})`, "フォルダをたたむと、中のリソースが隠れる");
  const scrolled = await evaluate(`(() => { const el = document.querySelector(".grid-scroll"); el.scrollLeft = 180; return el.scrollLeft; })()`);
  check(scrolled > 0, "表は横にスクロールできる（復元の確認の前提）", scrolled);
  // 状態がサーバー側に保存されるのを待つ（ブラウザの保存領域は消して、サーバー側から戻ることを確かめる）。
  const savedLeft = `fetch("/api/rpc/uiState", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) }).then((r) => r.json()).then((b) => b.result?.state?.last?.scroll?.left)`;
  await until(`${savedLeft}.then((v) => v === ${scrolled})`, "状態が、サーバー側に保存される");
  check(true, "画面の状態（スクロールの位置を含む）が、サーバー側（その PC の DB）に保存される");
  await evaluate(`localStorage.clear(), true`);
  await send("Page.navigate", { url: base }, sessionId);
  await until(`document.readyState === "complete" && !!document.querySelector('[data-row="0"] .k-key')`, "開き直して、表が出る", 60_000);
  await evaluate(HELPERS);
  check((await evaluate(`document.querySelector(".tree-row.resource.selected")?.textContent.includes("chapter01.csv")`)) === true, "開き直すと、前回開いていたリソースが開く");
  await until(`__t.keys().join(",") === "CH01_CHOICE_001B,CH01_CHOICE_001A"`, "絞り込みと並べ替えが戻る");
  check(true, "前回の絞り込み（条件式）と並べ替え（キーの降順）が戻る");
  check((await evaluate(`__t.button(/^条件/).textContent.includes("式")`)) === true, "条件のボタンに、式で絞り込んでいることが出る");
  check((await evaluate(enumCells)) === 0, "隠した列は、隠れたまま");
  await until(`document.querySelector(".grid-scroll").scrollLeft === ${scrolled}`, "横のスクロールの位置が戻る");
  check(true, "スクロールの位置が戻る");
  check((await evaluate(`${systemFolder}?.closest('[role="treeitem"]')?.getAttribute("aria-expanded") === "false" && !(${treeRow("ui\\.csv")})`)) === true, "たたんだフォルダは、たたんだまま");
  await click(systemFolder, "ツリーの system フォルダ（開く）");
  await until(`!!(${treeRow("ui\\.csv")})`, "フォルダを開くと、中のリソースが出る");
  check((await evaluate(`__t.button(/お気に入り/).textContent.includes("1")`)) === true, "お気に入りが残っている");
  // お気に入りを選ぶと、その条件になる（いまは同じ条件なので、いったん条件を外してから選ぶ）。
  await click(`__t.button(/^条件/)`, "条件（外す）");
  await click(`__t.button(/^条件を外す$/)`, "条件を外す");
  await until(`__t.keys().length === 8`, "条件を外すと全行が出る");
  await until(`!document.querySelector(".tree-match")`, "ツリーの件数が消える");
  check(true, "条件を外すと、全行が出て、ツリーの件数も消える");
  await click(`__t.button(/お気に入り/)`, "お気に入り");
  await click(`__t.all('[role="dialog"][aria-label="お気に入りの条件"] .menu-item').find((b) => b.textContent.trim() === "韓国語の残り")`, "お気に入りの項目");
  await until(`__t.keys().length === 2`, "お気に入りの条件になる");
  check(true, "お気に入りを選ぶと、保存した条件で絞り込まれる");
  // あとの確認のために、列の表示を戻す。
  await click(`__t.button(/^表示する列を選ぶ/)`, "列");
  await click(`__t.button(/^すべて表示$/)`, "すべて表示");
  await until(`${enumCells} > 0`, "列が戻る");
  await evaluate(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);

  // 表のツールバーの一括アクション: 開いているリソースの、絞り込みに合う行が対象。
  await click(`__t.button(/^一括アクション ▾$/)`, "表の一括アクション");
  await until(`(document.querySelector('[role="menu"] .menu-note')?.textContent ?? "") === "このリソースの、絞り込みに合う 2 行に実行（次の窓で、プロジェクト全体に広げられます）"`, "メニューに、対象の行数が出る");
  check(true, "表のツールバーの一括アクションは、開いているリソースの、絞り込みに合う行を対象にする（2 行）");
  await evaluate(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);

  console.log("== 設定の画面で、プロジェクト設定を変える（言語、列の対応、列、検証） ==");
  {
    const settings = `__t.dialog(/^設定$/)`;
    const saved = async (what) => {
      await until(`__t.toasts().includes("プロジェクト設定を保存しました")`, `${what}: 保存の通知が出る`);
      // 通知を消して、次の保存の通知と区別できるようにする。
      await evaluate(`__t.all('.toast [aria-label="通知を閉じる"]').forEach((b) => b.click()), true`);
      await until(`!__t.toasts().includes("プロジェクト設定を保存しました")`, "通知が消える");
    };
    const original = readConfig();
    await click(`__t.button(/^設定$/)`, "設定");
    await until(`!!__t.labeled("ko の表示名", ${settings})`, "設定の画面に、言語の編集が出る");
    // 言語を足す。
    await evaluate(`__t.setValue(__t.labeled("追加する言語の ID"), "fr"), __t.setValue(__t.labeled("追加する言語の表示名"), "フランス語"), true`);
    await click(`__t.button(/^言語を追加$/, ${settings})`, "言語を追加");
    await click(`__t.button(/^言語を保存$/, ${settings})`, "言語を保存");
    await saved("言語");
    check(JSON.stringify(readConfig().languages.at(-1)) === JSON.stringify({ id: "fr", label: "フランス語", basedOn: "ja" }), "設定の画面で言語を足して保存すると、設定ファイルの languages に書かれる", readConfig().languages);
    check(JSON.stringify(readConfig().languages.slice(0, -1)) === JSON.stringify(original.languages), "すでにある言語の設定（グループなど、画面に欄のない項目を含む）は変わらない");
    check((await evaluate(`document.querySelectorAll('[role="dialog"]').length`)) === 1 && (await rpc("info", {}))?.restricted !== true, "基盤の項目のある設定ファイルを画面から変えても、信頼の確認は出ない（自分の変更なので）");
    check((await rpc("info", {}))?.languages?.some((l) => l.id === "fr") === true, "足した言語が、読み直したプロジェクトに入っている");
    // 列の対応: 足した言語の本文の列を決める。
    const frHeader = `${settings}.querySelector("#ps-mapping-text-fr")`;
    await until(`!!${frHeader}`, "列の対応に、足した言語の欄が出る");
    check((await evaluate(`${settings}.querySelector("#ps-mapping-key").value + "/" + ${settings}.querySelector("#ps-mapping-text-ko").value`)) === "ID/KR", "列の対応の欄に、いまの設定（キーは ID、韓国語は KR）が入っている");
    check((await evaluate(`__t.all("#ps-mapping-headers option").map((o) => o.value).includes("MaxLen")`)) === true, "見出しの候補に、ファイルの見出しが出る（MaxLen など）");
    await evaluate(`__t.setValue(${frHeader}, "FR"), true`);
    await click(`__t.button(/^列の対応を保存$/, ${settings})`, "列の対応を保存");
    await saved("列の対応");
    const mapped = readConfig().formats[0];
    check(mapped.options.text.fr === "FR" && mapped.options.key === "ID" && mapped.options.text.ko === "KR" && mapped.options.columns.maxLength === "MaxLen", "列の対応を保存すると、formats のオプションに書かれ、ほかのオプションは残る", mapped);
    check((await evaluate(`document.querySelectorAll('[role="dialog"]').length`)) === 1 && (await rpc("info", {}))?.restricted !== true, "列の対応（基盤の項目）を画面から変えても、信頼の確認は出ない");
    // 列: 表示名を変える。
    await evaluate(`__t.setValue(__t.labeled("列 due の表示名", ${settings}), "締め切り"), true`);
    await click(`__t.button(/^列を保存$/, ${settings})`, "列を保存");
    await saved("列");
    check(readConfig().columns.find((c) => c.id === "due")?.label === "締め切り" && readConfig().columns.length === original.columns.length, "列の表示名を変えて保存すると、設定ファイルの columns に書かれる");
    check((await rpc("info", {}))?.columns?.find((c) => c.id === "due")?.label === "締め切り", "変えた表示名が、読み直したプロジェクトに入っている");
    // 検証: 1 つ消して、足し直す。
    const validatorCount = original.validators.length;
    await click(`__t.button(/^未翻訳（5 番目）を削除$/, ${settings})`, "未翻訳の検証を削除");
    await click(`__t.button(/^検証を保存$/, ${settings})`, "検証を保存");
    await saved("検証");
    check(readConfig().validators.length === validatorCount - 1 && !readConfig().validators.includes("builtin.untranslated"), "検証を消して保存すると、設定ファイルの validators から消える", readConfig().validators);
    await until(`__t.all('[aria-label="追加する検証"] option', ${settings}).some((o) => o.value === "builtin.untranslated")`, "足せる検証の一覧が出る");
    await evaluate(`__t.select(__t.labeled("追加する検証", ${settings}), "builtin.untranslated"), true`);
    await click(`__t.button(/^検証を追加$/, ${settings})`, "検証を追加");
    await click(`__t.button(/^検証を保存$/, ${settings})`, "検証を保存（足し直す）");
    await saved("検証（足し直す）");
    check(readConfig().validators.at(-1) === "builtin.untranslated" && readConfig().validators.length === validatorCount, "登録済みの検証を選んで足すと、設定ファイルの validators に書かれる", readConfig().validators);
    // あとの確認のために、足した言語と列の対応、列の表示名を戻す。
    await evaluate(`__t.setValue(${frHeader}, ""), true`);
    await click(`__t.button(/^列の対応を保存$/, ${settings})`, "列の対応を保存（戻す）");
    await saved("列の対応（戻す）");
    await click(`__t.button(/^fr を削除$/, ${settings})`, "fr を削除");
    await click(`__t.button(/^言語を保存$/, ${settings})`, "言語を保存（戻す）");
    await saved("言語（戻す）");
    await evaluate(`__t.setValue(__t.labeled("列 due の表示名", ${settings}), "期日"), true`);
    await click(`__t.button(/^列を保存$/, ${settings})`, "列を保存（戻す）");
    await saved("列（戻す）");
    const restored = readConfig();
    check(JSON.stringify(restored.languages) === JSON.stringify(original.languages) && JSON.stringify(restored.formats) === JSON.stringify(original.formats) && JSON.stringify(restored.columns) === JSON.stringify(original.columns), "言語を消し、列の対応と表示名を戻すと、設定ファイルの languages / formats / columns が元の内容に戻る", { languages: restored.languages, formats: restored.formats });
    await click(`__t.all("button", ${settings}).find((b) => __t.name(b) === "閉じる")`, "設定を閉じる");
    await until(`document.querySelectorAll('[role="dialog"]').length === 0 && __t.keys().length === 2`, "設定を閉じると、表に戻る");
    check(true, "設定を変えたあとも、表はそのまま使える（絞り込みも残る）");
  }

  console.log("== ツールバーのまとまり、列の幅のドラッグ、レビューの投稿 ==");
  {
    // ---- ツールバー: 役目ごとのまとまりと、絞り込みの解除
    const groups = await evaluate(`__t.all('[role="toolbar"] > .tb-row > [role="group"]').map((g) => g.getAttribute("aria-label"))`);
    check(
      JSON.stringify(groups) === JSON.stringify(["検索と条件", "列の値で絞り込む", "行の状態で絞り込む", "行とリソースの操作", "表示", "保存"]),
      "ツールバーは、役目ごとのまとまり（検索、列の値、行の状態、操作、表示、保存）に分かれている",
      groups,
    );
    const captions = await evaluate(`__t.all('[role="toolbar"] .tb-caption').filter((c) => c.getBoundingClientRect().width > 0).map((c) => c.textContent.trim())`);
    check(JSON.stringify(captions) === JSON.stringify(["検索", "列の値で絞り込む", "行の状態で絞り込む", "操作", "表示"]), "まとまりの見出しが、画面に出ている", captions);
    const clearButton = `__t.button(/^絞り込みを解除（\\d+）$/)`;
    check((await evaluate(`!!${clearButton}`)) === true, "絞り込んでいる間は、「絞り込みを解除」が出る");
    await click(clearButton, "絞り込みを解除");
    await until(`!${clearButton} && __t.keys().length > 2`, "絞り込みが外れて、行が増える");
    check(true, "「絞り込みを解除」で、絞り込みがまとめて外れる");

    // ---- 探す範囲の切り替え（専用の検索の窓はない）、設定のボタン、キーのセルのダブルクリック
    const scopeButton = (name) => `__t.all('[role="group"][aria-label="探す範囲"] button').find((b) => b.textContent.trim() === ${JSON.stringify(name)})`;
    const resultsView = `document.querySelector('[role="region"][aria-label="検索結果の表示"]')`;
    check((await evaluate(`!__t.button(/横断検索/)`)) === true, "上のバーに、専用の検索のボタンはない");
    check((await evaluate(`${scopeButton("このファイル")}?.getAttribute("aria-pressed")`)) === "true", "探す範囲は、最初は「このファイル」");
    await click(scopeButton("全体"), "探す範囲を「全体」にする");
    await until(`!!${resultsView} && !document.querySelector('[role="grid"]')`, "表の代わりに、プロジェクト全体の検索結果が出る");
    check((await evaluate(`document.querySelector('[role="toolbar"] input[type="search"]').placeholder`)) === "キーと本文を検索（プロジェクト全体）", "範囲を「全体」にすると、検索欄の説明も「プロジェクト全体」になる");
    await click(scopeButton("このファイル"), "探す範囲を「このファイル」に戻す");
    await until(`!${resultsView} && !!document.querySelector('[role="grid"]') && __t.keys().length > 0`, "開いているファイルの表に戻る");
    check(true, "探す範囲の「全体」でプロジェクト全体の検索結果が出て、「このファイル」で表に戻る");
    check((await evaluate(`__t.button(/^設定$/).textContent.replace(/\\s+/g, " ").trim()`)) === "⚙ 設定", "右上の設定のボタンは、「設定」と文字で出ている");
    const firstKey = await evaluate(`__t.keys()[0]`);
    await evaluate(`document.querySelector('[data-row="0"] .k-key').dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
    await until(`!!__t.dialog(/^キーを変更$/)`, "キーのセルのダブルクリックで、キーの変更の窓が開く");
    check((await evaluate(`__t.dialog(/^キーを変更$/).querySelector("input").value`)) === firstKey, "キーの変更の窓に、その行のキーが入っている", firstKey);
    await click(`__t.labeled("閉じる", __t.dialog(/^キーを変更$/))`, "キーの変更を閉じる");
    await until(`!__t.dialog(/^キーを変更$/)`, "窓が閉じる");

    // ---- 列の幅: 本物のマウスの操作でドラッグする（境目のどこをつかめるかは、画面の重なりで決まるため）
    const mouse = (type, x, y, buttons) => send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 }, sessionId);
    const widthOf = (cellId) => evaluate(`__t.all(".g-hcell").find((c) => c.title.endsWith("（" + ${JSON.stringify(cellId)} + "）"))?.getBoundingClientRect().width ?? null`);
    /** 取っ手の中央をつかんで dx だけ動かす。つかんだ点にあるのが取っ手そのものかと、幅を変える列を返す。 */
    const dragHandle = async (finder, dx) => {
      const at = await evaluate(`(() => {
        const handle = ${finder};
        if (!handle) return null;
        const r = handle.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return { x, y, target: handle.dataset.resize, onTop: document.elementFromPoint(x, y) === handle };
      })()`);
      if (!at) return null;
      await mouse("mouseMoved", at.x, at.y, 0);
      await mouse("mousePressed", at.x, at.y, 1);
      for (let i = 1; i <= 5; i++) await mouse("mouseMoved", at.x + (dx * i) / 5, at.y, 1);
      await mouse("mouseReleased", at.x + dx, at.y, 0);
      return at;
    };
    const firstLanguage = `__t.all(".g-group").find((g) => g.querySelector(".g-group-tools"))`;
    const groupEdge = `${firstLanguage}?.querySelector(".g-resize:not(.g-resize-prev)")`;
    /** 取っ手を dx だけドラッグして、対象の列の幅が dx だけ変わることを確かめ、元の幅に戻す。 */
    const resizes = async (finder, label) => {
      const target = await evaluate(`${finder}?.dataset.resize ?? null`);
      const before = target === null ? null : await widthOf(target);
      const at = await dragHandle(finder, 30);
      const after = target === null ? null : await widthOf(target);
      check(at?.onTop === true && before !== null && after === before + 30, label, { target, before, after, onTop: at?.onTop });
      // ドラッグのあとで取っ手の位置が変わるので、もう一度つかんで戻す。
      await dragHandle(finder, -30);
      const restored = target === null ? null : await widthOf(target);
      check(restored === before, `${label}（逆向きにドラッグすると、元の幅に戻る）`, { before, restored });
      return target;
    };
    const lastOfGroup = await resizes(groupEdge, "言語の見出しの境目をドラッグすると、その言語の最後の列の幅が変わる");
    await resizes(`__t.all(".g-hcell").find((c) => c.title.endsWith("（" + ${JSON.stringify(lastOfGroup)} + "）"))?.querySelector(".g-resize:not(.g-resize-prev)")`, "列の見出しの右端をドラッグすると、その列の幅が変わる");
    // 列を本文だけにする（言語ごとの列が 1 つだけになる）。
    await click(`__t.button(/^表示する列を選ぶ/)`, "列");
    await until(`!!document.querySelector(".columns-panel")`, "列のメニュー");
    for (;;) {
      const more = await evaluate(`(() => {
        const label = __t.all(".columns-panel fieldset label").find((l) => { const i = l.querySelector("input"); return !i.disabled && i.checked && !/^本文/.test(l.textContent.trim()); });
        if (!label) return false;
        label.querySelector("input").click();
        return true;
      })()`);
      if (!more) break;
      await sleep(50);
    }
    await evaluate(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
    await until(`${groupEdge}?.dataset.resize?.startsWith("text@") && __t.all(".g-hcell").every((c) => /^(キー|本文)（/.test(c.title))`, "言語ごとの列が、本文だけになる");
    const single = await resizes(groupEdge, "列を本文だけにした言語でも、言語の見出しの境目をドラッグすると、本文の幅が変わる");
    const textHeader = `__t.all(".g-hcell").find((c) => c.title.endsWith("（" + ${JSON.stringify(single)} + "）"))`;
    await resizes(`${textHeader}?.querySelector(".g-resize:not(.g-resize-prev)")`, "列を本文だけにした言語でも、列の見出しの右端をドラッグすると、本文の幅が変わる");
    // 横にスクロールしていると、固定していない列の左端は固定した列の下に隠れるので、左端まで戻してから確かめる。
    await evaluate(`(document.querySelector(".grid-scroll").scrollLeft = 0), true`);
    await until(`document.querySelector(".grid-scroll").scrollLeft === 0 && !!${textHeader}?.nextElementSibling?.querySelector(".g-resize-prev")`, "表を左端まで戻す");
    await sleep(200);
    await resizes(`${textHeader}?.nextElementSibling?.querySelector(".g-resize-prev")`, "境目の右隣の見出しの左端をつかんでも、境目の左の列（本文）の幅が変わる");
    await click(`__t.button(/^表示する列を選ぶ/)`, "列");
    await click(`__t.button(/^すべて表示$/)`, "すべて表示");
    await evaluate(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
    await until(`__t.all('[data-row="0"] .k-review').length > 0`, "列が戻る");

    // ---- レビュー: セルのダブルクリックで投稿パネルを開き、投稿すると閉じて、セルにコメントと投稿者が出る
    const reviewCell = `__t.all('[data-row="0"] .k-review')[0]`;
    const reviewDialog = `__t.dialog(/^レビュー: /)`;
    const me = (await evaluate(`fetch("/api/rpc/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) }).then((r) => r.json())`)).result.user.name;
    check((await evaluate(`${reviewCell}.querySelector(".review-note")`)) === null, "投稿のないレビューのセルには、コメントが出ていない");
    await evaluate(`${reviewCell}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
    await until(`!!${reviewDialog}`, "レビューのセルのダブルクリックで、投稿パネルが開く");
    check((await evaluate(`__t.all('input[type="radio"]', ${reviewDialog}).every((r) => !r.checked)`)) === true, "ダブルクリックで開いたパネルは、判定を選んでいない状態");
    await click(`__t.all('input[type="radio"]', ${reviewDialog}).find((r) => /差し戻し/.test(r.closest("label").textContent))`, "差し戻し");
    await until(`__t.button(/^投稿$/, ${reviewDialog}).disabled === true`, "コメントがないと投稿できない");
    await evaluate(`__t.setValue(${reviewDialog}.querySelector("textarea"), "語尾をそろえてください"), true`);
    await click(`__t.button(/^投稿$/, ${reviewDialog})`, "投稿");
    await until(`!${reviewDialog}`, "投稿すると、パネルが閉じる");
    check(true, "レビューを投稿すると、パネルが閉じる");
    const noteOf = () => evaluate(`(() => { const c = ${reviewCell}; return { verdict: c.querySelector(".chip-label")?.textContent, by: c.querySelector(".review-note-by")?.textContent ?? null, text: c.querySelector(".review-note-text")?.textContent ?? null, visible: (c.querySelector(".review-note")?.getBoundingClientRect().width ?? 0) > 0 }; })()`);
    await until(`!!${reviewCell}.querySelector(".review-note-text")`, "セルにコメントが出る");
    const posted = await noteOf();
    check(posted.verdict === "差し戻し" && posted.by === me && posted.text === "語尾をそろえてください" && posted.visible, "投稿のあと、セルに判定、投稿者、コメントが出る", posted);
    // 読み直しても、サーバーが返す行に同じ内容が入っている（画面が投稿の結果を持っているだけではない）。
    await click(`__t.button(/^再読み込み$/)`, "再読み込み");
    await until(`__t.toasts().some((t) => /読み直しました|再読み込み/.test(t)) || true`, "読み直す");
    await sleep(500);
    await until(`!!${reviewCell}?.querySelector(".review-note-text")`, "読み直したあとも、コメントが出る");
    const reloaded = await noteOf();
    check(reloaded.by === me && reloaded.text === "語尾をそろえてください", "リソースを読み直しても、セルに投稿者とコメントが出る", reloaded);
  }

  console.log("== 複数選択と、右クリックのメニュー ==");
  {
    // 選択は、セルへの mousedown（Shift / Ctrl つき）で作る。メニューは、本物の右クリックで開く。
    const down = (finder, mods = {}) => evaluate(`${finder}.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, shiftKey: ${mods.shift === true}, ctrlKey: ${mods.ctrl === true} })), true`);
    const cellAt = (row, selector, nth = 0) => `__t.all('[data-row="${row}"] ${selector}')[${nth}]`;
    const statusText = `document.querySelector(".statusbar").textContent`;
    const closeMenu = async () => {
      await evaluate(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), true`);
      await until(`!${cellMenu}`, "メニューが閉じる");
    };
    const toastWith = (text) => `__t.toasts().some((t) => t.includes(${JSON.stringify(text)}))`;
    await evaluate(`(document.querySelector(".grid-scroll").scrollLeft = 0), true`);

    // ---- Shift で範囲、Ctrl で離れたセル
    await down(cellAt(0, ".k-text"));
    await down(cellAt(1, ".k-text"), { shift: true });
    await until(`(${statusText}).includes("2 行・2 セルを選択")`, "Shift で 2 つのセルを選ぶ");
    await down(cellAt(3, ".k-text"), { ctrl: true });
    await until(`(${statusText}).includes("3 行・3 セルを選択")`, "Ctrl で離れたセルを足す");
    const picked = await evaluate(`[0, 1, 2, 3].map((r) => ${cellAt("' + r + '", ".k-text")}.getAttribute("aria-selected"))`);
    check(JSON.stringify(picked) === JSON.stringify(["true", "true", "false", "true"]), "Shift で起点からの範囲を、Ctrl で離れたセルを選べる（選んでいない行は選ばれない）", picked);
    check((await evaluate(`__t.button(/^行を削除/).textContent.trim()`)) === "行を削除（3）", "ツールバーの「行を削除」に、選んでいる行の数が出る");

    // ---- 右クリックのメニュー: 選択の中のセルを押すと、選択はそのまま
    const pickedKeys = await evaluate(`[0, 1, 3].map((r) => __t.keys()[r])`);
    await rightClick(cellAt(1, ".k-text"));
    const textMenu = await menuItems();
    check((await evaluate(statusText)).includes("3 行・3 セルを選択"), "選択の中のセルを右クリックしても、選択は変わらない");
    check(
      ["コピー（3 セル）", "貼り付け（3 件）", "＋ 行を追加…", "行を削除…（3 行）", "選択を解除"].every((n) => textMenu.includes(n)) && !textMenu.includes("キーを変更…"),
      "メニューに、コピー、貼り付け、行の追加と削除、選択の解除が、対象の数つきで並ぶ（複数の行では、キーの変更は出ない）",
      textMenu,
    );
    // プラグインが足したアクション（check.mark。行が対象）が、メニューに並ぶ。
    check(textMenu.includes("作業中にする"), "プラグインのアクション（行が対象）が、右クリックのメニューに並ぶ", textMenu);
    await click(menuItem("作業中にする"), "メニューのアクション");
    await until(toastWith("作業中にする: 3 件を更新しました"), "アクションが、選んでいる 3 行に実行される");
    check(true, "メニューからアクションを実行すると、選んでいる行すべてが対象になる（3 件を更新）");

    // ---- 行の削除: 選んでいる行のキーを見せて確かめる（ここでは消さずにやめる）
    await down(cellAt(0, ".k-text"));
    await down(cellAt(1, ".k-text"), { shift: true });
    await down(cellAt(3, ".k-text"), { ctrl: true });
    await rightClick(cellAt(3, ".k-text"));
    await click(menuItem("行を削除…（3 行）"), "メニューの「行を削除…」");
    await until(`!!__t.dialog(/^行を削除$/)`, "削除の確認が出る");
    check((await evaluate(`__t.dialog(/^行を削除$/).textContent`)).includes(pickedKeys.join("、")), "削除の確認に、選んでいる行のキーが並ぶ", pickedKeys);
    await click(`__t.button(/^やめる$/, __t.dialog(/^行を削除$/))`, "やめる");
    await until(`!__t.dialog(/^行を削除$/)`, "確認が閉じる");
    check((await evaluate(`__t.keys().length`)) >= 4, "やめると、行は消えない");

    // ---- 選択式の列の値を、まとめて変える
    await down(cellAt(1, ".k-enum"));
    await down(cellAt(2, ".k-enum"), { shift: true });
    await rightClick(cellAt(2, ".k-enum"));
    const enumHead = await evaluate(`__t.all(".context-menu-head", ${cellMenu}).map((h) => h.textContent)`);
    check(enumHead.some((h) => /を変える（2 件）$/.test(h)), "選択式の列のメニューに、値を変える項目が、対象の数つきで並ぶ", enumHead);
    await click(menuItem("「未着手」にする"), "「未着手」にする");
    await until(toastWith("を「未着手」にしました"), "まとめて変えたことを知らせる");
    await until(`[1, 2].every((r) => ${cellAt("' + r + '", ".k-enum")}.textContent.trim().startsWith("未着手"))`, "選んだ 2 つのセルが変わる");
    check(true, "メニューから値を選ぶと、選んだセルがまとめて変わり、変えた数を知らせる");

    // ---- コピーと貼り付け（クリップボードの権限を与えて、本物のクリップボードで確かめる）
    await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: new URL(base).origin });
    const firstTexts = await evaluate(`[0, 1].map((r) => ${cellAt("' + r + '", ".k-text")}.querySelector(".cell-text").textContent)`);
    await down(cellAt(0, ".k-text"));
    await down(cellAt(1, ".k-text"), { shift: true });
    await rightClick(cellAt(0, ".k-text"));
    await click(menuItem("コピー（2 セル）"), "コピー");
    await until(toastWith("2 セルをコピーしました"), "コピーしたことを知らせる");
    // Windows のクリップボードは、読むときに改行を CRLF にするので、LF にそろえて比べる。
    const copied = (await evaluate(`navigator.clipboard.readText()`)).replace(/\r\n/g, "\n");
    check(copied === firstTexts.join("\n"), "コピーすると、選んだセルの本文が、行ごとにクリップボードに入る", { copied, firstTexts });
    await evaluate(`navigator.clipboard.writeText("貼り付けた本文").then(() => true)`);
    await rightClick(cellAt(1, ".k-text"));
    await click(menuItem("貼り付け（2 件）"), "貼り付け");
    await until(toastWith("2 件に貼り付けました"), "貼り付けたことを知らせる");
    await until(`[0, 1].every((r) => ${cellAt("' + r + '", ".k-text")}.querySelector(".cell-text").textContent === "貼り付けた本文")`, "選んだ 2 つのセルに、貼り付けた本文が入る");
    check((await evaluate(`[0, 1].every((r) => ${cellAt("' + r + '", ".k-text")}.classList.contains("unsaved"))`)) === true, "貼り付けた本文は、未保存の変更になる（保存するまで、ファイルには書かない）");

    // ---- レビューの一括の投稿
    await down(cellAt(0, ".k-review"));
    await down(cellAt(1, ".k-review"), { shift: true });
    await rightClick(cellAt(1, ".k-review"));
    await click(menuItem("レビューを一括で投稿…（2 件）"), "レビューを一括で投稿…");
    const bulkDialog = `__t.dialog(/^レビューを一括で投稿: /)`;
    await until(`!!${bulkDialog}`, "一括の投稿の窓が開く");
    await click(`__t.all('input[type="radio"]', ${bulkDialog}).find((r) => /差し戻し/.test(r.closest("label").textContent))`, "差し戻し");
    await evaluate(`__t.setValue(${bulkDialog}.querySelector("textarea"), "用語をそろえてください"), true`);
    await click(`__t.button(/^2 件に投稿$/, ${bulkDialog})`, "2 件に投稿");
    await until(`!${bulkDialog}`, "すべて投稿できると、窓が閉じる");
    await until(`[0, 1].every((r) => ${cellAt("' + r + '", ".k-review")}.querySelector(".review-note-text")?.textContent === "用語をそろえてください")`, "選んだ 2 つのセルに、コメントが出る");
    check(true, "レビューを一括で投稿すると、選んだセルすべてに同じ判定とコメントが入り、窓が閉じる");
    await closeMenu().catch(() => {});
  }

  console.log("== プラグインの設定 ==");
  {
    const settings = `__t.dialog(/^設定$/)`;
    const pluginForm = `document.querySelector('[role="dialog"] section[aria-label="プラグイン browser-check-settings の設定"]')`;
    const field = (label) => `${pluginForm}?.querySelector('#' + CSS.escape([...${pluginForm}.querySelectorAll("label")].find((l) => l.textContent.trim() === ${JSON.stringify(label)})?.htmlFor ?? "none"))`;
    const pluginFile = path.join(project, "loc-studio-plugin-settings", "browser-check-settings.json");
    const toastHas = (text) => `__t.toasts().some((t) => t.includes(${JSON.stringify(text)}))`;
    // 保存する前は、既定の値で動いている（設定ファイルはまだない）。
    await rightClick(`document.querySelector('[data-row="0"] .k-key')`);
    await click(menuItem("設定を読む"), "メニューの「設定を読む」");
    await until(toastHas("接頭辞: 既定 / 上限: 3 / strict"), "既定の値で動く");
    check(!existsSync(pluginFile), "設定を保存するまで、プラグインは既定の値で動く（設定ファイルは作らない）");

    await click(`__t.button(/^設定$/)`, "設定");
    await until(`!!${settings}`, "設定の画面");
    await click(`__t.all('[role="tab"]', ${settings}).find((t) => t.textContent.trim() === "プラグインの設定")`, "「プラグインの設定」のタブ");
    await until(`!!${pluginForm}`, "設定を宣言したプラグインの欄が出る");
    const fields = await evaluate(`(() => {
      const form = ${pluginForm};
      return [...form.querySelectorAll("input, select")].map((el) => [el.tagName === "SELECT" ? "select" : el.type, el.type === "checkbox" ? el.checked : el.value, el.placeholder ?? ""]);
    })()`);
    check(
      JSON.stringify(fields) === JSON.stringify([["text", "", "既定"], ["text", "", "3"], ["select", "", ""], ["checkbox", true, ""]]),
      "宣言した項目ごとに、種類に合った入力欄が出る（文字、数値、選択式、チェック。既定の値を添える）",
      fields,
    );
    check((await evaluate(`${pluginForm}.textContent`)).includes(pluginFile), "設定ファイルの場所が出る");
    await evaluate(`(__t.setValue(${field("接頭辞")}, "検査"), __t.setValue(${field("上限")}, "12"), __t.select(${field("やり方")}, "loose"), true)`);
    await click(`__t.button(/^設定を保存$/, ${pluginForm})`, "設定を保存");
    await until(toastHas("プラグイン「browser-check-settings」の設定を保存しました"), "保存したことを知らせる");
    const written = JSON.parse(readFileSync(pluginFile, "utf8"));
    check(JSON.stringify(written) === JSON.stringify({ prefix: "検査", limit: 12, mode: "loose" }), "変えた項目だけが、プラグインごとの設定ファイルに書かれる", written);
    await until(`${field("接頭辞")}?.value === "検査" && ${field("やり方")}?.value === "loose" && __t.button(/^設定を保存$/, ${pluginForm}).disabled`, "保存した値が、欄に入っている");
    const state = await evaluate(`fetch("/api/rpc/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) }).then((r) => r.json())`);
    check(state.result?.restricted !== true && state.result?.untrustedPlugins === 0, "画面から保存した値は、確認をやり直さずに使える（信頼の確認は出ない）", { restricted: state.result?.restricted, untrusted: state.result?.untrustedPlugins });
    await click(`__t.all("button", ${settings}).find((b) => __t.name(b) === "閉じる")`, "設定を閉じる");
    await until(`document.querySelectorAll('[role="dialog"]').length === 0`, "設定が閉じる");
    // プラグインは、次に呼ばれたときから、保存した値を受け取る。
    await rightClick(`document.querySelector('[data-row="0"] .k-key')`);
    await click(menuItem("設定を読む"), "メニューの「設定を読む」（保存のあと）");
    await until(toastHas("接頭辞: 検査 / 上限: 12 / loose"), "保存した値で動く");
    check(true, "保存すると、プラグインは次から新しい値で動く（アクションの結果が変わる）");
  }

  const errors = await evaluate(`__t.toasts().filter((t) => /できませんでした|失敗/.test(t))`);
  check(errors.length === 0, "操作の途中で、失敗の通知は出ていない", errors);

  console.log("== はじめて使う（プロジェクトを指定せずに起動して、新しいプロジェクトを作る） ==");
  server.kill();
  {
    // プロジェクトも、前に開いた記録もない状態（配布物を初めて起動したときと同じ）で起動する。
    const fport = await freePort();
    const fbase = `http://127.0.0.1:${fport}`;
    const fenv = { ...process.env, NODE_ENV: "production", PORT: String(fport), LOC_STUDIO_MODE: "local", LOC_STUDIO_LOCAL_TOKEN: TOKEN, LOC_STUDIO_USER_DATA_DIR: path.join(tmp, "first-user") };
    delete fenv.LOC_STUDIO_PROJECT;
    firstServer = spawn(process.execPath, [launcher], { env: fenv, stdio: ["ignore", "pipe", "pipe"] });
    firstServer.stdout.on("data", (d) => (serverLog += d));
    firstServer.stderr.on("data", (d) => (serverLog += d));
    for (let i = 0; ; i++) {
      try {
        await fetch(fbase);
        break;
      } catch {
        if (i > 100) throw new Error(`2 つ目のサーバーが起動しませんでした:\n${serverLog.slice(-500)}`);
        await sleep(300);
      }
    }
    await send("Page.navigate", { url: `${fbase}/?token=${TOKEN}` }, sessionId);
    await until("document.readyState === 'complete' && !!document.querySelector('.open-card')", "最初の画面");
    await evaluate(HELPERS);
    const newButton = `__t.button(/^新しいプロジェクトを作る…$/)`;
    await until(`!!${newButton} && !${newButton}.disabled`, "「新しいプロジェクトを作る…」が押せる");
    check(true, "プロジェクトを指定せずに起動すると、最初の画面に「新しいプロジェクトを作る…」が出る");
    const pathField = `document.querySelector("#new-project-path")`;
    const status = `document.querySelector(".new-project-status")?.textContent ?? ""`;
    const noDialog = `document.querySelectorAll('[role="dialog"]').length === 0`;
    const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

    // ---- 何もないところから作る
    const fresh = path.join(tmp, "fresh-game");
    await click(newButton, "新しいプロジェクトを作る…");
    await until(`!!${pathField}`, "作成の画面");
    await evaluate(`__t.setValue(${pathField}, ${JSON.stringify(fresh)}), true`);
    await until(`(${status}).includes("このフォルダはまだありません")`, "フォルダがまだないことを伝える");
    check((await evaluate(`document.querySelector("#new-project-name").value`)) === "fresh-game", "プロジェクトの名前を、フォルダの名前で埋める");
    check(!existsSync(fresh), "確かめるだけでは、フォルダを作らない");
    await click(`__t.button(/^プロジェクトを作る$/)`, "プロジェクトを作る");
    const freshRow = `__t.all(".tree-row.resource").find((b) => /main\\.csv/.test(b.textContent))`;
    await until(`!!(${freshRow})`, "作ったプロジェクトが開き、ツリーに最初のファイルが出る", 60_000);
    check((await evaluate(noDialog)) === true, "作ったプロジェクトは、信頼の確認なしで開く");
    check((await evaluate(`document.querySelector(".project-name").textContent`)) === "fresh-game", "上のバーに、プロジェクトの名前が出る");
    const freshConfig = readJson(path.join(fresh, "loc-studio.project.json"));
    check(
      JSON.stringify(freshConfig) ===
        JSON.stringify({
          name: "fresh-game",
          languages: [
            { id: "ja", label: "日本語", pinned: true },
            { id: "en", label: "English", basedOn: "ja" },
          ],
          columns: [
            { use: "builtin.key", id: "key" },
            { use: "builtin.text", id: "text" },
            { use: "builtin.textStatus", id: "textStatus" },
            { use: "builtin.reviewStatus", id: "reviewStatus", of: "text" },
          ],
          validators: ["builtin.whitespace", "builtin.untranslated"],
        }),
      "設定ファイルに、選んだ言語と、同梱の列と検証が書かれる",
      freshConfig,
    );
    const mainFile = path.join(fresh, "text", "main.csv");
    check(readFileSync(mainFile, "utf8") === "key,ja,en\n", "最初のファイルは、キーと言語の列だけの、行のないファイル", readFileSync(mainFile, "utf8"));
    await until(`(document.querySelector(".grid-empty")?.textContent ?? "").includes("まだ行がありません")`, "行の足し方の案内が出る");
    check(true, "行のないファイルでは、行の足し方を案内する");
    // そのまま行を足して、本文を書いて保存できる。
    check((await evaluate(`__t.button(/^行を削除/).disabled`)) === true, "行のないファイルでは、「行を削除」は押せない");
    await click(`__t.button(/^＋ 行を追加$/)`, "＋ 行を追加");
    await until(`!!__t.all('[role="dialog"] input')[0]`, "行を追加のダイアログ");
    await evaluate(`__t.setValue(__t.all('[role="dialog"] input')[0], "TITLE"), true`);
    await click(`__t.button(/^追加する$/)`, "追加する");
    await until(`__t.keys()[0] === "TITLE"`, "足した行が表に出る");
    await evaluate(`__t.all('[data-row="0"] .k-text')[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
    await until(`!!document.querySelector("#edit-textarea")`, "編集モーダルが開く");
    await evaluate(`__t.setValue(document.querySelector("#edit-textarea"), "はじめる"), true`);
    await click(`__t.button(/^確定 /)`, "確定");
    await until(`!document.querySelector("#edit-textarea")`, "編集モーダルが閉じる");
    await click(`__t.button(/^すべて保存/)`, "すべて保存");
    {
      const deadline = Date.now() + 20_000;
      while (readFileSync(mainFile, "utf8") !== "key,ja,en\nTITLE,はじめる,\n") {
        if (Date.now() > deadline) throw new Error(`待っても起きませんでした: 本文がファイルに書かれる（${JSON.stringify(readFileSync(mainFile, "utf8"))}）`);
        await sleep(100);
      }
    }
    check(true, "作ったプロジェクトで、行を足し、本文を書いて、ファイルに保存できる");

    // ---- すでに CSV のあるフォルダから作る（開こうとして、作る案内から進む）
    const existing = path.join(tmp, "existing-game");
    mkdirSync(path.join(existing, "Text"), { recursive: true });
    const existingCsv = "Note,ID,JP,EN\nmemo,OK,はい,Yes\n";
    writeFileSync(path.join(existing, "Text", "ui.csv"), existingCsv);
    await click(`__t.button(/^別のプロジェクト$/)`, "別のプロジェクト");
    await until(`!!document.querySelector("#project-path")`, "最初の画面に戻る");
    check((await evaluate(`__t.all(".recent-btn").map((b) => b.textContent.trim())`)).includes(fresh), "作ったプロジェクトが、最近のプロジェクトに出る");
    await evaluate(`__t.setValue(document.querySelector("#project-path"), ${JSON.stringify(existing)}), true`);
    await click(`__t.button(/^開く$/)`, "開く");
    const offer = `__t.button(/^このフォルダに新しいプロジェクトを作る…$/)`;
    await until(`!!${offer}`, "プロジェクトでないフォルダを開こうとすると、作る案内が出る");
    check((await evaluate(`document.querySelector('[role="alert"]').textContent`)).includes("プロジェクトの設定ファイル"), "開けなかった理由（設定ファイルがない）も出る");
    await click(offer, "このフォルダに新しいプロジェクトを作る…");
    await until(`${pathField}?.value === ${JSON.stringify(existing)}`, "作成の画面に、そのフォルダが入っている");
    await until(`(${status}).includes("CSV / TSV が 1 個あります")`, "すでにあるファイルを見つける");
    const jaSelect = `__t.all("select").find((x) => x.id.startsWith("new-project-text-") && document.querySelector('label[for="' + x.id + '"]').textContent.startsWith("日本語"))`;
    const enSelect = `__t.all("select").find((x) => x.id.startsWith("new-project-text-") && document.querySelector('label[for="' + x.id + '"]').textContent.startsWith("English"))`;
    await until(`!!${jaSelect}`, "本文の列の選択が出る");
    check((await evaluate(`[...document.querySelector("#new-project-key").options].map((o) => o.value).join(",")`)) === "Note,ID,JP,EN", "ファイルの見出しが、キーの列の候補に出る");
    check((await evaluate(`${enSelect}.value`)) === "EN", "言語の ID と同じ見出しは、最初から選ばれている");
    await evaluate(`(__t.select(document.querySelector("#new-project-key"), "ID"), __t.select(${jaSelect}, "JP"), true)`);
    // 検証は 1 つずつ選べる。未翻訳の検証だけを外す。
    const validatorCheck = (re) => `__t.all("label.check").find((l) => ${re}.test(l.textContent))?.querySelector("input")`;
    check((await evaluate(`[${validatorCheck("/空白の検証を付ける/")}?.checked, ${validatorCheck("/未翻訳の検証を付ける/")}?.checked]`)).join(",") === "true,true", "空白の検証と未翻訳の検証は、別々のチェックで、最初はどちらも付いている");
    await click(validatorCheck("/未翻訳の検証を付ける/"), "未翻訳の検証を付ける");
    await until(`${validatorCheck("/未翻訳の検証を付ける/")}.checked === false && ${validatorCheck("/空白の検証を付ける/")}.checked === true`, "未翻訳の検証だけが外れる");
    await click(`__t.button(/^プロジェクトを作る$/)`, "プロジェクトを作る");
    await until(`__t.keys()[0] === "OK"`, "すでにあるファイルの行が出る", 60_000);
    check((await evaluate(noDialog)) === true, "列を対応させたプロジェクトも、信頼の確認なしで開く");
    const texts = await evaluate(`__t.all('[data-row="0"] .k-text').map((c) => c.textContent.trim())`);
    check(texts.length === 2 && texts[0].includes("はい") && texts[1].includes("Yes"), "選んだ列の本文が、言語ごとに出る", texts);
    const formats = readJson(path.join(existing, "loc-studio.project.json")).formats;
    check(
      JSON.stringify(formats) ===
        JSON.stringify([
          { use: "builtin.csv", match: "**/*.csv", options: { key: "ID", text: { ja: "JP", en: "EN" } } },
          { use: "builtin.tsv", match: "**/*.tsv", options: { key: "ID", text: { ja: "JP", en: "EN" } } },
        ]),
      "設定ファイルに、選んだ列の対応が書かれる",
      formats,
    );
    const existingValidators = readJson(path.join(existing, "loc-studio.project.json")).validators;
    check(JSON.stringify(existingValidators) === JSON.stringify(["builtin.whitespace"]), "未翻訳の検証を外して作ると、設定ファイルの validators は空白の検証だけになる", existingValidators);
    check(readFileSync(path.join(existing, "Text", "ui.csv"), "utf8") === existingCsv, "すでにあるファイルは、作成では変えない");

    // ---- すでにプロジェクトのあるフォルダには作れない
    await click(`__t.button(/^別のプロジェクト$/)`, "別のプロジェクト");
    await click(newButton, "新しいプロジェクトを作る…");
    await until(`!!${pathField}`, "作成の画面");
    await evaluate(`__t.setValue(${pathField}, ${JSON.stringify(fresh)}), true`);
    await until(`(${status}).includes("すでにプロジェクトがあります")`, "すでにプロジェクトがあることを伝える");
    check((await evaluate(`__t.button(/^プロジェクトを作る$/).disabled`)) === true, "すでにプロジェクトのあるフォルダには作れない");
    await click(`__t.button(/^このプロジェクトを開く$/)`, "このプロジェクトを開く");
    await until(`__t.keys()[0] === "TITLE"`, "そのプロジェクトが開く", 60_000);
    check(true, "「このプロジェクトを開く」で、既存のプロジェクトとして開ける");
    const firstErrors = await evaluate(`__t.toasts().filter((t) => /できませんでした|失敗/.test(t))`);
    check(firstErrors.length === 0, "操作の途中で、失敗の通知は出ていない", firstErrors);
    firstServer.kill();
  }

  console.log("== LLM のプラグイン（機械翻訳と、翻訳の評価。手元の OpenAI 互換のサーバーを相手にする） ==");
  {
    // 手元の OpenAI 互換のサーバー（chat/completions）。受けた要求を覚える。
    // 翻訳は「訳:<本文>」、評価は訳文から決めた判定と理由を返す。まとめて送られたら、id ごとに返す。
    const llmRequests = [];
    mockLlm = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const system = body.messages[0].content;
        const user = body.messages[1].content;
        llmRequests.push({ system, user });
        let content;
        if (system.includes("verdict")) {
          const judge = (pair) => ({ verdict: pair.translation.includes("취소") ? "NG" : pair.translation.includes("?") ? "WARNING" : "OK", reason: "理由: " + pair.source });
          const parsed = JSON.parse(user);
          content = JSON.stringify(Array.isArray(parsed) ? parsed.map((pair) => ({ id: pair.id, ...judge(pair) })) : judge(parsed));
        } else if (system.includes('"translation"')) {
          content = JSON.stringify(JSON.parse(user).map((item) => ({ id: item.id, translation: "訳:" + item.text })));
        } else {
          content = "訳:" + user;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: "mock", choices: [{ message: { content } }] }));
      });
    });
    await new Promise((resolve) => mockLlm.listen(0, "127.0.0.1", resolve));
    const llmHost = `127.0.0.1:${mockLlm.address().port}`;
    const llmUrl = `http://${llmHost}/v1`;

    // 小さなプロジェクト（日本語と韓国語、リソース 2 つ）。韓国語に、機械翻訳の列と、翻訳の評価の列を足す。
    const lproject = path.join(tmp, "llm-project");
    mkdirSync(path.join(lproject, "text"), { recursive: true });
    writeFileSync(path.join(lproject, "text", "a.csv"), "ID,JP,KR\nA_OK,決定,확인\nA_CANCEL,キャンセル,취소\nA_SAVE,セーブしますか？,저장하시겠습니까?\nA_GOLD,所持金,소지금\n");
    writeFileSync(path.join(lproject, "text", "b.csv"), "ID,JP,KR\nB_YES,はい,예\nB_NO,いいえ,아니요\nB_BACK,戻る,뒤로\n");
    writeFileSync(
      path.join(lproject, "loc-studio.project.json"),
      JSON.stringify(
        {
          name: "LLM",
          languages: [
            { id: "ja", label: "日本語" },
            { id: "ko", label: "韓国語", basedOn: "ja" },
          ],
          tree: { use: "builtin.globTree", options: { include: ["text/*.csv"] } },
          formats: [{ use: "builtin.csv", match: "**/*.csv", options: { key: "ID", text: { ja: "JP", ko: "KR" } } }],
          generators: {
            mt: { use: "llm.translate", options: { endpoint: llmUrl, model: "mock" } },
            check: { use: "llm.evaluate", options: { endpoint: llmUrl, model: "mock" } },
          },
          columns: [
            { use: "builtin.key", id: "key" },
            { use: "builtin.text", id: "text" },
            { use: "llm.translation", id: "mt", generator: "mt", languages: ["ko"] },
            { use: "llm.evaluation", id: "mtCheck", generator: "check", languages: ["ko"] },
          ],
        },
        null,
        2,
      ),
    );
    const lport = await freePort();
    const lbase = `http://127.0.0.1:${lport}`;
    const lenv = { ...process.env, NODE_ENV: "production", PORT: String(lport), LOC_STUDIO_MODE: "local", LOC_STUDIO_LOCAL_TOKEN: TOKEN, LOC_STUDIO_PROJECT: lproject, LOC_STUDIO_USER_DATA_DIR: path.join(tmp, "llm-user") };
    llmServer = spawn(process.execPath, [launcher], { env: lenv, stdio: ["ignore", "pipe", "pipe"] });
    llmServer.stdout.on("data", (d) => (serverLog += d));
    llmServer.stderr.on("data", (d) => (serverLog += d));
    for (let i = 0; ; i++) {
      try {
        await fetch(lbase);
        break;
      } catch {
        if (i > 100) throw new Error(`LLM の確認用のサーバーが起動しませんでした:\n${serverLog.slice(-500)}`);
        await sleep(300);
      }
    }
    await send("Page.navigate", { url: `${lbase}/?token=${TOKEN}` }, sessionId);
    await until("document.readyState === 'complete'", "ページの読み込み");
    await evaluate(HELPERS);
    // 接続先（endpoint）は、設定ファイルの確認の対象。確認の画面に、接続先が出る。
    await until(`!!__t.button(/^(信頼して開く|信頼して読み込む)$/)`, "設定の確認が出る", 60_000);
    const confirmText = await evaluate(`[...document.querySelectorAll('[role="dialog"]')].map((d) => d.textContent).join(" / ")`);
    check(confirmText.includes(llmHost), "LLM の接続先（endpoint）は、設定の確認の画面に出る（確認するまで、つながない）", confirmText.slice(0, 300));
    await until(
      `(async () => {
        const b = __t.button(/^(信頼して開く|信頼して読み込む)$/);
        if (b) {
          if (!b.disabled) b.click();
          return false;
        }
        if (!document.querySelector('[data-row="0"] .k-key')) return false;
        const info = await fetch("/api/rpc/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) }).then((r) => r.json());
        return info.result?.restricted !== true && info.result?.untrustedPlugins === 0;
      })()`,
      "信頼の確認を済ませて、表が出る",
      60_000,
    );
    await click(`__t.all(".tree-row.resource").find((b) => /a\\.csv/.test(b.textContent))`, "ツリーの a.csv");
    await until(`__t.keys().join(",") === "A_OK,A_CANCEL,A_SAVE,A_GOLD"`, "a.csv の行が出る");

    // 行ごとの生成列のセル（機械翻訳、翻訳の評価の順）と、その印。
    const genCell = (row, n) => `__t.all('[data-row="${row}"] .k-generated')[${n}]`;
    const badge = (row, n) => `${genCell(row, n)}?.querySelector(".gen-badge")?.textContent.trim()`;
    const badges = (n) => `__t.all("[data-row]").map((r) => r.querySelectorAll(".k-generated")[${n}]?.querySelector(".gen-badge")?.textContent.trim()).filter((t) => t !== undefined).join(",")`;
    await until(`${badges(0)} === "未生成,未生成,未生成,未生成"`, "機械翻訳の列が、未生成で出る");
    check((await evaluate(badges(1))) === "未生成,未生成,未生成,未生成", "機械翻訳の列と、翻訳の評価の列が、未生成の印で出る");
    check(llmRequests.length === 0, "表を開いただけでは、LLM に何も送らない", llmRequests.length);

    // ---- セルの「⟳」から、1 行だけ生成する
    await click(`${genCell(0, 0)}?.querySelector("button")`, "機械翻訳のセルの生成のボタン");
    const genDialog = `__t.dialog(/^生成: 機械翻訳/)`;
    await until(`!!${genDialog}`, "生成の確認の窓");
    await until(`document.querySelector("#generate-batch-size")?.value === "1"`, "まとめて送る件数に、生成器の既定（1 件ずつ）が入る");
    check(true, "生成の確認の窓に、まとめて送る件数（既定は 1 件ずつ）が出る");
    await click(`__t.button(/^1 件を生成$/, ${genDialog})`, "1 件を生成");
    await until(`${badge(0, 0)} === "最新" && ${genCell(0, 0)}.textContent.includes("訳:확인")`, "機械翻訳の結果が、セルに出る");
    check(llmRequests.length === 1 && llmRequests[0].user === "확인" && llmRequests[0].system.includes("日本語に翻訳"), "セルの生成のボタンで、その行の本文を LLM に送り、結果を列に出す", llmRequests);

    // ---- 一括アクションから、プロジェクト全体を、3 行ずつまとめて生成する
    const menuItems2 = `__t.all('[role="menu"] [role="menuitem"]').map((b) => b.textContent.trim())`;
    await click(`__t.button(/^一括アクション ▾$/)`, "一括アクション");
    await until(`${menuItems2}.length > 0`, "一括アクションのメニュー");
    check(JSON.stringify(await evaluate(menuItems2)) === JSON.stringify(["機械翻訳 を生成（韓国語）", "翻訳の評価 を生成（韓国語）"]), "一括アクションのメニューに、生成列の生成が、列と言語ごとに並ぶ", await evaluate(menuItems2));
    await click(`__t.all('[role="menu"] [role="menuitem"]').find((b) => b.textContent.trim() === "機械翻訳 を生成（韓国語）")`, "機械翻訳 を生成（韓国語）");
    const bulk = `__t.dialog(/^一括アクション: 機械翻訳 を生成/)`;
    await until(`!!${bulk}`, "確かめる窓");
    check((await evaluate(`${bulk}.textContent`)).includes("このリソースの、すべての 4 行に実行します。"), "はじめは、開いているリソースの行が対象");
    await click(`__t.all('input[type="radio"]', ${bulk})[1]`, "プロジェクト全体");
    await until(`${bulk}.textContent.includes("プロジェクト全体の、すべての 7 行（2 個のリソース）に実行します。")`, "プロジェクト全体の行数を数える");
    check(true, "対象の範囲を「プロジェクト全体」に広げると、すべてのリソースの行数を数え直す（7 行、2 個のリソース）");
    await evaluate(`__t.setValue(document.querySelector("#match-batch-size"), "3"), true`);
    await click(`__t.button(/^7 行に実行$/, ${bulk})`, "7 行に実行");
    await until(`${bulk}.textContent.includes("終わりました。")`, "一括の生成が終わる", 60_000);
    const bulkStatus = await evaluate(`${bulk}.querySelector('[role="status"]').textContent`);
    check(bulkStatus.includes("対象のセル 7 / キャッシュにあり生成しなかったセル 1 / 生成したセル 6 / エラー 0 件"), "結果を数で出す（生成済みの 1 行は、もう一度は生成しない）", bulkStatus);
    const batchSizes = llmRequests.slice(1).map((r) => JSON.parse(r.user).length);
    check(JSON.stringify(batchSizes) === JSON.stringify([3, 3]), "まとめて送る行数を 3 にすると、リソースごとに、3 行を 1 回の要求で送る", batchSizes);
    await click(`__t.all("button", ${bulk}).filter((b) => __t.name(b) === "閉じる").at(-1)`, "閉じる");
    await until(`${badges(0)} === "最新,最新,最新,最新"`, "すべての行の機械翻訳が出る");
    check((await evaluate(`${genCell(3, 0)}.textContent`)).includes("訳:소지금"), "まとめて送っても、行ごとに自分の本文の翻訳が入る");

    // ---- 翻訳の評価を、このリソースに実行する
    const sent = llmRequests.length;
    await click(`__t.button(/^一括アクション ▾$/)`, "一括アクション");
    await click(`__t.all('[role="menu"] [role="menuitem"]').find((b) => b.textContent.trim() === "翻訳の評価 を生成（韓国語）")`, "翻訳の評価 を生成（韓国語）");
    const evalDialog = `__t.dialog(/^一括アクション: 翻訳の評価 を生成/)`;
    await until(`!!${evalDialog}`, "確かめる窓（評価）");
    await click(`__t.button(/^4 行に実行$/, ${evalDialog})`, "4 行に実行");
    await until(`${evalDialog}.textContent.includes("終わりました。")`, "評価が終わる", 60_000);
    await click(`__t.all("button", ${evalDialog}).filter((b) => __t.name(b) === "閉じる").at(-1)`, "閉じる");
    await until(`${badges(1)} === "最新,最新,最新,最新"`, "すべての行の評価が出る");
    const verdicts = await evaluate(`__t.all("[data-row]").map((r) => r.querySelectorAll(".k-generated")[1]?.querySelector(".chip-label")?.textContent).filter((t) => t !== undefined)`);
    check(JSON.stringify(verdicts) === JSON.stringify(["OK", "NG", "WARNING", "OK"]), "翻訳の評価の列に、OK / NG / WARNING の判定が、色つきの札で出る", verdicts);
    check((await evaluate(`${genCell(1, 1)}.querySelector(".review-note-text")?.textContent`)) === "理由: キャンセル", "判定の理由が、判定の横に出る");
    const evalRequests = llmRequests.slice(sent).map((r) => JSON.parse(r.user));
    check(evalRequests.length === 4 && evalRequests.some((r) => r.source === "キャンセル" && r.translation === "취소"), "評価は、原文（基にする言語の本文）と訳文を、1 組ずつ送る", evalRequests);

    // ---- 本文が変わると、機械翻訳と評価に「変更あり」の印が出る
    await evaluate(`__t.all('[data-row="0"] .k-text')[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
    await until(`!!document.querySelector("#edit-textarea")`, "編集モーダルが開く");
    await evaluate(`__t.setValue(document.querySelector("#edit-textarea"), "확인!"), true`);
    await click(`__t.button(/^確定 /)`, "確定");
    await until(`!document.querySelector("#edit-textarea")`, "編集モーダルが閉じる");
    await until(`${badge(0, 0)} === "変更あり" && ${badge(0, 1)} === "変更あり"`, "本文を変えた行の印が「変更あり」になる");
    check((await evaluate(`${genCell(0, 0)}.textContent`)).includes("訳:확인") && (await evaluate(badges(0))) === "変更あり,最新,最新,最新", "本文を変えると、その行の機械翻訳と評価に「変更あり」の印が出る（前の結果は残り、ほかの行は最新のまま）", await evaluate(badges(0)));

    // ---- プロンプトを、設定の画面で変える
    const settings = `__t.dialog(/^設定$/)`;
    const llmForm = `document.querySelector('[role="dialog"] section[aria-label="プラグイン @loc-studio/plugin-llm の設定"]')`;
    const field = (label) => `${llmForm}?.querySelector('#' + CSS.escape([...${llmForm}.querySelectorAll("label")].find((l) => l.textContent.trim() === ${JSON.stringify(label)})?.htmlFor ?? "none"))`;
    await click(`__t.button(/^設定$/)`, "設定");
    await until(`!!${settings}`, "設定の画面");
    await click(`__t.all('[role="tab"]', ${settings}).find((t) => t.textContent.trim() === "プラグインの設定")`, "「プラグインの設定」のタブ");
    await until(`!!${llmForm}`, "LLM のプラグインの設定の欄が出る");
    const promptField = field("機械翻訳: プロンプト");
    check((await evaluate(`${promptField}?.tagName`)) === "TEXTAREA", "プロンプトは、複数行の入力欄で編集できる");
    check(
      JSON.stringify(await evaluate(`[...${llmForm}.querySelectorAll("label")].map((l) => l.textContent.trim())`)) ===
        JSON.stringify(["機械翻訳: 訳し先の言語", "機械翻訳: プロンプト", "翻訳の評価: 比べる原文の言語", "翻訳の評価: プロンプト"]),
      "訳し先、機械翻訳のプロンプト、比べる原文の言語、評価のプロンプトの欄が出る",
    );
    await click(`__t.button(/^既定の文章を入力欄に入れる$/, ${llmForm})`, "既定の文章を入力欄に入れる");
    await until(`${promptField}.value.startsWith("ユーザーが送る文章を{to}に翻訳してください。")`, "既定のプロンプトが入力欄に入る");
    await evaluate(`__t.setValue(${promptField}, ${promptField}.value + "\\n敬語で訳すこと。"), true`);
    await click(`__t.button(/^設定を保存$/, ${llmForm})`, "設定を保存");
    await until(`__t.toasts().some((t) => t.includes("プラグイン「@loc-studio/plugin-llm」の設定を保存しました"))`, "保存したことを知らせる");
    const llmSettingsFile = path.join(lproject, "loc-studio-plugin-settings", "%40loc-studio%2Fplugin-llm.json");
    const savedPrompt = JSON.parse(readFileSync(llmSettingsFile, "utf8"));
    check(Object.keys(savedPrompt).join(",") === "translatePrompt" && savedPrompt.translatePrompt.endsWith("\n敬語で訳すこと。"), "変えたプロンプトが、プラグインの設定ファイルに書かれる", savedPrompt);
    const afterSave = await evaluate(`fetch("/api/rpc/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: {} }) }).then((r) => r.json())`);
    check(afterSave.result?.restricted !== true, "画面から保存したプロンプトは、確認をやり直さずに使える");
    await click(`__t.all("button", ${settings}).find((b) => __t.name(b) === "閉じる")`, "設定を閉じる");
    await until(`document.querySelectorAll('[role="dialog"]').length === 0`, "設定が閉じる");
    await until(`${badges(0)} === "変更あり,変更あり,変更あり,変更あり"`, "プロンプトを変えると、生成済みの結果が「変更あり」になる");
    check(true, "プロンプトを変えると、前のプロンプトで作った結果に「変更あり」の印が出る");
    const before = llmRequests.length;
    await click(`${genCell(1, 0)}?.querySelector("button")`, "機械翻訳のセルの生成のボタン（2 行目）");
    await until(`!!${genDialog}`, "生成の確認の窓");
    await click(`__t.button(/^1 件を生成$/, ${genDialog})`, "1 件を生成");
    await until(`${badge(1, 0)} === "最新"`, "生成し直すと、最新になる");
    check(llmRequests.length === before + 1 && llmRequests[before].system.includes("敬語で訳すこと。") && llmRequests[before].user === "취소", "生成し直すと、変えたプロンプトを LLM に送る", llmRequests[before]);

    const llmErrors = await evaluate(`__t.toasts().filter((t) => /できませんでした|失敗/.test(t))`);
    check(llmErrors.length === 0, "操作の途中で、失敗の通知は出ていない", llmErrors);
    llmServer.kill();
  }

  console.log("== Web モード（ログインと、役割による操作の絞り込み） ==");
  const web = prepareWebMode();
  const wport = await freePort();
  const wbase = `http://127.0.0.1:${wport}`;
  const wenv = { ...process.env, NODE_ENV: "production", PORT: String(wport), LOC_STUDIO_MODE: "web", LOC_STUDIO_SERVER_CONFIG: web.serverConfig, LOC_STUDIO_USER_DATA_DIR: web.data };
  for (const k of ["LOC_STUDIO_PROJECT", "LOC_STUDIO_LOCAL_TOKEN", "LOC_STUDIO_HOST"]) delete wenv[k];
  webServer = spawn(process.execPath, [launcher], { env: wenv, stdio: ["ignore", "pipe", "pipe"] });
  webServer.stdout.on("data", (d) => (serverLog += d));
  webServer.stderr.on("data", (d) => (serverLog += d));
  for (let i = 0; ; i++) {
    try {
      await fetch(wbase);
      break;
    } catch {
      if (i > 100) throw new Error(`Web モードのサーバーが起動しませんでした:\n${serverLog.slice(-500)}`);
      await sleep(300);
    }
  }
  await send("Page.navigate", { url: wbase }, sessionId);
  await until("document.readyState === 'complete' && !!document.querySelector('input[type=password]')", "ログインの画面");
  await evaluate(HELPERS);
  check(true, "ログインしていなければ、ログインの画面が出る");
  await evaluate(`(() => { const [name] = __t.all("input.input").filter((i) => i.type !== "password"); __t.setValue(name, "lqa1"); __t.setValue(document.querySelector("input[type=password]"), "lqa-pass-1234"); return true; })()`);
  await click(`__t.button(/^ログイン$/)`, "ログイン");
  await until(`!!document.querySelector('[data-row="0"] .k-key')`, "ログインして、表が出る", 60_000);
  check(true, "ログインすると、割り当てられたプロジェクトの表が出る（信頼の確認は出ない）");
  check((await evaluate(`__t.all(".badge").some((b) => b.textContent.trim().startsWith("LQA"))`)) === true, "上のバーに、役割の表示名（設定の label）が出る");
  const REASON = "この列は、あなたの役割では変更できません";
  check((await evaluate(`document.querySelector('[data-row="0"] .k-text').title`)) === REASON, "役割で変えられない列（本文）は、理由つきで変えられない");
  const rowsBtn = await evaluate(`[__t.button(/^＋ 行を追加$/), __t.button(/^行を削除/)].flatMap((b) => [b.disabled, b.title])`);
  check(
    JSON.stringify(rowsBtn) === JSON.stringify([true, "行の追加・削除とリソースの作成は、あなたの役割ではできません", true, "行の追加・削除とリソースの作成は、あなたの役割ではできません"]),
    "行の操作（追加と削除）は、理由つきで無効",
    rowsBtn,
  );
  check((await evaluate(`__t.button(/^リソースを作成$/).disabled`)) === true, "リソースの作成も無効");
  // 変えられる列（ステータス）は、選んで保存できる。
  await click(`__t.all('[data-row="0"] .k-enum button')[0]`, "ステータスのセル");
  await click(`__t.all('[role="listbox"] [role="option"]').find((o) => o.textContent.trim() === "作業中")`, "作業中");
  await until(`__t.all('[data-row="0"] .k-enum button')[0].textContent.trim().startsWith("作業中")`, "ステータスが変わる");
  check(true, "役割で変えられる列（ステータス）は、変えられる");
  // 本文のセルを開いても、編集欄は読み取り専用。
  await evaluate(`__t.all('[data-row="0"] .k-text')[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), true`);
  await until(`!!document.querySelector("#edit-textarea")`, "編集モーダルが開く");
  check((await evaluate(`document.querySelector("#edit-textarea").readOnly`)) === true, "本文の編集欄は読み取り専用");
  const webErrors = await evaluate(`__t.toasts().filter((t) => /できませんでした|失敗/.test(t))`);
  check(webErrors.length === 0, "操作の途中で、失敗の通知は出ていない", webErrors);

  console.log(failures === 0 ? "\nすべての確認に成功しました。" : `\n${failures} 件の確認に失敗しました。`);
  exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error(`\n途中で止まりました: ${err instanceof Error ? err.message : String(err)}`);
  try {
    console.error("画面の通知:", await evaluate(`window.__t ? __t.toasts() : []`));
    console.error("開いているダイアログ:", await evaluate(`[...document.querySelectorAll('[role="dialog"]')].map((d) => d.textContent.slice(0, 200))`));
  } catch {
    // ページに届かないときは、そのまま終わる
  }
} finally {
  // 自分が起動したブラウザとサーバーだけを止める。
  // ブラウザは、まず正常に閉じる。強制終了すると、子プロセスがプロフィールのファイルをしばらく掴んだままになり、
  // 一時フォルダを消せない（Windows で確かめた）。
  const browserExited = new Promise((resolve) => (browser.exitCode !== null ? resolve() : browser.once("exit", resolve)));
  await Promise.race([send("Browser.close").catch(() => undefined), sleep(3000)]);
  await Promise.race([browserExited, sleep(10_000)]);
  socket.close();
  if (browser.exitCode === null) browser.kill();
  server.kill();
  firstServer?.kill();
  llmServer?.kill();
  mockLlm?.closeAllConnections();
  mockLlm?.close();
  webServer?.kill();
  // 止めたブラウザとサーバーがファイルを離すまで、消すのを繰り返す（Windows では、少し遅れて離す）。
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  } catch (err) {
    console.error(`一時フォルダを消せませんでした。手で消してください: ${tmp}（${err instanceof Error ? err.message : String(err)}）`);
  }
}
process.exit(exitCode);
