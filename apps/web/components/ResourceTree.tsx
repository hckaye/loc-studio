"use client";
import { useEffect, useMemo, useState } from "react";
import type { ResourceStats, TreeNodeInfo } from "@loc-studio/server";
import { useStudio } from "@/components/context";
import { progressColumn } from "@/lib/client/model";

/* 左のリソースのツリー。フォルダは折りたためる。未保存の印と、進捗（裏で少しずつ stats を読む）。 */

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
}

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

export function ResourceTree({ nodes, selected, onSelect, statsToken, onError, onCreate, createDisabledReason }: ResourceTreeProps) {
  const { api, info } = useStudio();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
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
  const shown = filterTree(nodes, q);

  const render = (list: TreeNodeInfo[], depth: number): React.ReactNode =>
    list.map((n) => {
      if (n.kind === "folder") {
        const isCollapsed = q === "" && collapsed[n.id] === true;
        const p = progressOf(collectResources(n.children ?? []));
        return (
          <li key={n.id} role="treeitem" aria-expanded={!isCollapsed} aria-selected={false}>
            <button type="button" className="tree-row folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setCollapsed((c) => ({ ...c, [n.id]: !isCollapsed }))}>
              <span className="tree-caret" aria-hidden="true">
                {isCollapsed ? "▸" : "▾"}
              </span>
              <span className="tree-name">{n.name}</span>
              {n.unsaved ? <span className="tree-unsaved" title={`未保存 ${n.unsaved} 件`}>●{n.unsaved}</span> : null}
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
      return (
        <li key={n.id} role="treeitem" aria-selected={selected === id}>
          <button
            type="button"
            className={`tree-row resource${selected === id ? " selected" : ""}`}
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
      </div>
      <ul className="tree-list root" role="tree" aria-label="リソースのツリー">
        {render(shown, 0)}
      </ul>
      {shown.length === 0 && <p className="muted small pad">リソースがありません。</p>}
    </nav>
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
