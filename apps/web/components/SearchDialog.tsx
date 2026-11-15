"use client";
import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { useStudio, useToasts } from "@/components/context";

/* リソースをまたぐ検索（Ctrl+Shift+F）。結果を選ぶと、そのリソースのその行・その言語のセルへ移る。 */

export function SearchDialog({ onClose, onJump, resourceNames }: { onClose(): void; onJump(hit: SearchHit): void; resourceNames: Map<string, string> }) {
  const { api, info } = useStudio();
  const { reportError } = useToasts();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const q = query.trim();
    const n = ++seq.current;
    if (q === "") {
      setHits(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      api
        .search({ query: q, limit: 200 })
        .then((list) => {
          if (seq.current !== n) return;
          setHits(list);
          setActive(0);
        })
        .catch((err: unknown) => seq.current === n && reportError(err, "検索できませんでした"))
        .finally(() => seq.current === n && setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query, api, reportError]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onJump(hit);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!hits || e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(hits[active]);
    }
  };

  const langLabel = (id: string | undefined) => (id ? info.languages.find((l) => l.id === id)?.label ?? id : "キー");

  return (
    <Dialog title="プロジェクト全体を検索" className="search-dialog" onClose={onClose} initialFocus="input[type=search]">
      <div className="search-top">
        <input
          type="search"
          className="input grow"
          placeholder="キーと本文を検索（すべてのリソース）"
          aria-label="プロジェクト全体を検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-controls="search-results"
          aria-activedescendant={hits && hits.length ? `search-hit-${active}` : undefined}
        />
        {loading && <span className="spinner" aria-label="検索中" />}
      </div>
      {hits !== null && (
        <p className="muted small" aria-live="polite">
          {hits.length} 件{hits.length >= 200 ? "（上限まで表示）" : ""}
        </p>
      )}
      {hits && hits.length > 0 && (
        <ul id="search-results" ref={listRef} className="search-results" role="listbox" aria-label="検索結果">
          {hits.map((h, i) => (
            <li
              key={`${h.resourceId}:${h.key}:${h.language ?? ""}:${i}`}
              id={`search-hit-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              className={`search-hit${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(h)}
            >
              <div className="search-hit-head">
                <span className="muted small">{resourceNames.get(h.resourceId) ?? h.resourceId}</span>
                <span className="mono">{h.key}</span>
                <span className="badge">{langLabel(h.language)}</span>
              </div>
              <div className="search-snippet">{h.snippet}</div>
            </li>
          ))}
        </ul>
      )}
      {hits && hits.length === 0 && !loading && <p className="muted">見つかりませんでした。</p>}
    </Dialog>
  );
}
