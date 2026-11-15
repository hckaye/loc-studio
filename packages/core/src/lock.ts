/**
 * ロックファイルによる書き込みロック。
 *
 * ネットワーク共有上の SQLite は、SQLite 自身のファイルロックが信用できない。
 * そこで書き込む人は、データベースの隣にロックファイルを排他作成してから書く。
 * ロックは 1 回の短い書き込みの間だけ持つ。
 *
 * 守っていること:
 * - 取得は排他作成（"wx"）だけで行う。上書きや削除で奪わない。
 * - 古さは各 PC の時計ではなく、ファイルサーバーの時計で測る（同じフォルダに書いた探り用ファイルの mtime と比べる）。
 * - 古いロックの横取りは「自分の名前に改名できた 1 人だけ」が行い、改名したものだけを消す。
 *   改名した後に中身が変わっていたら（生きた保持者のロックだったら）元に戻す。
 * - 空や書きかけのロックファイルは「保持中」とみなす。
 */
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

export interface LockOwner {
  userName: string;
  hostName: string;
  pid: number;
  /** 何のための書き込みか（表示用）。 */
  purpose?: string;
}

export interface LockInfo extends LockOwner {
  token: string;
  acquiredAt: string;
}

export interface WriteLockOptions {
  lockPath: string;
  owner: LockOwner;
  /** これより古いロックは持ち主が死んだとみなす。既定 30000。 */
  staleAfterMs?: number;
  /** 保持中に mtime を更新する間隔。既定 5000。 */
  heartbeatMs?: number;
  /** 取得を待つ最長時間。既定 20000。 */
  waitMs?: number;
  /** 試行の間隔の基準（ゆらぎを加える）。既定 100。 */
  retryDelayMs?: number;
}

export class LockTimeoutError extends Error {
  readonly holder?: LockInfo;
  readonly lockPath: string;

  constructor(lockPath: string, waitMs: number, holder?: LockInfo) {
    const who = holder
      ? `${holder.userName}（${holder.hostName}）が書き込み中です${holder.purpose ? `（${holder.purpose}）` : ""}`
      : "ほかの誰かが書き込み中です";
    super(`書き込みロックを ${waitMs} ms 待っても取得できませんでした。${who}。ロックファイル: ${lockPath}`);
    this.name = "LockTimeoutError";
    this.lockPath = lockPath;
    if (holder) this.holder = holder;
  }
}

export interface WriteLockHandle {
  readonly info: LockInfo;
  /** ロックがもう自分のものでないと気づいたら true。 */
  readonly lost: boolean;
  renew(): Promise<void>;
  /** 何度呼んでもよい。 */
  release(): Promise<void>;
}

const DEFAULT_STALE_AFTER_MS = 30000;
const DEFAULT_HEARTBEAT_MS = 5000;
const DEFAULT_WAIT_MS = 20000;
const DEFAULT_RETRY_DELAY_MS = 100;

/** Windows で、ほかのプロセスがファイルを開いているときに一時的に出るエラー。 */
const TRANSIENT_CODES = new Set(["EPERM", "EBUSY"]);
const TRANSIENT_RETRIES = 8;

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomId(): string {
  return randomBytes(12).toString("hex");
}

/** 同じフォルダに置く一時ファイルの名前。改名は同じフォルダ内でしか原子的でないため。 */
function siblingPath(lockPath: string, tag: string): string {
  return path.join(path.dirname(lockPath), `${path.basename(lockPath)}.${tag}-${process.pid}-${randomId()}`);
}

/** EPERM / EBUSY のときだけ少し待って繰り返す。 */
async function retryTransient<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= TRANSIENT_RETRIES || !TRANSIENT_CODES.has(errorCode(err) ?? "")) throw err;
      await sleep(10 * (attempt + 1) + Math.random() * 10);
    }
  }
}

async function removeFile(p: string): Promise<void> {
  try {
    await retryTransient(() => fs.unlink(p));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw new Error(`ファイルを削除できませんでした: ${p}: ${errorMessage(err)}`, { cause: err });
  }
}

function parseInfo(text: string): LockInfo | undefined {
  if (text.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // 書きかけ。呼び出し側は「保持中」として扱う。
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.token !== "string" || v.token === "") return undefined;
  const info: LockInfo = {
    token: v.token,
    acquiredAt: typeof v.acquiredAt === "string" ? v.acquiredAt : "",
    userName: typeof v.userName === "string" ? v.userName : "",
    hostName: typeof v.hostName === "string" ? v.hostName : "",
    pid: typeof v.pid === "number" ? v.pid : 0,
  };
  if (typeof v.purpose === "string") info.purpose = v.purpose;
  return info;
}

/** ロックファイルの中身を読む。なければ undefined、書きかけなら info なし。 */
async function readInfoAt(p: string): Promise<{ info?: LockInfo } | undefined> {
  let text: string;
  try {
    text = await retryTransient(() => fs.readFile(p, "utf8"));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw new Error(`ロックファイルを読めませんでした: ${p}: ${errorMessage(err)}`, { cause: err });
  }
  const info = parseInfo(text);
  return info ? { info } : {};
}

async function statOrUndefined(p: string): Promise<Stats | undefined> {
  try {
    return await retryTransient(() => fs.stat(p));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw new Error(`ロックファイルの情報を取得できませんでした: ${p}: ${errorMessage(err)}`, { cause: err });
  }
}

/** ファイルサーバーの「いま」を、同じフォルダに新しく書いたファイルの mtime として得る。 */
async function serverNowMs(lockPath: string): Promise<number> {
  const probe = siblingPath(lockPath, "probe");
  try {
    await fs.writeFile(probe, "", { flag: "wx" });
  } catch (err) {
    throw new Error(`ロックの古さを測る一時ファイルを作れませんでした: ${probe}: ${errorMessage(err)}`, { cause: err });
  }
  try {
    const st = await retryTransient(() => fs.stat(probe));
    return st.mtimeMs;
  } finally {
    await removeFile(probe);
  }
}

interface LockSnapshot {
  info?: LockInfo;
  ageMs: number;
  mtimeMs: number;
  size: number;
}

/** ロックファイルの中身と、サーバーの時計での古さ。なければ undefined。 */
async function inspect(lockPath: string): Promise<LockSnapshot | undefined> {
  const st = await statOrUndefined(lockPath);
  if (!st) return undefined;
  const content = await readInfoAt(lockPath);
  if (!content) return undefined;
  // 読む間に入れ替わっていたら、次の試行で測り直す。
  const st2 = await statOrUndefined(lockPath);
  if (!st2) return undefined;
  const now = await serverNowMs(lockPath);
  const snap: LockSnapshot = {
    ageMs: Math.max(0, now - st2.mtimeMs),
    mtimeMs: st2.mtimeMs,
    size: st2.size,
  };
  if (content.info && st2.mtimeMs === st.mtimeMs) snap.info = content.info;
  return snap;
}

function sameLock(a: LockSnapshot, b: { info?: LockInfo; mtimeMs: number; size: number }): boolean {
  return a.info?.token === b.info?.token && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * 改名で退避したロックが、退避すべきでなかったもの（生きた保持者のもの）だったときに元へ戻す。
 * 戻す先に別のロックができていたら上書きしない（そのときは元の保持者がロックを失う）。
 */
async function restoreLock(moved: string, lockPath: string): Promise<void> {
  try {
    await retryTransient(() => fs.link(moved, lockPath));
    return;
  } catch (err) {
    if (errorCode(err) === "EEXIST") return;
    // ハードリンクが使えないファイルシステム。排他的なコピーで戻す（書きかけは「保持中」扱いなので安全）。
  }
  try {
    await retryTransient(() => fs.copyFile(moved, lockPath, fsConstants.COPYFILE_EXCL));
  } catch (err) {
    if (errorCode(err) === "EEXIST") return;
    throw new Error(`退避したロックファイルを元に戻せませんでした: ${moved} → ${lockPath}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

/**
 * ロックファイルを自分だけの名前に改名し、改名できたら check で中身を確かめる。
 * check が true なら削除、false なら元へ戻す。改名できなかったら（ほかの人が先にした）"missing"。
 */
async function moveAsideAndCheck(
  lockPath: string,
  tag: string,
  check: (moved: { info?: LockInfo; mtimeMs: number; size: number }) => boolean,
): Promise<"removed" | "restored" | "missing" | "busy"> {
  const moved = siblingPath(lockPath, tag);
  try {
    await retryTransient(() => fs.rename(lockPath, moved));
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return "missing";
    if (code && TRANSIENT_CODES.has(code)) return "busy";
    throw new Error(`ロックファイルを改名できませんでした: ${lockPath}: ${errorMessage(err)}`, { cause: err });
  }
  // ここから先、moved は自分が改名したものなので、消すか戻すかの責任は自分にある。
  const st = await statOrUndefined(moved);
  if (!st) return "missing";
  const content = await readInfoAt(moved);
  if (!content) return "missing";
  const snapshot: { info?: LockInfo; mtimeMs: number; size: number } = {
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
  if (content?.info) snapshot.info = content.info;
  if (check(snapshot)) {
    await removeFile(moved);
    return "removed";
  }
  await restoreLock(moved, lockPath);
  await removeFile(moved);
  return "restored";
}

/** 古いロックを横取りできる状態にする。消せたら true。 */
async function removeStale(lockPath: string, seen: LockSnapshot, staleAfterMs: number): Promise<boolean> {
  // 改名の直前に、同じロックがまだ古いかを確かめ直す。
  const again = await inspect(lockPath);
  if (!again || again.ageMs <= staleAfterMs || !sameLock(seen, again)) return false;
  const result = await moveAsideAndCheck(lockPath, "stale", (moved) => sameLock(again, moved));
  return result === "removed";
}

type CreateResult = { kind: "created" } | { kind: "exists" };

async function tryCreate(lockPath: string, info: LockInfo): Promise<CreateResult> {
  let fh: FileHandle;
  try {
    fh = await fs.open(lockPath, "wx");
  } catch (err) {
    const code = errorCode(err);
    // Windows では削除途中のファイルに対して EPERM になることがある。保持中と同じ扱いで待つ。
    if (code === "EEXIST" || (code && TRANSIENT_CODES.has(code))) return { kind: "exists" };
    throw new Error(`ロックファイルを作成できませんでした: ${lockPath}: ${errorMessage(err)}`, { cause: err });
  }
  try {
    await fh.writeFile(JSON.stringify(info), "utf8");
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    // 作った直後の自分のファイル。書けなかったので片付ける（失敗しても古いロックとして回収される）。
    await moveAsideAndCheck(lockPath, "abort", (m) => m.info === undefined || m.info.token === info.token).catch(
      () => undefined,
    );
    throw new Error(`ロックファイルに書き込めませんでした: ${lockPath}: ${errorMessage(err)}`, { cause: err });
  }
  await fh.close();
  return { kind: "created" };
}

function jitter(base: number): number {
  return Math.max(1, Math.round(base * (0.5 + Math.random())));
}

class Handle implements WriteLockHandle {
  readonly info: LockInfo;
  private _lost = false;
  private released = false;
  private timer: NodeJS.Timeout | undefined;
  private beating: Promise<void> | undefined;
  /** 心拍で起きた一時的な失敗。次の心拍か renew() で再試行する。 */
  lastHeartbeatError: unknown;

  constructor(
    private readonly lockPath: string,
    info: LockInfo,
    private readonly heartbeatMs: number,
  ) {
    this.info = info;
    this.schedule();
  }

  get lost(): boolean {
    return this._lost;
  }

  private schedule(): void {
    if (this.released || this._lost) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.beating = this.beat()
        .then(
          () => {
            this.lastHeartbeatError = undefined;
          },
          (err: unknown) => {
            // 心拍は呼び出し元がいないため、ここで記録して次の心拍で再試行する。
            this.lastHeartbeatError = err;
          },
        )
        .finally(() => {
          this.beating = undefined;
          this.schedule();
        });
    }, this.heartbeatMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private markLost(): void {
    this._lost = true;
    this.stopTimer();
  }

  /**
   * トークンを確かめてから、同じ中身を書き直して mtime を進める。
   * utimes だと PC の時計で mtime が付くため、書き込みでサーバーの時計の mtime を付けさせる。
   */
  private async beat(): Promise<void> {
    if (this.released || this._lost) return;
    let fh: FileHandle;
    try {
      fh = await retryTransient(() => fs.open(this.lockPath, "r+"));
    } catch (err) {
      if (errorCode(err) === "ENOENT") {
        this.markLost();
        return;
      }
      throw new Error(`ロックファイルを更新できませんでした: ${this.lockPath}: ${errorMessage(err)}`, { cause: err });
    }
    try {
      const text = await fh.readFile("utf8");
      const info = parseInfo(text);
      if (!info || info.token !== this.info.token) {
        this.markLost();
        return;
      }
      const bytes = Buffer.from(text, "utf8");
      await fh.write(bytes, 0, bytes.length, 0);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async renew(): Promise<void> {
    if (this.released) throw new Error(`解放済みのロックは更新できません: ${this.lockPath}`);
    if (this.beating) await this.beating;
    await this.beat();
    if (this._lost) throw new Error(`書き込みロックはすでにほかの人に移っています: ${this.lockPath}`);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopTimer();
    if (this.beating) await this.beating;
    if (this._lost) return;
    // 確かめてから消すと、その間に入れ替わったロックを消してしまう。改名してから確かめる。
    const result = await moveAsideAndCheck(this.lockPath, "release", (moved) => moved.info?.token === this.info.token);
    if (result === "busy") {
      this.released = false;
      this.schedule();
      throw new Error(`ロックファイルを解放できませんでした（使用中）: ${this.lockPath}`);
    }
    if (result !== "removed") this._lost = true;
  }
}

export async function acquireWriteLock(opts: WriteLockOptions): Promise<WriteLockHandle> {
  const lockPath = path.resolve(opts.lockPath);
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (heartbeatMs >= staleAfterMs) {
    throw new Error(
      `heartbeatMs（${heartbeatMs}）は staleAfterMs（${staleAfterMs}）より短くしてください。ロックファイル: ${lockPath}`,
    );
  }

  const deadline = Date.now() + waitMs;
  let holder: LockInfo | undefined;

  for (;;) {
    const info: LockInfo = {
      ...opts.owner,
      token: randomId(),
      acquiredAt: new Date().toISOString(),
    };
    const created = await tryCreate(lockPath, info);
    if (created.kind === "created") {
      const check = await readInfoAt(lockPath);
      if (check?.info?.token === info.token) return new Handle(lockPath, info, heartbeatMs);
      // 作った直後に入れ替わった。自分のものではないので触らずにやり直す。
    } else {
      const snap = await inspect(lockPath);
      if (!snap) continue; // 消えた。すぐに作り直す。
      if (snap.ageMs > staleAfterMs) {
        if (await removeStale(lockPath, snap, staleAfterMs)) continue;
      }
      if (snap.info) holder = snap.info;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new LockTimeoutError(lockPath, waitMs, holder);
    await sleep(Math.min(remaining, jitter(retryDelayMs)));
  }
}

export async function withWriteLock<T>(
  opts: WriteLockOptions,
  fn: (handle: WriteLockHandle) => Promise<T>,
): Promise<T> {
  const handle = await acquireWriteLock(opts);
  let result: T;
  try {
    result = await fn(handle);
  } catch (err) {
    try {
      await handle.release();
    } catch (releaseErr) {
      throw new AggregateError([err, releaseErr], `処理が失敗し、書き込みロックの解放にも失敗しました: ${opts.lockPath}`);
    }
    throw err;
  }
  await handle.release();
  return result;
}

/** いまのロックの保持者と古さ（サーバーの時計で測る）。ロックがなければ undefined。 */
export async function readLock(lockPath: string): Promise<{ info?: LockInfo; ageMs: number } | undefined> {
  const snap = await inspect(path.resolve(lockPath));
  if (!snap) return undefined;
  return snap.info ? { info: snap.info, ageMs: snap.ageMs } : { ageMs: snap.ageMs };
}
