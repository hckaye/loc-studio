import type { HostDb, PluginHost, SecretReader } from "@loc-studio/sdk";

export interface CreatePluginHostInput {
  db: HostDb;
  /** いまの利用者名。設定の変更が反映されるよう、使うたびに呼ぶ。 */
  userName: () => string;
  projectRoot: string;
  /** 省略時は process.env。 */
  env?: Record<string, string | undefined>;
  /** 省略時は env から読む（envSecrets）。 */
  secrets?: SecretReader;
  /** 省略時は globalThis.fetch。 */
  fetch?: typeof fetch;
  /** 省略時は標準エラー出力。 */
  log?: (message: string) => void;
}

/** 秘密情報の名前に対応する環境変数名。例: "llm.apiKey" → "LOC_STUDIO_SECRET_LLM_APIKEY"。 */
export const secretEnvName = (name: string): string => `LOC_STUDIO_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/**
 * 秘密情報を読む。extra（ローカル設定の秘密情報など）を先に見て、なければ環境変数を見る。
 * 空文字は「ない」として扱う。
 */
export function envSecrets(env: Record<string, string | undefined>, extra?: Record<string, string>): SecretReader {
  return {
    get(name) {
      const fromExtra = extra?.[name];
      if (fromExtra !== undefined && fromExtra !== "") return fromExtra;
      const fromEnv = env[secretEnvName(name)];
      return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
    },
  };
}

/** プラグインに渡すホストの機能をまとめる。 */
export function createPluginHost(input: CreatePluginHostInput): PluginHost {
  const env = input.env ?? process.env;
  const secrets = input.secrets ?? envSecrets(env);
  const doFetch: typeof fetch = input.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const log = input.log ?? ((message: string) => console.error(message));
  const userName = input.userName;
  return {
    db: input.db,
    // ローカル設定でユーザー名を変えたらすぐ反映されるよう、読むたびに求める。
    user: {
      get name() {
        return userName();
      },
    },
    secrets,
    env,
    projectRoot: input.projectRoot,
    fetch: doFetch,
    log,
  };
}
