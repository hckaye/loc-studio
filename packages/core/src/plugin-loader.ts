import { existsSync, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { PLUGIN_API_VERSION } from "@loc-studio/sdk";
import type { Plugin, PluginSetupContext, ProjectConfig } from "@loc-studio/sdk";
import { EXTENSION_FIELDS, EXTENSION_KINDS } from "./registry.js";
import { inspectPluginCode } from "./code-graph.js";
import { createSettingsReader, validateSettingDefs } from "./plugin-settings.js";
import type { PluginSettingValue } from "./plugin-settings.js";
import type { ExtensionKind, LoadedPlugin, PluginDirSpec, PluginLayer, PluginLoadError } from "./types.js";

/** 読み込む前に信頼を確かめるプラグイン（1 ファイル、またはフォルダ）。 */
export interface PluginCandidate {
  /**
   * "plugin": プラグイン（1 ファイル、またはフォルダ）。"config": プロジェクトのコードの設定（loc-studio.config.ts など）。
   * "settings": プロジェクトの設定ファイル（loc-studio.project.json）の基盤の項目と ${env:} の参照。
   */
  kind: "plugin" | "config" | "settings";
  /** 1 ファイルのプラグインとコードの設定はそのファイル、フォルダのプラグインはフォルダの絶対パス。 */
  path: string;
  /** コードの設定は "project"。 */
  layer: PluginLayer;
  /** 実行されうるコードのハッシュ（inspectPluginCode / inspectConfigCode）。中身が変われば変わる。 */
  hash: string;
  /** ハッシュに入れたファイル（読み込むと実行されうるもの）。確認の画面に出す。 */
  files: string[];
  /** "settings" のとき: 確認の画面に出す要約（展開前の値。パスワードは伏せる）。 */
  summary?: { label: string; value: string; host?: string; note?: string }[];
}

/** 信頼を確かめずに読み込む層（同梱と、管理者がアプリの隣に置いたもの）。 */
export const ALWAYS_TRUSTED_LAYERS: readonly PluginLayer[] = ["builtin", "app"];

/** プラグインのフォルダに置く plugin.json の中身。 */
export interface PluginManifest {
  name?: string;
  version?: string;
  main?: string;
  apiVersion?: number;
  enabled?: boolean;
}

export interface PluginEntry {
  /** 読み込むファイルの絶対パス。error があるときはフォルダの絶対パス。 */
  entry: string;
  /** 1 ファイルのプラグインではそのファイル、フォルダのプラグインではフォルダの絶対パス。 */
  root: string;
  manifest?: PluginManifest;
  /** plugin.json が壊れている、入口のファイルがないなど、読み込めない理由。 */
  error?: string;
}

export interface LoaderOptions {
  /** プラグインの "@loc-studio/sdk" をこのファイルに向ける。省略時はこのアプリ自身の SDK を探す。 */
  sdkPath?: string;
}

/** プラグインを構成するファイル（ハッシュの対象。inspectPluginCode の files）。 */
export async function pluginFiles(root: string): Promise<string[]> {
  return (await inspectPluginCode(root, await entryOf(root))).files;
}

/** プラグインの中身のハッシュ（inspectPluginCode の hash）。 */
export async function pluginContentHash(root: string): Promise<string> {
  return (await inspectPluginCode(root, await entryOf(root))).hash;
}

/** フォルダのプラグインの入口（ハッシュの計算で import をたどる起点）。 */
async function entryOf(root: string): Promise<string | undefined> {
  if ((await stat(root)).isFile()) return root;
  const found = await discoverFolderPlugin(root);
  return found && !found.error ? found.entry : undefined;
}

export interface LoadPluginDirsOptions extends LoaderOptions {
  /**
   * project / local 層のプラグインを読み込んでよいか。false なら読み込まない（コードを import しない）。
   * 省略時はすべて読み込む。builtin / app 層には呼ばない。
   */
  trust?: (candidate: PluginCandidate) => boolean;
  /**
   * プラグインの名前から、設定のいまの値を引く（入口の関数に渡す setup.settings が使う）。
   * プラグインを読み込んでいる間はまだ値がないので、undefined を返してよい（そのあいだの get は例外になる）。
   */
  settingsValues?: (pluginName: string) => Record<string, PluginSettingValue> | undefined;
}

const PLUGIN_FILE_EXTS = [".ts", ".mts", ".js", ".mjs", ".cjs"];
const INDEX_FILES = PLUGIN_FILE_EXTS.map((ext) => `index${ext}`);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isIgnoredName = (name: string): boolean => name.startsWith("_") || name.startsWith(".");

const isPluginFileName = (name: string): boolean => {
  if (isIgnoredName(name)) return false;
  if (/\.d\.[mc]?ts$/.test(name)) return false;
  if (/\.test\./.test(name)) return false;
  return PLUGIN_FILE_EXTS.includes(path.extname(name));
};

// 環境によらず同じ順にするため、ロケールに依存しない比較を使う。
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * フォルダの直下にあるプラグインを探す（下の階層は見ない）。
 * フォルダがなければ空の配列を返す。
 */
export async function discoverPluginEntries(dir: string): Promise<PluginEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`プラグインのフォルダ ${dir} を読めませんでした: ${errorMessage(err)}`);
  }
  names.sort(byName);

  const result: PluginEntry[] = [];
  for (const name of names) {
    if (isIgnoredName(name) || name === "node_modules") continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      // 壊れたシンボリックリンクなど。プラグインではないものとして扱う。
      continue;
    }
    if (st.isFile()) {
      if (isPluginFileName(name)) result.push({ entry: full, root: full });
    } else if (st.isDirectory()) {
      const found = await discoverFolderPlugin(full);
      if (found) result.push(found);
    }
  }
  return result;
}

async function discoverFolderPlugin(root: string): Promise<PluginEntry | undefined> {
  const manifestPath = path.join(root, "plugin.json");
  let manifest: PluginManifest | undefined;
  if (existsSync(manifestPath)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("JSON のオブジェクトではありません");
      }
      manifest = parsed as PluginManifest;
    } catch (err) {
      return { entry: root, root, error: `${manifestPath} を読めませんでした: ${errorMessage(err)}` };
    }
    if (manifest.enabled === false) return undefined;
    if (manifest.main !== undefined) {
      if (typeof manifest.main !== "string" || manifest.main === "") {
        return { entry: root, root, manifest, error: `${manifestPath} の main は空でない文字列にしてください。` };
      }
      const entry = path.resolve(root, manifest.main);
      if (!existsSync(entry)) {
        return { entry: root, root, manifest, error: `${manifestPath} の main に書かれたファイル ${entry} がありません。` };
      }
      // main はプラグインのフォルダの中のファイルであること（シンボリックリンクは実体で確かめる）。
      try {
        const realRoot = await realpath(root);
        const realEntry = await realpath(entry);
        const rel = path.relative(realRoot, realEntry);
        if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
          return { entry: root, root, manifest, error: `${manifestPath} の main（${manifest.main}）はプラグインのフォルダの外を指しています。` };
        }
      } catch (err) {
        return { entry: root, root, manifest, error: `${manifestPath} の main を確かめられませんでした: ${errorMessage(err)}` };
      }
      return { entry, root, manifest };
    }
  }
  for (const index of INDEX_FILES) {
    const entry = path.join(root, index);
    if (existsSync(entry)) return manifest ? { entry, root, manifest } : { entry, root };
  }
  if (manifest) {
    return {
      entry: root,
      root,
      manifest,
      error: `${root} に入口のファイル（plugin.json の main、または ${INDEX_FILES.join(" / ")}）がありません。`,
    };
  }
  // plugin.json も index.* もないフォルダは、プラグインではない（データ置き場など）。
  return undefined;
}

// ---------------------------------------------------------------------------
// モジュールの読み込み
// ---------------------------------------------------------------------------

/**
 * このアプリ自身の "@loc-studio/sdk" の入口を探す。
 * プラグインのフォルダは node_modules の外にあるので、そのままでは SDK を解決できないため。
 */
export function resolveSdkPath(): string | undefined {
  const candidates: (() => string)[] = [
    () => fileURLToPath(import.meta.resolve("@loc-studio/sdk")),
    () => createRequire(import.meta.url).resolve("@loc-studio/sdk"),
  ];
  for (const candidate of candidates) {
    try {
      const resolved = candidate();
      if (existsSync(resolved)) return resolved;
    } catch {
      // 次の方法を試す。どれも失敗したら別名なしで読み込み、プラグイン側の import が失敗する。
    }
  }
  return undefined;
}

let cachedSdkPath: string | null | undefined;

function sdkAlias(opts?: LoaderOptions): Record<string, string> {
  if (opts?.sdkPath) return { "@loc-studio/sdk": path.resolve(opts.sdkPath) };
  if (cachedSdkPath === undefined) cachedSdkPath = resolveSdkPath() ?? null;
  return cachedSdkPath ? { "@loc-studio/sdk": cachedSdkPath } : {};
}

/** プラグインや設定のファイルを読み込む関数を作る。毎回キャッシュなしで読むので、編集が反映される。 */
export function createModuleImporter(opts?: LoaderOptions): (file: string) => Promise<{ hasDefault: boolean; value: unknown }> {
  const jiti = createJiti(import.meta.url, {
    alias: sdkAlias(opts),
    moduleCache: false,
    fsCache: false,
  });
  return async (file) => {
    // Windows の "C:\..." が URL のスキームと紛れないよう、file URL で渡す。
    const mod = (await jiti.import(pathToFileURL(path.resolve(file)).href)) as Record<string, unknown> | null;
    if (mod === null || (typeof mod !== "object" && typeof mod !== "function")) {
      return { hasDefault: false, value: mod };
    }
    const hasDefault = Object.keys(mod).includes("default");
    return { hasDefault, value: hasDefault ? mod.default : mod };
  };
}

// ---------------------------------------------------------------------------
// 形の確認
// ---------------------------------------------------------------------------

/** 種類ごとに必須の関数。 */
const REQUIRED_FUNCTIONS: Record<ExtensionKind, string[]> = {
  tree: ["list", "read", "write"],
  format: ["match", "parse", "apply"],
  syntax: ["tokenize"],
  source: ["load", "save"],
  column: [],
  generator: ["cacheParams", "input", "run"],
  action: ["run"],
  // バリデータは validate か validateResource のどちらかがあればよい（下で確かめる）。
  validator: [],
  // フックは before か after のどちらかがあればよい（下で確かめる）。
  hook: [],
  renderer: [],
};

/** 種類ごとに必須の文字列。 */
const REQUIRED_STRINGS: Record<ExtensionKind, string[]> = {
  tree: [],
  format: [],
  syntax: [],
  source: ["saveMode"],
  column: ["kind", "scope"],
  generator: ["version"],
  action: ["label", "target"],
  validator: ["label", "version"],
  hook: [],
  renderer: ["module"],
};

/**
 * 独自描画のモジュールのパスを確かめる。プラグインのフォルダからの相対パスで、外に出ないこと。
 * 問題があれば理由を返す。
 */
export function rendererModuleProblem(module: string): string | undefined {
  if (module === "") return "空です";
  if (path.isAbsolute(module) || path.win32.isAbsolute(module) || /^[a-zA-Z]:/.test(module) || module.startsWith("/") || module.startsWith("\\")) {
    return "絶対パスは使えません（プラグインのフォルダからの相対パスにしてください）";
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(module)) return "URL は使えません（プラグインのフォルダからの相対パスにしてください）";
  let depth = 0;
  for (const part of module.split(/[\\/]+/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      depth--;
      if (depth < 0) return "プラグインのフォルダの外を指しています";
    } else depth++;
  }
  if (depth === 0) return "ファイルを指していません";
  return undefined;
}

/**
 * 登録された独自描画のモジュールのファイル（絶対パス）。1 ファイルのプラグインはそのファイルのフォルダ、
 * フォルダのプラグインはそのフォルダからの相対パスとして解決する。同梱（パスのない）プラグインでは undefined。
 */
export function rendererModuleFile(origin: { path?: string }, module: string): string | undefined {
  if (origin.path === undefined || rendererModuleProblem(module) !== undefined) return undefined;
  let base = origin.path;
  try {
    if (statSync(origin.path).isFile()) base = path.dirname(origin.path);
  } catch {
    return undefined;
  }
  const file = path.resolve(base, ...module.split(/[\\/]+/).filter((p) => p !== "" && p !== "."));
  const rel = path.relative(base, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return file;
}

/** プラグインの形を確かめ、問題の一覧を返す。 */
export function validatePluginShape(plugin: unknown): string[] {
  const problems: string[] = [];
  if (typeof plugin !== "object" || plugin === null || Array.isArray(plugin)) {
    return ["プラグインはオブジェクトにしてください。"];
  }
  const p = plugin as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name === "") problems.push("name は空でない文字列にしてください。");
  if (p.version !== undefined && typeof p.version !== "string") problems.push("version は文字列にしてください。");
  if (p.apiVersion !== undefined && typeof p.apiVersion !== "number") problems.push("apiVersion は数値にしてください。");
  problems.push(...validateSettingDefs(p.settings));
  for (const kind of EXTENSION_KINDS) {
    const field = EXTENSION_FIELDS[kind];
    const list = p[field];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      problems.push(`${field} は配列にしてください。`);
      continue;
    }
    list.forEach((item: unknown, i) => {
      const where = `${field}[${i}]`;
      if (typeof item !== "object" || item === null) {
        problems.push(`${where} はオブジェクトにしてください。`);
        return;
      }
      const obj = item as Record<string, unknown>;
      const label = typeof obj.id === "string" && obj.id !== "" ? `${where}（"${obj.id}"）` : where;
      if (typeof obj.id !== "string" || obj.id === "") problems.push(`${where} の id は空でない文字列にしてください。`);
      for (const fn of REQUIRED_FUNCTIONS[kind]) {
        if (typeof obj[fn] !== "function") problems.push(`${label} に関数 ${fn} がありません。`);
      }
      for (const key of REQUIRED_STRINGS[kind]) {
        if (typeof obj[key] !== "string") problems.push(`${label} の ${key} は文字列にしてください。`);
      }
      if (kind === "validator") {
        for (const fn of ["validate", "validateResource"]) {
          if (obj[fn] !== undefined && typeof obj[fn] !== "function") problems.push(`${label} の ${fn} は関数にしてください。`);
        }
        if (typeof obj.validate !== "function" && typeof obj.validateResource !== "function") {
          problems.push(`${label} に関数 validate か validateResource のどちらかが必要です。`);
        }
      }
      if (kind === "hook") {
        for (const fn of ["before", "after"]) {
          if (obj[fn] !== undefined && typeof obj[fn] !== "function") problems.push(`${label} の ${fn} は関数にしてください。`);
        }
        if (typeof obj.before !== "function" && typeof obj.after !== "function") problems.push(`${label} に関数 before か after のどちらかが必要です。`);
        if (obj.events !== undefined && (!Array.isArray(obj.events) || obj.events.some((e) => typeof e !== "string"))) {
          problems.push(`${label} の events は、できごとの種類の配列にしてください。`);
        }
      }
      if (kind === "renderer" && typeof obj.module === "string") {
        const problem = rendererModuleProblem(obj.module);
        if (problem) problems.push(`${label} の module "${obj.module}" は使えません: ${problem}。`);
      }
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

function fallbackName(entry: PluginEntry): string {
  const base = path.basename(entry.root);
  return entry.root === entry.entry ? base.slice(0, base.length - path.extname(base).length) : base;
}

async function loadEntry(
  entry: PluginEntry,
  importModule: (file: string) => Promise<{ hasDefault: boolean; value: unknown }>,
  settingsValues?: LoadPluginDirsOptions["settingsValues"],
): Promise<Plugin[]> {
  const { hasDefault, value } = await importModule(entry.entry);
  if (!hasDefault) throw new Error("既定のエクスポート（export default）がありません。");
  let exported = value;
  // 入口が関数なら、設定の値を読む窓口を渡して呼ぶ。値は、読み込みが終わったあと（拡張ポイントの関数の中）で読める。
  const loaded: { plugins?: Plugin[] } = {};
  if (typeof exported === "function") {
    const setup: PluginSetupContext = { settings: createSettingsReader(() => loaded.plugins, (name) => settingsValues?.(name)) };
    exported = await (exported as (setup: PluginSetupContext) => unknown)(setup);
  }
  const items: unknown[] = Array.isArray(exported) ? exported : [exported];
  if (items.length === 0) throw new Error("既定のエクスポートが空の配列です。");

  const baseName = entry.manifest?.name ?? fallbackName(entry);
  const plugins: Plugin[] = [];
  const problems: string[] = [];
  items.forEach((item, i) => {
    const where = items.length > 1 ? `[${i}] ` : "";
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      problems.push(`${where}既定のエクスポートがプラグインの形（オブジェクト）ではありません。`);
      return;
    }
    const raw = item as Partial<Plugin>;
    const plugin = {
      ...raw,
      name: raw.name ?? (items.length > 1 ? `${baseName}#${i + 1}` : baseName),
      version: raw.version ?? entry.manifest?.version,
      apiVersion: raw.apiVersion ?? entry.manifest?.apiVersion,
    } as Plugin;
    if (plugin.version === undefined) delete plugin.version;
    if (plugin.apiVersion === undefined) delete plugin.apiVersion;
    const shape = validatePluginShape(plugin);
    if (plugin.apiVersion !== undefined && typeof plugin.apiVersion === "number" && plugin.apiVersion !== PLUGIN_API_VERSION) {
      shape.push(
        `プラグイン API の版 ${plugin.apiVersion} には対応していません（このアプリの版は ${PLUGIN_API_VERSION}）。`,
      );
    }
    if (shape.length > 0) {
      problems.push(...shape.map((s) => `${where}${s}`));
      return;
    }
    plugins.push(plugin);
  });
  // 1 つでも問題があれば、そのファイルのプラグインは読み込まない（中途半端に登録しないため）。
  if (problems.length > 0) throw new Error(problems.join(" "));
  loaded.plugins = plugins;
  return plugins;
}

/**
 * プラグインのフォルダを順に読み込む。壊れたプラグインがあっても止めず、errors に集める。
 * 呼ぶたびにファイルを読み直すので、編集したプラグインは次の呼び出しで反映される。
 */
export async function loadPluginDirs(
  specs: PluginDirSpec[],
  opts?: LoadPluginDirsOptions,
): Promise<{ plugins: LoadedPlugin[]; errors: PluginLoadError[]; untrusted: PluginCandidate[] }> {
  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];
  const untrusted: PluginCandidate[] = [];
  const importModule = createModuleImporter(opts);
  for (const spec of specs) {
    let entries: PluginEntry[];
    try {
      entries = await discoverPluginEntries(spec.dir);
    } catch (err) {
      errors.push({ path: spec.dir, layer: spec.layer, message: errorMessage(err) });
      continue;
    }
    for (const entry of entries) {
      if (entry.error) {
        errors.push({ path: entry.root, layer: spec.layer, message: entry.error });
        continue;
      }
      const checkTrust = opts?.trust !== undefined && !ALWAYS_TRUSTED_LAYERS.includes(spec.layer);
      let candidate: PluginCandidate | undefined;
      if (checkTrust) {
        const inspected = await inspect(entry, spec.layer, errors, opts?.sdkPath);
        if (!inspected) continue;
        candidate = inspected;
        if (!opts.trust!(candidate)) {
          // 信頼されていないプラグインのコードは import しない。
          untrusted.push(candidate);
          continue;
        }
      }
      try {
        const loaded = await loadEntry(entry, importModule, opts?.settingsValues);
        if (candidate) {
          // 確かめてから読み込むまでの間に書き換えられていたら、読み込んだものを捨てて確認を待つ。
          const after = await inspect(entry, spec.layer, errors, opts?.sdkPath);
          if (!after) continue;
          if (after.hash !== candidate.hash) {
            untrusted.push(after);
            errors.push({ path: entry.root, layer: spec.layer, message: `プラグイン ${entry.root} は確認のあとで書き換えられたため、読み込みませんでした。もう一度確認してください。` });
            continue;
          }
        }
        for (const plugin of loaded) {
          plugins.push({ plugin, origin: { layer: spec.layer, path: entry.root } });
        }
      } catch (err) {
        errors.push({
          path: entry.root,
          layer: spec.layer,
          message: `プラグイン ${entry.entry} を読み込めませんでした: ${errorMessage(err)}`,
        });
      }
    }
  }
  return { plugins, errors, untrusted };
}

/** 信頼の確認のためにコードを確かめる。読み込んではいけないものはエラーに入れて undefined。 */
async function inspect(entry: PluginEntry, layer: PluginLayer, errors: PluginLoadError[], sdkPath?: string): Promise<PluginCandidate | undefined> {
  try {
    const r = await inspectPluginCode(entry.root, entry.entry, sdkPath ? { sdkPath } : {});
    if (r.error) {
      errors.push({ path: entry.root, layer, message: `プラグイン ${entry.root} は信頼の確認の条件を満たさないため読み込みません: ${r.error}` });
      return undefined;
    }
    return { kind: "plugin", path: entry.root, layer, hash: r.hash, files: r.files };
  } catch (err) {
    errors.push({ path: entry.root, layer, message: `プラグイン ${entry.root} の中身を確かめられませんでした: ${errorMessage(err)}` });
    return undefined;
  }
}

/** 環境変数でプラグインのフォルダを足すときの名前。 */
export const PLUGIN_DIRS_ENV = "LOC_STUDIO_PLUGIN_DIRS";

/** 既定のプロジェクト内のプラグインのフォルダ。 */
export const DEFAULT_PROJECT_PLUGIN_DIRS = ["loc-studio-plugins"];

/**
 * プラグインを探すフォルダを、登録する順（後ろほど優先）に返す。
 * 配布したアプリの隣 → 環境変数 → プロジェクト → 個人の設定フォルダ。
 */
export function defaultPluginDirs(input: {
  projectRoot: string;
  config: ProjectConfig;
  appDir?: string;
  userDataDir?: string;
  env?: Record<string, string | undefined>;
}): PluginDirSpec[] {
  const specs: PluginDirSpec[] = [];
  if (input.appDir) specs.push({ dir: path.resolve(input.appDir, "plugins"), layer: "app" });
  const fromEnv = input.env?.[PLUGIN_DIRS_ENV];
  if (fromEnv) {
    for (const dir of fromEnv.split(path.delimiter)) {
      if (dir.trim() !== "") specs.push({ dir: path.resolve(dir.trim()), layer: "app" });
    }
  }
  for (const dir of input.config.pluginDirs ?? DEFAULT_PROJECT_PLUGIN_DIRS) {
    specs.push({ dir: path.resolve(input.projectRoot, dir), layer: "project" });
  }
  if (input.userDataDir) specs.push({ dir: path.resolve(input.userDataDir, "plugins"), layer: "local" });
  return specs;
}
