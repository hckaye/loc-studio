"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectInfo } from "@loc-studio/server";
import { isRpcError, type ClientApi } from "@/lib/client/api";

/* 画面全体で使うもの: API、プロジェクトの情報、通知。 */

export type ToastKind = "info" | "success" | "warning" | "error";
export interface ToastAction {
  label: string;
  run(): void;
}
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastApi {
  toasts: Toast[];
  push(kind: ToastKind, message: string, action?: ToastAction): void;
  dismiss(id: number): void;
  /** 例外を通知にする。握りつぶさない。 */
  reportError(err: unknown, context?: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, message: string, action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-5), { id, kind, message, ...(action ? { action } : {}) }]);
      // エラーと、操作ボタンのある通知は利用者が閉じるまで残す
      if (kind !== "error" && !action) setTimeout(() => dismiss(id), kind === "warning" ? 8000 : 4000);
    },
    [dismiss],
  );
  const reportError = useCallback(
    (err: unknown, context?: string) => {
      // 制限された状態（コードの設定を信頼していない）は、画面全体を確認の画面に切り替えて扱うので通知しない
      if (isRpcError(err, "untrusted")) return;
      const message = err instanceof Error ? err.message : String(err);
      if (!isRpcError(err)) console.error(err);
      push("error", context ? `${context}: ${message}` : message);
    },
    [push],
  );
  const value = useMemo(() => ({ toasts, push, dismiss, reportError }), [toasts, push, dismiss, reportError]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToasts(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("ToastProvider の外で useToasts が呼ばれました。");
  return ctx;
}

export interface StudioState {
  api: ClientApi;
  project: string;
  info: ProjectInfo;
  setInfo(info: ProjectInfo): void;
  /** local: 1 人で使う。web: サーバーに置いて複数人で使う（認証と権限あり）。 */
  mode?: "local" | "web";
}

const StudioContext = createContext<StudioState | null>(null);

export function StudioProvider({ value, children }: { value: StudioState; children: ReactNode }) {
  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudioOptional(): StudioState | null {
  return useContext(StudioContext);
}

export function useStudio(): StudioState {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error("StudioProvider の外で useStudio が呼ばれました。");
  return ctx;
}

export function ToastArea() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" role="region" aria-label="通知" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button type="button" className="btn small" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="通知を閉じる" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
