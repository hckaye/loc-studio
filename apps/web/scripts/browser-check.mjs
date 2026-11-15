// 画面を本物のブラウザ（ヘッドレスの Chrome / Edge）で操作して確かめる。
// コンポーネントのテスト（jsdom）では分からない、本番ビルドの画面とサーバーをつないだ動きを見る。
// 使い方: npm run build:web && npm run check:browser
//   ブラウザの場所は環境変数 LOC_STUDIO_CHROME で指定できる。見つからなければ、何も確かめずに終了コード 2 で終わる。
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(file, JSON.stringify(config, null, 2));
}

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
  // 表が出るまで、信頼の確認のボタンを押していく。
  await until(
    `(() => {
      if (document.querySelector('[data-row="0"] .k-key')) return true;
      const b = __t.button(/^(信頼して開く|信頼して読み込む)$/);
      if (b && !b.disabled) b.click();
      return false;
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
  const rowsMenu = async (re) => {
    await click(`__t.button(/^行 ▾$/)`, "行のメニュー");
    await click(`__t.all('[role="menuitem"]').find((b) => ${re}.test(b.textContent))`, `メニューの ${re}`);
  };
  await selectRow(0);
  await rowsMenu("/行を追加/");
  await until(`!!__t.all('[role="dialog"] input')[0]`, "行を追加のダイアログ");
  await evaluate(`__t.setValue(__t.all('[role="dialog"] input')[0], "UI_BROWSER"), true`);
  await click(`__t.button(/^追加する$/)`, "追加する");
  await untilFile(() => fileHas("UI_BROWSER"), "リソースに行が書かれる");
  const lines = readFileSync(UI_FILE, "utf8").split("\n");
  check(lines[1].startsWith("UI_OK,") && lines[2].startsWith("UI_BROWSER,"), "選んだ行の後ろに、行がリソースへ書かれる", lines.slice(0, 4));
  await until(`__t.keys()[1] === "UI_BROWSER"`, "表に足した行が出る");
  check(true, "足した行が、表にも出る");

  await selectRow(1);
  await rowsMenu("/キーを変更/");
  await until(`__t.all('[role="dialog"] input')[0]?.value === "UI_BROWSER"`, "キーを変更のダイアログに、いまのキーが入っている");
  await evaluate(`__t.setValue(__t.all('[role="dialog"] input')[0], "UI_RENAMED"), true`);
  await click(`__t.button(/^変更する$/)`, "変更する");
  await untilFile(() => fileHas("UI_RENAMED") && !fileHas("UI_BROWSER"), "キーが書き換わる");
  await until(`__t.keys()[1] === "UI_RENAMED"`, "表のキーが変わる");
  check(true, "キーを変えると、リソースと表の両方が変わる");

  await selectRow(1);
  await rowsMenu("/選択した行を削除/");
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

  const errors = await evaluate(`__t.toasts().filter((t) => /できませんでした|失敗/.test(t))`);
  check(errors.length === 0, "操作の途中で、失敗の通知は出ていない", errors);

  console.log("== Web モード（ログインと、役割による操作の絞り込み） ==");
  server.kill();
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
  const rowsBtn = await evaluate(`(() => { const b = __t.button(/^行 ▾$/); return [b.disabled, b.title]; })()`);
  check(rowsBtn[0] === true && rowsBtn[1] === "行の追加・削除とリソースの作成は、あなたの役割ではできません", "行の操作は、理由つきで無効", rowsBtn);
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
  webServer?.kill();
  // 止めたブラウザとサーバーがファイルを離すまで、消すのを繰り返す（Windows では、少し遅れて離す）。
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  } catch (err) {
    console.error(`一時フォルダを消せませんでした。手で消してください: ${tmp}（${err instanceof Error ? err.message : String(err)}）`);
  }
}
process.exit(exitCode);
