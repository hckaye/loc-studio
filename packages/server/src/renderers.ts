/**
 * 独自描画（CellRenderer）のモジュール。ブラウザが実行時に import する .js / .mjs のファイルを、
 * 読み込んだ（信頼された）プラグインに登録されたものに限って返す。
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { rendererModuleFile } from "@loc-studio/core";
import type { WsContext } from "./context.js";
import { errorText } from "./context.js";
import { textHash } from "./hash.js";

const MODULE_EXTS = new Set([".js", ".mjs"]);

/** 登録された renderer のモジュールのファイル。拡張子が違う、場所が決まらないものは undefined。 */
function moduleFileOf(ctx: WsContext, id: string): { file: string; base: string; pluginName: string } | undefined {
  const entry = ctx.project.registry.list("renderer").find((e) => e.id === id);
  if (!entry) return undefined;
  const file = rendererModuleFile(entry.origin, entry.value.module);
  if (!file || !MODULE_EXTS.has(path.extname(file).toLowerCase())) return undefined;
  const base = entry.origin.path!;
  return { file, base, pluginName: entry.pluginName };
}

async function readModule(file: string, base: string): Promise<Buffer | undefined> {
  try {
    // シンボリックリンクでプラグインのフォルダの外を読まないよう、実体の場所で確かめる。
    const realBase = await realpath(base);
    const dir = (await stat(realBase)).isFile() ? path.dirname(realBase) : realBase;
    const realFile = await realpath(file);
    const rel = path.relative(dir, realFile);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return await readFile(realFile);
  } catch {
    return undefined;
  }
}

export async function listRenderers(ctx: WsContext): Promise<{ id: string; pluginName: string; hash: string }[]> {
  const out: { id: string; pluginName: string; hash: string }[] = [];
  for (const entry of ctx.project.registry.list("renderer")) {
    const m = moduleFileOf(ctx, entry.id);
    if (!m) {
      ctx.warn(`独自描画 "${entry.id}" のモジュール "${entry.value.module}" は使えません（プラグインのフォルダの中の .js / .mjs にしてください）。`);
      continue;
    }
    const data = await readModule(m.file, m.base);
    if (!data) {
      ctx.warn(`独自描画 "${entry.id}" のモジュール ${m.file} を読めませんでした。`);
      continue;
    }
    out.push({ id: entry.id, pluginName: m.pluginName, hash: textHash(data.toString("utf8")) });
  }
  return out;
}

export async function rendererModule(
  ctx: WsContext,
  id: string,
): Promise<{ source: string; hash: string; contentType: "text/javascript" } | undefined> {
  if (typeof id !== "string" || id === "") return undefined;
  const m = moduleFileOf(ctx, id);
  if (!m) return undefined;
  const data = await readModule(m.file, m.base).catch((err: unknown) => {
    ctx.warn(`独自描画 "${id}" のモジュールを読めませんでした: ${errorText(err)}`);
    return undefined;
  });
  if (!data) return undefined;
  const source = data.toString("utf8");
  return { source, hash: textHash(source), contentType: "text/javascript" };
}
