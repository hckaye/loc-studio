"use client";
import { useEffect, useState } from "react";
import { isRpcError, postJson } from "@/lib/client/api";

/* ログインの画面（Web モード、password）。エラーの文言はサーバーのものをそのまま出す。 */
export function LoginScreen({ onLoggedIn, notice }: { onLoggedIn(): void; notice?: string | null }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  // 続けて失敗して待たされている間は、残りの秒数を出す
  useEffect(() => {
    if (waitUntil === null) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= waitUntil) setWaitUntil(null);
    }, 500);
    return () => clearInterval(t);
  }, [waitUntil]);
  const remaining = waitUntil !== null ? Math.max(0, Math.ceil((waitUntil - now) / 1000)) : 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/auth/login", { name, password });
      setPassword("");
      onLoggedIn();
    } catch (err) {
      // 失敗の理由は区別しない（名前の有無を教えない）。待たされているときだけ、待つ時間を出す
      setError(isRpcError(err, "throttled") ? "ログインの失敗が続いたため、しばらく待ってからやり直してください。" : err instanceof Error ? err.message : String(err));
      if (isRpcError(err, "throttled")) {
        const ms = (err.data as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
        if (typeof ms === "number") {
          setNow(Date.now());
          setWaitUntil(Date.now() + ms);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="open-project">
      <div className="open-card login-card">
        <h1 className="open-title">
          <span className="logo" aria-hidden="true">
            ◧
          </span>{" "}
          loc-studio
        </h1>
        <h2 className="section-title">ログイン</h2>
        {notice && <p className="muted small">{notice}</p>}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>ログイン名</span>
            <input className="input" autoComplete="username" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>パスワード</span>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <p className="hint-error" role="alert">
              {error}
              {remaining > 0 && <span>（あと {remaining} 秒）</span>}
            </p>
          )}
          <button type="submit" className="btn primary" disabled={busy || name.trim() === "" || password === "" || remaining > 0}>
            {remaining > 0 ? `${remaining} 秒後にやり直せます` : "ログイン"}
          </button>
        </form>
      </div>
    </main>
  );
}
