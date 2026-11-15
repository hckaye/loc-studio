"use client";
import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { useToasts } from "@/components/context";
import { postJson } from "@/lib/client/api";

/* 自分のパスワードの変更（Web モード）。 */
export function ChangePasswordDialog({ onClose }: { onClose(): void }) {
  const { push } = useToasts();
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = again !== "" && again !== newPassword;
  const tooShort = newPassword !== "" && newPassword.length < 8;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/auth/password", { oldPassword, newPassword });
      push("success", "パスワードを変更しました。ほかの端末のログインは無効になりました。");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="パスワードの変更"
      className="small-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn primary" disabled={busy || !oldPassword || !newPassword || mismatch || tooShort || again === ""} onClick={() => void submit()}>
            変更する
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>いまのパスワード</span>
          <input className="input" type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} />
        </label>
        <label className="field">
          <span>新しいパスワード（8 文字以上）</span>
          <input className="input" type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} />
        </label>
        <label className="field">
          <span>新しいパスワード（確認）</span>
          <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        {tooShort && <p className="hint-error">8 文字以上にしてください。</p>}
        {mismatch && <p className="hint-error">確認のパスワードが一致しません。</p>}
        {error && (
          <p className="hint-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
