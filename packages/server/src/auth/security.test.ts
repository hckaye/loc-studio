/**
 * 認証の安全性（セキュリティレビューの C6 / C7 / C8 / C10）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryDb } from "@loc-studio/core";
import type { HostDb } from "@loc-studio/sdk";
import { clientAddressFrom } from "../server-config.js";
import { hashPassword, MAX_PASSWORD_LENGTH, scryptLimits, verifyPassword } from "./password.js";
import { addressKey, normalizeUserName, openAuthService } from "./service.js";
import type { AuthConfig, AuthService } from "./service.js";

const FAST = { N: 1024, r: 8, p: 1, keyLength: 32 };
let db: HostDb;
let clock: number;
const now = () => new Date(clock);
const open = (config: Partial<AuthConfig> = {}): AuthService =>
  openAuthService({ db, config: { mode: "password", scrypt: FAST, ...config }, now });

beforeEach(() => {
  db = createMemoryDb();
  clock = Date.parse("2026-01-01T00:00:00Z");
});
afterEach(() => {
  scryptLimits.concurrency = 2;
  scryptLimits.maxQueue = 32;
  scryptLimits.perKey = 2;
  scryptLimits.reserved = 8;
});

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  }
};

describe("C6: 試行は scrypt の前に、比較して書く形で予約する", () => {
  it("同じ名前と接続元から 60 回並べて投げても、評価されるのは 5 回まで（同じプロセス）", async () => {
    const auth = open();
    await auth.createUser({ name: "alice", password: "password-1" });
    const results = await Promise.all(Array.from({ length: 60 }, () => outcome(auth.login({ name: "alice", password: "wrong-pass", clientAddress: "1.2.3.4" }))));
    expect(results.filter((r) => r === "unauthorized")).toHaveLength(5);
    expect(results.filter((r) => r === "throttled")).toHaveLength(55);
  });

  it("同じ DB を使う 2 つのプロセス（サービス）からでも、数え漏れない", async () => {
    const a = open();
    const b = open();
    await a.createUser({ name: "alice", password: "password-1" });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => outcome((i % 2 ? a : b).login({ name: "alice", password: "wrong-pass", clientAddress: "1.2.3.4" }))),
    );
    expect(results.filter((r) => r === "unauthorized").length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r === "throttled").length).toBeGreaterThanOrEqual(35);
  });
});

describe("C7: 鍵は (名前, 接続元) と接続元ごと。ほかの接続元の失敗で正しいパスワードを止めない", () => {
  it("攻撃者の接続元が待たされても、ほかの接続元からの正しいパスワードは通る", async () => {
    const auth = open();
    await auth.createUser({ name: "alice", password: "password-1" });
    for (let i = 0; i < 10; i++) await auth.login({ name: "alice", password: "wrong-pass", clientAddress: "6.6.6.6" }).catch(() => undefined);
    await expect(auth.login({ name: "alice", password: "password-1", clientAddress: "6.6.6.6" })).rejects.toMatchObject({ code: "throttled" });
    expect((await auth.login({ name: "alice", password: "password-1", clientAddress: "10.0.0.2" })).user.name).toBe("alice");
  });

  it("接続元ごとの上限: 1 つの接続元から名前を変えて推測し続けると待たせる", async () => {
    const auth = open({ throttle: { address: { freeFailures: 10 } } });
    for (let i = 0; i < 10; i++) await expect(auth.login({ name: `user${i}`, password: "x", clientAddress: "6.6.6.6" })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(auth.login({ name: "someone-else", password: "x", clientAddress: "6.6.6.6" })).rejects.toMatchObject({ code: "throttled" });
    await expect(auth.login({ name: "someone-else", password: "x", clientAddress: "7.7.7.7" })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("名前ごとの上限（分散した推測）は待たせるだけで、断らない", async () => {
    const sleeps: number[] = [];
    const auth = open({ throttle: { name: { freeFailures: 3, stepMs: 100, maxDelayMs: 250 } }, sleep: async (ms) => void sleeps.push(ms) });
    await auth.createUser({ name: "alice", password: "password-1" });
    for (let i = 0; i < 6; i++) await expect(auth.login({ name: "alice", password: "wrong", clientAddress: `9.9.9.${i}` })).rejects.toMatchObject({ code: "unauthorized" });
    expect(sleeps).toEqual([100, 200, 250]);
    // 失敗のない接続元からの正しいパスワードは（待たされても）通る。
    expect((await auth.login({ name: "alice", password: "password-1", clientAddress: "10.1.1.1" })).user.name).toBe("alice");
  });

  it("古い記録は期限で忘れ、purge で消える", async () => {
    const auth = open();
    for (let i = 0; i < 5; i++) await auth.login({ name: "alice", password: "x", clientAddress: "1.1.1.1" }).catch(() => undefined);
    expect((await db.cells("auth.throttle").query({})).filter((c) => c.value).length).toBeGreaterThan(0);
    clock += 25 * 3600_000;
    const r = await auth.purge();
    expect(r.throttle).toBeGreaterThan(0);
    expect((await db.cells("auth.throttle").query({})).filter((c) => c.value)).toEqual([]);
  });

  it("changePassword もログインと同じ総当たり対策を受ける", async () => {
    const auth = open();
    await auth.createUser({ name: "alice", password: "password-1" });
    for (let i = 0; i < 5; i++) {
      await expect(auth.changePassword({ name: "alice", oldPassword: "guess-guess", newPassword: "password-2", clientAddress: "1.1.1.1" })).rejects.toMatchObject({
        code: "unauthorized",
      });
    }
    await expect(auth.changePassword({ name: "alice", oldPassword: "password-1", newPassword: "password-2", clientAddress: "1.1.1.1" })).rejects.toMatchObject({
      code: "throttled",
    });
  });

  it("接続元の求め方: 段数 0 なら X-Forwarded-For を信じない", () => {
    expect(clientAddressFrom({ remoteAddress: "10.0.0.5", forwardedFor: "1.2.3.4" })).toBe("10.0.0.5");
    expect(clientAddressFrom({ remoteAddress: "10.0.0.5", forwardedFor: "spoofed, 1.2.3.4" }, 1)).toBe("1.2.3.4");
    expect(clientAddressFrom({ remoteAddress: "10.0.0.5", forwardedFor: ["spoofed", "1.2.3.4, 172.16.0.1"] }, 2)).toBe("1.2.3.4");
    expect(clientAddressFrom({ remoteAddress: "10.0.0.5" }, 3)).toBe("10.0.0.5");
    expect(clientAddressFrom({})).toBe("unknown");
  });
});

describe("C8: 安価なサービス妨害", () => {
  it("長すぎるパスワードは scrypt の前に断る", async () => {
    const auth = open();
    await auth.createUser({ name: "alice", password: "password-1" });
    const long = "x".repeat(MAX_PASSWORD_LENGTH + 1);
    await expect(auth.login({ name: "alice", password: long, clientAddress: "1.1.1.1" })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(auth.createUser({ name: "bob", password: long })).rejects.toMatchObject({ code: "invalid" });
    await expect(auth.setPassword("alice", long)).rejects.toMatchObject({ code: "invalid" });
    expect(await verifyPassword(long, await hashPassword("password-1", FAST))).toBe(false);
  });

  it("scrypt の同時実行を絞り、待ちが長ければ throttled で断る", async () => {
    scryptLimits.concurrency = 1;
    scryptLimits.maxQueue = 2;
    scryptLimits.reserved = 0;
    const hash = await hashPassword("password-1", { N: 16384, r: 8, p: 1, keyLength: 64 });
    const results = await Promise.all(Array.from({ length: 8 }, () => outcome(verifyPassword("password-1", hash))));
    expect(results.filter((r) => r === "ok")).toHaveLength(3);
    expect(results.filter((r) => r === "throttled")).toHaveLength(5);
  });
});

describe("C10: セッションの絶対の期限、名前の正規化、proxy モード", () => {
  it("使っていても sessionMaxHours を過ぎたら無効。期限切れは purge で消える", async () => {
    const auth = open({ sessionTtlHours: 1, sessionMaxHours: 2 });
    await auth.createUser({ name: "alice", password: "password-1" });
    const { token } = await auth.login({ name: "alice", password: "password-1", clientAddress: "1.1.1.1" });
    for (let i = 0; i < 3; i++) {
      clock += 30 * 60_000;
      expect(await auth.authenticate(token)).toBeDefined();
    }
    clock += 31 * 60_000; // ログインから 121 分
    expect(await auth.authenticate(token)).toBeUndefined();
    const t2 = (await auth.login({ name: "alice", password: "password-1", clientAddress: "1.1.1.1" })).token;
    clock += 3 * 3600_000;
    expect((await auth.purge()).sessions).toBe(1);
    expect(await auth.authenticate(t2)).toBeUndefined();
  });

  it("名前は NFC・前後の空白を除き・大文字小文字を区別しない", async () => {
    expect(normalizeUserName("  Alice ")).toBe("alice");
    expect(normalizeUserName("ａｌｉｃｅ")).toBeUndefined(); // 全角は使えない
    expect(normalizeUserName("ali ce")).toBeUndefined();
    expect(normalizeUserName("-alice")).toBeUndefined();
    const auth = open();
    expect((await auth.createUser({ name: " Alice ", password: "password-1" })).name).toBe("alice");
    await expect(auth.createUser({ name: "ALICE" })).rejects.toMatchObject({ code: "conflict" });
    expect((await auth.login({ name: "ALICE ", password: "password-1", clientAddress: "1.1.1.1" })).user.name).toBe("alice");
    expect((await auth.getUser("AlIcE"))?.name).toBe("alice");
  });

  it("proxy モード: 合言葉が合わなければ名前を信じない。admins は作るときだけ", async () => {
    const auth = open({ mode: "proxy", admins: ["Boss"], proxySecret: "s3cret" });
    expect(await auth.authenticateProxyUser("boss")).toBeUndefined();
    expect(await auth.authenticateProxyUser("boss", { secret: "wrong" })).toBeUndefined();
    expect(await auth.authenticateProxyUser(" BOSS ", { secret: "s3cret" })).toMatchObject({ name: "boss", admin: true });
    await auth.updateUser("boss", { admin: false });
    expect(await auth.authenticateProxyUser("boss", { secret: "s3cret" })).toMatchObject({ admin: false });
    const noSecret = open({ mode: "proxy" });
    expect(await noSecret.authenticateProxyUser("worker")).toMatchObject({ name: "worker" });
  });
});

describe("N3: 1 つの接続元が scrypt の待ちを埋めて、ほかの人のログインを止められない", () => {
  it("1 つの接続元から名前を変えて 48 本同時に投げても、ほかの接続元からの正しいログインは通る（既定の上限）", async () => {
    const auth = open({ scrypt: undefined }); // 本番と同じ重さの scrypt
    await auth.createUser({ name: "alice", password: "password-1" });
    const flood = Array.from({ length: 48 }, (_, i) => outcome(auth.login({ name: `rnd${i}`, password: "x", clientAddress: "6.6.6.6" })));
    const good = auth.login({ name: "alice", password: "password-1", clientAddress: "10.0.0.9" });
    expect((await good).user.name).toBe("alice");
    const results = await Promise.all(flood);
    // 同じ接続元は、実行中と待ちを合わせて 2 本まで。残りはすぐ断る（失敗として数える）。
    expect(results.filter((r) => r === "unauthorized").length).toBeLessThanOrEqual(scryptLimits.perKey + 2);
    expect(results.filter((r) => r === "throttled").length).toBeGreaterThanOrEqual(44);
  });

  it("IPv6 は /64 ごと、IPv4 を写した IPv6 は IPv4 として数える", async () => {
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(addressKey("[2001:db8:1:2::5]")).toBe("2001:db8:1:2::/64");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("")).toBe("unknown");

    const auth = open({ throttle: { address: { freeFailures: 20 } } });
    await auth.createUser({ name: "alice", password: "password-1" });
    // 同じ /64 の 40 個のアドレスから順に推測しても、1 つの接続元として 20 回で待たせる。
    const results: string[] = [];
    for (let i = 1; i <= 40; i++) results.push(await outcome(auth.login({ name: `u${i}`, password: "x", clientAddress: `2001:db8:1:2::${i.toString(16)}` })));
    expect(results.filter((r) => r === "unauthorized")).toHaveLength(20);
    expect(results.filter((r) => r === "throttled")).toHaveLength(20);
    // 別の /64 からは通る。
    expect((await auth.login({ name: "alice", password: "password-1", clientAddress: "2001:db8:1:3::1" })).user.name).toBe("alice");
  });

  it("同時に投げた場合も、同じ /64 は scrypt の実行中と待ちを合わせて 2 本まで", async () => {
    const auth = open({ scrypt: undefined });
    const flood = await Promise.all(Array.from({ length: 40 }, (_, i) => outcome(auth.login({ name: `v${i}`, password: "x", clientAddress: `2001:db8:9:9::${(i + 1).toString(16)}` }))));
    expect(flood.filter((r) => r === "unauthorized").length).toBeLessThanOrEqual(scryptLimits.perKey + 2);
  });
});

describe("4: 分散した大量の試行でも、最近ログインに成功した接続元は締め出さない", () => {
  it("新しい 20 の接続元から 2 本ずつ同時に投げても、前にログインに成功した接続元からのログインは通る", async () => {
    const auth = open({ scrypt: undefined });
    await auth.createUser({ name: "alice", password: "password-1" });
    await auth.login({ name: "alice", password: "password-1", clientAddress: "198.51.100.7" });
    const flood = Array.from({ length: 40 }, (_, i) => outcome(auth.login({ name: `x${i}`, password: "x", clientAddress: `203.0.113.${(i % 20) + 1}` })));
    const good = outcome(auth.login({ name: "alice", password: "password-1", clientAddress: "198.51.100.7" }));
    expect(await good).toBe("ok");
    const results = await Promise.all(flood);
    // 新しい接続元は待ちの残りの枠しか使えないので、断られるものがある（残るリスク）。
    expect(results.filter((r) => r === "throttled").length).toBeGreaterThan(0);
  });

  it("成功の記録は 30 日で忘れる", async () => {
    const auth = open();
    await auth.createUser({ name: "alice", password: "password-1" });
    await auth.login({ name: "alice", password: "password-1", clientAddress: "198.51.100.7" });
    const known = () => db.cells("auth.throttle").query({}).then((cs) => cs.filter((c) => (c.value as { lastSuccess?: number } | null)?.lastSuccess !== undefined));
    expect(await known()).toHaveLength(1);
    clock += 29 * 24 * 3600_000;
    await auth.purge();
    expect(await known()).toHaveLength(1);
    clock += 2 * 24 * 3600_000;
    await auth.purge();
    expect(await known()).toHaveLength(0);
  });
});
