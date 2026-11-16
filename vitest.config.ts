import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@loc-studio/sdk": src("./packages/sdk/src/index.ts"),
      "@loc-studio/core": src("./packages/core/src/index.ts"),
      "@loc-studio/builtin": src("./packages/builtin/src/index.ts"),
      "@loc-studio/store": src("./packages/store/src/index.ts"),
      "@loc-studio/plugin-llm": src("./packages/plugin-llm/src/index.ts"),
      "@loc-studio/server": src("./packages/server/src/index.ts"),
    },
  },
  test: {
    testTimeout: 20000,
    // 準備（beforeEach）でプロジェクトを写してワークスペースを開く。新しい環境での 1 回目は、プラグインの読み込みなどで 10 秒（既定）を超えることがある
    // （Linux のコンテナで、1 回目の実行だけ準備が打ち切られて落ちた）。
    hookTimeout: 30000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
          // *.perf.test.ts は時間の予算を見るテスト。並べて走らせると結果がぶれるので、`npm run test:perf` で単独に走らせる。
          // apps/desktop/build と release は梱包の出力で、サーバーに入るパッケージの写し（テストのファイルも入る）がある。
          exclude: ["**/node_modules/**", "apps/web/**", "apps/desktop/build/**", "apps/desktop/release/**", "**/*.perf.test.ts"],
        },
      },
      {
        // 画面（apps/web）のコンポーネントのテスト。jsdom で動かす。
        extends: true,
        resolve: { alias: { "@": src("./apps/web") } },
        esbuild: { jsx: "automatic" },
        test: {
          name: "web",
          environment: "jsdom",
          include: ["apps/web/**/*.test.{ts,tsx}"],
          exclude: ["**/node_modules/**", "apps/web/.next/**"],
          setupFiles: ["apps/web/test/setup.ts"],
        },
      },
    ],
  },
});
