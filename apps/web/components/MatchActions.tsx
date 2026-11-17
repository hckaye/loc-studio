"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RowFilter } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { useStudio } from "@/components/context";
import {
  generateChoices,
  isGenerateChoice,
  matchChoices,
  MAX_BATCH_SIZE,
  runOnMatches,
  supportsBatch,
  type MatchChoice,
  type MatchRunState,
  type MatchTarget,
} from "@/lib/client/match-actions";
import { canGenerate, canRunAction } from "@/lib/client/permissions";

/*
 * 「一括アクション」: いまの絞り込みに合う行すべてに、アクションか、生成列の生成を実行する。
 * 表では開いているリソースの行、検索結果の表示ではプロジェクト全体の行が対象になる。表からは、確かめる窓で、
 * 対象を「このリソース」から「プロジェクト全体」に広げられる。
 * 押すとすぐには実行せず、対象の行数を見せて確かめる。実行中は進み具合を出し、途中でやめられる。
 * 外部の API に送るもの（生成と、行をまとめて受け取れるアクション）は、1 回にまとめて送る行数を選べる。
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
  /** true: 確かめる窓で、対象を「プロジェクト全体」に広げられる（表のツールバー）。 */
  allowProject?: boolean;
  /** 実行が終わったあと（値を読み直す）。 */
  onDone(): void;
  /** ジョブを始めたとき（ジョブの一覧に出す）。 */
  onJob?(jobId: string): void;
}

/** プロジェクト全体の、条件に合う行（確かめる窓で「プロジェクト全体」を選んだときに数える）。 */
type ProjectScope = { state: "loading" } | { state: "ready"; targets: MatchTarget[]; rows: number } | { state: "error"; message: string };

export function MatchActions({ filter, languages, targets, rows, scope, allowProject, onDone, onJob }: MatchActionsProps) {
  const { api, info } = useStudio();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<MatchChoice | null>(null);
  const [run, setRun] = useState<(MatchRunState & { finished: boolean }) | null>(null);
  const [wide, setWide] = useState(false);
  const [project, setProject] = useState<ProjectScope | null>(null);
  const [batchText, setBatchText] = useState("");
  const stop = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const actions = useMemo(() => matchChoices(info, languages), [info, languages]);
  const generations = useMemo(() => generateChoices(info, languages), [info, languages]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled)")?.focus();
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // 「プロジェクト全体」を選んだら、条件に合う行のあるリソースと行数を数える（行を選ぶのは、実行のときのサーバー）。
  const requestKey = JSON.stringify([filter, languages]);
  useEffect(() => {
    if (!pending || !wide) return;
    let alive = true;
    setProject({ state: "loading" });
    api
      .query({ ...filter, languages, limit: 0 })
      .then((r) => alive && setProject({ state: "ready", targets: r.resources.filter((x) => x.matched > 0).map((x) => ({ resourceId: x.resourceId, path: x.path })), rows: r.matched.rows }))
      .catch((err: unknown) => alive && setProject({ state: "error", message: err instanceof Error ? err.message : String(err) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, pending, wide, requestKey]);

  if (actions.length === 0 && generations.length === 0) return null;
  const filtering = Object.keys(filter).length > 0;
  const what = filtering ? "絞り込みに合う" : "すべての";

  // 確かめる窓の対象（表のツールバーでは、このリソースか、プロジェクト全体）。
  const ready = wide ? (project?.state === "ready" ? project : null) : { targets, rows };
  const scopeLabel = wide ? "プロジェクト全体" : scope;
  const generating = pending !== null && isGenerateChoice(pending);

  // まとめて送る行数。空は既定。
  const batchValue = batchText.trim() === "" ? undefined : Number(batchText);
  const batchProblem =
    batchValue !== undefined && (!Number.isInteger(batchValue) || batchValue < 1 || batchValue > MAX_BATCH_SIZE) ? `1 以上 ${MAX_BATCH_SIZE} 以下の整数で入力してください。` : undefined;

  const start = async (choice: MatchChoice) => {
    if (!ready || batchProblem !== undefined) return;
    stop.current = false;
    setRun({ done: 0, total: ready.targets.length, rows: 0, patched: 0, jobRows: 0, cached: 0, errors: [], messages: [], stopped: false, finished: false });
    const result = await runOnMatches(api, choice, { ...filter, languages }, ready.targets, {
      onProgress: (s) => setRun({ ...s, finished: false }),
      stopped: () => stop.current,
      ...(onJob ? { onJob } : {}),
      ...(supportsBatch(choice) && batchValue !== undefined ? { batchSize: batchValue } : {}),
    });
    setRun({ ...result, finished: true });
    onDone();
  };
  const choose = (choice: MatchChoice) => {
    setOpen(false);
    setWide(false);
    setProject(null);
    setBatchText("");
    setPending(choice);
  };
  const close = () => {
    setPending(null);
    setRun(null);
  };

  const item = (c: MatchChoice) => {
    const allowed = isGenerateChoice(c) ? canGenerate(info, c.column.id) : canRunAction(info, c.action.id);
    // 表のツールバーでは、このリソースに合う行がなくても、プロジェクト全体に広げて実行できる。
    const reason = !allowed.ok ? allowed.reason : rows === 0 && !allowProject ? "条件に合う行がありません" : undefined;
    const icon = !isGenerateChoice(c) && c.action.icon && [...c.action.icon].length <= 2 ? `${c.action.icon} ` : "";
    return (
      <button key={c.id} type="button" role="menuitem" className="menu-item" disabled={reason !== undefined} title={reason} onClick={() => choose(c)}>
        {icon}
        {c.label}
      </button>
    );
  };

  return (
    <div className="popover-anchor" ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button
        type="button"
        className="btn small"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${scope}の、${what}行（${rows.toLocaleString()} 行）に、アクションや生成をまとめて実行します。選んだ行だけに実行するときは、表で行を範囲で選びます。`}
        onClick={() => setOpen((o) => !o)}
      >
        一括アクション ▾
      </button>
      {open && (
        <div className="popover right menu-pop" role="menu" aria-label={`${what}行に実行するアクション`}>
          <div className="menu-note muted small">
            {scope}の、{what} {rows.toLocaleString()} 行に実行
            {allowProject ? "（次の窓で、プロジェクト全体に広げられます）" : ""}
          </div>
          {actions.length > 0 && generations.length > 0 && (
            <div className="menu-section" role="presentation">
              アクション
            </div>
          )}
          {actions.map(item)}
          {generations.length > 0 && (
            <div className="menu-section" role="presentation">
              生成（列の値を作る）
            </div>
          )}
          {generations.map(item)}
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
                <button type="button" className="btn primary" disabled={!ready || ready.rows === 0 || batchProblem !== undefined} onClick={() => void start(pending)}>
                  {ready ? `${ready.rows.toLocaleString()} 行に実行` : "行数を数えています…"}
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
              {allowProject && (
                <fieldset className="radio-group">
                  <legend>対象の範囲</legend>
                  <label className="check">
                    <input type="radio" name="match-scope" checked={!wide} onChange={() => setWide(false)} />
                    {scope}（{rows.toLocaleString()} 行）
                  </label>
                  <label className="check">
                    <input type="radio" name="match-scope" checked={wide} onChange={() => setWide(true)} />
                    プロジェクト全体（すべてのリソース）
                    {wide && project?.state === "ready" ? `（${project.rows.toLocaleString()} 行）` : ""}
                  </label>
                </fieldset>
              )}
              {wide && project?.state === "error" ? (
                <p className="hint-error" role="alert">
                  プロジェクト全体の行数を数えられませんでした: {project.message}
                </p>
              ) : !ready ? (
                <p className="muted small" role="status">
                  プロジェクト全体の、条件に合う行を数えています…
                </p>
              ) : (
                <p>
                  「{pending.label}」を、{scopeLabel}の、{what} <strong>{ready.rows.toLocaleString()} 行</strong>
                  {ready.targets.length > 1 ? `（${ready.targets.length} 個のリソース）` : ""}に実行します。
                </p>
              )}
              {supportsBatch(pending) && (
                <div className="field">
                  <label htmlFor="match-batch-size" className="field-label">
                    まとめて送る行数（バッチサイズ）
                  </label>
                  <input
                    id="match-batch-size"
                    className="input small"
                    type="text"
                    inputMode="numeric"
                    value={batchText}
                    placeholder={generating ? "既定" : "1"}
                    aria-invalid={batchProblem !== undefined}
                    onChange={(e) => setBatchText(e.target.value)}
                  />
                  <p className="muted small">
                    外部の API などに、何行分を 1 回で送るかです。空なら既定（{generating ? "生成器の既定。同梱の機械翻訳と翻訳の評価は 1 行ずつ" : "1 行ずつ"}）で実行します。
                  </p>
                  {batchProblem !== undefined && (
                    <p className="hint-error" role="alert">
                      {batchProblem}
                    </p>
                  )}
                </div>
              )}
              {generating ? (
                <p className="muted small">結果がキャッシュにある行は、もう一度は生成しません。生成した結果は、すぐに列に出ます。</p>
              ) : (
                <p className="muted small">アクションが本文を変えたときは、未保存の変更になります（保存するまで、ファイルには書きません）。ステータスなどの列の値は、すぐに変わります。</p>
              )}
            </>
          ) : (
            <div role="status">
              <p>
                {run.finished ? (run.stopped ? "途中でやめました。" : "終わりました。") : stop.current ? "中止しています…" : "実行しています…"} リソース {run.done} / {run.total}
              </p>
              {run.finished &&
                (generating ? (
                  <p>
                    対象のセル {run.rows.toLocaleString()} / キャッシュにあり生成しなかったセル {run.cached.toLocaleString()} / 生成したセル {run.jobRows.toLocaleString()} / エラー {run.errors.length.toLocaleString()} 件
                  </p>
                ) : (
                  <p>
                    条件に合った行 {run.rows.toLocaleString()} / 反映した変更 {run.patched.toLocaleString()}
                    {run.jobRows > 0 ? ` / ジョブで実行した行 ${run.jobRows.toLocaleString()}` : ""} / エラー {run.errors.length.toLocaleString()} 件
                  </p>
                ))}
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
