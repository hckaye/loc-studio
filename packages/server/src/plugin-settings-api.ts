/**
 * プラグインの設定: 一覧（pluginSettings）と、値の保存（setPluginSettings）。
 * 値は、プロジェクトのフォルダの loc-studio-plugin-settings/<プラグインの名前>.json に置く（コアの plugin-settings.ts）。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { PROJECT_CONFIG_JSON, readPluginSettingsFile, settingValueProblem, UntrustedConfigError } from "@loc-studio/core";
import type { PluginSettingsState } from "@loc-studio/core";
import { ApiError } from "./api-types.js";
import type { PluginSettingsInfo } from "./api-types.js";
import { currentCall } from "./call-context.js";
import type { WsContext } from "./context.js";
import { errorText } from "./context.js";
import { reloadProject, updateLocalSettings, writeAtomic } from "./settings-api.js";
import { currentSettingsCandidate, storeOf, TRUST_KEY } from "./trust.js";

function toInfo(state: PluginSettingsState): PluginSettingsInfo {
  const info: PluginSettingsInfo = {
    plugin: state.plugin,
    layer: state.layer,
    file: state.file,
    items: state.defs.map((def) => {
      const item: PluginSettingsInfo["items"][number] = { key: def.key, label: def.label, type: def.type, stored: Object.hasOwn(state.stored, def.key) };
      if (def.description !== undefined) item.description = def.description;
      if (def.options) item.options = def.options.map((o) => ({ value: o.value, ...(o.label !== undefined ? { label: o.label } : {}) }));
      if (def.default !== undefined) item.default = def.default;
      const value = state.values[def.key];
      if (value !== undefined) item.value = value;
      return item;
    }),
    problems: [...state.problems],
  };
  if (state.version !== undefined) info.version = state.version;
  return info;
}

/** 設定を宣言しているプラグインと、その項目、いまの値。 */
export function pluginSettings(ctx: WsContext): PluginSettingsInfo[] {
  return ctx.project.pluginSettings.map(toInfo);
}

/** 設定ファイルの確認が、いまの中身で済んでいるか（確認が要らない中身なら済んでいるとみなす）。読めなければ、済んでいない。 */
async function settingsTrusted(ctx: WsContext, configFile: string): Promise<boolean> {
  if (!existsSync(configFile)) return true;
  try {
    const candidate = await currentSettingsCandidate(configFile);
    return candidate === undefined || storeOf(ctx.layers.local)[ctx.project.root]?.[configFile] === candidate.hash;
  } catch {
    return false;
  }
}

/**
 * プラグインの設定の値を保存する。values は「キー: 値」で、null は値を消す（既定の値に戻す）。書かなかったキーは変えない。
 * 宣言にないキーや、種類の合わない値が 1 つでもあれば、何も書かずに invalid。
 * 保存したら、設定とプラグインを読み直す（プラグインは、次に呼ばれたときから新しい値を受け取る）。
 */
export async function setPluginSettings(ctx: WsContext, params: { plugin: string; values: Record<string, unknown> }): Promise<PluginSettingsInfo[]> {
  const name = params?.plugin;
  const values = params?.values;
  if (typeof name !== "string" || name === "") throw new ApiError("invalid", "plugin に、プラグインの名前を指定してください。");
  if (typeof values !== "object" || values === null || Array.isArray(values)) throw new ApiError("invalid", "values は「キー: 値」のオブジェクトで指定してください。");
  const state = ctx.project.pluginSettings.find((s) => s.plugin === name);
  if (!state) {
    throw new ApiError("not-found", `プラグイン "${name}" は読み込まれていないか、設定（settings）を宣言していません。`);
  }
  for (const [key, value] of Object.entries(values)) {
    const def = state.defs.find((d) => d.key === key);
    if (!def) {
      throw new ApiError("invalid", `プラグイン "${name}" は、設定 "${key}" を宣言していません（宣言している設定: ${state.defs.map((d) => d.key).join(", ")}）。`, { key });
    }
    if (value === null || value === undefined) continue;
    const problem = settingValueProblem(def, value);
    if (problem !== undefined) throw new ApiError("invalid", `プラグイン "${name}" の設定「${def.label}」（${key}）の値 ${JSON.stringify(value)} は${problem}`, { key });
  }

  await ctx.locks.run("\u0000project-settings", async () => {
    const file = state.file;
    const original = existsSync(file) ? await readFile(file, "utf8") : undefined;
    // 画面に欄のないキー（宣言からなくなった項目など）は、そのまま残す。読めない中身は、今回の値で書き直す。
    let current: Record<string, unknown> = {};
    try {
      current = await readPluginSettingsFile(file);
    } catch {
      current = {};
    }
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    // この PC で利用者が変えた値は、同じ操作で確認済みにする（変える前の設定が確認済みだったときだけ。
    // ほかで書き換えられた未確認の変更まで、ここで確認済みにしないように）。updateProjectSettings と同じ決まり。
    const configFile = path.join(ctx.project.root, PROJECT_CONFIG_JSON);
    const recordTrust = ctx.promptTrust && !currentCall() && (await settingsTrusted(ctx, configFile));
    const restore = async (): Promise<void> => {
      if (original !== undefined) await writeAtomic(file, original);
      else await unlink(file).catch(() => undefined);
    };
    if (Object.keys(next).length === 0) {
      // 値がすべてなくなったら、ファイルを残さない（既定の値だけで動く）。
      await unlink(file).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ApiError("failed", `設定ファイル ${file} を消せませんでした: ${errorText(err)}`);
      });
    } else {
      try {
        await mkdir(path.dirname(file), { recursive: true });
      } catch (err) {
        throw new ApiError("failed", `プラグインの設定のフォルダ ${path.dirname(file)} を作れませんでした: ${errorText(err)}`);
      }
      await writeAtomic(file, JSON.stringify(next, null, 2) + "\n");
    }
    if (recordTrust && existsSync(configFile)) {
      const after = await currentSettingsCandidate(configFile).catch(() => undefined);
      if (after) {
        await updateLocalSettings(ctx, (local) => {
          const store = storeOf(local);
          local[TRUST_KEY] = { ...store, [ctx.project.root]: { ...(store[ctx.project.root] ?? {}), [configFile]: after.hash } };
        });
      }
    }
    try {
      await reloadProject(ctx);
    } catch (err) {
      // 未確認の変更（ほかで書き換えられた設定）で開けなくなったときは、利用者の変更は残し、制限された状態に切り替える。
      if (err instanceof UntrustedConfigError) throw err;
      await restore();
      throw new ApiError("invalid", `プラグインの設定を反映できなかったため、元に戻しました: ${errorText(err)}`);
    }
  });
  return pluginSettings(ctx);
}
