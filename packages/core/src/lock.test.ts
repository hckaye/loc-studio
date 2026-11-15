import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LockTimeoutError, acquireWriteLock, readLock, withWriteLock } from "./lock.js";
import type { LockInfo, LockOwner, WriteLockOptions } from "./lock.js";

const owner = (userName: string): LockOwner => ({ userName, hostName: "test-host", pid: process.pid });

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "loc-lock-"));
  lockPath = path.join(dir, "db.sqlite.lock");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 条件が成り立つまで待つ。時間を決め打ちにして待つと、テストを並べて走らせて心拍が遅れたときに通ったり落ちたりするので、
 * 「起きるはずのことが起きるまで」待つ（起きなければ、長めの期限で失敗にする）。
 */
async function waitUntil(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${timeoutMs} ミリ秒待っても起きませんでした: ${what}`);
    await sleep(10);
  }
}

/**
 * 「まだ古くない」ことを確かめるテストで使う期限。テストの所要時間よりずっと長くして、
 * 混んで数秒止まっても本当に古くなってしまわないようにする。古いロックは、更新時刻を過去に戻して（makeOld）作る。
 */
const NOT_STALE = { staleAfterMs: 60_000, heartbeatMs: 200 };

function opts(over: Partial<WriteLockOptions> = {}): WriteLockOptions {
  return { lockPath, owner: owner("alice"), retryDelayMs: 5, waitMs: 5000, ...over };
}

async function writeForeignLock(token = "foreign-token"): Promise<LockInfo> {
  const info: LockInfo = { ...owner("bob"), token, acquiredAt: new Date().toISOString() };
  await fs.writeFile(lockPath, JSON.stringify(info));
  return info;
}

/** ロックファイルの更新時刻を過去に戻す（既定は 10 分前。NOT_STALE の期限より確実に古い）。 */
async function makeOld(ms = 600_000): Promise<void> {
  const t = new Date(Date.now() - ms);
  await fs.utimes(lockPath, t, t);
}

/** 一時ファイルが残っていないか（探り用・退避用のファイル）。 */
async function leftovers(): Promise<string[]> {
  return (await fs.readdir(dir)).filter((n) => n !== path.basename(lockPath) && n !== "counter.txt");
}

describe("acquireWriteLock", () => {
  it("同時に多数が取得しても保持者は常に 1 人", async () => {
    let inside = 0;
    let maxInside = 0;
    let count = 0;
    const workers = 12;
    const rounds = 4;
    await Promise.all(
      Array.from({ length: workers }, (_, w) =>
        (async () => {
          for (let i = 0; i < rounds; i++) {
            await withWriteLock(opts({ owner: owner(`u${w}`) }), async () => {
              inside++;
              maxInside = Math.max(maxInside, inside);
              await sleep(1);
              count++;
              inside--;
            });
          }
        })(),
      ),
    );
    expect(maxInside).toBe(1);
    expect(count).toBe(workers * rounds);
    await expect(fs.access(lockPath)).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("書いた中身に保持者とトークンが入る", async () => {
    const h = await acquireWriteLock(opts({ owner: { ...owner("alice"), purpose: "保存" } }));
    const read = await readLock(lockPath);
    expect(read?.info).toEqual(h.info);
    expect(read?.info?.purpose).toBe("保存");
    expect(read!.ageMs).toBeLessThan(5000);
    await h.release();
    expect(await readLock(lockPath)).toBeUndefined();
  });

  it("待ち時間を過ぎると保持者の情報つきで LockTimeoutError", async () => {
    const h = await acquireWriteLock(opts());
    const start = Date.now();
    const err = await acquireWriteLock(opts({ owner: owner("carol"), waitMs: 150 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    const e = err as LockTimeoutError;
    expect(e.holder?.userName).toBe("alice");
    expect(e.holder?.token).toBe(h.info.token);
    expect(e.message).toContain("alice");
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
    await h.release();
  });

  it("古いロックは横取りできる", async () => {
    await writeForeignLock();
    await makeOld(120_000);
    const h = await acquireWriteLock(opts(NOT_STALE));
    expect((await readLock(lockPath))?.info?.token).toBe(h.info.token);
    await h.release();
    expect(await leftovers()).toEqual([]);
  });

  it("新しい他人のロックは横取りしない", async () => {
    const foreign = await writeForeignLock();
    const err = await acquireWriteLock(opts({ ...NOT_STALE, waitMs: 100 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as LockTimeoutError).holder?.token).toBe(foreign.token);
    expect((await readLock(lockPath))?.info?.token).toBe(foreign.token);
  });

  it("1 つの古いロックを多数が同時に狙っても保持者は常に 1 人", async () => {
    await writeForeignLock();
    await makeOld();
    let inside = 0;
    let maxInside = 0;
    let count = 0;
    const n = 10;
    await Promise.all(
      Array.from({ length: n }, (_, w) =>
        withWriteLock(opts({ owner: owner(`w${w}`), ...NOT_STALE }), async () => {
          inside++;
          maxInside = Math.max(maxInside, inside);
          await sleep(2);
          count++;
          inside--;
        }),
      ),
    );
    expect(maxInside).toBe(1);
    expect(count).toBe(n);
    expect(await leftovers()).toEqual([]);
  });

  it("心拍のたびにロックの更新時刻が進み、持ち主は変わらない", async () => {
    const h = await acquireWriteLock(opts({ staleAfterMs: 60_000, heartbeatMs: 30 }));
    const mtime = async (): Promise<number> => (await fs.stat(lockPath)).mtimeMs;
    // 心拍が 3 回入る（更新時刻が 3 回進む）のを待つ。
    for (let beat = 1; beat <= 3; beat++) {
      const before = await mtime();
      await waitUntil(async () => (await mtime()) > before, `${beat} 回目の心拍`);
    }
    expect((await readLock(lockPath))?.info?.token).toBe(h.info.token);
    expect(h.lost).toBe(false);
    await h.release();
  });

  it("古くなったロックでも、持ち主が更新（心拍と同じ renew）すれば新しくなり、横取りされない", async () => {
    // 自動の心拍は事実上止めておき、renew を自分で呼んで確かめる（時間に左右されない）。
    const h = await acquireWriteLock(opts({ staleAfterMs: 100_000, heartbeatMs: 99_999 }));
    await makeOld(120_000);
    expect((await readLock(lockPath))!.ageMs).toBeGreaterThan(60_000);
    await h.renew();
    expect((await readLock(lockPath))!.ageMs).toBeLessThan(60_000);
    const err = await acquireWriteLock(opts({ owner: owner("carol"), ...NOT_STALE, waitMs: 100 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as LockTimeoutError).holder?.token).toBe(h.info.token);
    expect(h.lost).toBe(false);
    await h.release();
  });

  it("心拍が止まると古いロックになり横取りされる", async () => {
    // 取得したまま放置した保持者（プロセスが止まった状態）を、心拍を事実上なくして再現する。
    const dead = await acquireWriteLock(opts({ staleAfterMs: 100_000, heartbeatMs: 99_999 }));
    await makeOld(120_000);
    const h = await acquireWriteLock(opts({ owner: owner("carol"), ...NOT_STALE }));
    expect((await readLock(lockPath))?.info?.token).toBe(h.info.token);
    await expect(dead.renew()).rejects.toThrow();
    expect(dead.lost).toBe(true);
    await dead.release();
    expect((await readLock(lockPath))?.info?.token).toBe(h.info.token);
    await h.release();
  });

  it("ファイルが入れ替わると lost になり、解放しても他人のロックを消さない", async () => {
    const h = await acquireWriteLock(opts({ staleAfterMs: 60_000, heartbeatMs: 20 }));
    await writeForeignLock("replaced");
    await waitUntil(() => h.lost, "次の心拍で、ファイルが入れ替わったことに気づく");
    expect(h.lost).toBe(true);
    await h.release();
    expect((await readLock(lockPath))?.info?.token).toBe("replaced");
  });

  it("ファイルが消されると lost になる", async () => {
    const h = await acquireWriteLock(opts({ staleAfterMs: 60_000, heartbeatMs: 20 }));
    await fs.unlink(lockPath);
    await waitUntil(() => h.lost, "次の心拍で、ファイルが消えたことに気づく");
    expect(h.lost).toBe(true);
    await h.release();
  });

  it("renew は自分のロックなら成功し、他人のものなら失敗する", async () => {
    const h = await acquireWriteLock(opts());
    await h.renew();
    expect(h.lost).toBe(false);
    await writeForeignLock("other");
    await expect(h.renew()).rejects.toThrow(/ほかの人/);
    expect(h.lost).toBe(true);
    await h.release();
    expect((await readLock(lockPath))?.info?.token).toBe("other");
  });

  it("release は何度呼んでもよい", async () => {
    const h = await acquireWriteLock(opts());
    await h.release();
    await h.release();
    expect(await readLock(lockPath)).toBeUndefined();
    // 解放後にほかの人が取ったロックを、2 度目の release で消さない。
    const h2 = await acquireWriteLock(opts({ owner: owner("carol") }));
    await h.release();
    expect((await readLock(lockPath))?.info?.token).toBe(h2.info.token);
    await h2.release();
  });

  it("lost に気づく前でも、release は入れ替わった他人のロックを消さない", async () => {
    const h = await acquireWriteLock(opts({ heartbeatMs: 4000 }));
    await writeForeignLock("swapped");
    expect(h.lost).toBe(false);
    await h.release();
    expect(h.lost).toBe(true);
    expect((await readLock(lockPath))?.info?.token).toBe("swapped");
    expect(await leftovers()).toEqual([]);
  });

  it("空や書きかけのロックファイルは保持中とみなす", async () => {
    // 「まだ古くない」ことを確かめる部分では、期限をテストの所要時間よりずっと長くする。
    // 期限が 1 秒だと、テストを並べて走らせて 1 秒止まっただけで本当に古くなり、通ったり落ちたりする。
    const fresh = { staleAfterMs: 60_000, heartbeatMs: 200, waitMs: 80 };
    await fs.writeFile(lockPath, '{"token":"ab');
    const err = await acquireWriteLock(opts(fresh)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as LockTimeoutError).holder).toBeUndefined();
    expect(await fs.readFile(lockPath, "utf8")).toBe('{"token":"ab');

    await fs.writeFile(lockPath, "");
    await expect(acquireWriteLock(opts(fresh))).rejects.toBeInstanceOf(LockTimeoutError);

    // 古くなれば取れる（更新時刻を期限より前に戻して確かめる。待たない）。
    await makeOld(120_000);
    const h = await acquireWriteLock(opts({ staleAfterMs: 60_000, heartbeatMs: 200 }));
    await h.release();
  });

  it("readLock: ロックがなければ undefined、書きかけなら info なし", async () => {
    expect(await readLock(lockPath)).toBeUndefined();
    await fs.writeFile(lockPath, "{");
    await makeOld(5000);
    const r = await readLock(lockPath);
    expect(r?.info).toBeUndefined();
    expect(r!.ageMs).toBeGreaterThan(4000);
  });

  it("heartbeatMs が staleAfterMs 以上なら誤設定として失敗する", async () => {
    await expect(acquireWriteLock(opts({ staleAfterMs: 100, heartbeatMs: 100 }))).rejects.toThrow(/heartbeatMs/);
  });

  it("ロックのフォルダがなければ、パスつきのエラー", async () => {
    const bad = path.join(dir, "missing", "x.lock");
    await expect(acquireWriteLock(opts({ lockPath: bad }))).rejects.toThrow(bad);
  });
});

describe("withWriteLock", () => {
  it("戻り値を返し、解放する", async () => {
    const v = await withWriteLock(opts(), async (h) => {
      expect((await readLock(lockPath))?.info?.token).toBe(h.info.token);
      return 42;
    });
    expect(v).toBe(42);
    expect(await readLock(lockPath)).toBeUndefined();
  });

  it("fn が投げても解放する", async () => {
    await expect(
      withWriteLock(opts(), async () => {
        throw new Error("失敗");
      }),
    ).rejects.toThrow("失敗");
    expect(await readLock(lockPath)).toBeUndefined();
  });
});

describe("複数プロセス", () => {
  it("4 プロセスが 25 回ずつ増やすと 100 になる", async () => {
    const lockModule = fileURLToPath(new URL("./lock.ts", import.meta.url));
    const counter = path.join(dir, "counter.txt");
    await fs.writeFile(counter, "0");
    const runner = path.join(dir, "runner.mjs");
    // jiti はリポジトリの node_modules から解決させる（一時フォルダからは見えないため）。
    const jitiUrl = pathToFileURL(createRequire(import.meta.url).resolve("jiti")).href;
    await fs.writeFile(
      runner,
      `
import { createJiti } from ${JSON.stringify(jitiUrl)};
import { promises as fs } from "node:fs";
const [lockModule, lockPath, counter, name] = process.argv.slice(2);
const jiti = createJiti(import.meta.url);
const { withWriteLock } = await jiti.import(lockModule);
for (let i = 0; i < 25; i++) {
  await withWriteLock(
    { lockPath, owner: { userName: name, hostName: "h", pid: process.pid }, retryDelayMs: 5, waitMs: 15000 },
    async () => {
      const n = Number(await fs.readFile(counter, "utf8"));
      await new Promise((r) => setTimeout(r, 1));
      await fs.writeFile(counter, String(n + 1));
    },
  );
}
`,
    );
    const run = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [runner, lockModule, lockPath, counter, name], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`子プロセス ${name} が終了コード ${code} で終了: ${stderr}`)),
        );
      });
    await Promise.all(["p1", "p2", "p3", "p4"].map(run));
    expect(await fs.readFile(counter, "utf8")).toBe("100");
    await expect(fs.access(lockPath)).rejects.toThrow();
  });
});
