"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

/* モーダルのダイアログ。role="dialog"、フォーカスを中に閉じ込める、Esc で閉じる。 */

/** 開いているダイアログの順（いちばん上だけが Esc を受ける）。 */
const dialogStack: symbol[] = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Esc を受けたときの処理（既定は onClose）。編集中の確認などに使う。 */
  onEscape?(): void;
  initialFocus?: string;
  headerExtra?: ReactNode;
  ariaLabel?: string;
}

export function Dialog({ title, onClose, children, footer, className, onEscape, initialFocus, headerExtra, ariaLabel }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const escRef = useRef(onEscape ?? onClose);
  escRef.current = onEscape ?? onClose;

  // フォーカスがダイアログの外（通知など）にあっても、いちばん上のダイアログは Esc で閉じる
  useEffect(() => {
    const id = Symbol("dialog");
    dialogStack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (dialogStack[dialogStack.length - 1] !== id) return;
      if (ref.current?.contains(e.target as Node)) return; // 中のキーは onKeyDown が扱う
      e.preventDefault();
      escRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = dialogStack.indexOf(id);
      if (i >= 0) dialogStack.splice(i, 1);
    };
  }, []);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) {
      const target = (initialFocus ? el.querySelector<HTMLElement>(initialFocus) : null) ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el;
      target.focus();
    }
    return () => {
      // 開く前の場所にフォーカスを戻す
      if (prev && document.contains(prev)) prev.focus();
    };
    // 開いたときだけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !e.nativeEvent.isComposing) {
      e.stopPropagation();
      e.preventDefault();
      escRef.current();
      return;
    }
    if (e.key === "Tab" && ref.current) {
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && escRef.current()}>
      <div
        ref={ref}
        className={`dialog ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        {...(ariaLabel ? { "aria-label": ariaLabel } : { "aria-labelledby": titleId })}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-header">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          {headerExtra}
          <button type="button" className="icon-btn" aria-label="閉じる" onClick={() => escRef.current()}>
            ×
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
