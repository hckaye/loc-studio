import { createHash } from "node:crypto";
import { stableStringify } from "@loc-studio/core";

/** 本文の版: UTF-8 の SHA-256（16 進）。 */
export function textHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 列の値の版。文字列は本文と同じ規則、それ以外はキー順を固定した JSON のハッシュ。 */
export function valueHash(value: unknown): string {
  if (typeof value === "string") return textHash(value);
  return textHash(stableStringify(value ?? null));
}

/** 生成結果のキャッシュの鍵。 */
export function generatorCacheKey(id: string, version: string, params: unknown, input: unknown): string {
  return textHash(["loc-studio/generated/1", id, version, stableStringify(params), stableStringify(input)].join("\n"));
}
