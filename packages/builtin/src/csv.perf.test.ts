/**
 * CSV の速さ（時間の予算）。`npm run test:perf` で、ほかのテストと並べずに走らせる。
 * 正しさは csv.test.ts の「大きなファイル」で確かめている。
 */
import { describe, expect, it } from "vitest";
import type { Change, FormatContext } from "@loc-studio/sdk";
import { csvFormat } from "./csv.js";

const ROWS = 50_000;
const ctx: FormatContext = {
  resource: { id: "big.csv", path: "big.csv", name: "big.csv" },
  languages: ["ja", "en", "fr", "de", "zh", "ko"].map((id) => ({ id, label: id })),
  options: {},
};

function bigCsv(): Uint8Array {
  const parts: string[] = ["key,ja,en,fr,de,zh\n"];
  for (let i = 0; i < ROWS; i++) parts.push(`key_${i},"日本語の本文 ${i}, 引用符 """,English text ${i},Français ${i},Deutsch ${i},中文 ${i}😀\r\n`);
  return new TextEncoder().encode(parts.join(""));
}

function timed<T>(fn: () => T): { ms: number; value: T } {
  const t = performance.now();
  const value = fn();
  return { ms: performance.now() - t, value };
}

describe(`CSV の速さ（${ROWS} 行 × 6 列）`, () => {
  const input = bigCsv();

  it("解析は 5 秒以内", () => {
    const { ms, value } = timed(() => csvFormat.parse(input, ctx));
    console.log(`[perf] csv parse: ${ms.toFixed(0)} ms`);
    expect(value.entries).toHaveLength(ROWS);
    expect(ms).toBeLessThan(5000);
  });

  it("離れた 20 行への変更と、行の追加・削除は 5 秒以内", () => {
    const changes: Change[] = Array.from({ length: 20 }, (_, i): Change => ({ type: "set", key: `key_${i * 2500}`, field: { kind: "text", language: "en" }, value: `changed ${i}` }));
    changes.push({ type: "add", after: "key_100", entry: { key: "new", text: { ja: "新" } } }, { type: "remove", key: "key_200" });
    const { ms, value } = timed(() => csvFormat.apply(input, changes, ctx));
    console.log(`[perf] csv apply(22 changes): ${ms.toFixed(0)} ms`);
    expect(value.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(5000);
  });

  it("見出しにない列を足して全行に空のフィールドを足すのは 5 秒以内", () => {
    const changes: Change[] = Array.from({ length: 10 }, (_, i): Change => ({ type: "set", key: `key_${i * 5000}`, field: { kind: "text", language: "ko" }, value: `한국어 ${i}` }));
    const { ms, value } = timed(() => csvFormat.apply(input, changes, ctx));
    console.log(`[perf] csv apply(add column): ${ms.toFixed(0)} ms`);
    expect(value.length).toBeGreaterThan(input.length);
    expect(ms).toBeLessThan(5000);
  });
});
