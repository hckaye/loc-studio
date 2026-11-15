import type { ApiErrorCode, WorkspaceApi } from "@loc-studio/server";

/** 画面から呼ぶ API。WorkspaceApi のメソッドをそのまま RPC で呼ぶ。 */
export type ClientApi = {
  [K in keyof WorkspaceApi]: (
    ...args: Parameters<WorkspaceApi[K]> extends [] ? [] : Parameters<WorkspaceApi[K]>
  ) => ReturnType<WorkspaceApi[K]>;
};

export type RpcErrorCode = ApiErrorCode | "network" | "bad-response";

/** API の失敗。サーバーの日本語のメッセージをそのまま持つ。 */
export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly data?: unknown;
  readonly method: string;
  constructor(method: string, code: RpcErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.method = method;
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export function isRpcError(err: unknown, code?: RpcErrorCode): err is RpcError {
  return err instanceof RpcError && (code === undefined || err.code === code);
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RpcClientOptions {
  project?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** 認証が切れた（unauthorized）ときに呼ぶ（Web モードでログインの画面へ戻す）。 */
  onUnauthorized?(err: RpcError): void;
  /** コードの設定を信頼していないため、制限された状態になった（untrusted）とき。 */
  onUntrusted?(err: RpcError): void;
}

/** 応答の本文を、結果か RpcError にする。 */
export async function readRpcResponse(method: string, res: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RpcError(method, "bad-response", `サーバーの応答を読めませんでした（${method}、HTTP ${res.status}）。`);
  }
  if (body && typeof body === "object" && "error" in body && (body as { error: unknown }).error) {
    const e = (body as { error: { code?: unknown; message?: unknown; data?: unknown } }).error;
    const code = typeof e.code === "string" ? (e.code as RpcErrorCode) : "failed";
    const message = typeof e.message === "string" && e.message !== "" ? e.message : `${method} に失敗しました。`;
    throw new RpcError(method, code, message, e.data);
  }
  if (!res.ok) {
    throw new RpcError(method, "bad-response", `サーバーがエラーを返しました（${method}、HTTP ${res.status}）。`);
  }
  if (body && typeof body === "object" && "result" in body) return (body as { result: unknown }).result;
  throw new RpcError(method, "bad-response", `サーバーの応答の形が正しくありません（${method}）。`);
}

export async function callRpc(method: string, params: unknown, opts: RpcClientOptions = {}): Promise<unknown> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl ?? ""}/api/rpc/${encodeURIComponent(method)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(opts.project ? { project: opts.project } : {}), params: params ?? {} }),
      cache: "no-store",
    });
  } catch (err) {
    throw new RpcError(method, "network", `サーバーに接続できませんでした（${method}）: ${(err as Error).message}`);
  }
  try {
    return await readRpcResponse(method, res);
  } catch (err) {
    if (err instanceof RpcError && err.code === "unauthorized") opts.onUnauthorized?.(err);
    if (err instanceof RpcError && err.code === "untrusted") opts.onUntrusted?.(err);
    throw err;
  }
}

/** 認証や管理の口（/api/auth/*、/api/admin/*）を呼ぶ。失敗は RpcError。 */
export async function postJson(url: string, body: unknown, opts: Pick<RpcClientOptions, "fetch" | "onUnauthorized"> = {}): Promise<unknown> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), cache: "no-store" });
  } catch (err) {
    throw new RpcError(url, "network", `サーバーに接続できませんでした: ${(err as Error).message}`);
  }
  try {
    return await readRpcResponse(url, res);
  } catch (err) {
    if (err instanceof RpcError && err.code === "unauthorized") opts.onUnauthorized?.(err);
    throw err;
  }
}

export async function getJson(url: string, opts: Pick<RpcClientOptions, "fetch" | "onUnauthorized"> = {}): Promise<unknown> {
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(url, { method: "GET", cache: "no-store" });
  } catch (err) {
    throw new RpcError(url, "network", `サーバーに接続できませんでした: ${(err as Error).message}`);
  }
  try {
    return await readRpcResponse(url, res);
  } catch (err) {
    if (err instanceof RpcError && err.code === "unauthorized") opts.onUnauthorized?.(err);
    throw err;
  }
}

/** api.<method>(params) の形で呼べるクライアント。メソッド名は WorkspaceApi の型で決まる。 */
export function createApi(opts: RpcClientOptions = {}): ClientApi {
  const cache = new Map<string, (params?: unknown) => Promise<unknown>>();
  return new Proxy({} as ClientApi, {
    get(_target, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      let fn = cache.get(prop);
      if (!fn) {
        fn = (params?: unknown) => callRpc(prop, params, opts);
        cache.set(prop, fn);
      }
      return fn;
    },
  });
}
