/**
 * プラグインとコードの設定の信頼。プロジェクトを開くとそのコードが動くので、
 * project / local 層のプラグインとコードの設定（loc-studio.config.ts など）は、利用者が確認したもの
 * （確認したときと、実行されうるコードのハッシュが同じもの）だけを読み込む。
 * 信頼はローカル設定 "plugins.trust" に { [プロジェクトのルート]: { [パス]: ハッシュ } } で残す。
 */
import { inspectConfigCode, inspectPluginCode, readLocalSettings, readPluginSettingsTexts, settingsCandidate, writeLocalSettings } from "@loc-studio/core";
import { readFile } from "node:fs/promises";
import type { PluginCandidate } from "@loc-studio/core";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api-types.js";
import type { ProjectInfo, TrustItem, UntrustedPluginInfo } from "./api-types.js";
import type { WsContext } from "./context.js";
import { errorText } from "./context.js";
import { reloadProject, updateLocalSettings } from "./settings-api.js";

export const TRUST_KEY = "plugins.trust";

type TrustStore = Record<string, Record<string, string>>;

export function storeOf(local: Record<string, unknown> | undefined): TrustStore {
  const v = local?.[TRUST_KEY];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as TrustStore) : {};
}

/** openProject に渡す判定。ローカル設定はその時点のものを読む（信頼を変えたら読み直しで反映する）。 */
export function trustChecker(root: string, local: () => Record<string, unknown> | undefined): (c: PluginCandidate) => boolean {
  return (c) => storeOf(local())[root]?.[c.path] === c.hash;
}

export function untrustedInfo(candidates: PluginCandidate[]): UntrustedPluginInfo[] {
  return candidates.map((c) => {
    const info: UntrustedPluginInfo = { kind: c.kind, path: c.path, layer: c.layer, hash: c.hash, files: [...c.files] };
    if (c.summary) info.summary = c.summary.map((s) => ({ ...s }));
    return info;
  });
}

/** いまの中身のハッシュ（信頼の確認の条件を満たさなければ invalid）。 */
async function currentHash(root: string, c: PluginCandidate): Promise<string> {
  if (c.kind === "settings") {
    const sc = await currentSettingsCandidate(c.path);
    return sc?.hash ?? "";
  }
  let r;
  try {
    if (c.kind === "config") r = await inspectConfigCode(root, c.path);
    else {
      const isFile = (await stat(c.path)).isFile();
      r = await inspectPluginCode(c.path, isFile ? c.path : undefined);
    }
  } catch (err) {
    throw new ApiError("failed", `${c.path} の中身を確かめられませんでした: ${errorText(err)}`);
  }
  if (r.error) throw new ApiError("invalid", `${c.path} は信頼の確認の条件を満たしません: ${r.error}`);
  return r.hash;
}

/** 設定ファイルのいまの信頼の対象（基盤の項目も ${env:} もなければ undefined）。 */
export async function currentSettingsCandidate(file: string): Promise<PluginCandidate | undefined> {
  let text: string;
  let json: unknown;
  try {
    text = await readFile(file, "utf8");
    json = JSON.parse(text);
  } catch (err) {
    throw new ApiError("failed", `設定ファイル ${file} を読めませんでした: ${errorText(err)}`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  // プラグインの設定ファイルの中身も、設定ファイルの確認の対象に入れる（プロジェクトのフォルダは、設定ファイルのあるフォルダ）。
  return settingsCandidate(file, json as Record<string, unknown>, text, await readPluginSettingsTexts(path.dirname(file)));
}

export function requireItems(params: { items: TrustItem[] } | undefined): TrustItem[] {
  const items = params?.items;
  if (!Array.isArray(items) || items.length > 200 || items.some((i) => typeof i?.path !== "string" || typeof i?.hash !== "string")) {
    throw new ApiError("invalid", "items は { path, hash }（plugins() の untrusted の path と hash）の配列で指定してください。");
  }
  return items;
}

export function requirePaths(params: { paths: string[] } | undefined): string[] {
  if (!Array.isArray(params?.paths) || params.paths.length > 200 || params.paths.some((p) => typeof p !== "string")) {
    throw new ApiError("invalid", "paths はパスの配列で指定してください。");
  }
  return params.paths;
}

/**
 * 利用者が確認したハッシュで信頼する。いまの中身が確認したときと違えば conflict（もう一度確認してもらう）。
 * 戻り値は、記録するハッシュ（パス → ハッシュ）。
 */
export async function verifyItems(root: string, candidates: PluginCandidate[], items: TrustItem[]): Promise<Record<string, string>> {
  const known = new Map(candidates.map((c) => [c.path, c]));
  const hashes: Record<string, string> = {};
  for (const item of items) {
    const c = known.get(item.path);
    if (!c) throw new ApiError("not-found", `信頼の確認を待っているもの "${path.basename(item.path)}" はありません（plugins() の untrusted を見てください）。`);
    const now = await currentHash(root, c);
    if (now !== item.hash) {
      throw new ApiError("conflict", `${path.basename(item.path)} は確認したあとで変わりました。もう一度内容を確かめてください。`, {
        path: item.path,
        hash: now,
      });
    }
    hashes[item.path] = now;
  }
  return hashes;
}

/** ローカル設定のファイルの信頼の記録を書き換える（ワークスペースが制限された状態でも使う）。 */
export async function writeTrustFile(localFile: string, root: string, mutate: (forRoot: Record<string, string>) => void): Promise<Record<string, unknown>> {
  const values = await readLocalSettings(localFile);
  const store = storeOf(values);
  const forRoot = { ...(store[root] ?? {}) };
  mutate(forRoot);
  values[TRUST_KEY] = { ...store, [root]: forRoot };
  await writeLocalSettings(localFile, values);
  return values;
}

export async function trustPlugins(ctx: WsContext, params: { items: TrustItem[] }, info: () => Promise<ProjectInfo>): Promise<ProjectInfo> {
  const items = requireItems(params);
  const root = ctx.project.root;
  const hashes = await verifyItems(root, ctx.project.untrustedPlugins, items);
  await updateLocalSettings(ctx, (values) => {
    const store = storeOf(values);
    values[TRUST_KEY] = { ...store, [root]: { ...(store[root] ?? {}), ...hashes } };
  });
  await reloadProject(ctx);
  return info();
}

export async function untrustPlugins(ctx: WsContext, params: { paths: string[] }, info: () => Promise<ProjectInfo>): Promise<ProjectInfo> {
  const paths = requirePaths(params);
  const root = ctx.project.root;
  await updateLocalSettings(ctx, (values) => {
    const store = storeOf(values);
    const forRoot = { ...(store[root] ?? {}) };
    for (const p of paths) delete forRoot[p];
    values[TRUST_KEY] = { ...store, [root]: forRoot };
  });
  await reloadProject(ctx);
  return info();
}
