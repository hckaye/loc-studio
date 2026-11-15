/**
 * 変更履歴（log("core.history")）と本文の版（kv("core.text-versions")）の読み出し。
 */
import type { CellRef, LogRecord } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { HistoryInfo } from "./api-types.js";
import type { HistoryData, WsContext } from "./context.js";
import { HISTORY_NS, TEXT_VERSIONS_NS } from "./context.js";

const DEFAULT_LIMIT = 100;
/** 1 回に返す履歴の上限（多すぎる要求でサーバーを止めないため）。 */
export const MAX_HISTORY_LIMIT = 1000;

export async function history(
  ctx: WsContext,
  params: { resourceId: string; key: string; cellId?: string; limit?: number },
): Promise<HistoryInfo[]> {
  const { resourceId, key } = params ?? ({} as typeof params);
  if (typeof resourceId !== "string" || resourceId === "") throw new ApiError("invalid", "resourceId を指定してください。");
  if (typeof key !== "string") throw new ApiError("invalid", "key を指定してください。");
  const limit = Math.min(MAX_HISTORY_LIMIT, params.limit !== undefined ? Math.max(0, Math.floor(Number(params.limit)) || 0) : DEFAULT_LIMIT);
  const log = ctx.shared.log<HistoryData>(HISTORY_NS);

  // 行が消えていても履歴は見られるよう、リソースの中身は確かめない。
  let refs: CellRef[];
  if (params.cellId !== undefined) {
    const { column, language } = ctx.parseCellId(params.cellId);
    refs = [ctx.cellRef(resourceId, key, column, language?.id)];
  } else {
    refs = [];
    for (const column of ctx.columns()) {
      if (column.kind === "actions" || column.kind === "key") continue;
      if (column.scope === "entry") refs.push(ctx.cellRef(resourceId, key, column));
      else for (const l of ctx.project.languages) if (ctx.applies(column, l.id)) refs.push(ctx.cellRef(resourceId, key, column, l.id));
    }
  }
  const lists = await Promise.all(refs.map((cell) => log.list({ cell, limit })));
  const all: LogRecord<HistoryData>[] = lists.flat();
  // 各セルの一覧は新しい順。セルをまたいで日時で並べ直す（同じ日時なら元の順を保つ）。
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return all.slice(0, limit).map((rec) => toHistoryInfo(ctx, rec));
}

function toHistoryInfo(ctx: WsContext, rec: LogRecord<HistoryData>): HistoryInfo {
  const cell = rec.cell;
  const column = cell ? ctx.column(cell.columnId) : undefined;
  const cellId = cell ? (column ? ctx.cellId(column, cell.language) : cell.language ? `${cell.columnId}@${cell.language}` : cell.columnId) : "";
  const info: HistoryInfo = {
    id: rec.id,
    at: rec.at,
    by: rec.by,
    cellId,
    oldValue: rec.data?.oldValue,
    newValue: rec.data?.newValue,
    cause: rec.data?.cause ?? "manual",
  };
  if (rec.data?.causeRef !== undefined) info.causeRef = rec.data.causeRef;
  return info;
}

export async function textVersion(ctx: WsContext, params: { hash: string }): Promise<{ text?: string }> {
  if (typeof params?.hash !== "string" || params.hash === "") throw new ApiError("invalid", "hash を指定してください。");
  const v = await ctx.shared.kv(TEXT_VERSIONS_NS).get(params.hash);
  return typeof v === "string" ? { text: v } : {};
}
