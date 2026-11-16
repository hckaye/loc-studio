/**
 * 新しいプロジェクトの作成（ローカルモードの画面とコマンドラインが使う）。
 * まだプロジェクトがないフォルダを確かめ（inspectProjectFolder）、設定ファイルを書く（createProject）。
 *
 * 作る設定は、同梱の実装（CSV / TSV、フォルダのツリー、同梱の列と検証）を選ぶだけの雛形で、
 * 作ったあとは設定の画面や設定ファイルで自由に変えられる。雛形に入れるものは、利用者が画面で選んだ言語と列だけにする。
 * 既にある設定ファイルは書き換えない。
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { listGlobTree, readDelimitedHeader, readGlobTreeFile } from "@loc-studio/builtin";
import { PROJECT_CONFIG_CODE, PROJECT_CONFIG_JSON, settingsCandidate, validateProjectConfig } from "@loc-studio/core";
import type { TreeNode } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import { errorText } from "./context.js";
import { writeTrustFile } from "./trust.js";

/** 見出しを読んで返すファイルの数（それより多いフォルダは、数だけを返す）。 */
export const MAX_INSPECTED_RESOURCES = 30;
/** 作れる言語の数。 */
const MAX_LANGUAGES = 100;
const MAX_NAME_LENGTH = 200;

/** 既存のファイルを読むときに選べる文字コード（同梱の CSV / TSV の encoding と同じ値）。 */
export const NEW_PROJECT_ENCODINGS = ["auto", "utf-8", "utf-16le", "utf-16be", "shift_jis"] as const;
export type NewProjectEncoding = (typeof NEW_PROJECT_ENCODINGS)[number];

/** 言語 ID に使える文字。セルの ID（列@言語）や条件式でそのまま書けるものに限る。 */
const LANGUAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** 条件式で「どれかの言語」「すべての言語」を表す語（言語 ID にすると書き分けられない）。 */
const RESERVED_LANGUAGE_IDS = new Set(["any", "all"]);

export interface FolderResource {
  /** フォルダからの相対パス（区切りは "/"）。 */
  path: string;
  /** 見出しの行の値。読めなかったときは error。 */
  headers?: string[];
  error?: string;
}

export interface FolderInspection {
  /** 確かめたフォルダの絶対パス。 */
  root: string;
  /** フォルダがあるか（なければ、作成のときに作る）。 */
  exists: boolean;
  /** すでにある設定ファイルの名前（あれば、新しくは作れない。既存のプロジェクトとして開く）。 */
  configFile?: string;
  /** フォルダにある CSV / TSV（先頭の MAX_INSPECTED_RESOURCES 個）と、その見出し。 */
  resources: FolderResource[];
  /** フォルダにある CSV / TSV の数。 */
  totalResources: number;
}

export interface NewProjectLanguage {
  id: string;
  /** 表示名。省略時や空のときは ID。 */
  label?: string;
  /** 翻訳のもとにする言語の ID。 */
  basedOn?: string;
  /** 表の固定側に置く。 */
  pinned?: boolean;
}

export interface NewProjectMapping {
  /** キーの列の見出し。省略時は先頭の列。 */
  key?: string;
  /** 言語 ID → 本文の列の見出し。書かなかった言語は、言語 ID と同じ見出しの列を使う。 */
  text?: Record<string, string>;
  /** 文字コード。省略時は "auto"。 */
  encoding?: string;
}

export interface NewProjectInput {
  /** プロジェクトのフォルダ（絶対パス）。なければ作る。 */
  root: string;
  name: string;
  languages: NewProjectLanguage[];
  /** 進捗の列（同梱の builtin.textStatus）を付ける。既定は付ける。 */
  statusColumn?: boolean;
  /** レビューの列（同梱の builtin.reviewStatus）を付ける。既定は付ける。 */
  reviewColumn?: boolean;
  /** 同梱の空白の検証（builtin.whitespace）を付ける。既定は付ける。 */
  whitespaceValidator?: boolean;
  /** 同梱の未翻訳の検証（builtin.untranslated）を付ける。既定は付ける。 */
  untranslatedValidator?: boolean;
  /** すでにある CSV / TSV の列の対応。 */
  mapping?: NewProjectMapping;
  /** 最初に作るリソースの場所（確かめるだけ。作るのは呼び出し側が createResource で行う）。 */
  firstResource?: string;
}

export interface NewProjectResult {
  root: string;
  /** 書いた設定ファイルの絶対パス。 */
  configFile: string;
  config: Record<string, unknown>;
  /** 最初に作るリソースの場所（指定があったとき）。 */
  firstResource?: string;
  /** 設定ファイルの基盤の項目（formats）を、確認済みとして記録したか。 */
  trusted: boolean;
}

export interface CreateProjectOptions {
  /**
   * ローカル設定のファイル。渡すと、いま書いた設定ファイルの基盤の項目を確認済みとして記録する
   * （利用者がこの場で選んだ内容なので、開いた直後にもう一度確認を出さない）。
   */
  localSettingsFile?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function requireRoot(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ApiError("invalid", "プロジェクトのフォルダを指定してください。");
  const given = value.trim();
  if (!path.isAbsolute(given)) throw new ApiError("invalid", `プロジェクトのフォルダは、絶対パスで指定してください: ${given}`);
  return path.resolve(given);
}

/** フォルダの状態。ファイルなど、フォルダでないものがあれば invalid。 */
async function folderExists(root: string): Promise<boolean> {
  let info;
  try {
    info = await stat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ApiError("failed", `フォルダ ${root} を確かめられませんでした: ${errorText(err)}`);
  }
  if (!info.isDirectory()) throw new ApiError("invalid", `${root} はフォルダではありません。プロジェクトを置くフォルダを指定してください。`);
  return true;
}

async function existingConfig(root: string): Promise<string | undefined> {
  for (const name of [PROJECT_CONFIG_JSON, ...PROJECT_CONFIG_CODE]) {
    try {
      await stat(path.join(root, name));
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ApiError("failed", `${path.join(root, name)} を確かめられませんでした: ${errorText(err)}`);
    }
  }
  return undefined;
}

function flatten(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "resource") out.push(n.resource?.path ?? n.id);
    else flatten(n.children ?? [], out);
  }
  return out;
}

function requireEncoding(value: unknown): NewProjectEncoding {
  if (value === undefined) return "auto";
  if (typeof value !== "string" || !(NEW_PROJECT_ENCODINGS as readonly string[]).includes(value)) {
    throw new ApiError("invalid", `文字コードは ${NEW_PROJECT_ENCODINGS.join(" / ")} のどれかで指定してください: ${String(value)}`);
  }
  return value as NewProjectEncoding;
}

/**
 * プロジェクトを作る前に、フォルダを確かめる。フォルダがなくても失敗にしない（exists: false）。
 * すでにある CSV / TSV は、同梱のツリーと同じ決まりで探し、見出しの行を読む。
 */
export async function inspectProjectFolder(input: { root: string; encoding?: string }): Promise<FolderInspection> {
  const root = requireRoot(input?.root);
  const encoding = requireEncoding(input?.encoding);
  if (!(await folderExists(root))) return { root, exists: false, resources: [], totalResources: 0 };
  const result: FolderInspection = { root, exists: true, resources: [], totalResources: 0 };
  const configFile = await existingConfig(root);
  if (configFile !== undefined) result.configFile = configFile;
  let paths: string[];
  try {
    paths = flatten(await listGlobTree(root));
  } catch (err) {
    throw new ApiError("failed", `フォルダ ${root} の中を確かめられませんでした: ${errorText(err)}`);
  }
  result.totalResources = paths.length;
  for (const resourcePath of paths.slice(0, MAX_INSPECTED_RESOURCES)) {
    const item: FolderResource = { path: resourcePath };
    try {
      const delimiter = resourcePath.toLowerCase().endsWith(".tsv") ? "\t" : ",";
      item.headers = readDelimitedHeader(await readGlobTreeFile(root, resourcePath), delimiter, resourcePath, encoding);
    } catch (err) {
      item.error = errorText(err);
    }
    result.resources.push(item);
  }
  return result;
}

function requireLanguages(value: unknown): NewProjectLanguage[] {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError("invalid", "言語を 1 つ以上指定してください。");
  if (value.length > MAX_LANGUAGES) throw new ApiError("invalid", `言語は ${MAX_LANGUAGES} 個までにしてください。`);
  const seen = new Set<string>();
  const out: NewProjectLanguage[] = [];
  value.forEach((raw: unknown, i) => {
    if (!isRecord(raw)) throw new ApiError("invalid", `languages[${i}] はオブジェクトにしてください。`);
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (id === "") throw new ApiError("invalid", `${i + 1} 番目の言語の ID が空です。`);
    if (!LANGUAGE_ID.test(id)) {
      throw new ApiError("invalid", `言語の ID "${id}" は使えません。半角の英数字で始め、英数字と - _ だけの 40 文字までにしてください（例: ja、en、zh-Hans）。`);
    }
    if (RESERVED_LANGUAGE_IDS.has(id.toLowerCase())) throw new ApiError("invalid", `言語の ID "${id}" は使えません（条件式で「どれかの言語」「すべての言語」を表す語です）。`);
    if (seen.has(id)) throw new ApiError("invalid", `言語の ID "${id}" が重複しています。`);
    seen.add(id);
    if (raw.label !== undefined && typeof raw.label !== "string") throw new ApiError("invalid", `言語 "${id}" の表示名は文字列で指定してください。`);
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (label.length > MAX_NAME_LENGTH) throw new ApiError("invalid", `言語 "${id}" の表示名は ${MAX_NAME_LENGTH} 文字までにしてください。`);
    const language: NewProjectLanguage = { id, label: label === "" ? id : label };
    if (raw.basedOn !== undefined && raw.basedOn !== "") {
      if (typeof raw.basedOn !== "string") throw new ApiError("invalid", `言語 "${id}" の翻訳元は、言語の ID で指定してください。`);
      language.basedOn = raw.basedOn.trim();
    }
    if (raw.pinned === true) language.pinned = true;
    out.push(language);
  });
  for (const l of out) {
    if (l.basedOn === undefined) continue;
    if (l.basedOn === l.id) throw new ApiError("invalid", `言語 "${l.id}" の翻訳元に、その言語自身は指定できません。`);
    if (!seen.has(l.basedOn)) throw new ApiError("invalid", `言語 "${l.id}" の翻訳元 "${l.basedOn}" という言語はありません。`);
  }
  return out;
}

/** 列の対応を、フォーマットのオプションにする。対応が要らなければ undefined（設定に formats を書かない）。 */
function formatOptions(mapping: unknown, languages: NewProjectLanguage[]): Record<string, unknown> | undefined {
  if (mapping === undefined) return undefined;
  if (!isRecord(mapping)) throw new ApiError("invalid", "mapping（列の対応）はオブジェクトで指定してください。");
  const options: Record<string, unknown> = {};
  const used = new Map<string, string>();
  const use = (header: string, what: string): void => {
    const other = used.get(header);
    if (other !== undefined) throw new ApiError("invalid", `列「${header}」を、${other}と${what}の両方に使っています。別の列を選んでください。`);
    used.set(header, what);
  };
  if (mapping.key !== undefined && mapping.key !== "") {
    if (typeof mapping.key !== "string") throw new ApiError("invalid", "キーの列は、見出しの文字列で指定してください。");
    options.key = mapping.key;
    use(mapping.key, "キー");
  }
  if (mapping.text !== undefined) {
    if (!isRecord(mapping.text)) throw new ApiError("invalid", "mapping.text は「言語 ID: 見出し」のオブジェクトで指定してください。");
    const ids = new Set(languages.map((l) => l.id));
    const text: Record<string, string> = {};
    for (const [id, header] of Object.entries(mapping.text)) {
      if (!ids.has(id)) throw new ApiError("invalid", `列の対応にある "${id}" という言語はありません。`);
      if (typeof header !== "string") throw new ApiError("invalid", `言語 "${id}" の本文の列は、見出しの文字列で指定してください。`);
      if (header === "") continue;
      use(header, `言語 "${id}" の本文`);
      // 言語 ID と同じ見出しは、書かなくても同じ動きになる。
      if (header !== id) text[id] = header;
    }
    if (Object.keys(text).length > 0) options.text = text;
  }
  const encoding = requireEncoding(mapping.encoding);
  if (encoding !== "auto") options.encoding = encoding;
  return Object.keys(options).length > 0 ? options : undefined;
}

function requireFirstResource(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new ApiError("invalid", "最初のファイルの場所は、文字列で指定してください。");
  const p = value.trim();
  if (/^[\\/]|^[A-Za-z]:|\\/.test(p) || p.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new ApiError("invalid", `最初のファイルの場所は、プロジェクトのフォルダからの相対的な書き方（区切りは "/"）で指定してください: ${p}`);
  }
  if (!/\.(csv|tsv)$/i.test(p)) throw new ApiError("invalid", `最初のファイルの名前は、.csv か .tsv で終わるようにしてください: ${p}`);
  return p;
}

/** 雛形の設定を組み立てる（ファイルには書かない）。 */
export function buildProjectConfig(input: NewProjectInput): Record<string, unknown> {
  if (typeof input?.name !== "string" || input.name.trim() === "") throw new ApiError("invalid", "プロジェクトの名前を入力してください。");
  const name = input.name.trim();
  if (name.length > MAX_NAME_LENGTH) throw new ApiError("invalid", `プロジェクトの名前は ${MAX_NAME_LENGTH} 文字までにしてください。`);
  const languages = requireLanguages(input.languages);
  const config: Record<string, unknown> = {
    name,
    languages: languages.map((l) => ({ id: l.id, label: l.label, ...(l.basedOn !== undefined ? { basedOn: l.basedOn } : {}), ...(l.pinned ? { pinned: true } : {}) })),
  };
  const options = formatOptions(input.mapping, languages);
  if (options) {
    config.formats = [
      { use: "builtin.csv", match: "**/*.csv", options },
      { use: "builtin.tsv", match: "**/*.tsv", options },
    ];
  }
  const status = input.statusColumn !== false;
  const review = input.reviewColumn !== false;
  if (status || review) {
    config.columns = [
      { use: "builtin.key", id: "key" },
      { use: "builtin.text", id: "text" },
      ...(status ? [{ use: "builtin.textStatus", id: "textStatus" }] : []),
      ...(review ? [{ use: "builtin.reviewStatus", id: "reviewStatus", of: "text" }] : []),
    ];
  }
  const whitespace = input.whitespaceValidator !== false;
  const untranslated = input.untranslatedValidator !== false;
  if (whitespace || untranslated) {
    config.validators = [...(whitespace ? ["builtin.whitespace"] : []), ...(untranslated ? ["builtin.untranslated"] : [])];
  }
  const problems = validateProjectConfig(config);
  if (problems.length > 0) throw new ApiError("invalid", `この内容ではプロジェクトを作れません: ${problems.join(" / ")}`);
  return config;
}

/**
 * プロジェクトを作る: フォルダがなければ作り、設定ファイル（loc-studio.project.json）を書く。
 * すでに設定ファイルのあるフォルダには作らない（conflict）。失敗したときは、設定ファイルを残さない。
 */
export async function createProject(input: NewProjectInput, opts: CreateProjectOptions = {}): Promise<NewProjectResult> {
  const root = requireRoot(input?.root);
  const config = buildProjectConfig(input);
  const firstResource = requireFirstResource(input.firstResource);
  const exists = await folderExists(root);
  if (exists) {
    const found = await existingConfig(root);
    if (found !== undefined) {
      throw new ApiError("conflict", `${root} には、すでにプロジェクトの設定ファイル（${found}）があります。新しく作らずに、既存のプロジェクトとして開いてください。`);
    }
  } else {
    try {
      await mkdir(root, { recursive: true });
    } catch (err) {
      throw new ApiError("failed", `フォルダ ${root} を作れませんでした: ${errorText(err)}`);
    }
  }
  const configFile = path.join(root, PROJECT_CONFIG_JSON);
  const text = JSON.stringify(config, null, 2) + "\n";
  try {
    // "wx": 確かめたあとで誰かが作っていたら、上書きせずに失敗する。
    await writeFile(configFile, text, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ApiError("conflict", `${root} には、すでにプロジェクトの設定ファイル（${PROJECT_CONFIG_JSON}）があります。新しく作らずに、既存のプロジェクトとして開いてください。`);
    }
    throw new ApiError("failed", `設定ファイル ${configFile} を書けませんでした: ${errorText(err)}`);
  }
  let trusted = false;
  if (opts.localSettingsFile !== undefined) {
    // 基盤の項目（formats）があれば、開くときに確認が出る。いま利用者が選んだ内容そのものなので、そのハッシュを確認済みにする。
    const candidate = settingsCandidate(configFile, config, text);
    if (candidate) {
      await writeTrustFile(opts.localSettingsFile, root, (forRoot) => {
        forRoot[candidate.path] = candidate.hash;
      });
      trusted = true;
    }
  }
  const result: NewProjectResult = { root, configFile, config, trusted };
  if (firstResource !== undefined) result.firstResource = firstResource;
  return result;
}
