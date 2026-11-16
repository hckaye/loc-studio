"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { QueryRequest, ResourceStats, TreeNodeInfo } from "@loc-studio/server";
import { useStudio } from "@/components/context";
import { progressColumn } from "@/lib/client/model";
import type { TreeViewState } from "@/lib/client/prefs";

/*
 * 左のリソースのツリー。フォルダは折りたためる。未保存の印と、進捗（裏で少しずつ stats を読む）。
 * 絞り込んでいるあいだは、条件に合う行の数をリソースとフォルダに出す（どこにどれだけ残っているかが分かるように）。
 */

/** 絞り込みの条件（表と同じもの）と、対象の言語。 */
export type TreeMatchRequest = Omit<QueryRequest, "resourceIds" | "offset" | "limit" | "cells" | "groupBy">;

export interface ResourceTreeProps {
  nodes: TreeNodeInfo[];
  selected: string | undefined;
  onSelect(resourceId: string): void;
  statsToken: number;
  onError(err: unknown): void;
  /** リソースの作成を始める（渡したときだけボタンを出す）。 */
  onCreate?(): void;
  /** リソースを作れないときの理由。 */
  createDisabledReason?: string | undefined;
  /** 絞り込んでいるときの条件。渡すと、条件に合う行の数をリソースごとに出す。 */
  match?: TreeMatchRequest | undefined;
  /** 最初の見え方（前回の状態の復元）。 */
  initialView?: TreeViewState | undefined;
  /** 見え方（たたんだフォルダ、名前の絞り込み、「該当ありだけ」）が変わった。 */
  onViewChange?(view: TreeViewState): void;
}

/** 件数を 1 回に問い合わせるリソースの数。 */
const MATCH_BATCH = 8;

function collectResources(nodes: TreeNodeInfo[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "resource" && n.resource) out.push(n.resource.id);
    if (n.children) collectResources(n.children, out);
  }
  return out;
}

function filterTree(nodes: TreeNodeInfo[], q: string): TreeNodeInfo[] {
  if (q === "") return nodes;
  const out: TreeNodeInfo[] = [];
  for (const n of nodes) {
    if (n.kind === "folder") {
      const children = filterTree(n.children ?? [], q);
      if (children.length > 0 || n.name.toLowerCase().includes(q)) out.push({ ...n, children: children.length > 0 ? children : n.children ?? [] });
    } else if (n.name.toLowerCase().includes(q) || (n.resource?.path ?? "").toLowerCase().includes(q)) out.push(n);
  }
  return out;
}

export function ResourceTree({ nodes, selected, onSelect, statsToken, onError, onCreate, createDisabledReason, match, initialView, onViewChange }: ResourceTreeProps) {
  const { api, info } = useStudio();
  const [query, setQuery] = useState(() => (typeof initialView?.query === "string" ? initialView.query : ""));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((Array.isArray(initialView?.collapsed) ? initialView.collapsed : []).filter((id) => typeof id === "string").map((id) => [id, true])),
  );
  const [stats, setStats] = useState<Record<string, ResourceStats>>({});
  const col = progressColumn(info);
  const ids = useMemo(() => collectResources(nodes), [nodes]);

  // 重いので少しずつ順番に読む
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < ids.length && !cancelled; i += 4) {
        const batch = ids.slice(i, i + 4);
        try {
          const res = await api.stats({ resourceIds: batch });
          if (cancelled) return;
          setStats((s) => {
            const next = { ...s };
            for (const r of res) next[r.resourceId] = r;
            return next;
          });
        } catch (err) {
          if (!cancelled) onError(err);
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, ids, statsToken]);

  // 条件に合う行の数（リソースの ID → 数）。条件が変わったら捨てて、少しずつ数え直す。
  const [matches, setMatches] = useState<Record<string, number>>({});
  const [matchError, setMatchError] = useState<string | null>(null);
  const [onlyMatching, setOnlyMatching] = useState(initialView?.onlyMatching === true);
  // 見え方が変わったら知らせる（前回の状態として覚えてもらう）。
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  useEffect(() => {
    onViewChangeRef.current?.({ collapsed: Object.keys(collapsed).filter((id) => collapsed[id]), query, onlyMatching });
  }, [collapsed, query, onlyMatching]);
  const matchKey = match ? JSON.stringify(match) : "";
  useEffect(() => {
    setMatches({});
    setMatchError(null);
    if (!match) return;
    let cancelled = false;
    // 入力の途中で何度も数え直さないよう、少し待ってから始める。
    const timer = setTimeout(() => {
      void (async () => {
        for (let i = 0; i < ids.length && !cancelled; i += MATCH_BATCH) {
          try {
            const res = await api.query({ ...match, resourceIds: ids.slice(i, i + MATCH_BATCH), limit: 0 });
            if (cancelled) return;
            setMatches((m) => {
              const next = { ...m };
              for (const r of res.resources) next[r.resourceId] = r.matched;
              return next;
            });
          } catch (err) {
            // 条件の誤りは、表の側でも知らせる。ここでは件数を出さないだけにする。
            if (!cancelled) setMatchError(err instanceof Error ? err.message : String(err));
            return;
          }
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, ids, matchKey, statsToken]);
  /** 数え終えたリソースの合計。1 つも数え終えていなければ undefined。 */
  const matchOf = (resourceIds: string[]): number | undefined => {
    if (!match) return undefined;
    let total = 0;
    let any = false;
    for (const id of resourceIds) {
      const n = matches[id];
      if (n === undefined) continue;
      any = true;
      total += n;
    }
    return any ? total : undefined;
  };
  const totalMatched = matchOf(ids);
  const counted = ids.filter((id) => matches[id] !== undefined).length;

  const progressOf = (resourceIds: string[]): ProgressSummary | undefined => {
    if (!col) return undefined;
    let complete = 0;
    let total = 0;
    let any = false;
    const byLang = new Map<string, { complete: number; total: number }>();
    for (const id of resourceIds) {
      const per = stats[id]?.progress[col.id];
      if (!per) continue;
      any = true;
      for (const [lang, p] of Object.entries(per)) {
        complete += p.complete;
        total += p.total;
        const cur = byLang.get(lang) ?? { complete: 0, total: 0 };
        byLang.set(lang, { complete: cur.complete + p.complete, total: cur.total + p.total });
      }
    }
    if (!any) return undefined;
    // 言語ごとの内訳（設定の言語の順。entry スコープの列は "*"）
    const order = info.languages.map((l) => l.id);
    const perLanguage = [...byLang.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([lang, p]) => ({ label: lang === "*" ? "全体" : info.languages.find((l) => l.id === lang)?.label ?? lang, ...p }));
    return { complete, total, perLanguage };
  };

  const q = query.trim().toLowerCase();
  // 「該当ありだけ」: 条件に合う行のないリソースと、その下に 1 つもないフォルダを隠す（数え終えていないものは出したまま）。
  const hideEmpty = (list: TreeNodeInfo[]): TreeNodeInfo[] =>
    list.flatMap((n) => {
      if (n.kind === "folder") {
        const children = hideEmpty(n.children ?? []);
        return children.length > 0 ? [{ ...n, children }] : [];
      }
      return matches[n.resource?.id ?? n.id] === 0 ? [] : [n];
    });
  const named = filterTree(nodes, q);
  const shown = match && onlyMatching ? hideEmpty(named) : named;

  const render = (list: TreeNodeInfo[], depth: number): React.ReactNode =>
    list.map((n) => {
      if (n.kind === "folder") {
        const isCollapsed = q === "" && collapsed[n.id] === true;
        const p = progressOf(collectResources(n.children ?? []));
        const folderMatch = matchOf(collectResources(n.children ?? []));
        return (
          <li key={n.id} role="treeitem" aria-expanded={!isCollapsed} aria-selected={false}>
            <button type="button" className="tree-row folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setCollapsed((c) => ({ ...c, [n.id]: !isCollapsed }))}>
              <span className="tree-caret" aria-hidden="true">
                {isCollapsed ? "▸" : "▾"}
              </span>
              <span className="tree-name">{n.name}</span>
              {n.unsaved ? <span className="tree-unsaved" title={`未保存 ${n.unsaved} 件`}>●{n.unsaved}</span> : null}
              {folderMatch !== undefined && <MatchBadge count={folderMatch} />}
              {p && <Progress p={p} unit={info.grid.progressUnit} />}
            </button>
            {!isCollapsed && n.children && (
              <ul role="group" className="tree-list">
                {render(n.children, depth + 1)}
              </ul>
            )}
          </li>
        );
      }
      const id = n.resource?.id ?? n.id;
      const p = progressOf([id]);
      const st = stats[id];
      const matched = match ? matches[id] : undefined;
      return (
        <li key={n.id} role="treeitem" aria-selected={selected === id}>
          <button
            type="button"
            className={`tree-row resource${selected === id ? " selected" : ""}${matched === 0 ? " no-match" : ""}`}
            style={{ paddingLeft: 22 + depth * 14 }}
            onClick={() => onSelect(id)}
            title={`${n.resource?.path ?? n.name}${st ? `（${st.entries} 件）` : ""}`}
          >
            <span className="tree-name">{n.name}</span>
            {n.unsaved ? (
              <span className="tree-unsaved" title={`未保存 ${n.unsaved} 件`} aria-label={`未保存 ${n.unsaved} 件`}>
                ●{n.unsaved}
              </span>
            ) : null}
            {st && st.issues.error > 0 && (
              <span className="tree-err" title={`エラー ${st.issues.error} 件`}>
                !{st.issues.error}
              </span>
            )}
            {matched !== undefined && <MatchBadge count={matched} />}
            {p && <Progress p={p} unit={info.grid.progressUnit} />}
          </button>
        </li>
      );
    });

  return (
    <nav className="tree" aria-label="リソース">
      <div className="tree-head">
        <div className="row">
          <input type="search" className="input grow" placeholder="名前で絞り込む" aria-label="リソースを名前で絞り込む" value={query} onChange={(e) => setQuery(e.target.value)} />
          {onCreate && (
            <button type="button" className="btn small" aria-label="リソースを作成" title={createDisabledReason ?? "リソースを作成"} disabled={createDisabledReason !== undefined} onClick={onCreate}>
              ＋
            </button>
          )}
        </div>
        {col && <div className="muted small tree-legend">進捗: {col.label ?? col.id}</div>}
        {match && (
          <div className="tree-match-head" role="status">
            <span className="small">
              条件に合う行:{" "}
              {matchError !== null ? (
                <span className="hint-error">数えられません</span>
              ) : totalMatched === undefined ? (
                "数えています…"
              ) : (
                <strong>
                  {totalMatched.toLocaleString()} 行{counted < ids.length ? "（数えています…）" : ""}
                </strong>
              )}
            </span>
            <label className="check small">
              <input type="checkbox" checked={onlyMatching} onChange={(e) => setOnlyMatching(e.target.checked)} />
              該当ありだけ
            </label>
          </div>
        )}
      </div>
      <ul className="tree-list root" role="tree" aria-label="リソースのツリー">
        {render(shown, 0)}
      </ul>
      {shown.length === 0 && <p className="muted small pad">リソースがありません。</p>}
    </nav>
  );
}

/** 条件に合う行の数の札。0 のときは薄く出す。 */
function MatchBadge({ count }: { count: number }) {
  return (
    <span className={`tree-match${count === 0 ? " zero" : ""}`} title={`条件に合う行 ${count.toLocaleString()} 件`} aria-label={`条件に合う行 ${count} 件`}>
      {count.toLocaleString()}
    </span>
  );
}

interface ProgressSummary {
  complete: number;
  total: number;
  perLanguage: { label: string; complete: number; total: number }[];
}

const percent = (c: number, t: number) => (t === 0 ? 0 : Math.round((c / t) * 100));

/** 進捗を数えている単位（設定の grid.progressUnit）。数は、行数か、原文の文字数・語数。 */
const UNIT_LABEL: Record<"rows" | "characters" | "words", string> = { rows: "行", characters: "文字（原文）", words: "語（原文）" };

function Progress({ p, unit }: { p: ProgressSummary; unit: "rows" | "characters" | "words" }) {
  const pct = percent(p.complete, p.total);
  const title = [`合計 ${p.complete} / ${p.total} ${UNIT_LABEL[unit]}（${pct}%）`, ...p.perLanguage.map((l) => `${l.label}: ${l.complete} / ${l.total}（${percent(l.complete, l.total)}%）`)].join("\n");
  return (
    <span className="tree-progress" title={title} aria-label={`進捗 ${pct}%`}>
      <span className="bar">
        <span className="fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="pct">{pct}%</span>
    </span>
  );
}
