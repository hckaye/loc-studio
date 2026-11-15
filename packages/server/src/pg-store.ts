/**
 * Postgres の Store を開く（@loc-studio/store の openPostgresStore）。Postgres を扱うのはこのモジュールだけ。
 */
import { openPostgresStore } from "@loc-studio/store";
import type { OpenPostgresStoreOptions, Store } from "@loc-studio/store";

export type PostgresStoreOptions = OpenPostgresStoreOptions;

/** この版で Postgres を使えるか（@loc-studio/store が openPostgresStore を持つか）。 */
export function postgresAvailable(): boolean {
  return typeof openPostgresStore === "function";
}

export function openPostgres(opts: PostgresStoreOptions): Promise<Store> {
  return openPostgresStore(opts);
}

/** 接続文字列からパスワードを伏せる（表示とエラー用）。 */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:****@");
  }
}
