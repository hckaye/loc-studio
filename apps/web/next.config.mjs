import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, "../..");

// プラグインは実行時にプラグインフォルダから読み込むので、サービス層とその依存はバンドルしない。
// 配布したビルドの隣のフォルダにプラグインを置けば、再ビルドなしで使えること。
//
// 注意: ワークスペースのパッケージ（node_modules/@loc-studio/* はシンボリックリンク）は、Next 16 の Turbopack では
// serverExternalPackages に書いてもバンドルされてしまう。そのため実際には lib/server/runtime.ts が
// 静的に解析されない import（turbopackIgnore）で読み込んでいる。ここに並べるのは、レジストリから入れた場合の保険。
// バンドルされていないことは scripts/smoke.mjs（npm run smoke:web）が確かめる。
const externals = [
  "@loc-studio/sdk",
  "@loc-studio/core",
  "@loc-studio/builtin",
  "@loc-studio/store",
  "@loc-studio/plugin-llm",
  "@loc-studio/server",
  "jiti",
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  serverExternalPackages: externals,
  // サービス層は実行時に import する（lib/server/runtime.ts）ので、静的解析では見つからない。
  // サービス層とその依存、プラグインが使う SDK を standalone に含める。
  outputFileTracingIncludes: {
    "/api/**": [
      "../../packages/*/dist/**/*",
      "../../packages/*/package.json",
      ...["sdk", "core", "builtin", "store", "plugin-llm", "server"].map((p) => `../../node_modules/@loc-studio/${p}`),
      "../../node_modules/jiti/**/*",
      "../../node_modules/picomatch/**/*",
    ],
  },
  turbopack: { root: repoRoot },
  reactStrictMode: true,
  // 守りのヘッダーの土台（Proxy が CSP とあわせて付け直す。Proxy を通らない応答があっても付くように）
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
  poweredByHeader: false,
  // next dev が AGENTS.md を書き出さないようにする
  agentRules: false,
};

export default nextConfig;
