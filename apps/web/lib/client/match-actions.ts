import type { ActionInfo, JobInfo, ProjectInfo, RowFilter } from "@loc-studio/server";
import type { ClientApi } from "@/lib/client/api";
import { isRpcError } from "@/lib/client/api";
import { cellIdOf, columnAppliesTo, columnLabel, textColumnOf, type ColumnDef } from "@/lib/client/model";

/*
 * 条件に合う行すべてに、アクションか生成を実行する（表の絞り込みと、検索結果の表示から）。
 * 行を選ぶのはサーバー（runAction / generate の filter）。画面は、条件に合う行のあるリソースを順に回す。
 * 行の多いリソースはジョブになるので、1 つ終わるのを待ってから次のリソースに進む（ジョブの数の上限に当たらないように）。
 */

/** アクションの選択肢。 */
export interface ActionChoice {
  /** メニューの中で一意の ID。 */
  id: string;
  action: ActionInfo;
  cellId?: string;
  language?: string;
  label: string;
}

/** 生成列の生成の選択肢（列と言語の組ごと）。 */
export interface GenerateChoice {
  id: string;
  /** 生成する列（kind: "generated"）。 */
  column: ColumnDef;
  cellId: string;
  language?: string;
  label: string;
}

export type MatchChoice = ActionChoice | GenerateChoice;

export const isGenerateChoice = (choice: MatchChoice): choice is GenerateChoice => "column" in choice;

/** 1 回にまとめる数（バッチサイズ）を指定できるか。生成と、複数の行をまとめて受け取れるアクション。 */
export const supportsBatch = (choice: MatchChoice): boolean => isGenerateChoice(choice) || choice.action.batch === true;

/** バッチサイズに指定できる数の上限（サービス層の上限と同じ。確かめるのはサービス層）。 */
export const MAX_BATCH_SIZE = 1000;

/**
 * 条件に合う行に実行できるアクションの選択肢。対象は cell / row / selection のアクション
 * （file / column はファイルや列の全体が対象なので、ここには出さない）。
 * cell のアクションは、列（アクションの columns。なければ本文の列）と、表示中の言語の組ごとに 1 つ。
 * 言語を絞ったアクション（languages）は、表示中の言語のうち、その言語ごとに 1 つ。
 */
export function matchChoices(info: ProjectInfo, languages: readonly string[]): ActionChoice[] {
  const langLabel = (id: string): string => info.languages.find((l) => l.id === id)?.label ?? id;
  const text = textColumnOf(info);
  const out: ActionChoice[] = [];
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

/**
 * 条件に合う行に実行できる生成の選択肢。生成列（kind: "generated"）ごとに、言語ごとの列は表示中の言語の組ごとに 1 つ。
 * 列の ID は決め打ちしない（プラグインが足した生成列も、同じように並ぶ）。
 */
export function generateChoices(info: ProjectInfo, languages: readonly string[]): GenerateChoice[] {
  const langLabel = (id: string): string => info.languages.find((l) => l.id === id)?.label ?? id;
  const out: GenerateChoice[] = [];
  for (const column of info.columns) {
    if (column.kind !== "generated") continue;
    const name = columnLabel(column);
    if (column.scope !== "language") {
      out.push({ id: `generate\u0000${column.id}`, column, cellId: column.id, label: `${name} を生成` });
      continue;
    }
    for (const l of languages) {
      if (!columnAppliesTo(column, l)) continue;
      const cellId = cellIdOf(column, l);
      out.push({ id: `generate\u0000${cellId}`, column, cellId, language: l, label: `${name} を生成（${langLabel(l)}）` });
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
  /** 条件に合った行の数（サーバーが実行のときに数えたもの）。生成では、対象のセルの数。 */
  rows: number;
  /** すぐに反映した変更の数（ジョブになった分は入らない）。 */
  patched: number;
  /** ジョブで実行した行の数。生成では、生成したセルの数。 */
  jobRows: number;
  /** 生成だけ: キャッシュに結果があり、生成しなかったセルの数。 */
  cached: number;
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
  /** 1 回にまとめる数（アクションは行、生成は生成器に渡す入力）。省略時は既定（アクションは 1 行ずつ、生成は生成器の既定）。 */
  batchSize?: number;
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
  api: Pick<ClientApi, "runAction" | "generate" | "job" | "cancelJob">,
  choice: MatchChoice,
  filter: RowFilter & { languages: string[] },
  targets: readonly MatchTarget[],
  opts: MatchRunOptions = {},
): Promise<MatchRunState> {
  const pollMs = opts.pollMs ?? 500;
  const batch = opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {};
  const state: MatchRunState = { done: 0, total: targets.length, rows: 0, patched: 0, jobRows: 0, cached: 0, errors: [], messages: [], stopped: false };
  const report = (): void => opts.onProgress?.({ ...state, errors: [...state.errors], messages: [...state.messages] });
  /** 1 つのリソースに実行を始め、結果を足し上げる。ジョブになったら、その ID を返す。 */
  const startOn = async (target: MatchTarget): Promise<string | undefined> => {
    if (isGenerateChoice(choice)) {
      const res = await api.generate({
        columnId: choice.column.id,
        scope: "resource",
        resourceId: target.resourceId,
        filter,
        ...(choice.language !== undefined ? { languages: [choice.language] } : {}),
        ...batch,
      });
      state.rows += res.total;
      state.cached += res.cached;
      return res.jobId;
    }
    const res = await api.runAction({
      actionId: choice.action.id,
      resourceId: target.resourceId,
      filter,
      ...(choice.cellId !== undefined ? { cellId: choice.cellId } : {}),
      ...(choice.language !== undefined ? { language: choice.language } : {}),
      ...batch,
    });
    state.rows += res.matched ?? 0;
    state.patched += res.patched;
    if (res.message) state.messages.push(`${target.path}: ${res.message}`);
    for (const e of res.errors ?? []) state.errors.push(`${target.path}: ${e}`);
    return res.jobId;
  };
  report();
  for (const target of targets) {
    if (opts.stopped?.()) {
      state.stopped = true;
      break;
    }
    try {
      let started = false;
      let jobId: string | undefined;
      for (let attempt = 0; !started; attempt++) {
        try {
          jobId = await startOn(target);
          started = true;
        } catch (err) {
          // ほかのジョブ（生成など）で上限に達しているときは、空くのを待つ。
          if (!isRpcError(err, "throttled") || attempt >= (opts.throttleRetries ?? 60) || opts.stopped?.()) throw err;
          await wait(opts.throttleWaitMs ?? 1000);
        }
      }
      if (jobId) {
        opts.onJob?.(jobId);
        let job = await api.job({ id: jobId });
        let cancelled = false;
        while (running(job)) {
          if (!cancelled && opts.stopped?.()) {
            cancelled = true;
            await api.cancelJob({ id: jobId });
          }
          await wait(pollMs);
          job = await api.job({ id: jobId });
        }
        state.jobRows += job.done;
        if (job.error) state.errors.push(`${target.path}: ${job.error}`);
        else if (job.status === "failed" || job.failed > 0) state.errors.push(`${target.path}: ${job.failed} ${isGenerateChoice(choice) ? "件" : "行"}で失敗しました。`);
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
