/**
 * アカウント、セッション、プロジェクトごとの権限、利用者ごとの設定（Web モード）。
 * すべて HostDb（cells / kv）に置くので、SQLite でも Postgres でも同じように動く。
 * 秘密（パスワード、トークン）はログにもエラーの文言にも出さない。トークンはハッシュだけを保存する。
 *
 * 総当たり対策（throttle.ts の考え方をここにまとめる）:
 * - 試行は scrypt の前に「失敗」として予約し（版つきの CellStore.set で比較して書く。複数のプロセスでも数え漏れない）、成功したら取り消す。
 * - 鍵は (名前, 接続元) と、接続元ごと（名前をまたぐ）。失敗が続くと待ち時間が伸びる（固定のロックはしない）。
 * - 名前ごと（接続元をまたぐ）の上限は、待たせるだけで断らない（分散した推測を遅くする）。
 * - 失敗のない接続元からの正しいパスワードは、ほかの接続元の失敗では止めない。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { StoreConflictError } from "@loc-studio/sdk";
import type { CellRef, CellStore, HostDb } from "@loc-studio/sdk";
import { ApiError } from "../api-types.js";
import type { CallContext, Role, UserSettingsStore } from "../api-types.js";
import { KeyedMutex } from "../mutex.js";
import { ROLES } from "../permissions.js";
import { DEFAULT_SCRYPT, hashPassword, MAX_PASSWORD_LENGTH, needsRehash, verifyPassword } from "./password.js";
import type { ScryptParams } from "./password.js";

export interface ThrottlePolicy {
  /** この回数の失敗までは待たせない。 */
  freeFailures: number;
  /** それを超えた最初の待ち時間（ミリ秒）。以後、失敗ごとに倍にする。 */
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface AuthConfig {
  mode: "password" | "proxy";
  /** セッションの期限（最後の利用からの時間）。既定 168。 */
  sessionTtlHours?: number;
  /** セッションの絶対の期限（ログインからの時間）。既定 720（30 日）。 */
  sessionMaxHours?: number;
  /** proxy モードで利用者名を渡す HTTP ヘッダー（Web の層が読む）。既定 "x-forwarded-user"。 */
  proxyHeader?: string;
  /** proxy モードで、プロキシだけが知る合言葉を渡す HTTP ヘッダー（Web の層が読む）。 */
  proxySecretHeader?: string;
  /** proxy モードの合言葉の値（ServerRuntime が proxySecretEnv の環境変数から入れる）。あれば authenticateProxyUser で照合する。 */
  proxySecret?: string;
  /** 管理者のログイン名。アカウントを作るときだけ使う（あとで管理者が外したら、もう付けない）。 */
  admins?: string[];
  /** 総当たり対策。 */
  throttle?: { pair?: Partial<ThrottlePolicy>; address?: Partial<ThrottlePolicy>; name?: { freeFailures?: number; stepMs?: number; maxDelayMs?: number } };
  /** テスト用（既定は DEFAULT_SCRYPT）。 */
  scrypt?: ScryptParams;
  /** テスト用: 名前ごとの上限で待たせる関数（既定は setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
}

/** 利用者（パスワードのハッシュは含まない）。 */
export interface AuthUser {
  name: string;
  displayName: string;
  admin: boolean;
  disabled: boolean;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  projectId: string;
  user: string;
  role: Role;
  languages?: string[];
}

export interface LoginResult {
  /** セッションのトークン（ここで 1 回だけ返す。サーバーにはハッシュだけを残す）。 */
  token: string;
  user: AuthUser;
  expiresAt: string;
}

export interface AuthService {
  readonly config: Readonly<{ mode: "password" | "proxy"; sessionTtlHours: number; sessionMaxHours: number; proxyHeader: string; proxySecretHeader?: string; admins: string[] }>;
  // 利用者
  createUser(input: { name: string; password?: string; displayName?: string; admin?: boolean }): Promise<AuthUser>;
  listUsers(): Promise<AuthUser[]>;
  getUser(name: string): Promise<AuthUser | undefined>;
  updateUser(name: string, patch: { displayName?: string; admin?: boolean; disabled?: boolean }): Promise<AuthUser>;
  setPassword(name: string, password: string): Promise<void>;
  /** 本人がパスワードを変える（いまのパスワードを確かめる。ログインと同じ総当たり対策）。ほかのセッションは無効にする。 */
  changePassword(input: { name: string; oldPassword: string; newPassword: string; clientAddress: string }): Promise<void>;
  deleteUser(name: string): Promise<void>;
  /** アカウントが 1 つもなければ管理者を作る。作ったら true。 */
  bootstrapAdmin(input: { name: string; password: string }): Promise<boolean>;
  // セッション
  login(input: { name: string; password: string; clientAddress: string }): Promise<LoginResult>;
  authenticate(token: string): Promise<AuthUser | undefined>;
  /** proxy モード。proxySecret があれば、secret が一致したときだけ名前を信じる。 */
  authenticateProxyUser(name: string, opts?: { secret?: string }): Promise<AuthUser | undefined>;
  logout(token: string): Promise<void>;
  logoutAll(name: string): Promise<void>;
  // 権限
  setMembership(projectId: string, user: string, m: { role: Role; languages?: string[] }): Promise<Membership>;
  removeMembership(projectId: string, user: string): Promise<void>;
  listMemberships(filter: { projectId?: string; user?: string }): Promise<Membership[]>;
  /** そのプロジェクトでの呼び出しの文脈。管理者はどのプロジェクトでも manager（admin: true）。権限がなければ undefined。 */
  callContextFor(user: AuthUser, projectId: string): Promise<CallContext | undefined>;
  // 利用者ごとの設定
  getUserSettings(name: string): Promise<Record<string, unknown>>;
  setUserSettings(name: string, values: Record<string, unknown>): Promise<void>;
  userSettingsStore(): UserSettingsStore;
  /** 期限の切れたセッションと、古い総当たり対策の記録を消す（ログインのたびにも、ときどき行う）。 */
  purge(): Promise<{ sessions: number; throttle: number }>;
}

interface StoredUser {
  name: string;
  displayName: string;
  admin: boolean;
  disabled: boolean;
  passwordHash?: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredSession {
  user: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  ip?: string;
}

interface ThrottleRecord {
  /** 接続元の成功の記録（"s:" の鍵）では、最後にログインに成功した時刻。 */
  lastSuccess?: number;
  failures: number;
  /** この時刻（ミリ秒）までは次の試行を受け付けない。 */
  nextAt: number;
  updatedAt: number;
}

const LOGIN_FAILED = "名前かパスワードが違います。";
/** ログイン名: 英数字で始まり、英数字と . _ @ - の 1〜64 文字。大文字小文字は区別しない（小文字にそろえる）。 */
const NAME_RE = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
const MIN_PASSWORD = 8;
/** sliding expiry の更新を書き込む最短の間隔（毎回書かないため）。 */
const TOUCH_INTERVAL_MS = 60_000;
/** 総当たり対策の記録を忘れるまでの時間（最後の失敗から）。 */
const THROTTLE_WINDOW_MS = 24 * 3600_000;
/** ログインに成功した接続元を覚えておく期間（scrypt の待ちの優先の枠に使う）。 */
const KNOWN_ADDRESS_MS = 30 * 24 * 3600_000;
/** 覚えておく接続元の数の上限（超えたら古いものから消す）。 */
const KNOWN_ADDRESS_MAX = 10_000;
/** 古い記録を消す間隔。 */
const PURGE_INTERVAL_MS = 10 * 60_000;

const DEFAULT_PAIR: ThrottlePolicy = { freeFailures: 5, baseDelayMs: 30_000, maxDelayMs: 3600_000 };
const DEFAULT_ADDRESS: ThrottlePolicy = { freeFailures: 20, baseDelayMs: 10_000, maxDelayMs: 3600_000 };
/** 名前ごとの記録は待ち時間を持たない（待たせ方は namePolicy で別に決める）。 */
const NAME_COUNT: ThrottlePolicy = { freeFailures: Number.POSITIVE_INFINITY, baseDelayMs: 0, maxDelayMs: 0 };

const USERS: Pick<CellRef, "resourceId" | "columnId"> = { resourceId: "users", columnId: "user" };
const SESSIONS: Pick<CellRef, "resourceId" | "columnId"> = { resourceId: "sessions", columnId: "session" };
const SETTINGS: Pick<CellRef, "resourceId" | "columnId"> = { resourceId: "settings", columnId: "settings" };
const THROTTLE: Pick<CellRef, "resourceId" | "columnId"> = { resourceId: "throttle", columnId: "t" };
const MEMBERSHIP_COLUMN = "membership";

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** ログイン名をそろえる（NFC、前後の空白を除く、小文字）。使えない名前は undefined。 */
export function normalizeUserName(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 256) return undefined;
  const n = raw.normalize("NFC").trim().toLowerCase();
  return NAME_RE.test(n) ? n : undefined;
}

function checkName(raw: unknown): string {
  const n = normalizeUserName(raw);
  if (!n) throw new ApiError("invalid", "ログイン名は英数字で始まり、英数字と . _ @ - だけの 1〜64 文字にしてください（大文字小文字は区別しません）。");
  return n;
}

function checkPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD_LENGTH) {
    throw new ApiError("invalid", `パスワードは ${MIN_PASSWORD}〜${MAX_PASSWORD_LENGTH} 文字にしてください。`);
  }
  return password;
}

function checkRole(role: unknown): Role {
  if (!ROLES.includes(role as Role)) throw new ApiError("invalid", `役割は ${ROLES.join(" / ")} のどれかにしてください。`);
  return role as Role;
}

function publicUser(u: StoredUser): AuthUser {
  return {
    name: u.name,
    displayName: u.displayName,
    admin: u.admin,
    disabled: u.disabled,
    hasPassword: typeof u.passwordHash === "string",
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

function delayFor(p: ThrottlePolicy, failures: number): number {
  if (failures < p.freeFailures) return 0;
  return Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.min(30, failures - p.freeFailures));
}

/**
 * 総当たり対策の鍵にする接続元。IPv4 はそのまま、IPv4 を写した IPv6（::ffff:a.b.c.d）は IPv4、
 * IPv6 は先頭の /64（1 つの利用者が自由に使える範囲なので、アドレスを替えても同じ鍵にする）。
 */
export function addressKey(a: unknown): string {
  if (typeof a !== "string") return "unknown";
  let t = a.trim().toLowerCase();
  if (t.startsWith("[") && t.includes("]")) t = t.slice(1, t.indexOf("]"));
  const zone = t.indexOf("%");
  if (zone >= 0) t = t.slice(0, zone);
  if (t === "" || t.length > 128) return "unknown";
  if (isIPv4(t)) return t;
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(t) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (isIPv6(t)) {
    const groups = expandIPv6(t);
    if (groups) return `${groups.slice(0, 4).join(":")}::/64`;
  }
  return t;
}

function expandIPv6(t: string): string[] | undefined {
  // 末尾の IPv4 表記は 2 つの 16 ビットにする。
  let s = t;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1]!.split(".").map(Number);
    s = s.slice(0, -v4[1]!.length) + `${((p[0]! << 8) | p[1]!).toString(16)}:${((p[2]! << 8) | p[3]!).toString(16)}`;
  }
  const [head, tail] = s.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const tl = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - tl.length : 0;
  const all = [...h, ...Array.from({ length: fill }, () => "0"), ...tl];
  if (all.length !== 8) return undefined;
  return all.map((g) => (parseInt(g, 16) || 0).toString(16));
}

const normalizeAddress = addressKey;

export function openAuthService(opts: { db: HostDb; config: AuthConfig; now?: () => Date }): AuthService {
  const now = opts.now ?? (() => new Date());
  const cfg = opts.config;
  if (cfg.mode !== "password" && cfg.mode !== "proxy") throw new Error(`auth.mode は "password" か "proxy" にしてください（"${String(cfg.mode)}"）。`);
  const config = {
    mode: cfg.mode,
    sessionTtlHours: cfg.sessionTtlHours ?? 168,
    sessionMaxHours: cfg.sessionMaxHours ?? 720,
    proxyHeader: cfg.proxyHeader ?? "x-forwarded-user",
    ...(cfg.proxySecretHeader ? { proxySecretHeader: cfg.proxySecretHeader } : {}),
    admins: (cfg.admins ?? []).map((a) => normalizeUserName(a)).filter((a): a is string => a !== undefined),
  };
  const pairPolicy: ThrottlePolicy = { ...DEFAULT_PAIR, ...(cfg.throttle?.pair ?? {}) };
  const addressPolicy: ThrottlePolicy = { ...DEFAULT_ADDRESS, ...(cfg.throttle?.address ?? {}) };
  const namePolicy = { freeFailures: 100, stepMs: 100, maxDelayMs: 3000, ...(cfg.throttle?.name ?? {}) };
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const scryptParams = cfg.scrypt ?? DEFAULT_SCRYPT;
  const ttlMs = config.sessionTtlHours * 3600_000;
  const maxMs = config.sessionMaxHours * 3600_000;

  const users: CellStore = opts.db.cells("auth.users");
  const sessions: CellStore = opts.db.cells("auth.sessions");
  const memberships: CellStore = opts.db.cells("auth.memberships");
  const settings: CellStore = opts.db.cells("auth.user-settings");
  const throttle: CellStore = opts.db.cells("auth.throttle");
  const attempts = new KeyedMutex();
  let dummyHash: Promise<string> | undefined;
  let lastPurge = 0;

  const userRef = (name: string): CellRef => ({ ...USERS, entryKey: name });
  const sessionRef = (hash: string): CellRef => ({ ...SESSIONS, entryKey: hash });
  const throttleRef = (key: string): CellRef => ({ ...THROTTLE, entryKey: key });

  async function readUser(name: string): Promise<StoredUser | undefined> {
    const [c] = await users.get([userRef(name)]);
    const v = c?.value as StoredUser | null | undefined;
    return v && typeof v === "object" ? v : undefined;
  }
  async function writeUser(u: StoredUser): Promise<void> {
    await users.set([{ ...userRef(u.name), value: u }]);
  }
  async function requireUser(raw: string): Promise<StoredUser> {
    const name = checkName(raw);
    const u = await readUser(name);
    if (!u) throw new ApiError("not-found", `利用者「${name}」はいません。`);
    return u;
  }

  // ---------------------------------------------------------------------------
  // 総当たり対策
  // ---------------------------------------------------------------------------

  const live = (v: unknown, t: number): ThrottleRecord => {
    const r = v as ThrottleRecord | null | undefined;
    if (!r || typeof r !== "object" || t - r.updatedAt > THROTTLE_WINDOW_MS) return { failures: 0, nextAt: 0, updatedAt: t };
    return r;
  };

  /** 記録を比較して書き換える（版が合わなければ読み直してやり直す。複数のプロセスでも数え漏れない）。 */
  async function casThrottle<T>(key: string, fn: (cur: ThrottleRecord, t: number) => { next: ThrottleRecord | null; result: T }): Promise<T> {
    for (let i = 0; i < 20; i++) {
      const [c] = await throttle.get([throttleRef(key)]);
      const t = now().getTime();
      const { next, result } = fn(live(c?.value, t), t);
      try {
        await throttle.set([{ ...throttleRef(key), value: next, expectedVersion: c?.version ?? 0 }]);
        return result;
      } catch (err) {
        if (err instanceof StoreConflictError || (err instanceof Error && err.name === "StoreConflictError")) continue;
        throw err;
      }
    }
    throw new ApiError("throttled", "ログインが混み合っています。しばらく待ってからやり直してください。", { retryAfterMs: 1000 });
  }

  /** 試行を失敗として予約する。待つ必要があれば retryAfterMs を返す（予約しない）。 */
  function reserve(key: string, policy: ThrottlePolicy): Promise<{ retryAfterMs?: number; before: number }> {
    return casThrottle<{ retryAfterMs?: number; before: number }>(key, (cur, t) => {
      if (cur.nextAt > t) return { next: cur, result: { retryAfterMs: cur.nextAt - t, before: cur.failures } };
      const failures = cur.failures + 1;
      const d = delayFor(policy, failures);
      return { next: { failures, nextAt: d > 0 ? t + d : 0, updatedAt: t }, result: { before: cur.failures } };
    });
  }

  /** 予約を取り消す（成功したとき）。clear は記録ごと消す。 */
  function release(key: string, policy: ThrottlePolicy, clear: boolean): Promise<void> {
    return casThrottle(key, (cur, t) => {
      if (clear || cur.failures <= 1) return { next: null, result: undefined };
      const failures = cur.failures - 1;
      const d = delayFor(policy, failures);
      return { next: { failures, nextAt: d > 0 ? cur.updatedAt + d : 0, updatedAt: t }, result: undefined };
    });
  }

  /**
   * ログインと同じ総当たり対策をかけて check を実行する。check が true なら成功（予約を取り消す）。
   * 待つ必要があれば throttled、失敗なら unauthorized。
   */
  async function guarded(name: string, clientAddress: string, check: (admissionKey: string, priority: boolean) => Promise<boolean>): Promise<void> {
    const addr = normalizeAddress(clientAddress);
    const pairKey = `p:${sha256(`${name}\u0000${addr}`)}`;
    const addrKey = `a:${sha256(addr)}`;
    const nameKey = `n:${sha256(name)}`;
    const knownKey = `s:${sha256(addr)}`;
    // 同じ鍵の試行はこのプロセスの中で 1 つずつ（並べて投げても、前の結果を見てから評価する）。
    await attempts.run(pairKey, async () => {
      await maybePurge();
      const pair = await reserve(pairKey, pairPolicy);
      if (pair.retryAfterMs !== undefined) throw throttledError(pair.retryAfterMs);
      const address = await reserve(addrKey, addressPolicy);
      if (address.retryAfterMs !== undefined) {
        await release(pairKey, pairPolicy, false);
        throw throttledError(address.retryAfterMs);
      }
      // 名前ごとの上限: 断らずに待たせるだけ（分散した推測を遅くする）。
      const byName = await casThrottle(nameKey, (cur, t) => ({ next: { failures: cur.failures + 1, nextAt: 0, updatedAt: t }, result: cur.failures }));
      if (byName >= namePolicy.freeFailures) {
        await sleep(Math.min(namePolicy.maxDelayMs, (byName - namePolicy.freeFailures + 1) * namePolicy.stepMs));
      }
      // 最近ログインに成功した接続元は、scrypt の待ちの優先の枠を使える。
      const [known] = await throttle.get([throttleRef(knownKey)]);
      const lastSuccess = (known?.value as ThrottleRecord | null | undefined)?.lastSuccess;
      const priority = typeof lastSuccess === "number" && now().getTime() - lastSuccess < KNOWN_ADDRESS_MS;
      let ok = false;
      try {
        ok = await check(addrKey, priority);
      } catch (err) {
        // その接続元が同時に試しすぎたときは、失敗として数えたままにする。
        if (err instanceof ApiError && (err.data as { reason?: string } | undefined)?.reason === "address-busy") throw err;
        // 全体の混雑などで確かめられなかったときは、失敗として数えない。
        await release(pairKey, pairPolicy, false);
        await release(addrKey, addressPolicy, false);
        await release(nameKey, NAME_COUNT, false);
        throw err;
      }
      if (!ok) throw new ApiError("unauthorized", LOGIN_FAILED);
      await release(pairKey, pairPolicy, true);
      await release(addrKey, addressPolicy, false);
      await release(nameKey, NAME_COUNT, false);
      const t = now().getTime();
      await throttle.set([{ ...throttleRef(knownKey), value: { lastSuccess: t, failures: 0, nextAt: 0, updatedAt: t } }]);
    });
  }

  const throttledError = (ms: number): ApiError =>
    new ApiError("throttled", "ログインの失敗が続いたため、しばらく待ってからやり直してください。", { retryAfterMs: ms });

  async function verifyUser(name: string | undefined, password: unknown, admissionKey: string, priority = false): Promise<StoredUser | undefined> {
    if (typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) return undefined;
    const u = name ? await readUser(name) : undefined;
    if (!u || !u.passwordHash) {
      // 名前がない場合も同じだけ時間をかける。
      dummyHash ??= hashPassword("loc-studio-dummy-password", scryptParams);
      await verifyPassword(password, await dummyHash, { admissionKey, priority });
      return undefined;
    }
    if (!(await verifyPassword(password, u.passwordHash, { admissionKey, priority }))) return undefined;
    if (u.disabled) return undefined;
    return u;
  }

  // ---------------------------------------------------------------------------
  // セッション
  // ---------------------------------------------------------------------------

  const sessionExpiry = (s: StoredSession): number => Math.min(Date.parse(s.expiresAt), Date.parse(s.createdAt) + maxMs);

  async function logoutAll(raw: string): Promise<void> {
    const name = normalizeUserName(raw) ?? raw;
    const all = await sessions.query({ resourceId: SESSIONS.resourceId });
    const mine = all.filter((c) => (c.value as StoredSession | null)?.user === name);
    if (mine.length > 0) await sessions.set(mine.map((c) => ({ ...sessionRef(c.entryKey), value: null })));
  }

  async function newSession(user: StoredUser, ip: string): Promise<LoginResult> {
    const token = randomBytes(32).toString("base64url");
    const at = now();
    const s: StoredSession = {
      user: user.name,
      createdAt: at.toISOString(),
      lastUsedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + Math.min(ttlMs, maxMs)).toISOString(),
      ip,
    };
    await sessions.set([{ ...sessionRef(sha256(token)), value: s }]);
    return { token, user: publicUser(user), expiresAt: s.expiresAt };
  }

  async function purge(): Promise<{ sessions: number; throttle: number }> {
    const t = now().getTime();
    lastPurge = t;
    const oldSessions = (await sessions.query({ resourceId: SESSIONS.resourceId })).filter((c) => {
      const s = c.value as StoredSession | null;
      return s && sessionExpiry(s) <= t;
    });
    if (oldSessions.length > 0) await sessions.set(oldSessions.map((c) => ({ ...sessionRef(c.entryKey), value: null })));
    const all = await throttle.query({ resourceId: THROTTLE.resourceId });
    const oldThrottle = all.filter((c) => {
      const r = c.value as ThrottleRecord | null;
      if (!r) return false;
      // 成功の記録は 30 日、失敗の記録は 24 時間で忘れる。
      if (typeof r.lastSuccess === "number") return t - r.lastSuccess > KNOWN_ADDRESS_MS;
      return t - r.updatedAt > THROTTLE_WINDOW_MS && r.nextAt <= t;
    });
    // 成功の記録が多すぎたら、古いものから消す。
    const known = all
      .filter((c) => typeof (c.value as ThrottleRecord | null)?.lastSuccess === "number" && !oldThrottle.includes(c))
      .sort((a, b) => (a.value as ThrottleRecord).lastSuccess! - (b.value as ThrottleRecord).lastSuccess!);
    if (known.length > KNOWN_ADDRESS_MAX) oldThrottle.push(...known.slice(0, known.length - KNOWN_ADDRESS_MAX));
    // 消す間にほかで書かれた記録は残す（版を確かめて書く）。
    let removed = 0;
    for (const c of oldThrottle) {
      try {
        await throttle.set([{ ...throttleRef(c.entryKey), value: null, expectedVersion: c.version ?? 0 }]);
        removed++;
      } catch {
        // 書かれていたら次の機会に
      }
    }
    return { sessions: oldSessions.length, throttle: removed };
  }

  async function maybePurge(): Promise<void> {
    if (now().getTime() - lastPurge < PURGE_INTERVAL_MS) return;
    await purge();
  }

  async function createUser(input: { name: string; password?: string; displayName?: string; admin?: boolean }): Promise<AuthUser> {
    const name = checkName(input?.name);
    if (await readUser(name)) throw new ApiError("conflict", `利用者「${name}」はすでにいます。`);
    const at = now().toISOString();
    const display = typeof input.displayName === "string" ? input.displayName.normalize("NFC").trim().slice(0, 128) : "";
    const u: StoredUser = { name, displayName: display !== "" ? display : name, admin: input.admin === true, disabled: false, createdAt: at, updatedAt: at };
    if (input.password !== undefined) u.passwordHash = await hashPassword(checkPassword(input.password), scryptParams);
    await writeUser(u);
    return publicUser(u);
  }

  async function listUsers(): Promise<AuthUser[]> {
    const all = await users.query({ resourceId: USERS.resourceId });
    return all
      .map((c) => c.value as StoredUser | null)
      .filter((v): v is StoredUser => !!v && typeof v === "object")
      .map(publicUser)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  const service: AuthService = {
    config,
    createUser,
    listUsers,
    async getUser(raw) {
      const name = normalizeUserName(raw);
      if (!name) return undefined;
      const u = await readUser(name);
      return u ? publicUser(u) : undefined;
    },
    async updateUser(name, patch) {
      const u = await requireUser(name);
      if (patch.displayName !== undefined) {
        if (typeof patch.displayName !== "string" || patch.displayName.trim() === "") throw new ApiError("invalid", "表示名は空でない文字列にしてください。");
        u.displayName = patch.displayName.normalize("NFC").trim().slice(0, 128);
      }
      if (patch.admin !== undefined) u.admin = patch.admin === true;
      if (patch.disabled !== undefined) u.disabled = patch.disabled === true;
      u.updatedAt = now().toISOString();
      await writeUser(u);
      if (u.disabled) await logoutAll(u.name);
      return publicUser(u);
    },
    async setPassword(name, password) {
      const u = await requireUser(name);
      u.passwordHash = await hashPassword(checkPassword(password), scryptParams);
      u.updatedAt = now().toISOString();
      await writeUser(u);
      await logoutAll(u.name);
    },
    async changePassword({ name: raw, oldPassword, newPassword, clientAddress }) {
      const name = normalizeUserName(raw);
      checkPassword(newPassword);
      let user: StoredUser | undefined;
      try {
        await guarded(name ?? String(raw).slice(0, 256), clientAddress, async (key, priority) => {
          user = await verifyUser(name, oldPassword, key, priority);
          return user !== undefined;
        });
      } catch (err) {
        if (err instanceof ApiError && err.code === "unauthorized") throw new ApiError("unauthorized", "いまのパスワードが違います。");
        throw err;
      }
      await service.setPassword(user!.name, newPassword);
    },
    async deleteUser(name) {
      const u = await requireUser(name);
      await users.set([{ ...userRef(u.name), value: null }]);
      await logoutAll(u.name);
      const mine = (await memberships.query({ columnId: MEMBERSHIP_COLUMN })).filter((c) => c.entryKey === u.name && c.value);
      if (mine.length > 0) await memberships.set(mine.map((c) => ({ resourceId: c.resourceId, entryKey: c.entryKey, columnId: MEMBERSHIP_COLUMN, value: null })));
      await settings.set([{ ...SETTINGS, entryKey: u.name, value: null }]);
    },
    async bootstrapAdmin({ name, password }) {
      if ((await listUsers()).length > 0) return false;
      await createUser({ name, password, admin: true });
      return true;
    },

    async login({ name: raw, password, clientAddress }) {
      if (config.mode !== "password") throw new ApiError("invalid", "このサーバーはパスワードでのログインを使いません（auth.mode が proxy）。");
      if (typeof raw !== "string" || raw === "" || raw.length > 256 || typeof password !== "string" || password.length > MAX_PASSWORD_LENGTH) {
        throw new ApiError("unauthorized", LOGIN_FAILED);
      }
      const name = normalizeUserName(raw);
      let user: StoredUser | undefined;
      // 使えない名前も同じ手順で数える（名前の有無を教えないため）。
      await guarded(name ?? raw.normalize("NFC").trim().toLowerCase(), clientAddress, async (key, priority) => {
        user = await verifyUser(name, password, key, priority);
        return user !== undefined;
      });
      if (needsRehash(user!.passwordHash!, scryptParams)) {
        user!.passwordHash = await hashPassword(password, scryptParams);
        await writeUser(user!);
      }
      return newSession(user!, normalizeAddress(clientAddress));
    },

    async authenticate(token) {
      if (typeof token !== "string" || token === "" || token.length > 512) return undefined;
      const ref = sessionRef(sha256(token));
      const [c] = await sessions.get([ref]);
      const s = c?.value as StoredSession | null | undefined;
      if (!s) return undefined;
      const t = now().getTime();
      if (sessionExpiry(s) <= t) {
        await sessions.set([{ ...ref, value: null }]);
        return undefined;
      }
      const u = await readUser(s.user);
      if (!u || u.disabled) {
        await sessions.set([{ ...ref, value: null }]);
        return undefined;
      }
      if (t - Date.parse(s.lastUsedAt) >= TOUCH_INTERVAL_MS) {
        await sessions.set([{ ...ref, value: { ...s, lastUsedAt: new Date(t).toISOString(), expiresAt: new Date(t + ttlMs).toISOString() } }]);
      }
      return publicUser(u);
    },

    async authenticateProxyUser(raw, o) {
      if (config.mode !== "proxy") throw new ApiError("invalid", "このサーバーはプロキシでの認証を使いません（auth.mode が password）。");
      if (cfg.proxySecret !== undefined) {
        const given = typeof o?.secret === "string" ? o.secret : "";
        // 長さで分からないよう、ハッシュどうしを一定時間で比べる。
        const a = createHash("sha256").update(given).digest();
        const b = createHash("sha256").update(cfg.proxySecret).digest();
        if (!timingSafeEqual(a, b) || given === "") return undefined;
      }
      const name = normalizeUserName(raw);
      if (!name) return undefined;
      let u = await readUser(name);
      if (!u) {
        // admins はアカウントを作るときだけ使う（管理者が外したあと、また付けない）。
        await createUser({ name, admin: config.admins.includes(name) });
        u = (await readUser(name))!;
      }
      return u.disabled ? undefined : publicUser(u);
    },

    async logout(token) {
      if (typeof token !== "string" || token === "" || token.length > 512) return;
      await sessions.set([{ ...sessionRef(sha256(token)), value: null }]);
    },
    logoutAll,

    async setMembership(projectId, rawUser, m) {
      if (typeof projectId !== "string" || projectId === "") throw new ApiError("invalid", "projectId を指定してください。");
      const user = (await requireUser(rawUser)).name;
      const role = checkRole(m?.role);
      const value: { role: Role; languages?: string[] } = { role };
      if (m.languages !== undefined) {
        if (!Array.isArray(m.languages) || m.languages.length > 256 || m.languages.some((l) => typeof l !== "string" || l === "")) {
          throw new ApiError("invalid", "languages は言語 ID の配列にしてください。");
        }
        value.languages = [...new Set(m.languages)];
      }
      await memberships.set([{ resourceId: projectId, entryKey: user, columnId: MEMBERSHIP_COLUMN, value }]);
      return { projectId, user, ...value };
    },
    async removeMembership(projectId, rawUser) {
      const user = normalizeUserName(rawUser) ?? rawUser;
      await memberships.set([{ resourceId: projectId, entryKey: user, columnId: MEMBERSHIP_COLUMN, value: null }]);
    },
    async listMemberships(filter) {
      const all = await memberships.query(filter.projectId !== undefined ? { resourceId: filter.projectId, columnId: MEMBERSHIP_COLUMN } : { columnId: MEMBERSHIP_COLUMN });
      const userFilter = filter.user !== undefined ? (normalizeUserName(filter.user) ?? filter.user) : undefined;
      const out: Membership[] = [];
      for (const c of all) {
        const v = c.value as { role: Role; languages?: string[] } | null;
        if (!v || (userFilter !== undefined && c.entryKey !== userFilter)) continue;
        const m: Membership = { projectId: c.resourceId, user: c.entryKey, role: v.role };
        if (v.languages) m.languages = v.languages;
        out.push(m);
      }
      return out;
    },
    async callContextFor(user, projectId) {
      const name = normalizeUserName(user?.name);
      const u = name ? await readUser(name) : undefined;
      if (!u || u.disabled) return undefined;
      const base = { user: { name: u.name, displayName: u.displayName } };
      if (u.admin) return { ...base, role: "manager", admin: true };
      const [m] = await service.listMemberships({ projectId, user: u.name });
      if (!m) return undefined;
      return m.languages ? { ...base, role: m.role, languages: m.languages } : { ...base, role: m.role };
    },

    async getUserSettings(raw) {
      const name = normalizeUserName(raw) ?? raw;
      const [c] = await settings.get([{ ...SETTINGS, entryKey: name }]);
      const v = c?.value;
      return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
    },
    async setUserSettings(raw, values) {
      const name = normalizeUserName(raw) ?? raw;
      await settings.set([{ ...SETTINGS, entryKey: name, value: values }]);
    },
    userSettingsStore() {
      return { get: (n) => service.getUserSettings(n), set: (n, v) => service.setUserSettings(n, v) };
    },
    purge,
  };
  return service;
}
