import type { ActionInfo, JobInfo, ProjectInfo, RowFilter } from "@loc-studio/server";
import type { ClientApi } from "@/lib/client/api";
import { isRpcError } from "@/lib/client/api";
import { cellIdOf, columnAppliesTo, columnLabel, textColumnOf } from "@/lib/client/model";

/*
 * 条件に合う行すべてにアクションを実行する（表の絞り込みと、検索結果の表示から）。
 * 行を選ぶのはサーバー（runAction の filter）。画面は、条件に合う行のあるリソースを順に回す。
 * 行の多いリソースはジョブになるので、1 つ終わるのを待ってから次のリソースに進む（ジョブの数の上限に当たらないように）。
 */

export interface MatchChoice {
  /** メニューの中で一意の ID。 */
  id: string;
  action: ActionInfo;
  cellId?: string;
  language?: string;
  label: string;
}

/**
 * 条件に合う行に実行できるアクションの選択肢。対象は cell / row / selection のアクション
 * （file / column はファイルや列の全体が対象なので、ここには出さない）。
 * cell のアクションは、列（アクションの columns。なければ本文の列）と、表示中の言語の組ごとに 1 つ。
 * 言語を絞ったアクション（languages）は、表示中の言語のうち、その言語ごとに 1 つ。
 */
export function matchChoices(info: ProjectInfo, languages: readonly string[]): MatchChoice[] {
  const langLabel = (id: string): string => info.languages.find((l) => l.id === id)?.label ?? id;
  const text = textColumnOf(info);
  const out: MatchChoice[] = [];
  for (const action of info.actions) {
    const allowed = (l: string): boolean => !action.languages || action.languages.includes(l);
    if (action.target === "cell") {
      const columns = action.columns ? info.columns.filter((c) => action.columns!.includes(c.id)) : text ? [text] : [];
      for (const col of columns) {
        const name = col.kind === "text" ? (col.label ?? "本文") : columnLabel(col);
        if (col.scope !== "language") {
          out.push({ id: `${action.id}\u0000${col.id}`, action, cellId: col.id, label: `${action.label}（${name}）` });
          continue;
        }
        for (const l of languages) {
          if (!allowed(l) || !columnAppliesTo(col, l)) continue;
          const cellId = cellIdOf(col, l);
          out.push({ id: `${action.id}\u0000${cellId}`, action, cellId, language: l, label: `${action.label}（${langLabel(l)} / ${name}）` });
        }
      }
    } else if (action.target === "row" || action.target === "selection") {
      if (!action.languages) out.push({ id: action.id, action, label: action.label });
      else for (const l of languages) if (allowed(l)) out.push({ id: `${action.id}\u0000@${l}`, action, language: l, label: `${action.label}（${langLabel(l)}）` });
    }
  }
  return out;
}

export interface MatchTarget {
  resourceId: string;
  path: string;
}

export interface MatchRunState {
  /** 済んだリソースの数と、対象のリソースの数。 */
  done: number;
  total: number;
  /** 条件に合った行の数（サーバーが実行のときに数えたもの）。 */
  rows: number;
  /** すぐに反映した変更の数（ジョブになった分は入らない）。 */
  patched: number;
  /** ジョブで実行した行の数。 */
  jobRows: number;
  errors: string[];
  messages: string[];
  /** 途中でやめた。 */
  stopped: boolean;
}

export interface MatchRunOptions {
  onProgress?(state: MatchRunState): void;
  /** true を返したら、次のリソースに進まずにやめる（動いているジョブは取り消す）。 */
  stopped?(): boolean;
  onJob?(jobId: string): void;
  /** ジョブの終わりを確かめる間隔（ミリ秒）。 */
  pollMs?: number;
  /** ジョブの上限で断られたときに、待ってやり直す回数と、待つ長さ（ミリ秒）。 */
  throttleRetries?: number;
  throttleWaitMs?: number;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const running = (j: JobInfo): boolean => j.status === "running" || j.status === "queued";

export async function runOnMatches(
  api: Pick<ClientApi, "runAction" | "job" | "cancelJob">,
  choice: MatchChoice,
  filter: RowFilter & { languages: string[] },
  targets: readonly MatchTarget[],
  opts: MatchRunOptions = {},
): Promise<MatchRunState> {
  const pollMs = opts.pollMs ?? 500;
  const state: MatchRunState = { done: 0, total: targets.length, rows: 0, patched: 0, jobRows: 0, errors: [], messages: [], stopped: false };
  const report = (): void => opts.onProgress?.({ ...state, errors: [...state.errors], messages: [...state.messages] });
  report();
  for (const target of targets) {
    if (opts.stopped?.()) {
      state.stopped = true;
      break;
    }
    try {
      let res: Awaited<ReturnType<ClientApi["runAction"]>> | undefined;
      for (let attempt = 0; res === undefined; attempt++) {
        try {
          res = await api.runAction({
            actionId: choice.action.id,
            resourceId: target.resourceId,
            filter,
            ...(choice.cellId !== undefined ? { cellId: choice.cellId } : {}),
            ...(choice.language !== undefined ? { language: choice.language } : {}),
          });
        } catch (err) {
          // ほかのジョブ（生成など）で上限に達しているときは、空くのを待つ。
          if (!isRpcError(err, "throttled") || attempt >= (opts.throttleRetries ?? 60) || opts.stopped?.()) throw err;
          await wait(opts.throttleWaitMs ?? 1000);
        }
      }
      state.rows += res.matched ?? 0;
      state.patched += res.patched;
      if (res.message) state.messages.push(`${target.path}: ${res.message}`);
      for (const e of res.errors ?? []) state.errors.push(`${target.path}: ${e}`);
      if (res.jobId) {
        opts.onJob?.(res.jobId);
        let job = await api.job({ id: res.jobId });
        let cancelled = false;
        while (running(job)) {
          if (!cancelled && opts.stopped?.()) {
            cancelled = true;
            await api.cancelJob({ id: res.jobId });
          }
          await wait(pollMs);
          job = await api.job({ id: res.jobId });
        }
        state.jobRows += job.done;
        if (job.error) state.errors.push(`${target.path}: ${job.error}`);
        else if (job.status === "failed" || job.failed > 0) state.errors.push(`${target.path}: ${job.failed} 行で失敗しました。`);
      }
    } catch (err) {
      state.errors.push(`${target.path}: ${errorText(err)}`);
    }
    state.done++;
    report();
  }
  if (!state.stopped && opts.stopped?.() && state.done < state.total) state.stopped = true;
  report();
  return state;
}
