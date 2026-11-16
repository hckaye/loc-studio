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

  console.log("== 条件で絞り込む、ツリーの件数、検索ビュー、列の表示、状態の復元 ==");
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

  // 式で書く。入力に合わせて候補が出て、選んで入れられる。
  await click(`__t.button(/^条件/)`, "条件（2 回目）");
  await click(`__t.button(/^式で書く$/)`, "式で書く");
  await until(`__t.labeled("条件式")?.value === "text@ko is empty"`, "組み立てた条件の式から書き始められる");
  check(true, "「式で書く」に切り替えると、組み立てた条件の式が入っている");
  const typeQuery = (text) => evaluate(`(() => { const el = __t.labeled("条件式"); el.focus(); __t.setValue(el, ${JSON.stringify(text)}); el.setSelectionRange(el.value.length, el.value.length); return true; })()`);
  const suggestions = `__t.all("#query-suggestions [role=option] .mono").map((o) => o.textContent)`;
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

  // 検索ビュー: プロジェクト全体の結果、集計、CSV への書き出し、行へ移る。
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(tmp, "downloads") });
  await click(`__t.button(/^検索ビュー$/)`, "検索ビュー");
  const view = `document.querySelector('[role="region"][aria-label="検索ビュー"]')`;
  await until(`(${view}?.querySelector(".search-view-summary")?.textContent ?? "").startsWith("2 行（全 12 行のうち。1 / 3 個のリソース）")`, "検索ビューに件数が出る");
  check(true, "検索ビューに、プロジェクト全体で条件に合う行の数が出る（2 行、3 個のリソースのうち 1 個）");
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
