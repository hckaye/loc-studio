"use client";
import { useEffect, useRef, useState } from "react";
import type { WebSession } from "@/components/Studio";
import { ChangePasswordDialog } from "@/components/web/ChangePasswordDialog";

/* 上のバーの利用者のメニュー（Web モード）: 表示名、パスワードの変更、管理（管理者）、ログアウト。 */
export function UserMenu({ session }: { session: WebSession }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const u = session.user;
  return (
    <div className="popover-anchor" ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button type="button" className="btn small ghost user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={u.name}>
        👤 {u.displayName || u.name}
        {u.admin && <span className="badge">管理者</span>} ▾
      </button>
      {open && (
        <div className="popover right menu-pop" role="menu" aria-label="利用者のメニュー">
          <div className="menu-head small">
            <div>{u.displayName || u.name}</div>
            <div className="muted mono">{u.name}</div>
          </div>
          {session.authMode === "password" && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => (setOpen(false), setPw(true))}>
              パスワードの変更
            </button>
          )}
          {u.admin && session.onOpenAdmin && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => (setOpen(false), session.onOpenAdmin!())}>
              管理
            </button>
          )}
          {session.authMode === "password" && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => (setOpen(false), session.onLogout())}>
              ログアウト
            </button>
          )}
        </div>
      )}
      {pw && <ChangePasswordDialog onClose={() => setPw(false)} />}
    </div>
  );
}
