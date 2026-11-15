/**
 * 設定: ローカル設定（その PC）とプロジェクト設定（loc-studio.project.json）。
 */
import { existsSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { INFRA_CONFIG_KEYS, PROJECT_CONFIG_JSON, readLocalSettings, resolveSetting, settingsCandidate, UntrustedConfigError, writeLocalSettings } from "@loc-studio/core";
import { currentSettingsCandidate, storeOf, TRUST_KEY } from "./trust.js";
import type { SettingsLayers } from "@loc-studio/core";
import type { ProjectConfig } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { ProjectInfo, SettingInfo } from "./api-types.js";
import type { WsContext } from "./context.js";
import { currentCall, currentCallState } from "./call-context.js";
import type { CallState } from "./call-context.js";
import { errorText } from "./context.js";

/** アプリの既定値（設定の最後の層）。 */
export const APP_SETTING_DEFAULTS: Record<string, unknown> = {
  "review.forwardOnPost": "ask",
};

/** 一覧に出す秘密情報の値の代わり。 */
const SECRET_MASK = "********";

/** プロジェクト設定から、ローカル設定の層（enforce / defaults）を作り直す。 */
export function layersFromConfig(config: ProjectConfig, base: SettingsLayers): SettingsLayers {
  const layers: SettingsLayers = { ...base, app: APP_SETTING_DEFAULTS };
  const enforce = config.localSettings?.enforce;
  const defaults = config.localSettings?.defaults;
  if (enforce) layers.enforce = enforce;
  else delete layers.enforce;
  if (defaults) layers.defaults = defaults;
  else delete layers.defaults;
  return layers;
}

export function listSettings(ctx: WsContext): SettingInfo[] {
  const keys = new Set<string>(["user.name"]);
  const layers = ctx.currentLayers();
  for (const layer of [layers.enforce, layers.cli, layers.local, layers.defaults, layers.app]) {
    for (const k of Object.keys(layer ?? {})) keys.add(k);
  }
  const out: SettingInfo[] = [];
  for (const key of [...keys].sort()) {
    if (HIDDEN_KEYS.has(key)) continue;
    if (key === "user.name") {
      const u = ctx.userInfo();
      out.push({ key, value: u.value, source: u.source, locked: u.locked });
      continue;
    }
    const r = resolveSetting(key, layers);
    if (!r) continue;
    out.push({ key, value: key.startsWith("secrets.") ? SECRET_MASK : r.value, source: r.source, locked: r.locked });
  }
  return out;
}

export function settings(ctx: WsContext) {
  return {
    local: listSettings(ctx),
    // Web モードの呼び出しでは利用者ごとの設定（ファイルではない）。
    localFile: currentCallState() ? "" : ctx.localFile,
    project: ctx.project.config,
    projectFromCode: [...ctx.project.configFromCode],
    projectFile: path.join(ctx.project.root, PROJECT_CONFIG_JSON),
  };
}

/** ローカル設定のファイルを読み直して書き換える（ほかのプロセスが書いた値を消さないよう、書く直前に読む）。 */
export async function updateLocalSettings(ctx: WsContext, mutate: (values: Record<string, unknown>) => void): Promise<void> {
  await ctx.locks.run("\u0000local-settings", async () => {
    let values: Record<string, unknown>;
    try {
      values = await readLocalSettings(ctx.localFile);
    } catch (err) {
      throw new ApiError("failed", errorText(err));
    }
    mutate(values);
    try {
      await writeLocalSettings(ctx.localFile, values);
    } catch (err) {
      throw new ApiError("failed", errorText(err));
    }
    ctx.setLayers({ ...ctx.layers, local: values });
    ctx.bump();
  });
}

/** 一覧に出さない項目（専用のメソッドで扱う）。 */
const HIDDEN_KEYS = new Set(["plugins.trust"]);

export async function setLocalSetting(ctx: WsContext, params: { key: string; value: unknown }): Promise<SettingInfo[]> {
  const key = params?.key;
  if (typeof key !== "string" || key.trim() === "") throw new ApiError("invalid", "key を指定してください。");
  if (ctx.isLocked(key)) throw new ApiError("locked", `「${key}」はプロジェクト設定で固定されているため変更できません。`);
  if (HIDDEN_KEYS.has(key)) throw new ApiError("invalid", `「${key}」は trustPlugins / untrustPlugins で変更してください。`);
  const state = currentCallState();
  if (state) return setUserSetting(ctx, state, key, params.value);
  return ctx.locks.run("\u0000local-settings", async () => {
    // ほかのプロセスが書いた値を消さないよう、書く直前に読み直す。
    let values: Record<string, unknown>;
    try {
      values = await readLocalSettings(ctx.localFile);
    } catch (err) {
      throw new ApiError("failed", errorText(err));
    }
    if (params.value === null || params.value === undefined) delete values[key];
    else values[key] = params.value;
    try {
      await writeLocalSettings(ctx.localFile, values);
    } catch (err) {
      throw new ApiError("failed", errorText(err));
    }
    ctx.setLayers({ ...ctx.layers, local: values });
    ctx.bump();
    return listSettings(ctx);
  });
}

/** Web モード: 呼び出した利用者の設定を変える。ユーザー名と秘密情報はサーバー側で決めるので変えられない。 */
async function setUserSetting(ctx: WsContext, state: CallState, key: string, value: unknown): Promise<SettingInfo[]> {
  if (key === "user.name") throw new ApiError("forbidden", "Web モードではユーザー名はアカウントの名前で、変更できません。");
  if (key.startsWith("secrets.")) throw new ApiError("forbidden", "Web モードでは秘密情報はサーバーの環境変数で設定します。");
  if (!ctx.userSettings) throw new ApiError("failed", "利用者ごとの設定の置き場所がありません（ServerRuntime から開いてください）。");
  const name = state.call.user.name;
  await ctx.locks.run(`\u0000user-settings\u0000${name}`, async () => {
    const values = { ...(await ctx.userSettings!.get(name)) };
    if (value === null || value === undefined) delete values[key];
    else values[key] = value;
    await ctx.userSettings!.set(name, values);
    state.layers = { ...(state.layers ?? ctx.layers), local: values };
  });
  ctx.bump();
  return listSettings(ctx);
}

/** 設定とプラグインを読み直す。失敗したらいまの状態のまま例外にする。 */
export async function reloadProject(ctx: WsContext): Promise<void> {
  await ctx.project.reload();
  ctx.setLayers(layersFromConfig(ctx.project.config, ctx.layers));
  await ctx.afterReload();
  ctx.bump();
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw new ApiError("failed", `設定ファイル ${file} を書き込めませんでした: ${errorText(err)}`);
  }
}

/**
 * Web モードで、プロジェクトの manager が変えてよい設定の項目。
 * これ以外（基盤の項目）はサーバーの管理者だけが変えられる。サーバーの秘密やほかのデータベース、任意のフォルダのコードに
 * 届かないようにするため（storage、pluginDirs、tree、formats、syntaxes、sources、generators、actions、review）。
 * 役割の定義（roles）も管理者だけが変えられる。manage の権限がある人が、自分の役割の絞り込みを外せないようにするため。
 */
export const MANAGER_CONFIG_KEYS = ["name", "languages", "columns", "validators", "validation", "languageSets", "grid", "editor", "localSettings"] as const;
export const ADMIN_CONFIG_KEYS = [...INFRA_CONFIG_KEYS, "roles"] as const;

// ProjectConfig の項目を足したら、どちらかの一覧に入れないと型の確認で失敗する。
type UnlistedConfigKeys = Exclude<keyof ProjectConfig, (typeof MANAGER_CONFIG_KEYS)[number] | (typeof ADMIN_CONFIG_KEYS)[number]>;
const _allConfigKeysListed: UnlistedConfigKeys extends never ? true : UnlistedConfigKeys = true;
void _allConfigKeysListed;

/** Web モードの呼び出しで、その利用者が変えてよい項目か確かめる（変えられない項目があれば断る。黙って捨てない）。 */
function checkConfigKeys(patch: Record<string, unknown>): void {
  const call = currentCall();
  if (!call || call.admin) return;
  const managerKeys = new Set<string>(MANAGER_CONFIG_KEYS);
  const adminKeys = new Set<string>(ADMIN_CONFIG_KEYS);
  const denied = Object.keys(patch).filter((k) => adminKeys.has(k));
  if (denied.length > 0) {
    throw new ApiError("forbidden", `次の項目はサーバーの管理者だけが変えられます: ${denied.join(", ")}`, { keys: denied });
  }
  const unknown = Object.keys(patch).filter((k) => !managerKeys.has(k));
  if (unknown.length > 0) throw new ApiError("invalid", `次の項目は設定にありません: ${unknown.join(", ")}`, { keys: unknown });
}

export async function updateProjectSettings(
  ctx: WsContext,
  params: { patch: Record<string, unknown> },
  info: () => Promise<ProjectInfo>,
): Promise<ProjectInfo> {
  const patch = params?.patch;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new ApiError("invalid", "patch はオブジェクトで指定してください。");
  checkConfigKeys(patch);
  const fromCode = new Set(ctx.project.configFromCode);
  const locked = Object.keys(patch).filter((k) => fromCode.has(k));
  if (locked.length > 0) {
    throw new ApiError("locked", `次の項目はコードの設定（loc-studio.config.ts など）にあるため、ここでは変更できません: ${locked.join(", ")}`, { keys: locked });
  }
  await ctx.locks.run("\u0000project-settings", async () => {
    const file = path.join(ctx.project.root, PROJECT_CONFIG_JSON);
    const original = existsSync(file) ? await readFile(file, "utf8") : undefined;
    let current: Record<string, unknown> = {};
    let parsedOk = false;
    if (original !== undefined) {
      try {
        const parsed: unknown = JSON.parse(original);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          current = parsed as Record<string, unknown>;
          parsedOk = true;
        } else throw new Error("JSON のオブジェクトではありません");
      } catch (err) {
        throw new ApiError("failed", `設定ファイル ${file} を読めませんでした: ${errorText(err)}`);
      }
    }
    const next: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    // この PC で利用者が変えた設定は、同じ操作で信頼する（変える前の設定ファイルが信頼済みだったときだけ。
    // ほかで書き換えられた未確認の変更まで、ここで信頼してしまわないように）。
    // 変える前の信頼は、上で読んだ中身（original）で判断する（読み直すと、その間の書き換えを見落とすため）。
    // 読めない・解析できない中身は「信頼していない」とみなす。基盤の項目も ${env:} もない中身は確認が要らない。
    let trustedBefore = false;
    if (ctx.promptTrust && !currentCall()) {
      if (original === undefined) trustedBefore = true;
      else if (parsedOk) {
        const before = settingsCandidate(file, current, original);
        trustedBefore = before === undefined || storeOf(ctx.layers.local)[ctx.project.root]?.[file] === before.hash;
      }
    }
    await writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
    if (ctx.promptTrust && !currentCall() && trustedBefore) {
      const after = await currentSettingsCandidate(file).catch(() => undefined);
      if (after) {
        await updateLocalSettings(ctx, (values) => {
          const store = storeOf(values);
          values[TRUST_KEY] = { ...store, [ctx.project.root]: { ...(store[ctx.project.root] ?? {}), [file]: after.hash } };
        });
      }
    }
    try {
      await reloadProject(ctx);
    } catch (err) {
      // 未確認の変更（ほかで書き換えられた基盤の項目など）で開けなくなったときは、利用者の変更は残し、
      // 制限された状態に切り替える（外側の Workspace が UntrustedConfigError を受けて切り替える）。
      if (err instanceof UntrustedConfigError) throw err;
      // 読み直せない設定は残さない。元に戻す。
      if (original !== undefined) await writeAtomic(file, original);
      else await unlink(file).catch(() => undefined);
      throw new ApiError("invalid", `設定を反映できなかったため、元に戻しました: ${errorText(err)}`);
    }
  });
  return info();
}
