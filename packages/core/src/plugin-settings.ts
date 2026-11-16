/**
 * プラグインの設定。プラグインが `settings` で項目を宣言すると、値をプロジェクトのフォルダの
 * `loc-studio-plugin-settings/<プラグインの名前>.json` に置ける（1 つのプラグインに 1 つのファイル）。
 *
 * - ファイルはプラグインのフォルダの外に置く。フォルダ形式のプラグインは、フォルダの中のファイルすべてが信頼の確認の
 *   ハッシュに入るので、中に置くと、値を変えるたびにプラグインの確認をやり直すことになる。
 * - 値の形は、宣言した種類で確かめる。合わない値は使わず、既定の値に倒して警告にする（誤った値でプラグインを動かさない）。
 * - 値は、プロジェクトを開く（読み直す）ときにまとめて読む。プラグインは `setup.settings.get(key)` で、読んである値を受け取る。
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin, PluginSettingDef, PluginSettingsReader } from "@loc-studio/sdk";
import type { LoadedPlugin, PluginLayer } from "./types.js";

/** プラグインの設定ファイルを置くフォルダ（プロジェクトのフォルダからの相対）。 */
export const PLUGIN_SETTINGS_DIR = "loc-studio-plugin-settings";

export type PluginSettingValue = string | number | boolean;

const SETTING_TYPES = ["string", "number", "boolean", "enum"] as const;

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * プラグインの名前から作る、設定ファイルの名前。英数字と . _ - 以外は %XX にする
 * （名前に / や : があっても、フォルダの外や別のファイルを指さない。大文字小文字だけが違う名前は、別のファイルにならない OS がある）。
 */
export function pluginSettingsFileName(pluginName: string): string {
  const safe = Array.from(new TextEncoder().encode(pluginName), (b) => {
    const ch = String.fromCharCode(b);
    return /[A-Za-z0-9._-]/.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
  // "." や ".." だけの名前、先頭が "." の名前（隠しファイル）にしない。
  return `${safe.startsWith(".") ? `%2E${safe.slice(1)}` : safe}.json`;
}

export function pluginSettingsFile(projectRoot: string, pluginName: string): string {
  return path.join(path.resolve(projectRoot), PLUGIN_SETTINGS_DIR, pluginSettingsFileName(pluginName));
}

/** 設定の宣言（Plugin.settings）の形を確かめ、問題の一覧を返す。 */
export function validateSettingDefs(defs: unknown): string[] {
  if (defs === undefined) return [];
  if (!Array.isArray(defs)) return ["settings は配列にしてください。"];
  const problems: string[] = [];
  const seen = new Set<string>();
  defs.forEach((raw: unknown, i) => {
    const where = `settings[${i}]`;
    if (!isPlainObject(raw)) {
      problems.push(`${where} はオブジェクトにしてください。`);
      return;
    }
    const key = raw.key;
    if (typeof key !== "string" || key === "") {
      problems.push(`${where} の key は空でない文字列にしてください。`);
      return;
    }
    const label = `${where}（"${key}"）`;
    if (seen.has(key)) problems.push(`${label} の key が重複しています。`);
    seen.add(key);
    if (typeof raw.label !== "string" || raw.label === "") problems.push(`${label} の label は空でない文字列にしてください。`);
    if (raw.description !== undefined && typeof raw.description !== "string") problems.push(`${label} の description は文字列にしてください。`);
    if (typeof raw.type !== "string" || !(SETTING_TYPES as readonly string[]).includes(raw.type)) {
      problems.push(`${label} の type は ${SETTING_TYPES.join(" / ")} のどれかにしてください。`);
      return;
    }
    if (raw.type === "enum") {
      const options = raw.options;
      if (!Array.isArray(options) || options.length === 0) {
        problems.push(`${label} は type が enum なので、options に選択肢を 1 つ以上書いてください。`);
        return;
      }
      const values = new Set<string>();
      for (const o of options as unknown[]) {
        if (!isPlainObject(o) || typeof o.value !== "string" || o.value === "" || (o.label !== undefined && typeof o.label !== "string")) {
          problems.push(`${label} の options は { value: 空でない文字列, label?: 文字列 } の配列にしてください。`);
          return;
        }
        if (values.has(o.value)) problems.push(`${label} の options の値 "${o.value}" が重複しています。`);
        values.add(o.value);
      }
    } else if (raw.options !== undefined) {
      problems.push(`${label} の options は、type が enum のときだけ書けます。`);
    }
    if (raw.default !== undefined) {
      const problem = settingValueProblem(raw as unknown as PluginSettingDef, raw.default);
      if (problem) problems.push(`${label} の default は使えません: ${problem}`);
    }
  });
  return problems;
}

/** 値が、その項目の種類に合わないときの理由。合えば undefined。 */
export function settingValueProblem(def: PluginSettingDef, value: unknown): string | undefined {
  switch (def.type) {
    case "string":
      return typeof value === "string" ? undefined : "文字列ではありません。";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "数値ではありません。";
    case "boolean":
      return typeof value === "boolean" ? undefined : "true か false ではありません。";
    case "enum": {
      const options = def.options ?? [];
      return typeof value === "string" && options.some((o) => o.value === value) ? undefined : `選択肢（${options.map((o) => o.value).join(" / ")}）にありません。`;
    }
    default:
      return "値の種類が分かりません。";
  }
}

/** 1 つのプラグインの設定の状態（宣言、ファイル、いまの値）。 */
export interface PluginSettingsState {
  plugin: string;
  version?: string;
  layer: PluginLayer;
  defs: PluginSettingDef[];
  /** 設定ファイルの絶対パス（まだなくてもよい）。 */
  file: string;
  /** 設定ファイルに書いてある、宣言した項目の値（形の合うものだけ）。 */
  stored: Record<string, PluginSettingValue>;
  /** プラグインが受け取る値（stored、なければ default。どちらもなければキーがない）。 */
  values: Record<string, PluginSettingValue>;
  /** 使わなかった値と、読めなかった理由（利用者に見せる警告）。 */
  problems: string[];
}

/** 設定ファイルの中身（JSON のオブジェクト）から、項目ごとの値を決める。 */
export function resolveSettingValues(
  defs: PluginSettingDef[],
  raw: Record<string, unknown>,
): { stored: Record<string, PluginSettingValue>; values: Record<string, PluginSettingValue>; problems: { key: string; problem: string }[] } {
  const stored: Record<string, PluginSettingValue> = {};
  const values: Record<string, PluginSettingValue> = {};
  const problems: { key: string; problem: string }[] = [];
  for (const def of defs) {
    const value = raw[def.key];
    if (value !== undefined && value !== null) {
      const problem = settingValueProblem(def, value);
      if (problem === undefined) {
        stored[def.key] = value as PluginSettingValue;
        values[def.key] = value as PluginSettingValue;
        continue;
      }
      problems.push({ key: def.key, problem });
    }
    if (def.default !== undefined) values[def.key] = def.default;
  }
  return { stored, values, problems };
}

/** 設定ファイルを読む。なければ空。JSON のオブジェクトでなければ例外。 */
export async function readPluginSettingsFile(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`読めませんでした: ${errorMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON として読めませんでした: ${errorMessage(err)}`);
  }
  if (!isPlainObject(parsed)) throw new Error("JSON のオブジェクト（{ \"キー\": 値 }）ではありません。");
  return parsed;
}

/**
 * 設定を宣言しているプラグインの、設定ファイルを読む。読めないファイルや、形の合わない値は、
 * 既定の値に倒して warnings に理由を入れる。同じ名前のプラグインが 2 つ設定を宣言していたら、先のものだけを使う。
 */
export async function loadPluginSettings(projectRoot: string, plugins: LoadedPlugin[]): Promise<{ states: PluginSettingsState[]; warnings: string[] }> {
  const states: PluginSettingsState[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const { plugin, origin } of plugins) {
    const defs = plugin.settings;
    if (!defs || defs.length === 0) continue;
    if (seen.has(plugin.name)) {
      warnings.push(`プラグイン "${plugin.name}" が 2 つあり、どちらも設定（settings）を宣言しています。設定ファイルは名前で決まるので、あとから読み込んだほうの設定は使いません。プラグインの name を別にしてください。`);
      continue;
    }
    seen.add(plugin.name);
    const file = pluginSettingsFile(projectRoot, plugin.name);
    const state: PluginSettingsState = { plugin: plugin.name, layer: origin.layer, defs, file, stored: {}, values: {}, problems: [] };
    if (plugin.version !== undefined) state.version = plugin.version;
    let raw: Record<string, unknown> = {};
    try {
      raw = await readPluginSettingsFile(file);
    } catch (err) {
      state.problems.push(`プラグイン "${plugin.name}" の設定ファイル ${file} は${errorMessage(err)} 既定の値で動かします。ファイルを直すか、設定の画面の「プラグインの設定」で保存し直してください。`);
    }
    const resolved = resolveSettingValues(defs, raw);
    state.stored = resolved.stored;
    state.values = resolved.values;
    for (const p of resolved.problems) {
      const def = defs.find((d) => d.key === p.key)!;
      state.problems.push(
        `プラグイン "${plugin.name}" の設定「${def.label}」（${file} の "${p.key}"）は${p.problem} ${def.default !== undefined ? `既定の値（${JSON.stringify(def.default)}）` : "値なし"}で動かします。設定の画面の「プラグインの設定」で直せます。`,
      );
    }
    warnings.push(...state.problems);
    states.push(state);
  }
  return { states, warnings };
}

/**
 * 入口の関数に渡す、設定の値を読む窓口。
 * @param plugins この入口が返したプラグイン（読み込みが終わるまでは undefined）
 * @param valuesOf プラグインの名前から、いまの値を引く（まだ読んでいなければ undefined）
 */
export function createSettingsReader(plugins: () => Plugin[] | undefined, valuesOf: (pluginName: string) => Record<string, PluginSettingValue> | undefined): PluginSettingsReader {
  const NOT_READY = "プラグインの設定（settings.get）は、プラグインの読み込みが終わってから使えます。入口の関数の中ではなく、validate や run など、拡張ポイントの関数の中で呼んでください。";
  return {
    get(key) {
      const list = plugins();
      if (!list) throw new Error(NOT_READY);
      const owner = list.find((p) => p.settings?.some((d) => d.key === key));
      if (!owner) throw new Error(`設定 "${key}" は、プラグインの settings に宣言されていません（宣言したキー: ${list.flatMap((p) => p.settings?.map((d) => d.key) ?? []).join(", ") || "なし"}）。`);
      const values = valuesOf(owner.name);
      if (!values) throw new Error(NOT_READY);
      return values[key];
    },
  };
}

/** プロジェクトにある、プラグインの設定ファイルの中身（ファイル名 → 中身）。信頼の確認のハッシュと要約に使う。 */
export async function readPluginSettingsTexts(projectRoot: string): Promise<Record<string, string>> {
  const dir = path.join(path.resolve(projectRoot), PLUGIN_SETTINGS_DIR);
  let names: string[];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") return {};
    throw new Error(`プラグインの設定のフォルダ ${dir} を読めませんでした: ${errorMessage(err)}`);
  }
  const out: Record<string, string> = {};
  for (const name of names.sort()) out[name] = await readFile(path.join(dir, name), "utf8");
  return out;
}
