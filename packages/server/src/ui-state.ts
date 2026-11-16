/**
 * 画面の状態（開いていたリソース、絞り込み、並べ替え、列の表示、お気に入りの条件など）の置き場所。
 * その PC の DB（local.db）に、プロジェクトごと・利用者ごとに 1 つの JSON として置く。
 * ブラウザの保存領域は、デスクトップ版では起動のたびに接続先（ポート）が変わって読めなくなるので、サーバー側に持つ。
 * 中身は画面が決める（サービス層は形を見ない）。
 */
import { ApiError } from "./api-types.js";
import { currentCall } from "./call-context.js";
import type { WsContext } from "./context.js";

const UI_STATE_NS = "core.ui-state";
/** 1 つの状態の大きさの上限（JSON にした文字数）。 */
export const MAX_UI_STATE_LENGTH = 512 * 1024;

/** ローカルモードは 1 人。Web モードは、呼び出した利用者ごと。 */
const stateKey = (): string => {
  const call = currentCall();
  return call ? `user:${call.user.name}` : "local";
};

export async function uiState(ctx: WsContext): Promise<{ state: Record<string, unknown> | null }> {
  const value = await ctx.local.kv(UI_STATE_NS).get(stateKey());
  return { state: value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null };
}

export async function setUiState(ctx: WsContext, params: { state: Record<string, unknown> | null }): Promise<{ saved: boolean }> {
  const state = params?.state;
  const kv = ctx.local.kv(UI_STATE_NS);
  if (state === null) {
    await kv.delete(stateKey());
    return { saved: true };
  }
  if (typeof state !== "object" || state === undefined || Array.isArray(state)) throw new ApiError("invalid", "state はオブジェクトか null で指定してください。");
  let length: number;
  try {
    length = JSON.stringify(state).length;
  } catch {
    throw new ApiError("invalid", "state を JSON にできません。");
  }
  if (length > MAX_UI_STATE_LENGTH) throw new ApiError("invalid", `画面の状態が大きすぎます（${length} 文字。上限は ${MAX_UI_STATE_LENGTH} 文字）。`);
  await kv.set(stateKey(), state);
  return { saved: true };
}
