import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SettingSource = "enforce" | "cli" | "local" | "defaults" | "app";

export interface SettingsLayers {
  enforce?: Record<string, unknown>;
  cli?: Record<string, unknown>;
  local?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  app?: Record<string, unknown>;
}

export interface ResolvedSetting<T = unknown> {
  key: string;
  value: T;
  source: SettingSource;
  /** enforce 由来の値か。 */
  locked: boolean;
}

/** 優先順位の高い順。 */
const ORDER: SettingSource[] = ["enforce", "cli", "local", "defaults", "app"];

/** 秘密情報とプラグインの信頼は、プロジェクト側から固定させない。 */
export function isEnforceable(key: string): boolean {
  if (key.startsWith("secrets.")) return false;
  if (key === "plugins.trust" || key.startsWith("plugins.trust.")) return false;
  return true;
}

function has(layer: Record<string, unknown> | undefined, key: string): layer is Record<string, unknown> {
  return layer !== undefined && Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined;
}

export function resolveSetting(key: string, layers: SettingsLayers): ResolvedSetting | undefined {
  for (const source of ORDER) {
    if (source === "enforce" && !isEnforceable(key)) continue;
    const layer = layers[source];
    if (has(layer, key)) {
      return { key, value: layer[key], source, locked: source === "enforce" };
    }
  }
  return undefined;
}

export function resolveSettings(layers: SettingsLayers): {
  values: Record<string, ResolvedSetting>;
  ignoredEnforce: string[];
} {
  const keys = new Set<string>();
  for (const source of ORDER) {
    for (const key of Object.keys(layers[source] ?? {})) keys.add(key);
  }
  const values: Record<string, ResolvedSetting> = {};
  for (const key of keys) {
    const resolved = resolveSetting(key, layers);
    if (resolved) values[key] = resolved;
  }
  const ignoredEnforce = Object.keys(layers.enforce ?? {}).filter(
    (key) => has(layers.enforce, key) && !isEnforceable(key),
  );
  return { values, ignoredEnforce };
}

export function expandUserTemplate(value: string, sys: { hostname: string; osUser: string }): string {
  return value.replaceAll("{hostname}", sys.hostname).replaceAll("{osUser}", sys.osUser);
}

export function systemIdentity(): { hostname: string; osUser: string } {
  let hostname = "";
  try {
    hostname = os.hostname();
  } catch {
    // 取得できない環境では環境変数に頼る
  }
  let osUser = "";
  try {
    osUser = os.userInfo().username;
  } catch {
    // コンテナなどでユーザー情報がない場合
  }
  return {
    hostname: hostname || process.env["COMPUTERNAME"] || process.env["HOSTNAME"] || "unknown",
    osUser: osUser || process.env["USER"] || process.env["USERNAME"] || "unknown",
  };
}

export function resolveUserName(
  layers: SettingsLayers,
  sys: { hostname: string; osUser: string } = systemIdentity(),
): ResolvedSetting<string> {
  const key = "user.name";
  for (const source of ORDER) {
    if (source === "enforce" && !isEnforceable(key)) continue;
    const layer = layers[source];
    if (!has(layer, key)) continue;
    const raw = layer[key];
    if (typeof raw !== "string") continue;
    const expanded = expandUserTemplate(raw, sys);
    if (expanded.trim() === "") continue;
    return { key, value: expanded, source, locked: source === "enforce" };
  }
  return { key, value: sys.hostname, source: "app", locked: false };
}

export function cliSettingsFromEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const user = env["LOC_STUDIO_USER"];
  if (user !== undefined && user !== "") result["user.name"] = user;
  return result;
}

export function localSettingsPath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string {
  const override = env["LOC_STUDIO_SETTINGS"];
  if (override) return override;
  if (platform === "win32") {
    const base = env["APPDATA"] || path.win32.join(homeDir, "AppData", "Roaming");
    return path.win32.join(base, "loc-studio", "settings.json");
  }
  if (platform === "darwin") {
    return path.posix.join(homeDir, "Library", "Application Support", "loc-studio", "settings.json");
  }
  const base = env["XDG_CONFIG_HOME"] || path.posix.join(homeDir, ".config");
  return path.posix.join(base, "loc-studio", "settings.json");
}

export async function readLocalSettings(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`ローカル設定を読み込めませんでした: ${file}（${(e as Error).message}）`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`ローカル設定の JSON が壊れています: ${file}（${(e as Error).message}）`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`ローカル設定はオブジェクトで書いてください: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

export async function writeLocalSettings(file: string, values: Record<string, unknown>): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, JSON.stringify(values, null, 2) + "\n", "utf8");
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw new Error(`ローカル設定を書き込めませんでした: ${file}（${(e as Error).message}）`);
  }
}
