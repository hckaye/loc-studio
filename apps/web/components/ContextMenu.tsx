"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/*
 * 右クリックのメニュー。画面の座標に出し、画面の端からはみ出さない位置に寄せる。
 * 外を押す、Esc、スクロール、ウィンドウの大きさの変更で閉じる。↑↓ で項目を移り、Enter で選ぶ。
 */

export type ContextMenuItem =
  | { kind: "separator"; id: string }
  /** まとまりの見出し（押せない）。 */
  | { kind: "header"; id: string; label: string }
  | {
      kind?: "item";
      id: string;
      label: string;
      /** 押せないときの理由（ツールチップにも出す）。あれば、押せない。 */
      disabledReason?: string | undefined;
      /** 取り消せない操作（削除など）。 */
      danger?: boolean;
      /** 右に出す補足（ショートカットなど）。 */
      hint?: string;
      onSelect(): void;
    };

export interface ContextMenuProps {
  x: number;
  y: number;
  label: string;
  items: ContextMenuItem[];
  onClose(): void;
}

export function ContextMenu({ x, y, label, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 画面の右や下にはみ出すなら、内側に寄せる。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    setPos({ left, top });
  }, [x, y, items.length]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    // 表をスクロールしたら閉じる（メニューの位置が、押したセルからずれるため）。メニューの中のスクロールでは閉じない。
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const enabled = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = enabled.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      enabled[(at + 1) % enabled.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      enabled[(at - 1 + enabled.length) % enabled.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      enabled[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      enabled[enabled.length - 1]?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="context-menu menu-pop"
      role="menu"
      aria-label={label}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKeyDown}
      // メニューの上での右クリックで、ブラウザのメニューを出さない。
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => {
        if (item.kind === "separator") return <div key={item.id} className="context-menu-sep" role="separator" />;
        if (item.kind === "header")
          return (
            <div key={item.id} className="context-menu-head muted small" role="presentation">
              {item.label}
            </div>
          );
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`menu-item${item.danger ? " danger" : ""}`}
            disabled={item.disabledReason !== undefined}
            title={item.disabledReason}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="context-menu-hint muted small">{item.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
