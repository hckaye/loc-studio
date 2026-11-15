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
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
          exclude: ["**/node_modules/**", "apps/web/**"],
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
