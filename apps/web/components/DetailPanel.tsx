"use client";
import { useEffect, useState } from "react";
import type { HistoryInfo, ReviewInfo, RowInfo } from "@loc-studio/server";
import { Chip } from "@/components/EnumSelect";
import { TextMarks, ValueView } from "@/components/grid/cells";
import { canEdit } from "@/lib/client/permissions";
import { useStudio, useToasts } from "@/components/context";
import {
  cellIdOf,
  columnLabel,
  commonColumns,
  displayValue,
  findOption,
  formatTime,
  gridKind,
  type ColumnDef,
  type GridColumn,
  languageColumns,
  SEVERITY_LABEL,
  textValue,
} from "@/lib/client/model";

/* 詳細パネル: 選択した行の全言語の本文、全列の値、検証結果、レビューの投稿、変更履歴。 */

function gcOf(col: ColumnDef, language?: string): GridColumn {
  return { cellId: cellIdOf(col, language), col, kind: gridKind(col), groupId: language ? `lang:${language}` : "@common", width: 0, ...(language ? { language } : {}) };
}

const CAUSE_LABEL: Record<HistoryInfo["cause"], string> = {
  manual: "手動",
  action: "アクション",
  bulk: "一括",
  external: "外部",
  review: "レビュー",
  generate: "生成",
};

export function DetailPanel({
  resourceId,
  rowKey,
  reloadToken,
  onClose,
  preferLanguage,
  onDiscardRow,
}: {
  resourceId: string;
  rowKey: string | undefined;
  reloadToken: number;
  onClose(): void;
  preferLanguage?: string;
  onDiscardRow?(key: string): void;
}) {
  const { api, info } = useStudio();
  const { reportError } = useToasts();
  const [row, setRow] = useState<RowInfo | null>(null);
  const [history, setHistory] = useState<HistoryInfo[] | null>(null);
  const [reviewLang, setReviewLang] = useState<string | undefined>(preferLanguage);
  const [reviews, setReviews] = useState<Record<string, ReviewInfo[]>>({});

  useEffect(() => {
    if (preferLanguage) setReviewLang(preferLanguage);
  }, [preferLanguage]);

  useEffect(() => {
    if (!rowKey) {
      setRow(null);
      setHistory(null);
      return;
    }
    let alive = true;
    api
      .rowDetail({ resourceId, key: rowKey })
      .then((d) => alive && setRow(d.row))
      .catch((err: unknown) => reportError(err, "詳細の読み込み"));
    api
      .history({ resourceId, key: rowKey, limit: 100 })
      .then((h) => alive && setHistory(h))
      .catch((err: unknown) => reportError(err, "変更履歴の読み込み"));
    return () => {
      alive = false;
    };
  }, [api, resourceId, rowKey, reloadToken, reportError]);

  const reviewCols = info.columns.filter((c) => c.kind === "review");
  const lang = reviewLang ?? info.languages[0]?.id;
  useEffect(() => {
    if (!rowKey || !lang) return;
    let alive = true;
    const cols = reviewCols.filter((c) => c.scope === "entry" || !c.languages || c.languages.includes(lang));
    Promise.all(cols.map((c) => api.reviews({ resourceId, key: rowKey, cellId: cellIdOf(c, lang) }).then((r) => [cellIdOf(c, lang), r] as const)))
      .then((pairs) => alive && setReviews(Object.fromEntries(pairs)))
      .catch((err: unknown) => reportError(err, "レビューの読み込み"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, resourceId, rowKey, lang, reloadToken]);

  const colLabel = (cellId: string) => {
    const [colId, langId] = cellId.split("@");
    const col = info.columns.find((c) => c.id === colId);
    const l = langId ? info.languages.find((x) => x.id === langId)?.label ?? langId : undefined;
    const name = col ? col.label ?? (col.kind === "text" ? "本文" : col.id) : colId;
    return l ? `${l} / ${name}` : name;
  };

  return (
    <aside className="detail-panel" aria-label="詳細">
      <div className="panel-head">
        <h2 className="panel-title">詳細{rowKey && <span className="mono"> {rowKey}</span>}</h2>
        <button type="button" className="icon-btn" aria-label="詳細パネルを閉じる" onClick={onClose}>
          ×
        </button>
      </div>
      {!rowKey ? (
        <p className="muted small pad">行を選ぶと、ここに全言語の内容が出ます。</p>
      ) : !row ? (
        <p className="muted small pad">読み込み中…</p>
      ) : (
        <div className="detail-body">
          {onDiscardRow && canEdit(info).ok && Object.values(row.cells).some((c) => c.draft) && (
            <div className="detail-drafts">
              <span className="mark-unsaved-text">● この行に未保存の変更があります</span>
              <button type="button" className="btn small" onClick={() => onDiscardRow(row.key)}>
                変更を取り消す
              </button>
            </div>
          )}
          {commonColumns(info).filter((c) => c.kind !== "key" && c.kind !== "actions").length > 0 && (
            <section>
              <h3 className="section-title">共通</h3>
              <table className="kv">
                <tbody>
                  {commonColumns(info)
                    .filter((c) => c.kind !== "key" && c.kind !== "actions")
                    .map((c) => {
                      const cell = row.cells[c.id];
                      const o = findOption(c, cell?.value);
                      return (
                        <tr key={c.id}>
                          <th>{columnLabel(c)}</th>
                          <td>{o ? <Chip option={o} {...(cell?.stale ? { stale: true } : {})} /> : <ValueView info={info} row={row} gc={gcOf(c)} resourceId={resourceId} />}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </section>
          )}
          <section>
            <h3 className="section-title">全言語</h3>
            {info.languages.map((l) => {
              const cols = languageColumns(info, l.id);
              const textCols = cols.filter((c) => c.kind === "text");
              const others = cols.filter((c) => c.kind !== "text" && c.kind !== "actions");
              return (
                <div key={l.id} className="detail-lang">
                  <div className="detail-lang-head">
                    {l.label} <span className="muted small">{l.id}</span>
                  </div>
                  {textCols.map((c) => {
                    const cell = row.cells[cellIdOf(c, l.id)];
                    const v = textValue(cell);
                    return (
                      <div key={c.id} className="detail-text" {...(l.hint?.dir ? { dir: l.hint.dir } : {})}>
                        {v === "" ? <span className="muted">（未翻訳）</span> : v}
                        <TextMarks cell={cell} me={info.user.name} />
                        {cell?.issues && cell.issues.length > 0 && (
                          <ul className="issue-list compact">
                            {cell.issues.map((i, n) => (
                              <li key={n} className={`issue sev-${i.severity}`}>
                                <span className={`sev-badge sev-${i.severity}`}>{SEVERITY_LABEL[i.severity]}</span> {i.message}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                  <div className="detail-chips">
                    {others.map((c) => {
                      const cell = row.cells[cellIdOf(c, l.id)];
                      const o = findOption(c, cell?.value);
                      return (
                        <span key={c.id} className="detail-chip">
                          <span className="muted small">{columnLabel(c)}</span>{" "}
                          {o ? (
                            <Chip option={o} {...(cell?.stale ? { stale: true } : {})} />
                          ) : (
                            <ValueView info={info} row={row} gc={gcOf(c, l.id)} resourceId={resourceId} />
                          )}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </section>
          {reviewCols.length > 0 && (
            <section>
              <h3 className="section-title">
                レビュー
                <select className="inline-select" aria-label="レビューを見る言語" value={lang} onChange={(e) => setReviewLang(e.target.value)}>
                  {info.languages.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </h3>
              {Object.entries(reviews).map(([cellId, list]) => (
                <div key={cellId}>
                  <div className="muted small">{colLabel(cellId)}</div>
                  {list.length === 0 ? (
                    <p className="muted small">投稿なし</p>
                  ) : (
                    <ul className="review-list compact">
                      {list.map((p) => {
                        const col = info.columns.find((c) => c.id === cellId.split("@")[0]);
                        return (
                          <li key={p.id} className="review-item">
                            <div className="review-meta">
                              <Chip option={col ? findOption(col, p.verdict) : undefined} fallback={p.verdict} />
                              <span>{p.userName}</span>
                              <span className="muted small">{formatTime(p.createdAt)}</span>
                              {p.stale && <span className="badge warn">変更あり</span>}
                            </div>
                            {p.comment && <div className="review-comment-text">{p.comment}</div>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ))}
            </section>
          )}
          <section>
            <h3 className="section-title">変更履歴</h3>
            {history === null ? (
              <p className="muted small">読み込み中…</p>
            ) : history.length === 0 ? (
              <p className="muted small">記録はありません。</p>
            ) : (
              <ul className="history-list">
                {history.map((h) => (
                  <li key={h.id}>
                    <div className="history-meta">
                      <span className="muted small">{formatTime(h.at)}</span> <span>{h.by}</span> <span className="badge">{CAUSE_LABEL[h.cause] ?? h.cause}</span>{" "}
                      <span className="small">{colLabel(h.cellId)}</span>
                    </div>
                    <div className="history-change">
                      <span className="diff-removed">{displayValue(h.oldValue) || "（空）"}</span>
                      <span aria-hidden="true"> → </span>
                      <span className="diff-added">{displayValue(h.newValue) || "（空）"}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </aside>
  );
}
