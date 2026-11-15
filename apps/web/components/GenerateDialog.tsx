"use client";
import { useEffect, useState } from "react";
import type { GenerateParams } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { useStudio, useToasts } from "@/components/context";
import { columnLabel, type ColumnDef } from "@/lib/client/model";
import { canRun } from "@/lib/client/permissions";

/* 生成の確認。先に dryRun で件数（全体 / キャッシュ済み / 実行する）を出し、確認してから始める。 */

export interface GenerateRequest {
  column: ColumnDef;
  resourceId: string;
  keys: string[];
  languages: string[];
  /** 最初に選んでおく範囲。 */
  scope: GenerateParams["scope"];
}

const SCOPE_LABEL: Record<GenerateParams["scope"], string> = { cell: "このセル", selection: "選択した行", resource: "このリソース全体", project: "プロジェクト全体" };

export function GenerateDialog({ req, onClose, onStarted }: { req: GenerateRequest; onClose(): void; onStarted(jobId: string | undefined): void }) {
  const { api, info } = useStudio();
  const run = canRun(info);
  const { push, reportError } = useToasts();
  const [scope, setScope] = useState<GenerateParams["scope"]>(req.scope);
  const [counts, setCounts] = useState<{ total: number; cached: number; toRun: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const params = (dryRun: boolean): GenerateParams => ({
    columnId: req.column.id,
    scope,
    ...(scope !== "project" ? { resourceId: req.resourceId } : {}),
    ...(scope === "cell" || scope === "selection" ? { keys: req.keys } : {}),
    ...(req.column.scope === "language" ? { languages: req.languages } : {}),
    dryRun,
  });

  useEffect(() => {
    let alive = true;
    setCounts(null);
    api
      .generate(params(true))
      .then((c) => alive && setCounts({ total: c.total, cached: c.cached, toRun: c.toRun }))
      .catch((err: unknown) => reportError(err, "件数を数えられませんでした"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const start = async () => {
    setBusy(true);
    try {
      const res = await api.generate(params(false));
      push("info", res.jobId ? "生成を始めました" : `生成しました（${res.toRun} 件）`);
      onStarted(res.jobId);
      onClose();
    } catch (err) {
      reportError(err, "生成を始められませんでした");
    } finally {
      setBusy(false);
    }
  };

  const scopes: GenerateParams["scope"][] = req.keys.length === 1 ? ["cell", "resource", "project"] : req.keys.length > 1 ? ["selection", "resource", "project"] : ["resource", "project"];

  return (
    <Dialog
      title={`生成: ${columnLabel(req.column)}`}
      className="small-dialog"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn primary" disabled={busy || !run.ok || !counts || counts.toRun === 0} title={run.reason} onClick={() => void start()}>
            {counts && counts.toRun > 0 ? `${counts.toRun} 件を生成` : "生成"}
          </button>
        </>
      }
    >
      <fieldset className="radio-group">
        <legend>範囲</legend>
        {scopes.map((s) => (
          <label key={s} className="check">
            <input type="radio" name="gen-scope" checked={scope === s} onChange={() => setScope(s)} />
            {SCOPE_LABEL[s]}
            {s === "selection" ? `（${req.keys.length} 行）` : ""}
          </label>
        ))}
      </fieldset>
      {req.column.scope === "language" && <p className="small muted">対象の言語: {req.languages.join(", ")}</p>}
      {!counts ? (
        <p className="muted small">件数を数えています…</p>
      ) : (
        <table className="kv">
          <tbody>
            <tr>
              <th>全体</th>
              <td>{counts.total} 件</td>
            </tr>
            <tr>
              <th>キャッシュ済み</th>
              <td>{counts.cached} 件（実行しません）</td>
            </tr>
            <tr>
              <th>実行する</th>
              <td>
                <strong>{counts.toRun} 件</strong>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </Dialog>
  );
}
