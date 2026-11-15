/**
 * SQLite のストアの速さ（時間の予算）。`npm run test:perf` で、ほかのテストと並べずに走らせる。
 * 正しさは store-contract.ts の「まとまった量」で確かめている。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "./sqlite-store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "loc-store-perf-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const COUNT = 10_000;
const writes = Array.from({ length: COUNT }, (_, i) => ({
  resourceId: `res${i % 7}`,
  entryKey: `key_${i}`,
  columnId: "status",
  language: i % 2 ? "ja" : "en",
  value: { i, text: `値 ${i}` },
}));

async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  const value = await fn();
  const ms = performance.now() - t;
  console.log(`[perf] ${name}: ${ms.toFixed(0)} ms`);
  expect(ms, name).toBeLessThan(3000);
  return value;
}

for (const [label, sharing] of [
  ["この PC だけ", undefined],
  ["共有モード（ロックファイル）", { mode: "lockfile" as const }],
] as const) {
  describe(`SQLite のストアの速さ: ${label}`, () => {
    it(`${COUNT} セルの set / get / 版を確かめた更新が、それぞれ 3 秒以内`, async () => {
      const store = await openStore({ path: path.join(dir, "meta.db"), userName: () => "perf", ...(sharing ? { sharing } : {}) });
      try {
        const cells = store.cells("perf");
        await timed("set", () => cells.set(writes));
        expect(await timed("get", () => cells.get(writes))).toHaveLength(COUNT);
        const again = await timed("update", () => cells.set(writes.map((w) => ({ ...w, expectedVersion: 1 }))));
        expect(again.every((c) => c.version === 2)).toBe(true);
      } finally {
        store.close();
      }
    });
  });
}
