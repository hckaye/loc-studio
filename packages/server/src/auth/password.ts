/**
 * パスワードのハッシュ（node:crypto の scrypt）。塩は毎回乱数。
 * パラメータをハッシュと一緒に残すので、あとで強くしても古いハッシュを確かめられる。
 * 形: "scrypt$<N>$<r>$<p>$<塩 base64>$<ハッシュ base64>"
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { ApiError } from "../api-types.js";

/** パスワードの最大の長さ（正規化と scrypt の前に確かめる）。 */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * scrypt を同時にいくつまで動かすか。ログインが殺到しても、ほかの要求（ファイルの読み書きなど）が
 * スレッドプールを使えなくならないよう、少なく抑え、待ちが長ければ断る。
 */
export const scryptLimits = { concurrency: 2, maxQueue: 32, perKey: 2, reserved: 8 };
let running = 0;
/** 待ち: 最近ログインに成功した接続元（優先）と、それ以外。 */
const waitingPriority: (() => void)[] = [];
const waiting: (() => void)[] = [];
/** 鍵（接続元）ごとの、実行中と待っている数。 */
const perKey = new Map<string, number>();

/**
 * scrypt の枠を取って fn を実行する。key（接続元）があれば、その接続元は実行中と待ちを合わせて perKey（既定 2）まで。
 * 超えたら待たせずに断る（1 つの接続元が全体の待ちを埋めて、ほかの人のログインを止められないように）。
 * 全体の待ちは先着順。1 つの接続元が使えるのは concurrency + maxQueue のうち perKey 個まで。
 */
async function withScryptSlot<T>(fn: () => Promise<T>, key?: string, priority = false): Promise<T> {
  if (key !== undefined) {
    const n = perKey.get(key) ?? 0;
    if (n >= scryptLimits.perKey) {
      throw new ApiError("throttled", "ログインの試行が多すぎます。しばらく待ってからやり直してください。", { retryAfterMs: 1000, reason: "address-busy" });
    }
    perKey.set(key, n + 1);
  }
  try {
    return await withGlobalSlot(fn, priority);
  } finally {
    if (key !== undefined) {
      const n = (perKey.get(key) ?? 1) - 1;
      if (n <= 0) perKey.delete(key);
      else perKey.set(key, n);
    }
  }
}

/**
 * 全体の枠。待ちは maxQueue まで、そのうち reserved 個は最近ログインに成功した接続元（priority）だけが使える。
 * 枠が空いたら、優先の待ちから先に進める（分散した大量の試行で、いつもの利用者が締め出されにくくする）。
 */
async function withGlobalSlot<T>(fn: () => Promise<T>, priority: boolean): Promise<T> {
  if (running >= scryptLimits.concurrency) {
    const total = waiting.length + waitingPriority.length;
    const full = priority ? total >= scryptLimits.maxQueue : waiting.length >= scryptLimits.maxQueue - scryptLimits.reserved || total >= scryptLimits.maxQueue;
    if (full) {
      throw new ApiError("throttled", "サーバーが混んでいます。しばらく待ってからやり直してください。", { retryAfterMs: 1000 });
    }
    await new Promise<void>((resolve) => (priority ? waitingPriority : waiting).push(resolve));
  } else running++;
  try {
    return await fn();
  } finally {
    const next = waitingPriority.shift() ?? waiting.shift();
    if (next) next();
    else running--;
  }
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { N: 16384, r: 8, p: 1, keyLength: 64 };

function derive(password: string, salt: Buffer, params: ScryptParams, key?: string, priority = false): Promise<Buffer> {
  if (password.length > MAX_PASSWORD_LENGTH) return Promise.reject(new Error("パスワードが長すぎます。"));
  return withScryptSlot(() => deriveNow(password, salt, params), key, priority);
}

function deriveNow(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFC"),
      salt,
      params.keyLength,
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r + 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), key.toString("base64")].join("$");
}

/** ハッシュと照らし合わせる（比較は一定時間）。形の壊れたハッシュは false。 */
export async function verifyPassword(password: string, stored: string, opts: { admissionKey?: string; priority?: boolean } = {}): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const params: ScryptParams = { N: Number(n), r: Number(r), p: Number(p), keyLength: 0 };
  if (![params.N, params.r, params.p].every((x) => Number.isInteger(x) && x > 0)) return false;
  const expected = Buffer.from(keyB64, "base64");
  if (expected.length === 0) return false;
  params.keyLength = expected.length;
  let actual: Buffer;
  try {
    actual = await derive(password, Buffer.from(saltB64, "base64"), params, opts.admissionKey, opts.priority === true);
  } catch (err) {
    // 混雑で断ったときは、そのまま伝える（パスワードの誤りと区別する）。
    if (err instanceof ApiError) throw err;
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** いまの既定より弱いパラメータのハッシュか（ログインの成功時に作り直す）。 */
export function needsRehash(stored: string, params: ScryptParams = DEFAULT_SCRYPT): boolean {
  const parts = stored.split("$");
  return parts[0] !== "scrypt" || Number(parts[1]) < params.N || Number(parts[2]) < params.r || Number(parts[3]) < params.p;
}
