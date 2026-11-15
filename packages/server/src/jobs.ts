/**
 * ジョブ（生成、多数の行へのアクション）。プロセスの中で、ワークスペースごとに 1 つずつ実行する。
 * 進み具合はメモリに持ち、終わったジョブは共有 DB の log("core.jobs") に残す。
 */
import { randomUUID } from "node:crypto";
import type { LogStore } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import { currentCallState, runWithCall } from "./call-context.js";
import type { JobInfo } from "./api-types.js";

export const JOBS_LOG_NS = "core.jobs";

export interface JobHandle {
  readonly info: JobInfo;
  /** cancelJob が呼ばれたか。ジョブはバッチの合間にこれを見て止まる。 */
  cancelled(): boolean;
  /** ワークスペースを閉じたときに中断する。 */
  readonly signal: AbortSignal;
}

interface JobRecord {
  info: JobInfo;
  cancelled: boolean;
  done: Promise<JobInfo>;
}

/** メモリに残す終わったジョブの数。 */
const KEEP_FINISHED = 200;
/** 待っている・実行中のジョブの上限（利用者ごと、ワークスペースごと）。 */
export const jobLimits = { perUser: 3, perWorkspace: 20 };

export class JobManager {
  private readonly records = new Map<string, JobRecord>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();

  constructor(
    private readonly log: () => LogStore<JobInfo>,
    private readonly userName: () => string,
    private readonly onWarning: (message: string) => void,
    private readonly onChange: () => void,
  ) {}

  start(
    kind: JobInfo["kind"],
    label: string,
    total: number,
    run: (job: JobHandle) => Promise<void>,
  ): JobInfo {
    const active = [...this.records.values()].filter((r) => r.info.status === "queued" || r.info.status === "running");
    const user = this.userName();
    if (active.length >= jobLimits.perWorkspace) {
      throw new ApiError("throttled", `実行中・待機中のジョブが多すぎます（上限 ${jobLimits.perWorkspace}）。終わるのを待ってからやり直してください。`);
    }
    if (active.filter((r) => r.info.startedBy === user).length >= jobLimits.perUser) {
      throw new ApiError("throttled", `あなたの実行中・待機中のジョブが多すぎます（上限 ${jobLimits.perUser}）。終わるのを待ってからやり直してください。`);
    }
    const info: JobInfo = {
      id: randomUUID(),
      kind,
      label,
      status: "queued",
      total,
      done: 0,
      failed: 0,
      skipped: 0,
      startedBy: this.userName(),
      startedAt: new Date().toISOString(),
    };
    const record = { info, cancelled: false } as JobRecord;
    // ジョブはあとで動くので、開始した利用者をここで覚え、ジョブの書き込みもその名前で残す。
    const starter = currentCallState();
    const handle: JobHandle = { info, cancelled: () => record.cancelled, signal: this.abort.signal };
    const task = async (): Promise<JobInfo> => {
      if (record.cancelled) {
        info.status = "cancelled";
      } else {
        info.status = "running";
        try {
          await run(handle);
          if (record.cancelled) info.status = "cancelled";
          else info.status = info.failed > 0 ? "failed" : "done";
        } catch (err) {
          info.status = record.cancelled ? "cancelled" : "failed";
          info.error = err instanceof Error ? err.message : String(err);
        }
      }
      info.finishedAt = new Date().toISOString();
      try {
        await this.log().append([{ data: { ...info } }]);
      } catch (err) {
        this.onWarning(`ジョブ「${label}」の記録を DB に残せませんでした: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.onChange();
      this.prune();
      return info;
    };
    const runTask = (): Promise<JobInfo> => runWithCall(starter, task);
    record.done = this.chain.then(runTask, runTask);
    this.chain = record.done.catch(() => undefined);
    this.records.set(info.id, record);
    return { ...info };
  }

  list(): JobInfo[] {
    return [...this.records.values()].map((r) => ({ ...r.info })).reverse();
  }

  get(id: string): JobInfo {
    return { ...this.require(id).info };
  }

  cancel(id: string): JobInfo {
    const r = this.require(id);
    if (r.info.status === "queued" || r.info.status === "running") r.cancelled = true;
    return { ...r.info };
  }

  async wait(id: string): Promise<JobInfo> {
    const r = this.require(id);
    await r.done;
    return { ...r.info };
  }

  /** 閉じるとき: 待っているジョブを取り消し、実行中のものに中断を伝えて終わるのを待つ。 */
  async close(): Promise<void> {
    for (const r of this.records.values()) r.cancelled = true;
    this.abort.abort(new Error("ワークスペースを閉じたため中断しました。"));
    await this.chain;
  }

  private require(id: string): JobRecord {
    const r = this.records.get(id);
    if (!r) throw new ApiError("not-found", `ジョブ "${id}" が見つかりません。`);
    return r;
  }

  private prune(): void {
    const finished = [...this.records.values()].filter((r) => r.info.finishedAt !== undefined);
    for (const r of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.records.delete(r.info.id);
  }
}
