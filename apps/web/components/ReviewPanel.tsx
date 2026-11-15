"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CellInfo, ReviewInfo } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { Chip } from "@/components/EnumSelect";
import { useStudio, useToasts } from "@/components/context";
import { diffText } from "@/lib/client/diff";
import { chipColors } from "@/lib/client/colors";
import { canReview } from "@/lib/client/permissions";
import { safeHttpUrl } from "@/lib/client/url";
import {
  cellIdOf,
  columnLabel,
  displayValue,
  enumOptions,
  findOption,
  formatTime,
  optionLabel,
  type ColumnDef,
  type GridColumn,
} from "@/lib/client/model";

/*
 * レビューの投稿パネル。判定はレビュー列の選択肢から。requireComment の選択肢はコメント必須。
 * 下にこれまでの投稿（変更あり、リンク、この時点の値との比較）と、レビュー先への手動の転載。
 */

export interface ReviewPanelProps {
  resourceId: string;
  rowKey: string;
  gc: GridColumn;
  initialVerdict?: string;
  onClose(): void;
  onPosted(key: string, cellId: string, cell: CellInfo): void;
}

export function ReviewPanel({ resourceId, rowKey, gc, initialVerdict, onClose, onPosted }: ReviewPanelProps) {
  const { api, info } = useStudio();
  const { push, reportError } = useToasts();
  const options = enumOptions(gc.col) ?? [];
  const [verdict, setVerdict] = useState<string | undefined>(initialVerdict);
  const [comment, setComment] = useState("");
  const [posts, setPosts] = useState<ReviewInfo[] | null>(null);
  const [targetValue, setTargetValue] = useState<unknown>(undefined);
  const [forwardMode, setForwardMode] = useState<string>("ask");
  const [forward, setForward] = useState(false);
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<{ id: string; before?: string } | null>(null);

  const targetCol: ColumnDef | undefined = useMemo(() => (gc.col.of ? info.columns.find((c) => c.id === gc.col.of) : undefined), [info, gc.col.of]);
  const targetCellId = targetCol ? cellIdOf(targetCol, gc.language) : undefined;
  const option = options.find((o) => o.value === verdict);
  const commentRequired = option?.requireComment === true;
  const allowed = canReview(info, gc.col.scope === "language" ? gc.language : undefined);
  const canPost = allowed.ok && verdict !== undefined && (!commentRequired || comment.trim() !== "") && !busy;

  const loadPosts = useCallback(() => {
    api
      .reviews({ resourceId, key: rowKey, cellId: gc.cellId })
      .then(setPosts)
      .catch((err: unknown) => reportError(err, "レビューの読み込み"));
  }, [api, resourceId, rowKey, gc.cellId, reportError]);

  useEffect(() => {
    loadPosts();
    if (targetCellId) {
      api
        .rowDetail({ resourceId, key: rowKey })
        .then((d) => setTargetValue(d.row.cells[targetCellId]?.value))
        .catch((err: unknown) => reportError(err, "対象の値の読み込み"));
    }
    api
      .settings()
      .then((s) => {
        const v = s.local.find((x) => x.key === "review.forwardOnPost")?.value;
        if (typeof v === "string") setForwardMode(v);
      })
      .catch((err: unknown) => reportError(err, "設定の読み込み"));
  }, [api, resourceId, rowKey, targetCellId, loadPosts, reportError]);

  const post = async () => {
    if (!canPost || verdict === undefined) return;
    setBusy(true);
    try {
      const res = await api.postReview({
        resourceId,
        key: rowKey,
        cellId: gc.cellId,
        verdict,
        comment,
        ...(info.reviewTargets.length > 0 && forwardMode === "ask" ? { forward } : {}),
      });
      for (const w of res.warnings ?? []) push("warning", w);
      push("success", "レビューを投稿しました");
      onPosted(rowKey, gc.cellId, { value: res.verdict, stale: false, updatedBy: res.userName, updatedAt: res.createdAt, ...(res.basisHash ? { basisHash: res.basisHash } : {}) });
      setComment("");
      loadPosts();
    } catch (err) {
      reportError(err, "投稿できませんでした");
    } finally {
      setBusy(false);
    }
  };

  const forwardPost = async (p: ReviewInfo, actionId: string) => {
    try {
      const res = await api.forwardReview({ resourceId, key: rowKey, cellId: gc.cellId, reviewId: p.id, actionId });
      for (const w of res.warnings ?? []) push("warning", w);
      push("success", "転載しました");
      loadPosts();
    } catch (err) {
      reportError(err, "転載できませんでした");
    }
  };

  const showCompare = async (p: ReviewInfo) => {
    if (compare?.id === p.id) return setCompare(null);
    if (!p.basisHash) return setCompare({ id: p.id });
    try {
      const v = await api.textVersion({ hash: p.basisHash });
      setCompare({ id: p.id, ...(v.text !== undefined ? { before: v.text } : {}) });
    } catch (err) {
      reportError(err, "その時点の値を読めませんでした");
    }
  };

  const langLabel = gc.language ? info.languages.find((l) => l.id === gc.language)?.label ?? gc.language : undefined;
  const current = displayValue(targetValue);

  return (
    <Dialog
      title={`レビュー: ${columnLabel(gc.col)}`}
      className="review-panel"
      onClose={onClose}
      footer={
        <>
          <span className="muted small footer-hint">投稿者: {info.user.name}</span>
          <button type="button" className="btn" onClick={onClose}>
            閉じる
          </button>
          {!allowed.ok && <span className="hint-error">{allowed.reason}</span>}
          <button type="button" className="btn primary" disabled={!canPost} title={allowed.reason} onClick={() => void post()}>
            投稿
          </button>
        </>
      }
    >
      <div className="review-target">
        <div className="muted small">
          <span className="mono">{rowKey}</span>
          {langLabel && ` ・ ${langLabel}`}
          {targetCol && ` ・ 対象: ${targetCol.label ?? (targetCol.kind === "text" ? "本文" : targetCol.id)}`}
        </div>
        <div className="ref-text">{current === "" ? <span className="muted">（空）</span> : current}</div>
      </div>
      <fieldset className="verdicts">
        <legend>判定</legend>
        {options.map((o) => {
          const c = chipColors(o.color);
          return (
            <label key={o.value} className={`verdict${verdict === o.value ? " on" : ""}`} style={{ borderColor: verdict === o.value ? c.fg : undefined }}>
              <input type="radio" name="verdict" value={o.value} checked={verdict === o.value} onChange={() => setVerdict(o.value)} />
              <Chip option={o} />
              {o.requireComment && <span className="muted small">コメント必須</span>}
            </label>
          );
        })}
      </fieldset>
      <label className="field">
        <span>
          コメント{commentRequired && <span className="required">（必須）</span>}
        </span>
        <textarea
          className="review-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          aria-required={commentRequired}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void post();
            }
          }}
        />
      </label>
      {commentRequired && comment.trim() === "" && <p className="hint-error">「{option ? optionLabel(option) : ""}」にはコメントが必要です。</p>}
      {info.reviewTargets.length > 0 && forwardMode === "ask" && (
        <label className="check">
          <input type="checkbox" checked={forward} onChange={(e) => setForward(e.target.checked)} />
          レビュー先に転載する（{info.reviewTargets.map((t) => t.label).join("、")}）
        </label>
      )}
      {info.reviewTargets.length > 0 && forwardMode === "always" && <p className="muted small">投稿はレビュー先に自動で転載されます。</p>}
      <h3 className="section-title">これまでの投稿</h3>
      {posts === null ? (
        <p className="muted small">読み込み中…</p>
      ) : posts.length === 0 ? (
        <p className="muted small">まだ投稿はありません。</p>
      ) : (
        <ul className="review-list">
          {posts.map((p) => {
            const o = findOption(gc.col, p.verdict);
            return (
              <li key={p.id} className="review-item">
                <div className="review-meta">
                  <Chip option={o} fallback={p.verdict} />
                  <span>{p.userName}</span>
                  <span className="muted small">{formatTime(p.createdAt)}</span>
                  {p.stale && <span className="badge warn">変更あり</span>}
                </div>
                {p.comment && <div className="review-comment-text">{p.comment}</div>}
                {p.links && p.links.length > 0 && (
                  <div className="review-links">
                    {p.links.map((l, i) => {
                      // http / https で正しく読める URL だけをリンクにする（ほかは文字として出す）
                      const url = safeHttpUrl(l.url);
                      return url ? (
                        <a key={`${i}:${l.url}`} href={url} target="_blank" rel="noopener noreferrer" title={url}>
                          {l.label}
                        </a>
                      ) : (
                        <span key={`${i}:${l.url}`} className="muted small" title="開けない形式の URL のため、リンクにしていません">
                          {l.label}（{l.url}）
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="review-tools">
                  {targetCol && (
                    <button type="button" className="btn small" onClick={() => void showCompare(p)} aria-expanded={compare?.id === p.id}>
                      この時点の値と比べる
                    </button>
                  )}
                  {info.reviewTargets.map((t) => (
                    <button key={t.id} type="button" className="btn small" disabled={!allowed.ok} title={allowed.reason} onClick={() => void forwardPost(p, t.id)}>
                      {t.label}に転載
                    </button>
                  ))}
                </div>
                {compare?.id === p.id && (
                  <div className="diff" aria-label="差分">
                    {compare.before === undefined ? (
                      <span className="muted small">この投稿の時点の値は記録されていません。</span>
                    ) : (
                      diffText(compare.before, current).map((part, i) => (
                        <span key={i} className={`diff-${part.type}`}>
                          {part.text}
                        </span>
                      ))
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
