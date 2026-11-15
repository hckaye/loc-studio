"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JobInfo } from "@loc-studio/server";
import { useStudio, useToasts } from "@/components/context";
import { formatTime } from "@/lib/client/model";
import { isRpcError } from "@/lib/client/api";

/* ジョブ（生成、アクション）の表示。動いているジョブがあるか、一覧を開いている間だけ問い合わせる。 */

const STATUS_LABEL: Record<JobInfo["status"], string> = { queued: "待機中", running: "実行中", done: "完了", failed: "失敗", cancelled: "取消" };

export function useJobs(onFinished: (job: JobInfo) => void) {
  const { api } = useStudio();
  const { reportError } = useToasts();
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [watching, setWatching] = useState(0);
  const prev = useRef(new Map<string, JobInfo["status"]>());
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const refresh = useCallback(async () => {
    try {
      const list = await api.jobs();
      for (const j of list) {
        const before = prev.current.get(j.id);
        if ((before === "running" || before === "queued") && j.status !== "running" && j.status !== "queued") onFinishedRef.current(j);
        prev.current.set(j.id, j.status);
      }
      setJobs(list);
      return list;
    } catch (err) {
      if (isRpcError(err, "network")) console.warn(err);
      else reportError(err, "ジョブの一覧");
      return [];
    }
  }, [api, reportError]);

  const active = jobs.some((j) => j.status === "running" || j.status === "queued");
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!active && watching === 0) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [active, watching, refresh]);
  // ほかの人やコマンドラインが始めたジョブも見えるように、画面が見えている間はゆっくり問い合わせる
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  const track = useCallback(
    (jobId: string) => {
      prev.current.set(jobId, "running");
      void refresh();
    },
    [refresh],
  );
  const cancel = useCallback(
    async (id: string) => {
      try {
        await api.cancelJob({ id });
        void refresh();
      } catch (err) {
        reportError(err, "取り消せませんでした");
      }
    },
    [api, refresh, reportError],
  );
  return { jobs, active, track, cancel, setWatching, refresh };
}

export function JobsIndicator({ jobs, active, onCancel, onOpenChange }: { jobs: JobInfo[]; active: boolean; onCancel(id: string): void; onOpenChange(open: boolean): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued");
  useEffect(() => onOpenChange(open), [open, onOpenChange]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="popover-anchor" ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button type="button" className={`btn small topbar-btn${active ? " busy" : ""}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={`ジョブ（実行中 ${running.length} 件）`}>
        {active ? <span className="spinner" aria-hidden="true" /> : "⚙"} ジョブ{running.length > 0 ? ` ${running.length}` : ""}
      </button>
      {open && (
        <div className="popover right jobs-popover" role="region" aria-label="ジョブの一覧">
          {jobs.length === 0 && <p className="muted small">ジョブはありません。</p>}
          <ul className="plain-list">
            {[...jobs].reverse().map((j) => {
              const pct = j.total > 0 ? Math.round(((j.done + j.failed + j.skipped) / j.total) * 100) : j.status === "done" ? 100 : 0;
              return (
                <li key={j.id} className="job">
                  <div className="job-head">
                    <span>{j.label}</span>
                    <span className={`badge job-${j.status}`}>{STATUS_LABEL[j.status]}</span>
                    {(j.status === "running" || j.status === "queued") && (
                      <button type="button" className="btn small" onClick={() => onCancel(j.id)}>
                        取消
                      </button>
                    )}
                  </div>
                  <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${j.label} の進み具合`}>
                    <span className="fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="muted small">
                    {j.done} / {j.total} 件{j.failed ? `・失敗 ${j.failed}` : ""}
                    {j.skipped ? `・スキップ ${j.skipped}` : ""} ・ {j.startedBy} {formatTime(j.startedAt)}
                  </div>
                  {j.error && <div className="hint-error">{j.error}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
