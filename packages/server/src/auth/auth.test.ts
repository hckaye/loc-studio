import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDb } from "@loc-studio/core";
import type { HostDb } from "@loc-studio/sdk";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import { openAuthService } from "./service.js";
import type { AuthConfig, AuthService } from "./service.js";

const FAST = { N: 1024, r: 8, p: 1, keyLength: 32 };

describe("パスワードのハッシュ", () => {
  it("塩つきで、同じパスワードでも毎回違う。照合と、パラメータの引き上げの判定", async () => {
    const a = await hashPassword("correct horse", FAST);
    const b = await hashPassword("correct horse", FAST);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(a).not.toContain("correct horse");
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("correct horsE", a)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
    expect(await verifyPassword("x", "scrypt$0$8$1$aaaa$bbbb")).toBe(false);
    expect(needsRehash(a)).toBe(true);
    expect(needsRehash(a, FAST)).toBe(false);
  });
});

let db: HostDb;
let clock: number;
const now = () => new Date(clock);
const open = (config: Partial<AuthConfig> = {}): AuthService =>
  openAuthService({ db, config: { mode: "password", scrypt: FAST, sessionTtlHours: 1, ...config }, now });

beforeEach(() => {
  db = createMemoryDb();
  clock = Date.parse("2026-01-01T00:00:00Z");
});

describe("AuthService", () => {
  it("利用者の作成・一覧・更新・削除と、ログイン・認証・ログアウト", async () => {
    const auth = open();
    const u = await auth.createUser({ name: "alice", password: "password-1", displayName: "Alice" });
    expect(u).toMatchObject({ name: "alice", displayName: "Alice", admin: false, disabled: false, hasPassword: true });
    expect(JSON.stringify(u)).not.toContain("scrypt");
    await expect(auth.createUser({ name: "alice" })).rejects.toMatchObject({ code: "conflict" });
    await expect(auth.createUser({ name: "bad name" })).rejects.toMatchObject({ code: "invalid" });
    await expect(auth.createUser({ name: "short", password: "1234" })).rejects.toMatchObject({ code: "invalid" });
    await auth.createUser({ name: "bob" });
    expect((await auth.listUsers()).map((x) => x.name)).toEqual(["alice", "bob"]);

    const login = await auth.login({ name: "alice", password: "password-1", clientAddress: "127.0.0.1" });
    expect(login.token.length).toBeGreaterThan(30);
    expect(login.user.name).toBe("alice");
    // トークンはそのままでは保存しない。
    const stored = await db.cells("auth.sessions").query({});
    expect(JSON.stringify(stored)).not.toContain(login.token);
    expect((await auth.authenticate(login.token))?.name).toBe("alice");
    expect(await auth.authenticate("nope")).toBeUndefined();
    await auth.logout(login.token);
    expect(await auth.authenticate(login.token)).toBeUndefined();

    expect((await auth.updateUser("alice", { displayName: "アリス", admin: true })).displayName).toBe("アリス");
    await auth.deleteUser("bob");
    expect(await auth.getUser("bob")).toBeUndefined();
    expect((await auth.listUsers()).map((x) => x.name)).toEqual(["alice"]);
  });

  it("名前の有無を教えない。パスワードのない利用者もログインできない", async () => {
    const auth = open();
    await auth.createUser({ name: "alice", password: "password-1" });
    await auth.createUser({ name: "nopass" });
    const wrong = await auth.login({ name: "alice", password: "wrong-pass", clientAddress: "127.0.0.1" }).catch((e: unknown) => e);
    const unknown = await auth.login({ name: "nobody", password: "wrong-pass", clientAddress: "127.0.0.1" }).catch((e: unknown) => e);
    const nopass = await auth.login({ name: "nopass", password: "whatever1", clientAddress: "127.0.0.1" }).catch((e: unknown) => e);
    for (const e of [wrong, unknown, nopass]) expect(e).toMatchObject({ code: "unauthorized", message: "名前かパスワードが違います。" });
    expect((wrong as Error).message).not.toContain("wrong-pass");
  });

  it("同じ (名前, 接続元) で 5 回失敗すると待たせ、失敗が続くと待ち時間が伸びる", async () => {
    const auth = open();
    await auth.createUser({ name: "alice", password: "password-1" });
    const A = "10.0.0.1";
    for (let i = 0; i < 5; i++) await expect(auth.login({ name: "alice", password: "bad-pass-x", clientAddress: A })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(auth.login({ name: "alice", password: "password-1", clientAddress: A })).rejects.toMatchObject({ code: "throttled", data: { retryAfterMs: 30_000 } });
    clock += 30_001;
    await expect(auth.login({ name: "alice", password: "bad-pass-x", clientAddress: A })).rejects.toMatchObject({ code: "unauthorized" });
    await expect(auth.login({ name: "alice", password: "password-1", clientAddress: A })).rejects.toMatchObject({ code: "throttled", data: { retryAfterMs: 60_000 } });
    clock += 60_001;
    expect((await auth.login({ name: "alice", password: "password-1", clientAddress: A })).user.name).toBe("alice");
    // 成功すると数え直し。4 回の失敗では待たせない。
    for (let i = 0; i < 4; i++) await expect(auth.login({ name: "alice", password: "bad-pass-x", clientAddress: A })).rejects.toMatchObject({ code: "unauthorized" });
    expect((await auth.login({ name: "alice", password: "password-1", clientAddress: A })).user.name).toBe("alice");
    // 存在しない名前でも同じように数える。
    for (let i = 0; i < 5; i++) await auth.login({ name: "ghost", password: "x", clientAddress: A }).catch(() => undefined);
    await expect(auth.login({ name: "ghost", password: "x", clientAddress: A })).rejects.toMatchObject({ code: "throttled" });
  });

  it("セッションは最後の利用から期限が延び、過ぎたら無効", async () => {
    const auth = open({ sessionTtlHours: 1 });
    await auth.createUser({ name: "alice", password: "password-1" });
    const { token, expiresAt } = await auth.login({ name: "alice", password: "password-1", clientAddress: "127.0.0.1" });
    expect(expiresAt).toBe("2026-01-01T01:00:00.000Z");
    clock += 50 * 60_000;
    expect(await auth.authenticate(token)).toBeDefined(); // ここで延びる
    clock += 50 * 60_000; // ログインから 100 分、最後の利用から 50 分
    expect(await auth.authenticate(token)).toBeDefined();
    clock += 61 * 60_000;
    expect(await auth.authenticate(token)).toBeUndefined();
  });

  it("logoutAll、パスワードの変更、無効にした利用者", async () => {
    const auth = open();
    await auth.createUser({ name: "alice", password: "password-1" });
    const s1 = await auth.login({ name: "alice", password: "password-1", clientAddress: "127.0.0.1" });
    const s2 = await auth.login({ name: "alice", password: "password-1", clientAddress: "127.0.0.1" });
    await auth.logoutAll("alice");
    expect(await auth.authenticate(s1.token)).toBeUndefined();
    expect(await auth.authenticate(s2.token)).toBeUndefined();

    const s3 = await auth.login({ name: "alice", password: "password-1", clientAddress: "127.0.0.1" });
    await expect(auth.changePassword({ name: "alice", oldPassword: "nope-nope", newPassword: "password-2", clientAddress: "127.0.0.1" })).rejects.toMatchObject({ code: "unauthorized" });
    await auth.changePassword({ name: "alice", oldPassword: "password-1", newPassword: "password-2", clientAddress: "127.0.0.1" });
    expect(await auth.authenticate(s3.token)).toBeUndefined();
    await expect(auth.login({ name: "alice", password: "password-1", clientAddress: "127.0.0.1" })).rejects.toMatchObject({ code: "unauthorized" });
    const s4 = await auth.login({ name: "alice", password: "password-2", clientAddress: "127.0.0.1" });

    await auth.updateUser("alice", { disabled: true });
    expect(await auth.authenticate(s4.token)).toBeUndefined();
    await expect(auth.login({ name: "alice", password: "password-2", clientAddress: "127.0.0.1" })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("最初の管理者は利用者がいないときだけ作る", async () => {
    const auth = open();
    expect(await auth.bootstrapAdmin({ name: "root", password: "password-1" })).toBe(true);
    expect(await auth.bootstrapAdmin({ name: "root2", password: "password-1" })).toBe(false);
    expect(await auth.getUser("root")).toMatchObject({ admin: true });
    expect(await auth.getUser("root2")).toBeUndefined();
  });

  it("proxy モード: 初めての利用者は自動で登録し、admins は管理者。パスワードのログインは使えない", async () => {
    const auth = open({ mode: "proxy", admins: ["boss"] });
    expect(await auth.authenticateProxyUser("boss")).toMatchObject({ name: "boss", admin: true, hasPassword: false });
    expect(await auth.authenticateProxyUser("worker")).toMatchObject({ admin: false });
    expect(await auth.authenticateProxyUser("bad name")).toBeUndefined();
    await auth.updateUser("worker", { disabled: true });
    expect(await auth.authenticateProxyUser("worker")).toBeUndefined();
    await expect(auth.login({ name: "boss", password: "x", clientAddress: "127.0.0.1" })).rejects.toMatchObject({ code: "invalid" });
    await expect(open().authenticateProxyUser("x")).rejects.toMatchObject({ code: "invalid" });
  });

  it("プロジェクトごとの権限と callContextFor。管理者はどこでも manager", async () => {
    const auth = open();
    const admin = await auth.createUser({ name: "root", admin: true, displayName: "Root" });
    const kim = await auth.createUser({ name: "kim" });
    await expect(auth.setMembership("p1", "kim", { role: "god" as never })).rejects.toMatchObject({ code: "invalid" });
    await expect(auth.setMembership("p1", "nobody", { role: "viewer" })).rejects.toMatchObject({ code: "not-found" });
    await auth.setMembership("p1", "kim", { role: "translator", languages: ["ko"] });
    await auth.setMembership("p2", "kim", { role: "viewer" });
    expect(await auth.callContextFor(kim, "p1")).toEqual({ user: { name: "kim", displayName: "kim" }, role: "translator", languages: ["ko"] });
    expect(await auth.callContextFor(kim, "p2")).toEqual({ user: { name: "kim", displayName: "kim" }, role: "viewer" });
    expect(await auth.callContextFor(kim, "p3")).toBeUndefined();
    expect(await auth.callContextFor(admin, "p3")).toEqual({ user: { name: "root", displayName: "Root" }, role: "manager", admin: true });
    expect((await auth.listMemberships({ user: "kim" })).map((m) => m.projectId).sort()).toEqual(["p1", "p2"]);
    expect(await auth.listMemberships({ projectId: "p1" })).toEqual([{ projectId: "p1", user: "kim", role: "translator", languages: ["ko"] }]);
    await auth.removeMembership("p2", "kim");
    expect(await auth.callContextFor(kim, "p2")).toBeUndefined();
    await auth.updateUser("kim", { disabled: true });
    expect(await auth.callContextFor(kim, "p1")).toBeUndefined();
  });

  it("利用者ごとの設定", async () => {
    const auth = open();
    await auth.createUser({ name: "alice" });
    expect(await auth.getUserSettings("alice")).toEqual({});
    const store = auth.userSettingsStore();
    await store.set("alice", { "ui.theme": "dark" });
    expect(await store.get("alice")).toEqual({ "ui.theme": "dark" });
    await auth.deleteUser("alice");
    expect(await auth.getUserSettings("alice")).toEqual({});
  });
});
