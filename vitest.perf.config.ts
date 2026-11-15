import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/*
 * 時間の予算を見るテスト（*.perf.test.ts）だけを、1 ファイルずつ順に走らせる。
 * ほかのテストと並べて走らせると、CPU やディスクの混み具合で時間がぶれ、通ったり落ちたりする。
 * 通常の `npm test` には入れず、`npm run test:perf` で走らせる。
 */
export default mergeConfig(
  { resolve: base.resolve },
  defineConfig({
    test: {
      testTimeout: 180_000,
      include: ["packages/**/*.perf.test.ts", "apps/**/*.perf.test.ts"],
      // 画面のビルド（.next/standalone）は、ソースの写しを含む。写しのテストは拾わない。
      exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", "apps/desktop/build/**", "apps/desktop/release/**"],
      fileParallelism: false,
    },
  }),
);
