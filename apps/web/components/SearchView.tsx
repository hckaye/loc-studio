"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QueryResponse, QueryRow, RowFilter } from "@loc-studio/server";
import { useStudio, useToasts } from "@/components/context";
import { columnLabel, displayValue, findOption, optionLabel, worstSeverity, type GridColumn } from "@/lib/client/model";
import { queryFields } from "@/lib/client/query-text";

/*
 * 検索ビュー: いまの絞り込みに合う行を、プロジェクトのすべてのリソースから集めて 1 つの表で見る。
 * 件数と原文の量、欄の値ごとの集計を出し、結果と集計を CSV / TSV に書き出せる。行を選ぶと、そのリソースのその行へ移る。
 */

export const SEARCH_PAGE_SIZE = 200;

export interface SearchViewProps {
  /** 絞り込みの条件（表と同じもの）。 */
  filter: RowFilter;
  /** 対象の言語（表示中の言語）。 */
  languages: string[];
  /** 結果の表に出す列（表に出している列。キーとアクションの列は除く）。 */
  columns: GridColumn[];
  /** 集計の区切り（欄。2 つまで）。 */
  groupBy: string[];
  onGroupBy(groupBy: string[]): void;
  /** 値が変わったら読み直す（保存や、ほかの人の変更のあと）。 */
  refreshToken: number;
  /** 行へ移る。index は、そのリソースの中で条件に合う行のうち何番目か。 */
  onJump(target: { resourceId: string; key: string; index: number }): void;
  onClose(): void;
}

const BOM = "\uFEFF";

/** 文字列をファイルとして保存させる。 */
function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function SearchView({ filter, languages, columns, groupBy, onGroupBy, refreshToken, onJump, onClose }: SearchViewProps) {
  const { api, info } = useStudio();
  const { push, reportError } = useToasts();
  const [result, setResult] = useState<QueryResponse | null>(null);
  const [rows, setRows] = useState<QueryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const shown = useMemo(() => columns.filter((c) => c.kind !== "key" && c.kind !== "actions"), [columns]);
  const cells = useMemo(() => shown.map((c) => c.cellId), [shown]);
  const request = useMemo(() => ({ ...filter, languages, cells }), [filter, languages, cells]);
  const requestKey = JSON.stringify([request, groupBy]);

  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    api
      .query({ ...request, ...(groupBy.length > 0 ? { groupBy } : {}), offset: 0, limit: SEARCH_PAGE_SIZE })
      .then((r) => {
        if (seq.current !== n) return;
        setResult(r);
        setRows(r.rows);
      })
      .catch((err: unknown) => {
        if (seq.current !== n) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => seq.current === n && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, requestKey, refreshToken]);

  const loadMore = useCallback(() => {
    const n = seq.current;
    setLoading(true);
    api
      .query({ ...request, offset: rows.length, limit: SEARCH_PAGE_SIZE })
      .then((r) => seq.current === n && setRows((cur) => [...cur, ...r.rows]))
      .catch((err: unknown) => seq.current === n && reportError(err, "続きを読み込めませんでした"))
      .finally(() => seq.current === n && setLoading(false));
  }, [api, request, rows.length, reportError]);

  // 集計の区切りに選べる欄: 値の種類が少ないもの（選択式、問題の重さ、はい／いいえ、問題の種類）と、リソース。
  const groupOptions = useMemo(() => {
    const langLabel = (id: string) => info.languages.find((l) => l.id === id)?.label ?? id;
    const out: { value: string; label: string }[] = [];
    for (const f of queryFields(info)) {
      if (f.name === "resource") out.push({ value: f.name, label: "リソース" });
      if (!["enum", "severity", "flag", "boolean", "code"].includes(f.type)) continue;
      if (!f.perLanguage) out.push({ value: f.name, label: f.label });
      else for (const l of f.languages.filter((id) => languages.includes(id))) out.push({ value: `${f.name}@${l}`, label: `${f.label}（${langLabel(l)}）` });
    }
    return out;
  }, [info, languages]);
  const groupLabel = (value: string) => groupOptions.find((o) => o.value === value)?.label ?? value;

  const exportTable = async (table: "rows" | "groups", how: "csv" | "copy") => {
    try {
      const r = await api.exportQuery({ ...request, format: how === "csv" ? "csv" : "tsv", table, ...(groupBy.length > 0 ? { groupBy } : {}) });
      const what = table === "rows" ? "結果" : "集計";
      if (how === "csv") {
        // 表計算ソフトが文字コードを見分けられるよう、先頭に BOM を付ける。
        download(table === "rows" ? "loc-studio-search.csv" : "loc-studio-summary.csv", BOM + r.text, "text/csv;charset=utf-8");
        push(r.truncated ? "warning" : "success", `${what} ${r.rows.toLocaleString()} 行を CSV に書き出しました${r.truncated ? "（行数の上限で打ち切りました）" : ""}`);
      } else {
        await navigator.clipboard.writeText(r.text);
        push(r.truncated ? "warning" : "success", `${what} ${r.rows.toLocaleString()} 行をコピーしました（表計算ソフトに貼り付けられます）${r.truncated ? "（行数の上限で打ち切りました）" : ""}`);
      }
    } catch (err) {
      reportError(err, "書き出せませんでした");
    }
  };

  const cellText = (row: QueryRow, gc: GridColumn): string => {
    const cell = row.cells[gc.cellId];
    const option = findOption(gc.col, cell?.value);
    return option ? optionLabel(option) : displayValue(cell?.value);
  };
  const langLabel = (id: string | undefined) => (id ? (info.languages.find((l) => l.id === id)?.label ?? id) : "");
  /** そのリソースの中で、条件に合う行のうち何番目か（結果はリソースごとに、行の順に並んでいる）。 */
  const indexInResource = (at: number): number => {
    let n = 0;
    for (let i = 0; i < at; i++) if (rows[i]!.resourceId === rows[at]!.resourceId) n++;
    return n;
  };

  const matched = result?.matched;
  const filtering = Object.keys(filter).length > 0;
  const withMatches = result ? result.resources.filter((r) => r.matched > 0).length : 0;

  return (
    <div className="search-view" role="region" aria-label="検索ビュー">
      <div className="search-view-head">
        <strong>検索ビュー（プロジェクト全体）</strong>
        <span className="muted small">{filtering ? "いまの絞り込みに合う行を、すべてのリソースから集めています。" : "絞り込みがないので、すべての行を出しています。上のツールバーで絞り込めます。"}</span>
        <span className="tb-grow" />
        <button type="button" className="btn small" onClick={onClose}>
          表に戻る
        </button>
      </div>
      {error !== null && (
        <p className="hint-error" role="alert">
          {error}
        </p>
      )}
      {result && matched && (
        <p className="search-view-summary" role="status">
          <strong>{matched.rows.toLocaleString()} 行</strong>（全 {result.totalRows.toLocaleString()} 行のうち。{withMatches} / {result.resources.length} 個のリソース） ・ 原文 {matched.characters.toLocaleString()} 文字 /{" "}
          {matched.words.toLocaleString()} 語
          {loading && <span className="spinner small" aria-label="読み込み中" />}
        </p>
      )}
      {result && result.unreadable.length > 0 && (
        <p className="hint-error" role="alert">
          読めなかったリソースが {result.unreadable.length} 個あります（数に入っていません）: {result.unreadable.map((u) => u.path).join("、")}
        </p>
      )}

      <section className="search-view-groups" aria-label="集計">
        <div className="row">
          <strong>集計</strong>
          {[0, 1].map((i) =>
            i > groupBy.length ? null : (
              <select
                key={i}
                className="input small"
                aria-label={i === 0 ? "集計の区切り" : "集計の区切り（2 つ目）"}
                value={groupBy[i] ?? ""}
                onChange={(e) => {
                  const next = [...groupBy.slice(0, i), ...(e.target.value ? [e.target.value] : [])];
                  onGroupBy(next);
                }}
              >
                <option value="">{i === 0 ? "区切りを選ぶ…" : "さらに区切らない"}</option>
                {groupOptions
                  .filter((o) => o.value === groupBy[i] || !groupBy.includes(o.value))
                  .map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
              </select>
            ),
          )}
          {groupBy.length > 0 && (
            <>
              <button type="button" className="btn small" onClick={() => void exportTable("groups", "csv")}>
                集計を CSV に保存
              </button>
              <button type="button" className="btn small" onClick={() => void exportTable("groups", "copy")}>
                集計をコピー
              </button>
            </>
          )}
        </div>
        {result?.groups && (
          <table className="search-table groups" aria-label="集計の表">
            <thead>
              <tr>
                {groupBy.map((g) => (
                  <th key={g} scope="col">
                    {groupLabel(g)}
                  </th>
                ))}
                <th scope="col" className="num">
                  行数
                </th>
                <th scope="col" className="num">
                  原文の文字数
                </th>
                <th scope="col" className="num">
                  原文の語数
                </th>
              </tr>
            </thead>
            <tbody>
              {result.groups.map((g, i) => (
                <tr key={i}>
                  {g.labels.map((label, j) => (
                    <td key={j}>{label}</td>
                  ))}
                  <td className="num">{g.rows.toLocaleString()}</td>
                  <td className="num">{g.characters.toLocaleString()}</td>
                  <td className="num">{g.words.toLocaleString()}</td>
                </tr>
              ))}
              {result.groups.length === 0 && (
                <tr>
                  <td colSpan={groupBy.length + 3} className="muted">
                    条件に合う行がありません。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      <section className="search-view-rows" aria-label="結果">
        <div className="row">
          <strong>結果</strong>
          <button type="button" className="btn small" disabled={!matched || matched.rows === 0} onClick={() => void exportTable("rows", "csv")}>
            結果を CSV に保存
          </button>
          <button type="button" className="btn small" disabled={!matched || matched.rows === 0} onClick={() => void exportTable("rows", "copy")}>
            結果をコピー
          </button>
          <span className="muted small">行を押すと、そのリソースのその行へ移ります。</span>
        </div>
        <div className="search-table-wrap">
          <table className="search-table" aria-label="結果の表">
            <thead>
              <tr>
                <th scope="col">リソース</th>
                <th scope="col">キー</th>
                {shown.map((c) => (
                  <th key={c.cellId} scope="col">
                    {c.language ? `${langLabel(c.language)} / ` : ""}
                    {c.kind === "text" ? (c.col.label ?? "本文") : columnLabel(c.col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={`${row.resourceId}\u0000${row.key}`}
                  tabIndex={0}
                  className="search-row"
                  onClick={() => onJump({ resourceId: row.resourceId, key: row.key, index: indexInResource(i) })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onJump({ resourceId: row.resourceId, key: row.key, index: indexInResource(i) });
                  }}
                >
                  <td className="mono small">{row.path}</td>
                  <td className="mono small">{row.key}</td>
                  {shown.map((c) => {
                    const severity = worstSeverity(row.cells[c.cellId]?.issues);
                    return (
                      <td key={c.cellId} className={severity ? `sev-${severity}` : undefined} title={row.cells[c.cellId]?.issues?.map((x) => x.message).join("\n") || undefined}>
                        {cellText(row, c)}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {result && rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={shown.length + 2} className="muted">
                    条件に合う行がありません。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {matched && rows.length < matched.rows && (
          <button type="button" className="btn small" disabled={loading} onClick={loadMore}>
            続きを表示（{rows.length.toLocaleString()} / {matched.rows.toLocaleString()} 行）
          </button>
        )}
        {!result && loading && <p className="muted">読み込み中…</p>}
      </section>
    </div>
  );
}
