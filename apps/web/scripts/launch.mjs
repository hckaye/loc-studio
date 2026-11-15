#!/usr/bin/env node
// loc-studio の画面のサーバーを起動する（本番: standalone の server.js、開発: --dev で next dev）。
// 起動の前に、モード、Web モードの設定、バインドするアドレス、ローカルモードの起動の合言葉を確かめる。
// 問題があれば起動しない（認証のないローカルモードに落とさない）。
//
// 環境変数:
//   LOC_STUDIO_MODE            "local"（既定）か "web"。ほかの値は起動しない。
//   LOC_STUDIO_HOST            バインドするアドレス（既定 127.0.0.1）。HOSTNAME は見ない（シェルが PC 名を入れていることがあるため）。
//   LOC_STUDIO_ALLOW_REMOTE_LOCAL=1  ローカルモードでループバック以外にバインドするとき（合言葉は必要なまま）。
//   PORT                       ポート（既定 3000）。
//   LOC_STUDIO_LOCAL_TOKEN     ローカルモードの起動の合言葉。なければ作って URL を表示する。"off" は開発用（ループバックだけ）。
//   LOC_STUDIO_SERVER_CONFIG   Web モードのサーバーの設定ファイル。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");

function fail(message) {
  console.error(`[loc-studio] 起動できません: ${message}`);
  process.exit(1);
}

const isLoopbackBind = (h) => {
  const v = h.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return v === "localhost" || v === "::1" || /^127(\.\d{1,3}){3}$/.test(v);
};

// --- モード
const rawMode = process.env.LOC_STUDIO_MODE;
const mode = rawMode === undefined || rawMode === "" || rawMode === "local" ? "local" : rawMode === "web" ? "web" : null;
if (!mode) fail(`LOC_STUDIO_MODE は "local" か "web" にしてください（いまの値: "${String(rawMode).slice(0, 40)}"）。`);
process.env.LOC_STUDIO_MODE = mode;

// --- バインドするアドレス
const host = process.env.LOC_STUDIO_HOST || "127.0.0.1";
if (mode === "local" && !isLoopbackBind(host) && process.env.LOC_STUDIO_ALLOW_REMOTE_LOCAL !== "1") {
  fail(`ローカルモードでループバック以外のアドレス（${host}）には待ち受けません。必要なら LOC_STUDIO_ALLOW_REMOTE_LOCAL=1 も設定してください（起動の合言葉は必要なままです）。`);
}
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`PORT が正しくありません: ${process.env.PORT}`);
process.env.HOSTNAME = host; // standalone の server.js はこれを見る
process.env.PORT = String(port);
process.env.LOC_STUDIO_BIND_HOST = host;

// --- Web モードの設定（読めて形が正しいこと）
if (mode === "web") {
  try {
    const server = await import("@loc-studio/server");
    const core = await import("@loc-studio/core");
    // lib/server/host.ts の dataDir() と同じ決め方
    const dataDir = process.env.LOC_STUDIO_USER_DATA_DIR ? path.resolve(process.env.LOC_STUDIO_USER_DATA_DIR) : path.dirname(core.localSettingsPath(process.env));
    const file = path.resolve(server.serverConfigPath(process.env, dataDir));
    server.loadServerConfig(file, process.env);
    // 要求を受けるときも同じファイルを使うよう、見つけた場所を渡す（決め方を 2 か所に持たない）
    process.env.LOC_STUDIO_SERVER_CONFIG = file;
  } catch (err) {
    fail(`Web モードのサーバーの設定を読めません（LOC_STUDIO_SERVER_CONFIG）: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (process.env.LOC_STUDIO_LOCAL_TOKEN === "off") fail("LOC_STUDIO_LOCAL_TOKEN=off はローカルモードの開発用です。Web モードでは使えません。");
}

// --- ローカルモードの起動の合言葉
let token;
if (mode === "local") {
  token = process.env.LOC_STUDIO_LOCAL_TOKEN;
  if (token === "off") {
    if (!isLoopbackBind(host)) fail("LOC_STUDIO_LOCAL_TOKEN=off はループバックで待ち受けるときだけ使えます。");
    console.warn("[loc-studio] 警告: 起動の合言葉を使いません（LOC_STUDIO_LOCAL_TOKEN=off）。この PC のほかのプログラムやユーザーから操作できます。開発のときだけ使ってください。");
  } else if (!token) {
    token = crypto.randomBytes(32).toString("base64url");
    process.env.LOC_STUDIO_LOCAL_TOKEN = token;
  } else if (token.length < 16) {
    fail("LOC_STUDIO_LOCAL_TOKEN は 16 文字以上にしてください。");
  }
} else {
  delete process.env.LOC_STUDIO_LOCAL_TOKEN;
}

// --- 接続そのもののアドレスを、合言葉つきのヘッダーで Next に渡す（クライアントが付けた同名のヘッダーは消す）
const internalSecret = crypto.randomBytes(24).toString("base64url");
process.env.LOC_STUDIO_INTERNAL_SECRET = internalSecret;
const wrap = (listener) =>
  function wrapped(req, res) {
    delete req.headers["x-loc-studio-remote-address"];
    delete req.headers["x-loc-studio-internal"];
    req.headers["x-loc-studio-remote-address"] = req.socket.remoteAddress ?? "";
    req.headers["x-loc-studio-internal"] = internalSecret;
    return listener(req, res);
  };
const origCreateServer = http.createServer;
let announced = false;
http.createServer = function (...args) {
  const i = args.findIndex((a) => typeof a === "function");
  if (i >= 0) args[i] = wrap(args[i]);
  const server = origCreateServer.apply(this, args);
  server.once("listening", () => {
    if (!announced) {
      announced = true;
      announce();
    }
  });
  return server;
};

function announce() {
  const shown = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host;
  const base = `http://${shown}:${port}/`;
  if (mode === "local" && token && token !== "off") {
    console.log(`\nloc-studio: ${base}?token=${token}\n（この URL から開いてください。URL はほかの人に教えないでください）\n`);
  } else {
    console.log(`\nloc-studio: ${base}（${mode === "web" ? "Web モード" : "ローカルモード・合言葉なし"}）\n`);
  }
}

if (dev) {
  // 開発: next dev を同じプロセスで動かす（上の http.createServer の差し替えが効く）
  const appDir = path.resolve(here, "..");
  const { default: next } = await import("next");
  const app = next({ dev: true, dir: appDir, hostname: host, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  http.createServer((req, res) => handle(req, res)).listen(port, host);
} else {
  // 本番: standalone の server.js（このファイルが standalone の中にあればその隣、なければビルドの出力）
  const candidates = [path.join(here, "server.js"), path.resolve(here, "..", ".next", "standalone", "apps", "web", "server.js")];
  const serverJs = candidates.find((p) => fs.existsSync(p));
  if (!serverJs) fail("standalone の server.js が見つかりません。先に npm run build:web を実行してください。");
  await import(pathToFileURL(serverJs).href);
}
