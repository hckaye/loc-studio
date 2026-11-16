// 梱包したデスクトップ版（electron-builder の出力）を実際に起動して確かめる。
// 見るのは、サーバーが起動して画面が出ること、アプリを作り直さずにプラグインを後から足せること、終了でサーバーも止まること、
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
async function launch() {
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const app = spawn(exe, ["--remote-debugging-port=0", `--user-data-dir=${userData}`, project], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
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
  const until = async (expression, label, timeout = 30_000) => {
    for (const deadline = Date.now() + timeout; Date.now() < deadline; await sleep(150)) {
      if (await evaluate(expression).catch(() => false)) return;
    }
    throw new Error(`待っても成り立ちませんでした: ${label}`);
  };
  // 画面と同じ口（/api/rpc）を、ページの中から呼ぶ（合言葉のクッキーはページが持っている）。
  const rpc = async (method, params = {}) => {
    const body = await evaluate(
      `fetch("/api/rpc/${method}", { method: "POST", headers: { "Content-Type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ params }))}, cache: "no-store" }).then((r) => r.json())`,
    );
    if (body?.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
    return body.result;
  };
  /** ウィンドウを閉じて、アプリと内部サーバーが止まるのを待つ。 */
  const quit = async () => {
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
  return { base, evaluate, until, rpc, quit };
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
/** ツリーのリソースの行（名前で探す）と、表のキーの並び。ページの中で評価する式。 */
const treeRow = (name) => `[...document.querySelectorAll(".tree-row.resource")].find((b) => b.textContent.includes(${JSON.stringify(name)}))`;
const KEYS = `[...document.querySelectorAll("[data-row] .k-key")].map((c) => c.textContent.trim()).join(",")`;
const SEARCH_BOX = `document.querySelector('input[type=search][aria-label="検索"]')`;

try {
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
} finally {
  try {
    running?.socket?.close();
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
