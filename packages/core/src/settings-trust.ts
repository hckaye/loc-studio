/**
 * プロジェクトの設定ファイル（loc-studio.project.json）の信頼（確認のモードのとき）。
 *
 * 設定ファイルはコードではないが、基盤の項目（storage、tree、generators など）と ${env:NAME} の参照で、
 * 開いただけで外部につないだり、環境変数や秘密を外へ送ったりできる。そのため、基盤の項目と参照する環境変数の名前の
 * 組をハッシュにして、利用者が確認したものだけを使う。manager が普段変える項目（言語、列など）はハッシュに入れない。
 */
import { createHash } from "node:crypto";
import type { PluginCandidate } from "./plugin-loader.js";
import { stableStringify } from "./validation.js";

/** 基盤の項目（Web モードでは管理者だけが変えられ、確認のモードでは設定ファイルの信頼のハッシュに入る）。 */
export const INFRA_CONFIG_KEYS = ["storage", "pluginDirs", "tree", "formats", "syntaxes", "sources", "generators", "actions", "hooks", "review"] as const;

/** どのモードでも ${env:NAME} やプラグインのホストの env に出さない環境変数（秘密は host.secrets だけで読む）。 */
const RESERVED_ENV = new Set(["LOC_STUDIO_LOCAL_TOKEN", "LOC_STUDIO_INTERNAL_SECRET", "LOC_STUDIO_ADMIN_USER", "LOC_STUDIO_ADMIN_PASSWORD"]);

export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV.has(name) || name.startsWith("LOC_STUDIO_SECRET_");
}

/** env から予約された名前を除いた写し。 */
export function withoutReservedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!isReservedEnvName(k)) out[k] = v;
  return out;
}

/** 文字列の中の ${env:NAME} の名前（重複なし、並べ替え済み）。 */
export function envReferences(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\$\{env:([^}]*)\}/g)) names.add(m[1]!);
  return [...names].sort();
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 接続文字列の形をした文字列のパスワードの部分を伏せる（展開前のテンプレートのまま）。 */
function maskTemplate(s: string): string {
  const m = /\/\/([^/\s]*)@/.exec(s);
  if (!m) return s;
  const info = m[1]!;
  // ${env:NAME} の中の ":" は区切りではない。
  let depth = 0;
  for (let i = 0; i < info.length; i++) {
    if (info.startsWith("${", i)) depth++;
    else if (info[i] === "}" && depth > 0) depth--;
    else if (info[i] === ":" && depth === 0) {
      const masked = `${info.slice(0, i)}:****`;
      return s.slice(0, m.index + 2) + masked + s.slice(m.index + 2 + info.length);
    }
  }
  return s;
}

/** 確認の画面の 1 行。 */
export interface SummaryRow {
  label: string;
  value: string;
  /** 文字列が接続先の URL のとき、実際の接続先（ホストとポート）。http:/host や http:\\host、user@host の形でも本当の行き先を出す。 */
  host?: string;
  /** 補足（URL にユーザー情報がある、接続先が環境変数で決まる、秘密情報の名前、など）。 */
  note?: string;
}

/** 1 つの値の最大の長さ（超えた分は印を付けて省く。接続先の部分は切らない）。 */
const MAX_VALUE = 500;
/** 1 つの項目で出す options の葉の数（超えたら残りの数を出し、URL・パス・環境変数を含むものは必ず出す）。 */
const MAX_LEAVES = 40;
/** 接続先として扱わない URL のスキーム（その PC の中のもの）。 */
const LOCAL_SCHEMES = new Set(["file:", "data:", "blob:", "about:", "javascript:", "node:"]);
// 秘密情報の名前らしい項目名。CSV の `key`（キーの列名）のような、ただの "key" は含めない。
// 末尾の "Key" は、apiKey や accessKey のような書き方（大文字の K）だけを見る。hotkey のような語は含めない。
const SECRET_WORD = /secret|token|password|credential|api[-_]?key/i;
const SECRET_SUFFIX = /[a-z0-9]Key$/;
const SECRET_KEY = { test: (key: string): boolean => SECRET_WORD.test(key) || SECRET_SUFFIX.test(key) };
const ENV_TOKEN = "loc-studio-env-placeholder";

/** 制御文字と書字方向の制御文字を、見える形にする（表示の順を入れ替えられないように）。 */
export function escapeControls(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`);
}

/** 長すぎる値を省く（keep の範囲は切らない）。 */
function cap(s: string, keep?: string): string {
  if (s.length <= MAX_VALUE) return s;
  let at = MAX_VALUE;
  if (keep) {
    const i = s.indexOf(keep);
    if (i >= 0 && i < at && i + keep.length > at) at = i + keep.length;
  }
  return `${s.slice(0, at)}…（残り ${s.length - at} 文字）`;
}

const looksLikePath = (v: string): boolean => v.startsWith("/") || v.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith("./") || v.startsWith("../") || v.startsWith("~");

/**
 * Postgres の接続文字列の接続先。共有 DB のドライバー（pg）が使う pg-connection-string の parse() と同じ順で決める:
 * - 文字列が "/" で始まれば、最初の空白までがソケットのフォルダ。
 * - URL として読めなければ "@/" を仮のホストにして読み直す（// のあとにホストがない形）。
 * - クエリの host があればそれ、なければ // のあとのホスト。クエリの port があればそれ、なければ // のあとのポート。
 * - socket: のスキームは、パスがソケット。
 * hostaddr は pg-connection-string がそのまま渡すだけで、pg は接続に使わない（接続先は host）。
 * テストで pg-connection-string の parse() と結果を比べている（packages/store）。
 */
export function postgresDestination(input: string): { host: string; port: string; params: Record<string, string> } | undefined {
  if (input.charAt(0) === "/") return { host: input.split(" ")[0]!, port: "", params: {} };
  let str = input;
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) str = encodeURI(str).replace(/%25(\d\d)/g, "%$1");
  let result: URL;
  let dummyHost = false;
  try {
    try {
      result = new URL(str, "postgres://base");
    } catch {
      result = new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base");
      dummyHost = true;
    }
  } catch {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [k, v] of result.searchParams.entries()) params[k] = v;
  if (result.protocol === "socket:") {
    let host: string;
    try {
      host = decodeURI(result.pathname);
    } catch {
      return undefined;
    }
    return { host, port: params.port ?? "", params };
  }
  const hostname = (dummyHost ? "" : result.hostname).replace(/^\[(.+)\]$/, "$1");
  let host: string;
  try {
    host = params.host ? params.host : decodeURIComponent(hostname);
  } catch {
    return undefined;
  }
  const port = params.port ? params.port : result.port;
  return { host, port, params };
}

/** 接続文字列のクエリのうち、行き先やファイルを変えるもの（要約に必ず行を出す）。 */
const PG_SENSITIVE_PARAMS = ["host", "hostaddr", "port", "sslrootcert", "sslcert", "sslkey", "options", "service", "target_session_attrs"];
const isPostgres = (v: string): boolean => /^postgres(?:ql)?:/i.test(v.trim()) || /^socket:/i.test(v.trim());

/** env の仮の印を元の ${env:NAME} に戻す。 */
function restoreEnv(s: string, envNames: string[]): string {
  let out = s;
  for (const n of envNames) out = out.split(`${ENV_TOKEN}-${n.toLowerCase()}`).join(`\${env:${n}}`);
  return out;
}

/** Postgres の接続文字列の接続先と補足。 */
function pgDestination(probe: string, envNames: string[]): { host?: string; notes: string[] } | undefined {
  const d = postgresDestination(probe);
  if (!d) return undefined;
  const notes: string[] = [];
  let authority: URL | undefined;
  try {
    authority = new URL(probe);
  } catch {
    authority = undefined;
  }
  const overrides = ["host", "port"].filter((k) => d.params[k] !== undefined && d.params[k] !== "");
  if (overrides.length > 0) notes.push(`URL のクエリの ${overrides.join(" / ")} が、// のあとの接続先より優先されます`);
  if (d.params.hostaddr !== undefined) notes.push("hostaddr は、このアプリのドライバー（pg）では接続に使われません（接続先は host です）");
  if (authority && (authority.username || authority.password)) notes.push("URL にユーザー情報（user@ の部分）があります。実際の接続先は host の欄です");
  const host = restoreEnv(d.host, envNames);
  if (host.startsWith("/")) {
    notes.push(`この PC のソケット（${host}）に接続します`);
    return { host, notes };
  }
  const shownHost = host === "" ? "localhost" : host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  if (host === "") notes.push("ホストの指定がないため、既定（localhost。環境変数 PGHOST で変わることがあります）に接続します");
  const port = restoreEnv(d.port, envNames) || "5432";
  if (!d.port) notes.push("ポートの指定がないため、既定（5432。環境変数 PGPORT で変わることがあります）を使います");
  return { host: `${shownHost}:${port}`, notes };
}

/** 文字列の値が接続先の URL なら、その接続先と補足。 */
function destination(v: string): { host?: string; note?: string; important: boolean } {
  const envNames = envReferences(v);
  const probe = envNames.reduce((acc, n) => acc.split(`\${env:${n}}`).join(`${ENV_TOKEN}-${n.toLowerCase()}`), v);
  const notes: string[] = [];
  if (envNames.length > 0) notes.push(`接続先やパスは環境変数 ${envNames.join(", ")} で決まります`);
  if (isPostgres(probe)) {
    // Postgres は、ドライバーと同じ決め方で本当の接続先を出す（クエリの host / port が優先される）。
    const pg = pgDestination(probe, envNames);
    if (pg) {
      notes.push(...pg.notes);
      return { ...(pg.host ? { host: pg.host } : {}), ...(notes.length > 0 ? { note: notes.join("。") } : {}), important: true };
    }
  }
  let url: URL | undefined;
  try {
    url = new URL(probe);
  } catch {
    url = undefined;
  }
  if (url && !LOCAL_SCHEMES.has(url.protocol) && !/^[a-z]:$/i.test(url.protocol) && url.host !== "") {
    let host = url.host;
    for (const n of envNames) host = host.split(`${ENV_TOKEN}-${n.toLowerCase()}`).join(`\${env:${n}}`);
    if (url.username || url.password) notes.push("URL にユーザー情報（user@ の部分）があります。実際の接続先は host の欄です");
    return { host, ...(notes.length > 0 ? { note: notes.join("。") } : {}), important: true };
  }
  return { ...(notes.length > 0 ? { note: notes.join("。") } : {}), important: envNames.length > 0 || looksLikePath(v) || url !== undefined };
}

/** Postgres の接続文字列の、行き先やファイルを変えるクエリの行（必ず出す）。 */
function pgParamRows(label: string, value: unknown): SummaryRow[] {
  if (typeof value !== "string" || !isPostgres(value)) return [];
  const envNames = envReferences(value);
  const probe = envNames.reduce((acc, n) => acc.split(`\${env:${n}}`).join(`${ENV_TOKEN}-${n.toLowerCase()}`), value);
  const d = postgresDestination(probe);
  if (!d) return [];
  const rows: SummaryRow[] = [];
  for (const k of PG_SENSITIVE_PARAMS) {
    if (d.params[k] === undefined) continue;
    const v = restoreEnv(d.params[k]!, envNames);
    const row: SummaryRow = { label: escapeControls(`${label} の ?${k}`), value: cap(escapeControls(JSON.stringify(v))) };
    if (k === "host" || k === "port") row.note = "// のあとの接続先より、こちらが優先されます";
    else if (k === "hostaddr") row.note = "このアプリのドライバー（pg）では接続に使われません";
    else if (k.startsWith("ssl")) row.note = "この PC のファイルを読みます";
    rows.push(row);
  }
  return rows;
}

/** 値を JSON のスカラーとして出す行。 */
function leafRow(label: string, value: unknown, key: string): SummaryRow & { important: boolean } {
  if (typeof value !== "string") return { label: escapeControls(label), value: cap(escapeControls(JSON.stringify(value) ?? "null")), important: false };
  const d = destination(value);
  const shown = cap(escapeControls(JSON.stringify(maskTemplate(value))), d.host ? escapeControls(d.host) : undefined);
  const row: SummaryRow & { important: boolean } = { label: escapeControls(label), value: shown, important: d.important };
  if (d.host) row.host = escapeControls(d.host);
  const notes = d.note ? [d.note] : [];
  if (SECRET_KEY.test(key)) notes.push("秘密情報の名前です（値はこの PC のローカル設定にあります）");
  if (notes.length > 0) row.note = escapeControls(notes.join("。"));
  return row;
}

/** オブジェクトや配列を葉に平らにする（a.b[0] の形のパス）。 */
function leaves(v: unknown, p: string, out: { path: string; value: unknown; key: string }[]): void {
  if (Array.isArray(v)) {
    if (v.length === 0) out.push({ path: p, value: [], key: p });
    v.forEach((x, i) => leaves(x, `${p}[${i}]`, out));
  } else if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) out.push({ path: p, value: {}, key: p });
    for (const k of keys) leaves(v[k], p === "" ? k : `${p}.${k}`, out);
  } else out.push({ path: p, value: v, key: p.split(/[.[]/).pop() ?? p });
}

function useOf(ref: unknown): string {
  if (typeof ref === "string") return ref;
  if (isPlainObject(ref)) return String(ref.use ?? "");
  return JSON.stringify(ref) ?? "";
}

/**
 * 確認の画面に出す要約。基盤の項目は何も省かずに出す（多すぎる項目は数を出して省くが、URL・パス・環境変数を含む値は必ず出す）。
 * 展開した値は入れない。
 */
export function summarizeInfra(json: Record<string, unknown>, envNames: string[]): SummaryRow[] {
  const out: SummaryRow[] = [];
  /** 1 つの項目（実装の選択など）の行。 */
  const entry = (label: string, ref: unknown, skip: string[] = ["use"], id?: string): void => {
    out.push({ label: escapeControls(label), value: escapeControls(cap(id !== undefined ? `${id} → ${useOf(ref)}` : useOf(ref))) });
    if (!isPlainObject(ref)) return;
    const all: { path: string; value: unknown; key: string }[] = [];
    for (const [k, v] of Object.entries(ref)) if (!skip.includes(k)) leaves(v, k, all);
    const rows = all.map((l) => ({ main: leafRow(`${label} の ${l.path}`, l.value, l.key), extra: pgParamRows(`${label} の ${l.path}`, l.value) }));
    const head = rows.slice(0, MAX_LEAVES);
    const rest = rows.slice(MAX_LEAVES);
    for (const r of head) out.push(stripImportant(r.main), ...r.extra);
    if (rest.length > 0) {
      out.push({ label: escapeControls(label), value: `ほかに ${rest.length} 項目あります。設定ファイルを開いて確かめてください` });
      for (const r of rest) if (r.main.important || r.extra.length > 0) out.push(stripImportant(r.main), ...r.extra);
    }
  };
  const storage = json.storage;
  if (storage !== undefined) entry("共有 DB", isPlainObject(storage) ? { use: String(storage.driver ?? "sqlite"), ...storage } : storage, ["use", "driver"]);
  for (const name of envNames) out.push({ label: "環境変数", value: escapeControls(name) });
  if (Array.isArray(json.pluginDirs)) json.pluginDirs.forEach((d, i) => out.push(stripImportant(leafRow(`プラグインのフォルダ[${i}]`, d, "pluginDirs"))));
  else if (json.pluginDirs !== undefined) out.push(stripImportant(leafRow("プラグインのフォルダ", json.pluginDirs, "pluginDirs")));
  if (json.tree !== undefined) entry("ツリー", json.tree);
  if (Array.isArray(json.formats)) json.formats.forEach((f, i) => entry(`フォーマット[${i}]`, f));
  if (Array.isArray(json.syntaxes)) json.syntaxes.forEach((x, i) => out.push(stripImportant(leafRow(`記法[${i}]`, x, "syntaxes"))));
  for (const [section, label] of [["sources", "列ソース"], ["generators", "生成器"]] as const) {
    const entries = json[section];
    if (isPlainObject(entries)) for (const [name, ref] of Object.entries(entries)) entry(`${label} ${name}`, ref, ["use"], name);
  }
  if (Array.isArray(json.actions)) json.actions.forEach((a, i) => entry(`アクション[${i}]`, a));
  if (Array.isArray(json.hooks)) json.hooks.forEach((h, i) => entry(`フック[${i}]`, h));
  const review = json.review;
  if (isPlainObject(review)) {
    if (Array.isArray(review.targets)) review.targets.forEach((t, i) => entry(`レビュー先[${i}]`, t));
    for (const [k, v] of Object.entries(review)) {
      if (k === "targets") continue;
      const all: { path: string; value: unknown; key: string }[] = [];
      leaves(v, k, all);
      for (const l of all) out.push(stripImportant(leafRow(`review.${l.path}`, l.value, l.key)));
    }
  }
  // 形の違う値（配列のはずがオブジェクトなど）も、何も省かずに出す。
  for (const k of ["formats", "syntaxes", "actions", "hooks", "sources", "generators"] as const) {
    const v = json[k];
    const expectArray = k === "formats" || k === "syntaxes" || k === "actions" || k === "hooks";
    if (v !== undefined && (expectArray ? !Array.isArray(v) : !isPlainObject(v))) out.push(stripImportant(leafRow(k, v, k)));
  }
  const runsCode =
    json.tree !== undefined ||
    isPlainObject(json.generators) ||
    Array.isArray(json.actions) ||
    Array.isArray(json.hooks) ||
    isPlainObject(json.sources) ||
    (isPlainObject(review) && Array.isArray(review.targets));
  if (runsCode) {
    out.push({
      label: "秘密情報",
      value: "これらの実装は、この PC のローカル設定の秘密情報（接続キーなど）を読んで、上の接続先へ送ることがあります",
    });
  }
  return out;
}

function stripImportant(r: SummaryRow & { important?: boolean }): SummaryRow {
  const { important: _i, ...row } = r;
  return row;
}

/**
 * 設定ファイルの信頼の対象。基盤の項目がなく ${env:} も参照していなければ undefined（確認は要らない）。
 * @param text 設定ファイルの中身（${env:} の参照を探す）
 */
export function settingsCandidate(file: string, json: Record<string, unknown>, text: string): PluginCandidate | undefined {
  const infra: Record<string, unknown> = {};
  for (const k of INFRA_CONFIG_KEYS) if (json[k] !== undefined) infra[k] = json[k];
  const env = envReferences(text);
  if (Object.keys(infra).length === 0 && env.length === 0) return undefined;
  const hash = createHash("sha256").update(stableStringify({ format: "loc-studio/settings-trust/1", infra, env }), "utf8").digest("hex");
  return { kind: "settings", path: file, layer: "project", hash, files: [file], summary: summarizeInfra(json, env) };
}
