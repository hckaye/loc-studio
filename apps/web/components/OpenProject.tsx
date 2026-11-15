"use client";
import { useEffect, useState } from "react";

/* プロジェクトを開く画面: パスの入力、最近のプロジェクト、（デスクトップ版なら）フォルダの選択。 */
export function OpenProject({
  recent,
  loading,
  error,
  onOpen,
  initialPath = "",
}: {
  recent: string[];
  loading: boolean;
  error: string | null;
  onOpen(path: string): void;
  /** URL の ?project= から入れておく値（開くのは利用者が「開く」を押したときだけ）。 */
  initialPath?: string;
}) {
  const [path, setPath] = useState(initialPath);
  const [canPick, setCanPick] = useState(false);
  useEffect(() => setCanPick(typeof window !== "undefined" && typeof window.locStudio?.pickFolder === "function"), []);

  const pick = async () => {
    const p = await window.locStudio?.pickFolder?.();
    if (p) {
      setPath(p);
      onOpen(p);
    }
  };

  return (
    <main className="open-project">
      <div className="open-card">
        <h1 className="open-title">
          <span className="logo" aria-hidden="true">
            ◧
          </span>{" "}
          loc-studio
        </h1>
        <h2 className="section-title">プロジェクトを開く</h2>
        <form
          className="open-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) onOpen(path.trim());
          }}
        >
          <label htmlFor="project-path" className="field-label">
            プロジェクトのフォルダ（loc-studio.project.json のあるフォルダ）
          </label>
          <div className="row">
            <input id="project-path" className="input mono grow" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/project" autoFocus />
            {canPick && (
              <button type="button" className="btn" onClick={() => void pick()}>
                フォルダを選ぶ…
              </button>
            )}
            <button type="submit" className="btn primary" disabled={loading || path.trim() === ""}>
              開く
            </button>
          </div>
        </form>
        {loading && <p className="muted small">読み込み中…</p>}
        {error && (
          <p className="hint-error" role="alert">
            {error}
          </p>
        )}
        {recent.length > 0 && (
          <>
            <h2 className="section-title">最近のプロジェクト</h2>
            <ul className="recent-list">
              {recent.map((r) => (
                <li key={r}>
                  <button type="button" className="recent-btn mono" onClick={() => onOpen(r)} disabled={loading}>
                    {r}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
