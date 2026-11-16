"use client";
import { useEffect, useState } from "react";

/*
 * 最初の画面（ローカルモード）: 新しいプロジェクトを作る、既存のプロジェクトを開く（パスの入力、デスクトップ版ならフォルダの選択）、
 * 最近のプロジェクト。
 */
export function OpenProject({
  recent,
  loading,
  error,
  onOpen,
  onCreate,
  createOffer,
  initialPath = "",
}: {
  recent: string[];
  loading: boolean;
  error: string | null;
  onOpen(path: string): void;
  /** 新しいプロジェクトを作る画面へ進む。path は、フォルダの欄に入れておく値。 */
  onCreate(path?: string): void;
  /** 開こうとしたフォルダに、まだプロジェクトがなかった（そのフォルダに作ることを勧める）。 */
  createOffer?: string | null;
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
        <p className="muted">
          ゲームの翻訳テキスト（CSV など）を、言語を並べた表で編集、検証、レビューするツールです。データはこの PC のフォルダに置き、プロジェクトのフォルダごとに設定を持ちます。
        </p>
        <h2 className="section-title">はじめて使う</h2>
        <div className="row open-start">
          <button type="button" className="btn primary" onClick={() => onCreate()} disabled={loading}>
            新しいプロジェクトを作る…
          </button>
          <span className="muted small">翻訳テキストのあるフォルダ（またはこれから作るフォルダ）を選び、言語を決めるだけで始められます。</span>
        </div>
        <h2 className="section-title">既存のプロジェクトを開く</h2>
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
            <button type="submit" className="btn" disabled={loading || path.trim() === ""}>
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
        {createOffer && (
          <p className="open-offer">
            このフォルダには、まだプロジェクトがありません。{" "}
            <button type="button" className="btn small primary" onClick={() => onCreate(createOffer)} disabled={loading}>
              このフォルダに新しいプロジェクトを作る…
            </button>
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
