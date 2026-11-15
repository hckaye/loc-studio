/**
 * RPC の口。画面側の 1 つのルートがこれを呼ぶ。
 */
import { LockTimeoutError } from "@loc-studio/core";
import { StoreConflictError } from "@loc-studio/sdk";
import { ApiError, WORKSPACE_METHODS } from "./api-types.js";
import type { ApiErrorCode, CallContext, Workspace, WorkspaceApi } from "./api-types.js";
import { runWithCall } from "./call-context.js";
import { checkMethod } from "./permissions.js";
import { redactError, redactResult } from "./redact.js";
import type { RedactionPaths } from "./redact.js";

export type RpcResponse = { result: unknown } | { error: { code: ApiErrorCode; message: string; data?: unknown } };

const allowed = new Set<string>(WORKSPACE_METHODS);

export function toRpcError(err: unknown): { code: ApiErrorCode; message: string; data?: unknown } {
  if (err instanceof ApiError) return err.data !== undefined ? { code: err.code, message: err.message, data: err.data } : { code: err.code, message: err.message };
  if (err instanceof StoreConflictError || (err instanceof Error && err.name === "StoreConflictError")) {
    return { code: "conflict", message: err.message, data: (err as StoreConflictError).conflicts };
  }
  if (err instanceof LockTimeoutError || (err instanceof Error && err.name === "LockTimeoutError")) {
    const e = err as LockTimeoutError;
    return { code: "locked", message: e.message, data: { lockPath: e.lockPath, holder: e.holder } };
  }
  return { code: "failed", message: err instanceof Error ? err.message : String(err) };
}

/**
 * RPC の口。call（Web モードの利用者）を渡すと、メソッドの権限を確かめ、呼び出しの間の記録をその利用者の名前で残す。
 * call がなければローカルモード（従来どおり、すべて許す）。
 */
export async function dispatch(
  workspace: WorkspaceApi & Partial<Pick<Workspace, "withCall" | "redaction">>,
  method: string,
  params: unknown,
  call?: CallContext,
): Promise<RpcResponse> {
  if (typeof method !== "string" || !allowed.has(method)) {
    return { error: { code: "not-found", message: `メソッド "${String(method)}" はありません。` } };
  }
  // 管理者でない Web の利用者には、サーバーのパスや内部のエラーを伏せて返す。
  const redact: RedactionPaths | undefined =
    call && !call.admin ? (workspace.redaction?.() ?? { paths: [], log: (m: string) => console.error(m) }) : undefined;
  try {
    const fn = workspace[method as keyof WorkspaceApi] as (p: unknown) => Promise<unknown>;
    const invoke = () => fn.call(workspace, params ?? {});
    let result: unknown;
    if (call) {
      checkMethod(call, method as keyof WorkspaceApi);
      result = workspace.withCall ? await workspace.withCall(call, invoke) : await runWithCall({ call }, invoke);
    } else {
      result = await invoke();
    }
    if (redact) result = redactResult(method, result, redact);
    return { result: result === undefined ? null : result };
  } catch (err) {
    const e = toRpcError(err);
    return { error: redact ? redactError(e, redact, method) : e };
  }
}
