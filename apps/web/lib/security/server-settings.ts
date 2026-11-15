import { readFileSync } from "node:fs";
import path from "node:path";
import { parseHostList } from "./hosts";
import { parseMode, type Mode } from "./mode";

/*
 * 守りに使う設定（要求ごとに読むので、1 回読んで覚える）。
 * Web モードの allowedHosts と auth.trustedProxyHops は server.json から読む（サービス層の設定の読み込みは
 * 知らない項目を無視するので、allowedHosts を同じファイルに書ける）。
 */

export interface SecuritySettings {
  mode: Mode;
  allowedHosts: string[];
  trustedProxyHops: number;
  /** web で allowedHosts も LOC_STUDIO_ALLOWED_HOSTS もないとき（ループバックだけを許す）。 */
  loopbackOnlyWeb: boolean;
}

let cached: { key: string; value: SecuritySettings } | undefined;
// Proxy とルートは別のモジュールとして読み込まれるので、警告を 1 回にする印はプロセスに 1 つ置く
const WARNED = Symbol.for("loc-studio.web.warned-loopback-only");

export function serverConfigFile(env: Record<string, string | undefined>, dataDir: string | undefined): string | undefined {
  if (env["LOC_STUDIO_SERVER_CONFIG"]) return path.resolve(env["LOC_STUDIO_SERVER_CONFIG"]);
  const base = env["LOC_STUDIO_USER_DATA_DIR"] || dataDir;
  return base ? path.join(path.resolve(base), "server.json") : undefined;
}

/** 例外: モードの誤り、Web モードで設定ファイルが読めない。呼び出し側は 500 にする。 */
export function securitySettings(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): SecuritySettings {
  const key = [env["LOC_STUDIO_MODE"], env["LOC_STUDIO_ALLOWED_HOSTS"], env["LOC_STUDIO_SERVER_CONFIG"], env["LOC_STUDIO_USER_DATA_DIR"]].join("\u0000");
  if (cached && cached.key === key) return cached.value;
  const mode = parseMode(env["LOC_STUDIO_MODE"]);
  const extra = parseHostList(env["LOC_STUDIO_ALLOWED_HOSTS"]);
  let trustedProxyHops = 0;
  let fromConfig: string[] = [];
  if (mode === "web") {
    const file = serverConfigFile(env, undefined);
    // 起動の仕組み（launch.mjs）が、サービス層と同じ決め方で見つけたファイルを LOC_STUDIO_SERVER_CONFIG に入れて渡す
    if (!file) throw new Error("Web モードのサーバーの設定ファイルが決まりません（launch.mjs で起動するか、LOC_STUDIO_SERVER_CONFIG を設定してください）。");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`Web モードのサーバーの設定ファイルを読めません: ${(err as Error).message.split("\n")[0]}`);
    }
    const r = (raw ?? {}) as { allowedHosts?: unknown; auth?: { trustedProxyHops?: unknown } };
    if (Array.isArray(r.allowedHosts)) fromConfig = parseHostList(r.allowedHosts.filter((x) => typeof x === "string").join(","));
    const hops = r.auth?.trustedProxyHops;
    trustedProxyHops = typeof hops === "number" && Number.isInteger(hops) && hops > 0 && hops <= 10 ? hops : 0;
  }
  const allowedHosts = [...new Set([...extra, ...fromConfig])];
  const value: SecuritySettings = { mode, allowedHosts, trustedProxyHops, loopbackOnlyWeb: mode === "web" && allowedHosts.length === 0 };
  const g = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (value.loopbackOnlyWeb && !g[WARNED]) {
    g[WARNED] = true;
    console.warn("[loc-studio] Web モードですが allowedHosts（server.json）も LOC_STUDIO_ALLOWED_HOSTS も設定されていません。ループバック（localhost）からの要求だけを受け付けます。");
  }
  cached = { key, value };
  return value;
}

export function resetSecuritySettingsCache(): void {
  cached = undefined;
}
