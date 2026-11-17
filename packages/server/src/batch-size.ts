/**
 * まとめて実行するときの「1 回にまとめる数」（生成の batchSize、アクションの batchSize）の確認。
 */
import { ApiError } from "./api-types.js";

/** 1 回にまとめる数の上限。 */
export const MAX_BATCH_SIZE = 1000;

/** batchSize の形を確かめる。指定がなければ undefined。1 以上 MAX_BATCH_SIZE 以下の整数でなければ invalid。 */
export function batchSizeOf(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new ApiError("invalid", `batchSize は 1 以上 ${MAX_BATCH_SIZE} 以下の整数で指定してください（${JSON.stringify(value)}）。`);
  }
  return value;
}
