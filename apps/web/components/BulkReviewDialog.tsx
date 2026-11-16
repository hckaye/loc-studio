"use client";
import { useState } from "react";
import type { CellInfo } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { Chip } from "@/components/EnumSelect";
import { useStudio, useToasts } from "@/components/context";
import { chipColors } from "@/lib/client/colors";
import { columnLabel, enumOptions, optionLabel, type ColumnDef } from "@/lib/client/model";

/*
 * レビューの一括の投稿。選んだレビューのセルすべてに、同じ判定とコメントを投稿する。
 * 投稿は 1 件ずつ行い（判定の遷移の制限や、フックは、1 件ずつの投稿と同じに効く）、終わったら、投稿できた数と、できなかったセルと理由を出す。
 * すべて投稿できたら閉じる。できなかったセルがあれば、理由を見せるために開いたままにする。
 */

export interface BulkReviewTarget {
  rowKey: string;
  cellId: string;
  /** 言語ごとの列なら、その言語。 */
  language?: string | undefined;
}

export interface BulkReviewDialogProps {
  resourceId: string;
  /** レビュー列（選んだセルは、すべてこの列）。 */
  column: ColumnDef;
  targets: BulkReviewTarget[];
  onClose(): void;
  onPosted(key: string, cellId: string, cell: CellInfo): void;
}

interface Failure {
  rowKey: string;
  cellId: string;
  message: string;
}

export function BulkReviewDialog({ resourceId, column, targets, onClose, onPosted }: BulkReviewDialogProps) {
  const { api, info } = useStudio();
  const { push } = useToasts();
  const options = enumOptions(column) ?? [];
  const [verdict, setVerdict] = useState<string | undefined>(undefined);
  const [comment, setComment] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ posted: number; failures: Failure[] } | null>(null);

  const option = options.find((o) => o.value === verdict);
  const commentRequired = option?.requireComment === true;
  const busy = progress !== null;
  const canPost = verdict !== undefined && (!commentRequired || comment.trim() !== "") && !busy && targets.length > 0;
  const langLabel = (id: string | undefined) => (id ? (info.languages.find((l) => l.id === id)?.label ?? id) : undefined);

  const post = async () => {
    if (!canPost || verdict === undefined) return;
    const failures: Failure[] = [];
    let posted = 0;
    setResult(null);
    setProgress({ done: 0, total: targets.length });
    for (const [i, t] of targets.entries()) {
      try {
        const res = await api.postReview({ resourceId, key: t.rowKey, cellId: t.cellId, verdict, comment });
        posted++;
        onPosted(t.rowKey, t.cellId, {
          value: res.verdict,
          stale: false,
          updatedBy: res.userName,
          updatedAt: res.createdAt,
          ...(res.comment !== "" ? { comment: res.comment } : {}),
          ...(res.basisHash ? { basisHash: res.basisHash } : {}),
        });
        for (const w of res.warnings ?? []) push("warning", w);
      } catch (err) {
        failures.push({ rowKey: t.rowKey, cellId: t.cellId, message: err instanceof Error ? err.message : String(err) });
      }
      setProgress({ done: i + 1, total: targets.length });
    }
    setProgress(null);
    if (failures.length === 0) {
      push("success", `${posted} 件のレビューを投稿しました`);
      onClose();
      return;
    }
    push(posted > 0 ? "warning" : "error", `レビューの投稿: ${posted} 件を投稿し、${failures.length} 件は投稿できませんでした`);
    setResult({ posted, failures });
  };

  const languages = [...new Set(targets.map((t) => t.language).filter((l): l is string => l !== undefined))];

  return (
    <Dialog
      title={`レビューを一括で投稿: ${columnLabel(column)}`}
      className="review-panel"
      onClose={onClose}
      footer={
        <>
          <span className="muted small footer-hint">投稿者: {info.user.name}</span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            閉じる
          </button>
          <button type="button" className="btn primary" disabled={!canPost} onClick={() => void post()}>
            {busy ? `投稿しています…（${progress.done} / ${progress.total}）` : `${targets.length} 件に投稿`}
          </button>
        </>
      }
    >
      <p className="review-target" role="status">
        選んだ <strong>{targets.length} 件</strong>のセルに、同じ判定とコメントを投稿します
        {languages.length > 0 && `（${languages.map((l) => langLabel(l)).join("、")}）`}。
      </p>
      <fieldset className="verdicts">
        <legend>判定</legend>
        {options.map((o) => {
          const c = chipColors(o.color);
          return (
            <label key={o.value} className={`verdict${verdict === o.value ? " on" : ""}`} style={{ borderColor: verdict === o.value ? c.fg : undefined }}>
              <input type="radio" name="bulk-verdict" value={o.value} checked={verdict === o.value} disabled={busy} onChange={() => setVerdict(o.value)} />
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
        <textarea className="review-comment" value={comment} disabled={busy} onChange={(e) => setComment(e.target.value)} rows={3} aria-required={commentRequired} />
      </label>
      {commentRequired && comment.trim() === "" && <p className="hint-error">「{option ? optionLabel(option) : ""}」にはコメントが必要です。</p>}
      <p className="muted small">いまの判定から選べない判定や、担当でない言語のセルは、そのセルだけ投稿されません（終わったあとに、理由と一緒に出します）。</p>
      {result && (
        <div role="alert" className="bulk-result">
          <p className="hint-error">
            {result.posted} 件を投稿しました。{result.failures.length} 件は投稿できませんでした。
          </p>
          <ul className="plain-list small">
            {result.failures.slice(0, 20).map((f) => (
              <li key={`${f.rowKey}\u0000${f.cellId}`}>
                <span className="mono">{f.rowKey}</span>（{f.cellId}）: {f.message}
              </li>
            ))}
          </ul>
          {result.failures.length > 20 && <p className="muted small">ほか {result.failures.length - 20} 件</p>}
        </div>
      )}
    </Dialog>
  );
}
