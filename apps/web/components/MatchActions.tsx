"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RowFilter } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { useStudio } from "@/components/context";
import { matchChoices, runOnMatches, type MatchChoice, type MatchRunState, type MatchTarget } from "@/lib/client/match-actions";
import { canRunAction } from "@/lib/client/permissions";

/*
 * 「一括アクション」: いまの絞り込みに合う行すべてに、アクションを実行する。
 * 表では開いているリソースの行、検索結果の表示ではプロジェクト全体の行が対象になる。
 * 押すとすぐには実行せず、対象の行数を見せて確かめる。実行中は進み具合を出し、途中でやめられる。
 */

export interface MatchActionsProps {
  /** 絞り込みの条件（表と同じもの）。 */
  filter: RowFilter;
  /** 条件の対象の言語（表示中の言語）。 */
  languages: string[];
  /** 条件に合う行のあるリソース。 */
  targets: MatchTarget[];
  /** 条件に合う行の数（確認に出す。実行のときは、サーバーが数え直す）。 */
  rows: number;
  /** 対象の説明（確認に出す。例: 「このリソース」「プロジェクト全体」）。 */
  scope: string;
  /** 実行が終わったあと（値を読み直す）。 */
  onDone(): void;
  /** ジョブを始めたとき（ジョブの一覧に出す）。 */
  onJob?(jobId: string): void;
}

export function MatchActions({ filter, languages, targets, rows, scope, onDone, onJob }: MatchActionsProps) {
  const { api, info } = useStudio();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<MatchChoice | null>(null);
  const [run, setRun] = useState<(MatchRunState & { finished: boolean }) | null>(null);
  const stop = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const choices = useMemo(() => matchChoices(info, languages), [info, languages]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (choices.length === 0) return null;
  const filtering = Object.keys(filter).length > 0;
  const what = filtering ? "絞り込みに合う" : "すべての";

  const start = async (choice: MatchChoice) => {
    stop.current = false;
    setRun({ done: 0, total: targets.length, rows: 0, patched: 0, jobRows: 0, errors: [], messages: [], stopped: false, finished: false });
    const result = await runOnMatches(api, choice, { ...filter, languages }, targets, {
      onProgress: (s) => setRun({ ...s, finished: false }),
      stopped: () => stop.current,
      ...(onJob ? { onJob } : {}),
    });
    setRun({ ...result, finished: true });
    onDone();
  };
  const close = () => {
    setPending(null);
    setRun(null);
  };

  return (
    <div className="popover-anchor" ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button
        type="button"
        className="btn small"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${scope}の、${what}行（${rows.toLocaleString()} 行）に、アクションをまとめて実行します。選んだ行だけに実行するときは、表で行を範囲で選びます。`}
        onClick={() => setOpen((o) => !o)}
      >
        一括アクション ▾
      </button>
      {open && (
        <div className="popover right menu-pop" role="menu" aria-label={`${what}行に実行するアクション`}>
          <div className="menu-note muted small">
            {scope}の、{what} {rows.toLocaleString()} 行に実行
          </div>
          {choices.map((c) => {
            const allowed = canRunAction(info, c.action.id);
            const reason = !allowed.ok ? allowed.reason : rows === 0 ? "条件に合う行がありません" : undefined;
            return (
              <button
                key={c.id}
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={reason !== undefined}
                title={reason}
                onClick={() => {
                  setOpen(false);
                  setPending(c);
                }}
              >
                {c.action.icon && [...c.action.icon].length <= 2 ? `${c.action.icon} ` : ""}
                {c.label}
              </button>
            );
          })}
        </div>
      )}
      {pending && (
        <Dialog
          title={`一括アクション: ${pending.label}`}
          onClose={() => {
            // 実行中は閉じない（「中止」でやめる）。
            if (!run || run.finished) close();
          }}
          footer={
            !run ? (
              <>
                <button type="button" className="btn" onClick={close}>
                  やめる
                </button>
                <button type="button" className="btn primary" onClick={() => void start(pending)}>
                  {rows.toLocaleString()} 行に実行
                </button>
              </>
            ) : run.finished ? (
              <button type="button" className="btn primary" onClick={close}>
                閉じる
              </button>
            ) : (
              <button type="button" className="btn" disabled={stop.current} onClick={() => ((stop.current = true), setRun((r) => (r ? { ...r } : r)))}>
                中止
              </button>
            )
          }
        >
          {!run ? (
            <>
              <p>
                「{pending.label}」を、{scope}の、{what} <strong>{rows.toLocaleString()} 行</strong>
                {targets.length > 1 ? `（${targets.length} 個のリソース）` : ""}に実行します。
              </p>
              <p className="muted small">アクションが本文を変えたときは、未保存の変更になります（保存するまで、ファイルには書きません）。ステータスなどの列の値は、すぐに変わります。</p>
            </>
          ) : (
            <div role="status">
              <p>
                {run.finished ? (run.stopped ? "途中でやめました。" : "終わりました。") : stop.current ? "中止しています…" : "実行しています…"} リソース {run.done} / {run.total}
              </p>
              {run.finished && (
                <p>
                  条件に合った行 {run.rows.toLocaleString()} / 反映した変更 {run.patched.toLocaleString()}
                  {run.jobRows > 0 ? ` / ジョブで実行した行 ${run.jobRows.toLocaleString()}` : ""} / エラー {run.errors.length.toLocaleString()} 件
                </p>
              )}
              {run.messages.length > 0 && (
                <ul className="plain-list small">
                  {run.messages.slice(0, 20).map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                  {run.messages.length > 20 && <li className="muted">ほか {run.messages.length - 20} 件</li>}
                </ul>
              )}
              {run.errors.length > 0 && (
                <ul className="plain-list small hint-error" role="alert">
                  {run.errors.slice(0, 20).map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                  {run.errors.length > 20 && <li>ほか {run.errors.length - 20} 件</li>}
                </ul>
              )}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
