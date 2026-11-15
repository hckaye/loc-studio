// 本番ビルドの動作確認。サンプルプロジェクトの一時コピーに対してサーバーを起動し、API を呼んで確かめる。
// 使い方: npm run build:web && npm run smoke:web
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appDir, "../..");
const sample = path.join(repoRoot, "examples", "sample-project");

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log(`  OK  ${label}`);
  else {
    failures++;
    console.log(`  NG  ${label}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500)}` : ""}`);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, ms) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    try {
      await fetch(url);
      // 起動していれば何か答える（401 や 500 も起動の印。中身はあとの確かめで見る）
      return;
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`サーバーが起動しませんでした（${url}）: ${last}`);
}

// サービス層は実行時に import する（lib/server/runtime.ts）。Next の更新でバンドルされるようになっていないかを確かめる:
// 各パッケージの dist から日本語の文字列をいくつか拾い、サーバーのチャンクに入っていないことを見る。
function serviceLayerMarkers() {
  const out = [];
  for (const pkg of ["server", "core", "builtin", "store"]) {
    const dir = path.join(repoRoot, "packages", pkg, "dist");
    const found = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const text = readFileSync(path.join(dir, f), "utf8");
      for (const m of text.matchAll(/["`]([^"`\\\n$]{12,60})["`]/g)) {
        if (/[\u3040-\u30ff\u4e00-\u9fff]/.test(m[1])) found.push(m[1]);
        if (found.length >= 4) break;
      }
      if (found.length >= 4) break;
    }
    out.push(...found.map((text) => ({ pkg, text })));
  }
  out.push({ pkg: "store", text: "DatabaseSync" });
  return out;
}

function listJs(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) listJs(p, acc);
    else if (name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

function escapeUnicode(s) {
  return s.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

{
  const standaloneServer = path.join(appDir, ".next", "standalone", "apps", "web", ".next", "server");
  const serverDir = existsSync(standaloneServer) ? standaloneServer : path.join(appDir, ".next", "server");
  const files = listJs(serverDir);
  const markers = serviceLayerMarkers();
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of markers) {
      if (text.includes(m.text) || text.includes(escapeUnicode(m.text))) hits.push(`${m.pkg}: "${m.text}" in ${path.relative(appDir, f)}`);
    }
  }
  console.log(`バンドルの確認: ${files.length} 個のサーバーのチャンク、${markers.length} 個の目印`);
  check(files.length > 0 && markers.length >= 5, "目印とチャンクが見つかる", { files: files.length, markers: markers.length });
  check(hits.length === 0, "サーバーのチャンクにサービス層（@loc-studio/*）のコードが入っていない", hits.slice(0, 5).join("\n      "));
}

/** Host などを自由に付けて送る（fetch は Host を変えられないため）。 */
function raw(baseUrl, method, pathname, headers = {}, body) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port, method, path: pathname, headers: { ...(body !== undefined ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

/** 起動の仕組み（launch.mjs）が設定の誤りで起動を断ること。 */
function expectRefusal(extraEnv, label, pattern) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [launcher], { env: { ...process.env, PORT: "0", NODE_ENV: "production", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      c.kill();
      check(false, label, "起動を断りませんでした");
      resolve();
    }, 20000);
    c.on("exit", (code) => {
      clearTimeout(timer);
      check(code !== 0 && pattern.test(out), label, out.slice(-300));
      resolve();
    });
  });
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "loc-studio-smoke-"));
const project = path.join(tmp, "project");
const userData = path.join(tmp, "user-data");
cpSync(sample, project, { recursive: true });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const standalone = path.join(appDir, ".next", "standalone", "apps", "web", "server.js");
// 本番と同じく、起動の仕組み（モード・アドレス・合言葉の確かめ）から起動する
const launcher = existsSync(path.join(path.dirname(standalone), "launch.mjs")) ? path.join(path.dirname(standalone), "launch.mjs") : path.join(appDir, "scripts", "launch.mjs");
const TOKEN = `smoke-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const env = {
  ...process.env,
  PORT: String(port),
  HOSTNAME: "0.0.0.0", // 起動の仕組みが無視して 127.0.0.1 にすること（シェルの HOSTNAME に引きずられない）
  LOC_STUDIO_LOCAL_TOKEN: TOKEN,
  LOC_STUDIO_PROJECT: project,
  LOC_STUDIO_USER_DATA_DIR: userData,
  LOC_STUDIO_SETTINGS: path.join(userData, "settings.json"),
  SMOKE_SECRET_ENV: "smoke-secret-value-42",
  NODE_ENV: "production",
};
delete env.LOC_STUDIO_MODE;
delete env.LOC_STUDIO_HOST;
const useStandalone = existsSync(standalone);
const child = spawn(process.execPath, [launcher], { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

let localCookie = "";
async function rpc(method, params, headers = {}) {
  const res = await fetch(`${base}/api/rpc/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(localCookie ? { Cookie: localCookie } : {}), ...headers },
    body: JSON.stringify({ params }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

console.log("\n== ローカルモード ==");
try {
  console.log(`サーバー: ${useStandalone ? "standalone (launch.mjs → server.js)" : "launch.mjs"}  ${base}`);
  console.log(`プロジェクト: ${project}`);
  await waitFor(`${base}/api/session`, 60000);
  await new Promise((r) => setTimeout(r, 300));
  check(serverLog.includes(`?token=${TOKEN}`), "起動したときに合言葉つきの URL を表示する");
  check(serverLog.includes(`http://127.0.0.1:${port}/`), "HOSTNAME に関係なく 127.0.0.1 で待ち受ける", serverLog.slice(-300));

  // --- 守りの確かめ（合言葉なし、Host、ヘッダー）
  const noToken = await fetch(`${base}/api/session`);
  check(noToken.status === 401, "合言葉のクッキーがなければ /api/session は 401", noToken.status);
  const noTokenPage = await fetch(`${base}/`);
  const noTokenHtml = await noTokenPage.text();
  check(noTokenPage.status === 401 && noTokenHtml.includes("?token="), "合言葉なしのページは開き方の案内（401）", noTokenPage.status);
  const rpcNoToken = await fetch(`${base}/api/rpc/info`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check(rpcNoToken.status === 401, "合言葉のクッキーがなければ RPC は 401", rpcNoToken.status);
  const wrongToken = await fetch(`${base}/?token=wrong`, { redirect: "manual" });
  check(wrongToken.status === 401, "違う合言葉は 401", wrongToken.status);
  const exchange = await fetch(`${base}/?token=${encodeURIComponent(TOKEN)}`, { redirect: "manual" });
  const setLocal = exchange.headers.get("set-cookie") ?? "";
  check(exchange.status === 303 && ["/", `${base}/`].includes(exchange.headers.get("location") ?? "") && /HttpOnly/i.test(setLocal) && /SameSite=Strict/i.test(setLocal), "合言葉を HttpOnly・SameSite=Strict のクッキーに換え、URL から消す", { status: exchange.status, loc: exchange.headers.get("location"), setLocal });
  localCookie = setLocal.split(";")[0];
  const evilHost = await raw(base, "GET", "/api/session", { Host: "evil.example", Cookie: localCookie });
  check(evilHost.status === 421, "許可していない Host（DNS リバインディング）は 421", evilHost.status);
  const evilHostPage = await raw(base, "GET", "/", { Host: `attacker.example:${port}`, Cookie: localCookie });
  check(evilHostPage.status === 421, "許可していない Host はページも 421", evilHostPage.status);
  const fwdHost = await raw(base, "POST", "/api/rpc/info", { Host: `127.0.0.1:${port}`, "X-Forwarded-Host": "evil.example", Origin: "http://evil.example", Cookie: localCookie, "Content-Type": "application/json" }, "{}");
  check(fwdHost.status === 403, "X-Forwarded-Host を付けても Origin の確かめはすり抜けられない", fwdHost.status);
  // 開いていないプロジェクトの独自描画は返さず、ワークスペースも開かない
  const other = path.join(tmp, "other");
  cpSync(sample, other, { recursive: true });
  const rendNoCookie = await raw(base, "GET", `/api/renderer/demo.bar?project=${encodeURIComponent(other)}`);
  check(rendNoCookie.status === 401, "クッキーのない独自描画の GET は 401", rendNoCookie.status);
  const rendCross = await raw(base, "GET", `/api/renderer/demo.bar?project=${encodeURIComponent(other)}`, { Cookie: localCookie, "Sec-Fetch-Site": "cross-site" });
  check(rendCross.status === 403, "ほかのサイトからの独自描画の読み込みは 403", rendCross.status);
  const rendUnopened = await raw(base, "GET", `/api/renderer/demo.bar?project=${encodeURIComponent(other)}`, { Cookie: localCookie, "Sec-Fetch-Site": "same-origin" });
  check(rendUnopened.status === 404 && !existsSync(path.join(other, ".loc-studio")), "開いていないプロジェクトの独自描画は 404 で、ワークスペースを開かない", rendUnopened.status);
  const projQuery = await raw(base, "GET", `/?project=${encodeURIComponent(other)}`, { Cookie: localCookie });
  await new Promise((r) => setTimeout(r, 300));
  check(projQuery.status === 200 && !existsSync(path.join(other, ".loc-studio")), "?project= のページを開いてもプロジェクトは開かない", projQuery.status);

  const page = await fetch(`${base}/`, { headers: { Cookie: localCookie } });
  const html = await page.text();
  check(page.status === 200 && /<html/i.test(html), "/ が HTML を返す");
  const csp = page.headers.get("content-security-policy") ?? "";
  check(
    /frame-ancestors 'none'/.test(csp) && /script-src 'self' 'nonce-/.test(csp) &&
      page.headers.get("x-frame-options") === "DENY" &&
      page.headers.get("x-content-type-options") === "nosniff" &&
      page.headers.get("referrer-policy") === "no-referrer" &&
      page.headers.get("cross-origin-opener-policy") === "same-origin" &&
      page.headers.get("cross-origin-resource-policy") === "same-origin",
    "ページに守りのヘッダー（CSP frame-ancestors、X-Frame-Options など）がある",
    Object.fromEntries(page.headers),
  );
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  check(nonce !== undefined && html.includes(`nonce="${nonce}"`), "Next のスクリプトに CSP の nonce が付く");

  const sessionRes = await fetch(`${base}/api/session`, { headers: { Cookie: localCookie } });
  check(sessionRes.headers.get("x-frame-options") === "DENY" && /frame-ancestors 'none'/.test(sessionRes.headers.get("content-security-policy") ?? ""), "API の応答にも守りのヘッダーがある");
  const session = await sessionRes.json();
  check(session.defaultProject === project, "/api/session が既定のプロジェクトを返す", session);

  // 設定ファイルの信頼: 画面は pluginTrust: "prompt" で開くので、設定ファイルを信頼するまで制限された状態（DB も開かない）
  const first = await rpc("info", {});
  check(first.status === 200 && first.body?.result?.restricted === true, "開いた直後は制限された状態（設定ファイルを信頼していない）", first.body);
  const early = await rpc("rows", { resourceId: "x" });
  check(early.body?.error?.code === "untrusted", "信頼する前の rows は untrusted", early.body);
  check(!existsSync(path.join(project, ".loc-studio")), "信頼する前はプロジェクトに .loc-studio を作らない（DB を開かない）");
  const firstPlugins = await rpc("plugins", {});
  const settingsItem = (firstPlugins.body?.result?.untrusted ?? []).find((u) => u.kind === "settings");
  check(
    settingsItem !== undefined && Array.isArray(settingsItem.summary) && settingsItem.summary.length > 0 && settingsItem.files.length === 1,
    "plugins が設定ファイルの確認（要約つき）を返す",
    firstPlugins.body?.result?.untrusted,
  );
  const stale = await rpc("trustPlugins", { items: [{ path: settingsItem.path, hash: "0".repeat(64) }] });
  check(stale.body?.error?.code === "conflict", "見せたものと違うハッシュでは信頼できない（conflict）", stale.body);
  const opened = await rpc("trustPlugins", { items: [{ path: settingsItem.path, hash: settingsItem.hash }] });
  check(opened.body?.result?.restricted !== true, "設定ファイルを信頼すると開ける", opened.body);

  const info = await rpc("info", {});
  check(info.status === 200 && Array.isArray(info.body?.result?.languages) && info.body.result.languages.length > 0, "info が言語の一覧を返す", info.body);
  const languages = info.body.result.languages.map((l) => l.id);
  // プラグインの信頼: 信頼するまでプロジェクトのプラグインは読み込まれない
  const isCustom = (v) => v.id.startsWith("mystudio.");
  check(info.body.result.untrustedPlugins > 0, `信頼する前は未信頼のプラグインがある（${info.body.result.untrustedPlugins} 個）`, info.body.result.untrustedPlugins);
  check(!info.body.result.validators.some(isCustom), "信頼する前はプロジェクトのバリデータ（mystudio.*）がない", info.body.result.validators);
  const plugins = await rpc("plugins", {});
  const untrusted = plugins.body?.result?.untrusted ?? [];
  check(untrusted.length > 0 && untrusted.every((u) => u.files.length > 0), "plugins が未信頼のプラグインとファイルを返す", untrusted);
  const oldShape = await rpc("trustPlugins", { paths: untrusted.map((u) => u.path) });
  check(oldShape.body?.error?.code === "invalid", "trustPlugins の古い形（paths）は invalid", oldShape.body);
  const trusted = await rpc("trustPlugins", { items: untrusted.map((u) => ({ path: u.path, hash: u.hash })) });
  const tinfo = trusted.body?.result;
  check(tinfo?.untrustedPlugins === 0, "trustPlugins のあとは未信頼のプラグインがない", trusted.body);
  // プロジェクトのプラグインフォルダのコード（TypeScript を含む）を実行時に読み込めていること
  check(tinfo?.pluginErrors?.length === 0, "プラグインの読み込みエラーがない", tinfo?.pluginErrors);
  check(tinfo?.validators?.some((v) => v.id === "mystudio.lineWidth"), "信頼したあとはプロジェクトのプラグイン（loc-studio-plugins/line-width.ts）が読み込まれている", tinfo?.validators);
  const textCol = info.body.result.columns.find((c) => c.kind === "text");

  const tree = await rpc("tree", {});
  const resources = [];
  const walk = (nodes) => nodes.forEach((n) => (n.kind === "resource" ? resources.push(n.resource) : walk(n.children ?? [])));
  walk(tree.body?.result ?? []);
  check(resources.length > 0, `tree がリソースを返す（${resources.length} 件）`, tree.body);

  const res0 = resources.find((r) => r.path.endsWith("ui.csv")) ?? resources[0];
  const rows = await rpc("rows", { resourceId: res0.id, languages, offset: 0, limit: 50 });
  check(rows.body?.result?.rows?.length > 0, `rows が行を返す（${rows.body?.result?.total} 行）`, rows.body);

  const stats = await rpc("stats", { resourceIds: [res0.id] });
  check(Array.isArray(stats.body?.result), "stats が結果を返す", stats.body);

  // setText + save でファイルの 1 つのフィールドだけが変わること
  const file = path.join(project, ...res0.path.split("/"));
  const before = readFileSync(file, "utf8");
  let target;
  for (const r of rows.body.result.rows) {
    for (const lang of [...languages].reverse()) {
      const v = r.cells[`${textCol.id}@${lang}`]?.value;
      if (typeof v === "string" && v !== "" && !/[",\n\r]/.test(v) && before.split(v).length === 2) {
        target = { key: r.key, lang, value: v };
        break;
      }
    }
    if (target) break;
  }
  check(target !== undefined, "書き換えに使うセルが見つかる");
  if (target) {
    const next = `${target.value}（確認）`;
    const set = await rpc("setText", { resourceId: res0.id, key: target.key, language: target.lang, value: next });
    check(set.body?.result?.cell?.draft === true, "setText がドラフトを作る", set.body);
    check(readFileSync(file, "utf8") === before, "保存するまでファイルは変わらない");
    const saved = await rpc("save", { resourceId: res0.id });
    check(saved.body?.result?.saved === 1, "save が 1 件を書く", saved.body);
    const after = readFileSync(file, "utf8");
    check(after === before.replace(target.value, next), "ファイルは対象のフィールドだけが変わる", { key: target.key, lang: target.lang });
  }

  const unknown = await rpc("noSuchMethod", {});
  check(unknown.status === 404 && unknown.body?.error?.code === "not-found", "知らないメソッドは 404", unknown.body);

  const malformed = await fetch(`${base}/api/rpc/info`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: localCookie }, body: "{not json" });
  check(malformed.status === 400, "壊れた本文は 400");
  const notJson = await fetch(`${base}/api/rpc/info`, { method: "POST", headers: { "Content-Type": "text/plain", Cookie: localCookie }, body: "{}" });
  check(notJson.status === 415, "JSON 以外の本文は 415", notJson.status);
  const huge = await fetch(`${base}/api/rpc/rows`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: localCookie }, body: JSON.stringify({ params: { pad: "x".repeat(1_200_000) } }) });
  check(huge.status === 413, "大きすぎる本文（1 MB 超の rows）は 413", huge.status);
  const crossSite = await rpc("info", {}, { "Sec-Fetch-Site": "cross-site" });
  check(crossSite.status === 403, "Sec-Fetch-Site: cross-site の POST は拒否される", crossSite.status);

  const foreign = await rpc("info", {}, { Origin: "http://evil.example" });
  check(foreign.status === 403 && !foreign.body?.result, "ほかのオリジンからの要求は拒否される", foreign);

  const sameOrigin = await rpc("info", {}, { Origin: base });
  check(sameOrigin.status === 200 && sameOrigin.body?.result, "同じオリジンからの要求は通る", sameOrigin.status);

  const open = await fetch(`${base}/api/session/open`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: localCookie }, body: JSON.stringify({ project }) });
  const openBody = await open.json();
  check(openBody.result?.recentProjects?.[0] === project, "/api/session/open が最近の一覧に覚える", openBody);

  // 信頼していないプロジェクトを開いただけでは、設定ファイルに書かれた接続先に接続しない（環境変数の値を外に送らない）
  {
    const received = [];
    const sink = net.createServer((sock) => {
      sock.on("data", (d) => received.push(d.toString("latin1")));
      sock.on("error", () => {});
    });
    await new Promise((r) => sink.listen(0, "127.0.0.1", r));
    const sinkPort = sink.address().port;
    const evil = path.join(tmp, "evil");
    mkdirSync(evil, { recursive: true });
    writeFileSync(
      path.join(evil, "loc-studio.project.json"),
      JSON.stringify({
        languages: [{ id: "ja", label: "ja" }],
        tree: { use: "builtin.glob", options: { include: ["*.csv"] } },
        storage: { driver: "postgres", url: `postgres://\${env:SMOKE_SECRET_ENV}:x@127.0.0.1:${sinkPort}/\${env:HOME}` },
      }),
    );
    const eopen = await fetch(`${base}/api/session/open`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: localCookie }, body: JSON.stringify({ project: evil }) });
    const eproject = (await eopen.json()).result?.project;
    const call = async (method, params) => {
      const res = await fetch(`${base}/api/rpc/${method}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: localCookie }, body: JSON.stringify({ project: eproject, params }) });
      return res.json().catch(() => null);
    };
    const ei = await call("info", {});
    const ep = await call("plugins", {});
    await call("rows", { resourceId: "a.csv" });
    await call("tree", {});
    await new Promise((r) => setTimeout(r, 500));
    const item = (ep?.result?.untrusted ?? []).find((u) => u.kind === "settings");
    const shown = JSON.stringify(item?.summary ?? []);
    check(ei?.result?.restricted === true, "接続先を書いた設定ファイルのプロジェクトは、制限された状態で開く", ei);
    check(received.length === 0, "信頼する前は、設定ファイルに書かれた接続先に接続しない", received.join("").slice(0, 200));
    check(shown.includes("${env:SMOKE_SECRET_ENV}") && !shown.includes("smoke-secret-value-42") && shown.includes(String(sinkPort)), "確認の要約には、展開する前の値と接続先が出る（環境変数の値は出ない）", shown);
    check(!existsSync(path.join(evil, ".loc-studio")), "信頼していないプロジェクトには何も書かない");
    sink.close();
  }
} catch (err) {
  failures++;
  console.error(err);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(tmp, { recursive: true, force: true });
}


// ---------------------------------------------------------------------------
// Web モード: サーバーの設定（プロジェクト 1 つ）、環境変数で最初の管理者、管理の口で言語を限った翻訳者を作り、権限を確かめる
// ---------------------------------------------------------------------------
console.log("\n== Web モード ==");
{
  const wtmp = mkdtempSync(path.join(os.tmpdir(), "loc-studio-smoke-web-"));
  const wproject = path.join(wtmp, "project");
  cpSync(sample, wproject, { recursive: true });
  // 独自描画のプラグイン（ブラウザ用のモジュール）と、プラグインのフォルダの外のファイル
  mkdirSync(path.join(wproject, "loc-studio-plugins", "render-pack", "web"), { recursive: true });
  writeFileSync(
    path.join(wproject, "loc-studio-plugins", "render-pack", "index.mjs"),
    `export default { name: "render-pack", renderers: [{ id: "demo.bar", module: "web/bar.mjs" }] };\n`,
  );
  writeFileSync(path.join(wproject, "loc-studio-plugins", "render-pack", "web", "bar.mjs"), `export default { render(el, ctx) { el.textContent = "BAR:" + String(ctx.value); } };\n`);
  writeFileSync(path.join(wproject, "outside.mjs"), `export const secret = "SECRET-OUTSIDE";\n`);
  const config = path.join(wtmp, "server.json");
  writeFileSync(
    config,
    JSON.stringify({ projects: [{ id: "sample", name: "Sample", root: wproject }], allowedHosts: ["loc.example.test"], auth: { mode: "password" }, serverDb: { driver: "sqlite", path: path.join(wtmp, "server.db") } }, null, 2),
  );
  const wport = await freePort();
  const wbase = `http://127.0.0.1:${wport}`;
  const wenv = {
    ...process.env,
    PORT: String(wport),
    NODE_ENV: "production",
    LOC_STUDIO_MODE: "web",
    LOC_STUDIO_SERVER_CONFIG: config,
    LOC_STUDIO_USER_DATA_DIR: path.join(wtmp, "data"),
    LOC_STUDIO_ADMIN_USER: "admin",
    LOC_STUDIO_ADMIN_PASSWORD: "admin-pass-1234",
  };
  delete wenv.LOC_STUDIO_PROJECT;
  delete wenv.LOC_STUDIO_LOCAL_TOKEN;
  delete wenv.LOC_STUDIO_HOST;
  const wchild = spawn(process.execPath, [launcher], { env: wenv, stdio: ["ignore", "pipe", "pipe"] });
  wchild.stdout.on("data", (d) => (serverLog += d));
  wchild.stderr.on("data", (d) => (serverLog += d));

  const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];
  const call = async (url, { body, cookie, headers = {}, method = "POST" } = {}) => {
    const res = await fetch(`${wbase}${url}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // JSON でない（モジュールの本文など）
    }
    return { status: res.status, headers: res.headers, json, text, res };
  };
  const wrpc = (method, params, cookie) => call(`/api/rpc/${method}`, { body: { project: "sample", params }, cookie });

  try {
    console.log(`サーバー: ${wbase}  設定: ${config}`);
    await waitFor(`${wbase}/api/session`, 60000);
    const session = await call("/api/session", { method: "GET" });
    check(session.json?.mode === "web", "/api/session が Web モードを返す", session.json);

    const goodHost = await raw(wbase, "GET", "/api/session", { Host: `loc.example.test:${wport}` });
    check(goodHost.status === 200, "server.json の allowedHosts の名前は通す", goodHost.status);
    const badHost = await raw(wbase, "GET", "/api/session", { Host: "evil.example" });
    check(badHost.status === 421, "Web モードでも許可していない Host は 421", badHost.status);
    const bigLogin = await call("/api/auth/login", { body: { name: "admin", password: "x".repeat(20000) } });
    check(bigLogin.status === 413, "ログインの本文が 16 KB を超えたら 413", bigLogin.status);
    const anon = await wrpc("info", {});
    check(anon.status === 401 && anon.json?.error?.code === "unauthorized", "セッションのない RPC は 401", anon.json);
    const anonMe = await call("/api/auth/me", { method: "GET" });
    check(anonMe.status === 401, "セッションのない /api/auth/me は 401", anonMe.status);
    const foreign = await call("/api/auth/login", { body: { name: "admin", password: "admin-pass-1234" }, headers: { Origin: "http://evil.example" } });
    check(foreign.status === 403, "ほかのオリジンからのログインは拒否される", foreign.status);

    const bad = await call("/api/auth/login", { body: { name: "admin", password: "wrong-password" } });
    check(bad.status === 401 && typeof bad.json?.error?.message === "string", `間違ったパスワードは 401（${bad.json?.error?.message}）`, bad.json);
    for (let i = 0; i < 5; i++) await call("/api/auth/login", { body: { name: "nobody", password: "x".repeat(8) } });
    const throttled = await call("/api/auth/login", { body: { name: "nobody", password: "x".repeat(8) } });
    check(throttled.status === 429 && Number(throttled.headers.get("retry-after")) > 0, `失敗が続くと 429 と Retry-After（${throttled.headers.get("retry-after")} 秒）`, throttled.json);

    const login = await call("/api/auth/login", { body: { name: "admin", password: "admin-pass-1234" } });
    const setCookie = login.headers.get("set-cookie") ?? "";
    check(login.status === 200 && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && !/Secure/i.test(setCookie), "管理者がログインでき、クッキーは HttpOnly・SameSite=Lax（http なので Secure なし）", setCookie);
    const adminCookie = cookieOf(login.res);
    const https = await call("/api/auth/login", { body: { name: "admin", password: "admin-pass-1234" }, headers: { "x-forwarded-proto": "https" } });
    check(/;\s*Secure/i.test(https.headers.get("set-cookie") ?? ""), "x-forwarded-proto: https のときは Secure", https.headers.get("set-cookie"));
    const me = await call("/api/auth/me", { method: "GET", cookie: adminCookie });
    check(me.json?.result?.admin === true && me.json.result.projects?.[0]?.role === "manager", "/api/auth/me が管理者とプロジェクト（manager）を返す", me.json);
    const adminInfo = await wrpc("info", {}, adminCookie);
    check(adminInfo.json?.result?.validators?.some((v) => v.id === "mystudio.lineWidth"), "Web モードではプロジェクトのプラグインを確認なしで読み込む", adminInfo.json?.result?.validators);

    const created = await call("/api/admin/createUser", { body: { input: { name: "tom", password: "tom-pass-1234", displayName: "Tom" } }, cookie: adminCookie });
    check(created.status === 200 && created.json?.result?.name === "tom", "管理の口で利用者を作れる", created.json);
    const member = await call("/api/admin/setMembership", { body: { projectId: "sample", user: "tom", role: "translator", languages: ["JaEnglish"] }, cookie: adminCookie });
    check(member.json?.result?.role === "translator", "管理の口で翻訳者（JaEnglish だけ）を割り当てられる", member.json);

    const tomLogin = await call("/api/auth/login", { body: { name: "tom", password: "tom-pass-1234" } });
    const tom = cookieOf(tomLogin.res);
    check(tomLogin.status === 200 && tom.startsWith("loc_studio_session="), "翻訳者がログインできる", tomLogin.json);
    const tomAdmin = await call("/api/admin/listUsers", { body: {}, cookie: tom });
    check(tomAdmin.status === 403, "管理者でない人の管理の口は 403", tomAdmin.json);
    const tinfo = await wrpc("info", {}, tom);
    const perms = tinfo.json?.result?.permissions;
    check(perms?.role === "translator" && perms.languages?.[0] === "JaEnglish" && perms.can.edit && !perms.can.review, "info.permissions が翻訳者の権限を返す", perms);
    const textCol = tinfo.json.result.columns.find((c) => c.kind === "text");
    const tree = await wrpc("tree", {}, tom);
    const res0 = [];
    const walk = (nodes) => nodes.forEach((n) => (n.kind === "resource" ? res0.push(n.resource) : walk(n.children ?? [])));
    walk(tree.json?.result ?? []);
    const ui = res0.find((r) => r.path.endsWith("ui.csv")) ?? res0[0];
    const rows = await wrpc("rows", { resourceId: ui.id, languages: ["JaEnglish"], offset: 0, limit: 5 }, tom);
    const key = rows.json?.result?.rows?.[0]?.key;
    const before = rows.json?.result?.rows?.[0]?.cells[`${textCol.id}@JaEnglish`]?.value;
    const okSet = await wrpc("setText", { resourceId: ui.id, key, language: "JaEnglish", value: `${before} (tom)`, baseValue: before }, tom);
    check(okSet.status === 200 && okSet.json?.result?.cell?.draftBy === "tom", "担当の言語の setText はできて、ドラフトに名前が残る", okSet.json);
    const saved = await wrpc("save", { resourceId: ui.id }, tom);
    check(saved.json?.result?.saved === 1, "担当の言語の保存ができる", saved.json);
    const hist = await wrpc("history", { resourceId: ui.id, key, cellId: `${textCol.id}@JaEnglish` }, tom);
    check(hist.json?.result?.[0]?.by === "tom", "履歴に翻訳者の名前が残る", hist.json?.result?.[0]);
    const denied = await wrpc("setText", { resourceId: ui.id, key, language: "ko", value: "x" }, tom);
    check(denied.status === 403 && denied.json?.error?.code === "forbidden", `担当外の言語の setText は 403（${denied.json?.error?.message}）`, denied.json);
    const manage = await wrpc("updateProjectSettings", { patch: { name: "X" } }, tom);
    check(manage.status === 403, "manager だけのメソッドは 403", manage.json);

    // 独自描画のモジュール
    const r = (tinfo.json.result.renderers ?? []).find((x) => x.id === "demo.bar");
    check(r !== undefined, "info.renderers にプラグインの独自描画がある", tinfo.json.result.renderers);
    if (r) {
      const mod = await call(`/api/renderer/demo.bar?project=sample&h=${r.hash}`, { method: "GET", cookie: tom });
      check(
        mod.status === 200 &&
          (mod.headers.get("content-type") ?? "").startsWith("text/javascript") &&
          mod.headers.get("x-content-type-options") === "nosniff" &&
          /immutable/.test(mod.headers.get("cache-control") ?? "") &&
          mod.text.includes("BAR:"),
        "独自描画のモジュールを text/javascript・nosniff・immutable で返す",
        { status: mod.status, ct: mod.headers.get("content-type"), cc: mod.headers.get("cache-control") },
      );
      const stale = await call(`/api/renderer/demo.bar?project=sample&h=old`, { method: "GET", cookie: tom });
      check(stale.status === 200 && stale.headers.get("cache-control") === "no-store", "ハッシュが違えばキャッシュさせない", stale.headers.get("cache-control"));
      const noSession = await call(`/api/renderer/demo.bar?project=sample&h=${r.hash}`, { method: "GET" });
      check(noSession.status === 401, "セッションがなければモジュールも返さない", noSession.status);
    }
    for (const trick of ["..%2F..%2Foutside.mjs", "demo.bar%2F..%2F..%2F..%2Foutside.mjs", "%2E%2E%2Foutside", "..%5C..%5Coutside.mjs", "nope"]) {
      const t = await call(`/api/renderer/${trick}?project=sample`, { method: "GET", cookie: tom });
      check(t.status === 404 && !t.text.includes("SECRET-OUTSIDE"), `パスの細工は 404（${trick}）`, t.status);
    }
    const otherProject = await call(`/api/renderer/demo.bar?project=..%2F..`, { method: "GET", cookie: tom });
    check(otherProject.status === 404, "知らないプロジェクトの独自描画は 404", otherProject.status);

    const logout = await call("/api/auth/logout", { body: {}, cookie: tom });
    check(logout.status === 200 && /Max-Age=0/i.test(logout.headers.get("set-cookie") ?? ""), "ログアウトでクッキーを消す", logout.headers.get("set-cookie"));
    const after = await wrpc("info", {}, tom);
    check(after.status === 401, "ログアウトしたセッションは使えない（401）", after.status);
    const openFolder = await call("/api/session/open", { body: { project: wproject }, cookie: adminCookie });
    check(openFolder.status === 403, "Web モードでは任意のフォルダは開けない", openFolder.status);
    const token = adminCookie.split("=")[1] ?? "";
    check(!/admin-pass-1234|tom-pass-1234/.test(serverLog) && (token === "" || !serverLog.includes(decodeURIComponent(token))), "サーバーのログにパスワードやトークンが出ていない");
  } catch (err) {
    failures++;
    console.error(err);
  } finally {
    wchild.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(wtmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 起動の仕組みが、設定の誤りで起動を断ること
// ---------------------------------------------------------------------------
console.log("\n== 起動の確かめ ==");
await expectRefusal({ LOC_STUDIO_MODE: "webb" }, "知らない LOC_STUDIO_MODE では起動しない", /LOC_STUDIO_MODE/);
await expectRefusal({ LOC_STUDIO_MODE: "web", LOC_STUDIO_SERVER_CONFIG: path.join(os.tmpdir(), "no-such-loc-studio.json") }, "Web モードで設定ファイルが読めなければ起動しない", /設定/);
await expectRefusal({ LOC_STUDIO_MODE: "local", LOC_STUDIO_HOST: "0.0.0.0" }, "ローカルモードでループバック以外には（明示しない限り）待ち受けない", /LOC_STUDIO_ALLOW_REMOTE_LOCAL/);
await expectRefusal({ LOC_STUDIO_MODE: "local", LOC_STUDIO_LOCAL_TOKEN: "off", LOC_STUDIO_HOST: "0.0.0.0", LOC_STUDIO_ALLOW_REMOTE_LOCAL: "1" }, "合言葉なし（off）はループバック以外では使えない", /off/);
{
  // Web モードで、設定ファイルの場所を指定せず既定の場所（データフォルダの server.json）だけでも要求に答える
  const dtmp = mkdtempSync(path.join(os.tmpdir(), "loc-studio-smoke-default-"));
  const dproject = path.join(dtmp, "project");
  cpSync(sample, dproject, { recursive: true });
  writeFileSync(path.join(dtmp, "server.json"), JSON.stringify({ projects: [{ id: "sample", name: "Sample", root: dproject }], auth: { mode: "password" } }));
  const dport = await freePort();
  const denv = { ...process.env, PORT: String(dport), NODE_ENV: "production", LOC_STUDIO_MODE: "web", LOC_STUDIO_SETTINGS: path.join(dtmp, "settings.json") };
  for (const k of ["LOC_STUDIO_SERVER_CONFIG", "LOC_STUDIO_USER_DATA_DIR", "LOC_STUDIO_PROJECT", "LOC_STUDIO_LOCAL_TOKEN", "LOC_STUDIO_HOST", "LOC_STUDIO_ALLOWED_HOSTS"]) delete denv[k];
  const d = spawn(process.execPath, [launcher], { env: denv, stdio: ["ignore", "pipe", "pipe"] });
  let dlog = "";
  d.stdout.on("data", (x) => (dlog += x));
  d.stderr.on("data", (x) => (dlog += x));
  try {
    await waitFor(`http://127.0.0.1:${dport}/api/session`, 60000);
    const r = await fetch(`http://127.0.0.1:${dport}/api/session`);
    const j = await r.json().catch(() => null);
    check(r.status === 200 && j?.mode === "web", "Web モードは、既定の場所の server.json だけでも要求に答える", { status: r.status, j, log: dlog.slice(-300) });
    const warns = dlog.split("allowedHosts（server.json）も").length - 1;
    check(warns === 1, "allowedHosts がないときの警告は 1 回だけ", warns);
  } catch (err) {
    failures++;
    console.error(err, dlog.slice(-500));
  } finally {
    d.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dtmp, { recursive: true, force: true });
  }
}
{
  // 起動の仕組みを通さずに server.js を直接動かしても、合言葉がなければ何も受け付けない（閉じる側に倒れる）
  const dport = await freePort();
  const denv = { ...process.env, PORT: String(dport), HOSTNAME: "127.0.0.1", NODE_ENV: "production", LOC_STUDIO_MODE: "local", LOC_STUDIO_USER_DATA_DIR: path.join(os.tmpdir(), "loc-studio-direct") };
  delete denv.LOC_STUDIO_LOCAL_TOKEN;
  const d = spawn(process.execPath, [standalone], { env: denv, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await waitFor(`http://127.0.0.1:${dport}/api/session`, 60000);
    const r = await fetch(`http://127.0.0.1:${dport}/api/session`);
    check(r.status === 500, "合言葉なしで server.js を直接動かすと、要求に 500（認証なしで動かない）", r.status);
  } finally {
    d.kill();
  }
}

if (failures > 0) {
  console.log(`\n${failures} 件の確認に失敗しました。サーバーのログ:\n${serverLog.slice(-4000)}`);
  process.exit(1);
}
console.log("\nすべての確認に成功しました。");
