import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectConfig } from "@loc-studio/sdk";
import { createModuleImporter } from "./plugin-loader.js";
import type { LoaderOptions, PluginCandidate } from "./plugin-loader.js";
import { inspectConfigCode } from "./code-graph.js";
import { envReferences, isReservedEnvName, settingsCandidate } from "./settings-trust.js";
import { readPluginSettingsTexts } from "./plugin-settings.js";
import { stableStringify } from "./validation.js";

/** JSON の設定ファイルの名前。設定画面が書き換えるのはこちら。 */
export const PROJECT_CONFIG_JSON = "loc-studio.project.json";

/** コードの設定ファイルの名前（前にあるものを優先）。 */
export const PROJECT_CONFIG_CODE = ["loc-studio.config.ts", "loc-studio.config.mts", "loc-studio.config.js", "loc-studio.config.mjs"];

export interface LoadedProjectConfig {
  config: ProjectConfig;
  files: { json?: string; code?: string };
  /** コードの設定から来た最上位のキー。設定画面では読み取り専用にする。 */
  fromCode: string[];
  /** 信頼されていないため読み込まなかったコードの設定（trustConfig を渡したときだけ）。 */
  untrustedCode?: PluginCandidate;
  /** コードの設定を読み込まなかった理由（信頼の確認の条件を満たさないなど）。 */
  codeError?: string;
}

export interface LoadProjectConfigOptions extends LoaderOptions {
  /**
   * コードの設定（loc-studio.config.ts など）を読み込んでよいか。false なら import せず、JSON の設定だけを使う。
   * 省略時は確かめずに読み込む（コマンドライン）。
   */
  trustConfig?: (candidate: PluginCandidate) => boolean;
}

/**
 * コードの設定を信頼していないため、JSON の設定だけでは開けない。
 * 画面は candidate を利用者に見せて信頼を確かめてから開き直す。
 */
export class UntrustedConfigError extends Error {
  /** 確認を待っているもの（設定ファイル "settings" とコードの設定 "config"）。 */
  readonly candidates: PluginCandidate[];
  readonly problems: string[];
  constructor(message: string, candidates: PluginCandidate[], problems: string[]) {
    super(message);
    this.name = "UntrustedConfigError";
    this.candidates = candidates;
    this.problems = problems;
  }
  /** 最初の候補（互換のため）。 */
  get candidate(): PluginCandidate | undefined {
    return this.candidates[0];
  }
}

/** 予約された環境変数を ${env:} で参照していたら、設定の誤りとして名前を出す。 */
function checkReservedEnv(text: string, where: string): void {
  const bad = envReferences(text).filter(isReservedEnvName);
  if (bad.length > 0) {
    throw new Error(`設定（${where}）の \${env:${bad[0]}} は使えません（${bad.join(", ")} は秘密を扱う予約された名前です。秘密はプラグインから host.secrets で読みます）。`);
  }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * プロジェクトの設定を読む。JSON とコードの両方があれば、コードにある最上位のキーが JSON の同じキーを置き換える。
 */
export async function loadProjectConfig(projectRoot: string, opts?: LoadProjectConfigOptions): Promise<LoadedProjectConfig> {
  const root = path.resolve(projectRoot);
  const files: { json?: string; code?: string } = {};
  let json: Record<string, unknown> = {};
  let code: Record<string, unknown> = {};

  const jsonPath = path.join(root, PROJECT_CONFIG_JSON);
  let untrustedSettings: PluginCandidate | undefined;
  if (existsSync(jsonPath)) {
    files.json = jsonPath;
    let parsed: unknown;
    let text: string;
    try {
      text = await readFile(jsonPath, "utf8");
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`設定ファイル ${jsonPath} を読めませんでした: ${errorMessage(err)}`);
    }
    if (!isPlainObject(parsed)) throw new Error(`設定ファイル ${jsonPath} は JSON のオブジェクトにしてください。`);
    json = parsed;
    checkReservedEnv(text, jsonPath);
    if (opts?.trustConfig) {
      // 設定ファイルの基盤の項目と ${env:} の参照は、確認するまで使わない（つながない、展開しない）。
      const sc = settingsCandidate(jsonPath, json, text, await readPluginSettingsTexts(root));
      if (sc && !opts.trustConfig(sc)) untrustedSettings = sc;
    }
  }

  const codePath = PROJECT_CONFIG_CODE.map((name) => path.join(root, name)).find((p) => existsSync(p));
  let untrustedCode: PluginCandidate | undefined;
  let codeError: string | undefined;
  let candidate: PluginCandidate | undefined;
  let loadCode = codePath !== undefined;
  if (codePath && opts?.trustConfig) {
    // 信頼の確認: 読み込む前にコード（import 先を含む）を確かめる。
    try {
      const inspected = await inspectConfigCode(root, codePath, opts?.sdkPath ? { sdkPath: opts.sdkPath } : {});
      if (inspected.error) {
        codeError = `コードの設定 ${codePath} は信頼の確認の条件を満たさないため読み込みません: ${inspected.error}`;
        loadCode = false;
      } else {
        candidate = { kind: "config", path: codePath, layer: "project", hash: inspected.hash, files: inspected.files };
        if (!opts.trustConfig(candidate)) {
          untrustedCode = candidate;
          loadCode = false;
        }
      }
    } catch (err) {
      codeError = `コードの設定 ${codePath} を確かめられませんでした: ${errorMessage(err)}`;
      loadCode = false;
    }
  }
  // 設定ファイルを確認していなければ、信頼したコードの設定も読み込まない（何も動かさない）。
  if (untrustedSettings) loadCode = false;
  if (codePath && loadCode) {
    files.code = codePath;
    let value: unknown;
    try {
      const importModule = createModuleImporter(opts);
      const mod = await importModule(codePath);
      if (!mod.hasDefault) throw new Error("既定のエクスポート（export default）がありません。");
      value = mod.value;
      if (typeof value === "function") value = await (value as () => unknown)();
    } catch (err) {
      throw new Error(`設定ファイル ${codePath} を読み込めませんでした: ${errorMessage(err)}`);
    }
    if (!isPlainObject(value)) throw new Error(`設定ファイル ${codePath} の既定のエクスポートは設定のオブジェクトにしてください。`);
    code = value;
    if (candidate) {
      // 確かめてから読み込むまでの間に書き換えられていたら、読み込んだものを使わない。
      const after = await inspectConfigCode(root, codePath, opts?.sdkPath ? { sdkPath: opts.sdkPath } : {}).catch(() => undefined);
      if (!after || after.error || after.hash !== candidate.hash) {
        code = {};
        delete files.code;
        untrustedCode = after && !after.error ? { ...candidate, hash: after.hash, files: after.files } : candidate;
        codeError = `コードの設定 ${codePath} は確認のあとで書き換えられたため、使いませんでした。もう一度確認してください。`;
      }
    }
  }

  if (untrustedSettings) {
    const candidates = [untrustedSettings, ...(untrustedCode ? [untrustedCode] : [])];
    throw new UntrustedConfigError(
      `プロジェクトの設定ファイル ${jsonPath} の基盤の項目（共有 DB、ツリー、生成器など）を確認するまで、プロジェクトを開けません。${codeError ? ` ${codeError}` : ""}`,
      candidates,
      [],
    );
  }
  if (Object.keys(code).length > 0) checkReservedEnv(stableStringify(code), codePath ?? "");

  const pending = codePath !== undefined && files.code === undefined;
  if (pending) {
    // コードの設定を使わないときは JSON だけで開けるか確かめ、開けなければ（信頼を待つ状態として）例外にする。
    const problems = files.json ? validateProjectConfig(json) : [`${PROJECT_CONFIG_JSON} がありません。`];
    if (problems.length > 0) {
      throw new UntrustedConfigError(
        `コードの設定 ${codePath} を${untrustedCode ? "信頼するまで" : ""}読み込まないため、プロジェクトを開けません（JSON の設定だけでは足りません: ${problems.join(" / ")}）。${codeError ? ` ${codeError}` : ""}`,
        untrustedCode ? [untrustedCode] : [],
        problems,
      );
    }
  }

  if (!files.json && !files.code) {
    throw new Error(
      `${root} にプロジェクトの設定ファイル（${[PROJECT_CONFIG_JSON, ...PROJECT_CONFIG_CODE].join(" / ")}）がありません。`,
    );
  }

  const fromCode = Object.keys(code).filter((k) => code[k] !== undefined);
  const merged: Record<string, unknown> = { ...json };
  for (const key of fromCode) merged[key] = code[key];

  const problems = validateProjectConfig(merged);
  if (problems.length > 0) {
    const where = [files.json, files.code].filter(Boolean).join("、");
    throw new Error(`プロジェクトの設定（${where}）に問題があります:\n- ${problems.join("\n- ")}`);
  }
  const result: LoadedProjectConfig = { config: merged as unknown as ProjectConfig, files, fromCode };
  if (untrustedCode) result.untrustedCode = untrustedCode;
  if (codeError) result.codeError = codeError;
  return result;
}

/** 設定の形を確かめ、問題の一覧を返す。 */
export function validateProjectConfig(config: unknown): string[] {
  if (!isPlainObject(config)) return ["設定はオブジェクトにしてください。"];
  const problems: string[] = [];
  const languages = config.languages;
  if (!Array.isArray(languages) || languages.length === 0) {
    problems.push("languages には言語を 1 つ以上書いてください。");
  } else {
    const ids = new Set<string>();
    const basedOn = new Map<string, string>();
    languages.forEach((lang: unknown, i) => {
      if (!isPlainObject(lang)) {
        problems.push(`languages[${i}] はオブジェクトにしてください。`);
        return;
      }
      const id = lang.id;
      if (typeof id !== "string" || id === "") {
        problems.push(`languages[${i}] の id は空でない文字列にしてください。`);
        return;
      }
      if (ids.has(id)) problems.push(`言語の id "${id}" が重複しています。`);
      ids.add(id);
      if (typeof lang.label !== "string") problems.push(`言語 "${id}" の label は文字列にしてください。`);
      if (lang.basedOn !== undefined) {
        if (typeof lang.basedOn !== "string") problems.push(`言語 "${id}" の basedOn は文字列にしてください。`);
        else basedOn.set(id, lang.basedOn);
      }
    });
    for (const [id, base] of basedOn) {
      if (!ids.has(base)) problems.push(`言語 "${id}" の basedOn "${base}" という言語はありません。`);
    }
    // basedOn をたどって同じ言語に戻るものを探す。
    const reported = new Set<string>();
    for (const start of basedOn.keys()) {
      const seen: string[] = [];
      let cur: string | undefined = start;
      while (cur !== undefined && !seen.includes(cur)) {
        seen.push(cur);
        cur = basedOn.get(cur);
      }
      if (cur !== undefined && !reported.has(cur)) {
        const cycle = seen.slice(seen.indexOf(cur));
        cycle.forEach((c) => reported.add(c));
        problems.push(`言語の basedOn が循環しています: ${[...cycle, cur].join(" → ")}`);
      }
    }
  }
  if (config.pluginDirs !== undefined) {
    if (!Array.isArray(config.pluginDirs) || config.pluginDirs.some((d) => typeof d !== "string")) {
      problems.push("pluginDirs は文字列の配列にしてください。");
    }
  }
  for (const key of ["formats", "syntaxes", "columns", "actions", "validators"]) {
    if (config[key] !== undefined && !Array.isArray(config[key])) problems.push(`${key} は配列にしてください。`);
  }
  return problems;
}

/** `${env:NAME}` を環境変数の値に置き換える。参照した変数がなければ例外を投げる。 */
export function expandEnv(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\{env:([^}]*)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`環境変数 ${name} が設定されていません（"${value}" の中で参照しています）。`);
    return v;
  });
}
