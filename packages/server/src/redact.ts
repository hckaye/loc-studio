/**
 * Web モードで、管理者でない利用者に返す値から、サーバーのパスや接続先、内部のエラーの詳細を伏せる。
 * 伏せる処理はここ 1 か所（dispatch と ServerRuntime.handle が使う）。
 */
import { randomBytes } from "node:crypto";
import { INFRA_CONFIG_KEYS } from "@loc-studio/core";
import type { ApiErrorCode } from "./api-types.js";

export interface RedactionPaths {
  /** 長いものから並べる。prefix を label に置き換える。 */
  paths: { prefix: string; label: string }[];
  /** 伏せた内部のエラーの詳細を残す先（サーバーのログ）。 */
  log(message: string): void;
}

function replacePaths(s: string, paths: RedactionPaths["paths"]): string {
  let out = s;
  for (const { prefix, label } of paths) {
    if (!prefix) continue;
    out = out.split(prefix).join(label);
    // Windows の区切りとの書き分けにも当てる。
    const alt = prefix.includes("\\") ? prefix.split("\\").join("/") : prefix.split("/").join("\\");
    if (alt !== prefix) out = out.split(alt).join(label);
  }
  return out;
}

function walk(v: unknown, paths: RedactionPaths["paths"]): unknown {
  if (typeof v === "string") return replacePaths(v, paths);
  if (Array.isArray(v)) return v.map((x) => walk(x, paths));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, paths);
    return out;
  }
  return v;
}

/** URL と「ホスト:ポート」の形（接続先）を <接続先> に置き換える。 */
const URL_RE = /[a-z][a-z0-9+.-]*:[\\/]{1,2}[^\s"'<>（）「」、。]+/gi;
const HOST_PORT_RE =
  /\[[0-9a-f:.]+\](?::\d{1,5})?|\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b|\blocalhost(?::\d{1,5})?\b|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5}(?:\/[^\s"'<>（）「」、。]*)?|\/[^\s"'<>（）「」、。]*)/gi;

/** URL と「ホスト:ポート」の形を伏せる（ポートもパスもないドメイン名だけの形は、ID などと見分けられないので残す）。 */
export function redactDestinations(s: string): string {
  return s.replace(URL_RE, "<接続先>").replace(HOST_PORT_RE, "<接続先>");
}

/** 結果の中のエラーの文言（error、errors、message）から接続先を伏せる。 */
function redactErrorTexts(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactErrorTexts);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === "error" || k === "message") && typeof x === "string") out[k] = redactDestinations(x);
      else if (k === "errors" && Array.isArray(x)) out[k] = x.map((e) => (typeof e === "string" ? redactDestinations(e) : redactErrorTexts(e)));
      else out[k] = redactErrorTexts(x);
    }
    return out;
  }
  return v;
}

/** 接続先を伏せる結果のメソッド（ジョブの失敗、セルのエラー、アクションのエラーの文言）。 */
const DESTINATION_METHODS = new Set(["jobs", "job", "cancelJob", "rows", "rowDetail", "runAction", "generate"]);

/** メソッドの結果を伏せる。 */
export function redactResult(method: string, result: unknown, r: RedactionPaths): unknown {
  let v = walk(result, r.paths) as Record<string, unknown> | unknown;
  // 生成器の接続先（管理者だけが見られる設定）がエラーの文言から漏れないようにする。
  if (DESTINATION_METHODS.has(method)) v = redactErrorTexts(v);
  if (method === "info" && v && typeof v === "object") {
    const info = v as { root?: string; storage?: { path: string; shared: boolean } };
    info.root = "";
    // 接続先（Postgres の URL など）と DB のファイルの場所は出さない。
    if (info.storage) info.storage = { ...info.storage, path: "" };
  }
  if ((method === "pluginSettings" || method === "setPluginSettings") && Array.isArray(v)) {
    v = (v as { file?: string }[]).map((p) => ({ ...p, file: "" }));
  }
  if (method === "settings" && v && typeof v === "object") {
    const s = v as { localFile?: string; projectFile?: string; project?: Record<string, unknown> };
    s.localFile = "";
    s.projectFile = "";
    // 基盤の項目（接続先、生成器の endpoint など）は管理者だけが見る。画面は info().actions / reviewTargets の id と表示名を使う。
    if (s.project && typeof s.project === "object") {
      const project = { ...s.project };
      for (const k of INFRA_CONFIG_KEYS) delete project[k];
      s.project = project;
    }
  }
  return v;
}

/** エラーを伏せる。内部のエラー（failed）は、一般的な文言と参照番号だけにして、詳細はサーバーのログに残す。 */
export function redactError(
  e: { code: ApiErrorCode; message: string; data?: unknown },
  r: RedactionPaths,
  where: string,
): { code: ApiErrorCode; message: string; data?: unknown } {
  if (e.code === "failed") {
    const ref = randomBytes(4).toString("hex");
    r.log(`[${ref}] ${where}: ${e.message}`);
    return { code: "failed", message: `サーバーで問題が起きました（参照番号: ${ref}）。管理者に参照番号を伝えてください。` };
  }
  const out: { code: ApiErrorCode; message: string; data?: unknown } = { code: e.code, message: redactDestinations(replacePaths(e.message, r.paths)) };
  if (e.data !== undefined && e.code !== "locked") out.data = walk(e.data, r.paths);
  return out;
}
