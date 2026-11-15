/**
 * Web モードのサーバーの設定（server.json）。形を確かめ、${env:NAME} を展開し、相対パスを設定ファイルのフォルダから解決する。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expandEnv } from "@loc-studio/core";
import type { AuthConfig } from "./auth/service.js";

export interface ServerProject {
  id: string;
  name: string;
  root: string;
  /** このプロジェクトの設定で ${env:NAME} として使ってよい環境変数の名前（既定はなし）。プラグインのホストの env もこの名前だけになる。 */
  env?: string[];
}

export type ServerDbConfig = { driver: "sqlite"; path: string } | { driver: "postgres"; url: string; schema?: string };

export interface ServerAuthConfig {
  mode: AuthConfig["mode"];
  sessionTtlHours: number;
  /** セッションの絶対の期限（ログインからの時間）。既定 720（30 日）。 */
  sessionMaxHours?: number;
  proxyHeader: string;
  /** proxy モード: プロキシが付ける合言葉のヘッダー。設定したら proxySecretEnv も必要。 */
  proxySecretHeader?: string;
  /** proxy モード: 合言葉の値を入れた環境変数の名前。 */
  proxySecretEnv?: string;
  admins: string[];
  /** 前段のリバースプロキシの段数（X-Forwarded-For を信じる数）。既定 0（信じない。接続元のアドレスを使う）。 */
  trustedProxyHops?: number;
}

export interface ServerConfig {
  projects: ServerProject[];
  auth: ServerAuthConfig;
  serverDb: ServerDbConfig;
}

const PROJECT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 設定のオブジェクトを確かめて ServerConfig にする。問題があれば、すべての問題を並べた例外を投げる。
 * @param baseDir 相対パスの基準（設定ファイルのフォルダ）
 * @param where エラーに出す場所（ファイルのパスなど）
 */
export function parseServerConfig(raw: unknown, opts: { baseDir: string; env: Record<string, string | undefined>; where?: string }): ServerConfig {
  const problems: string[] = [];
  const where = opts.where ?? "サーバーの設定";
  const expand = (value: string, field: string): string => {
    try {
      return expandEnv(value, opts.env);
    } catch (err) {
      problems.push(`${field}: ${err instanceof Error ? err.message : String(err)}`);
      return value;
    }
  };
  if (!isObject(raw)) throw new Error(`${where} は JSON のオブジェクトにしてください。`);

  const projects: ServerProject[] = [];
  if (!Array.isArray(raw.projects)) problems.push("projects はプロジェクトの配列にしてください。");
  else {
    const ids = new Set<string>();
    raw.projects.forEach((p: unknown, i) => {
      const at = `projects[${i}]`;
      if (!isObject(p)) return void problems.push(`${at} はオブジェクトにしてください。`);
      if (typeof p.id !== "string" || !PROJECT_ID_RE.test(p.id)) return void problems.push(`${at}.id は英数字と . _ - の 1〜64 文字にしてください。`);
      if (ids.has(p.id)) problems.push(`${at}.id "${p.id}" が重複しています。`);
      ids.add(p.id);
      if (typeof p.root !== "string" || p.root === "") return void problems.push(`${at}.root にプロジェクトのフォルダを書いてください。`);
      if (p.name !== undefined && typeof p.name !== "string") problems.push(`${at}.name は文字列にしてください。`);
      if (p.env !== undefined && (!Array.isArray(p.env) || p.env.some((e) => typeof e !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)))) {
        problems.push(`${at}.env は環境変数の名前の配列にしてください。`);
      }
      projects.push({
        id: p.id,
        name: typeof p.name === "string" && p.name !== "" ? p.name : p.id,
        root: path.resolve(opts.baseDir, expand(p.root, `${at}.root`)),
        env: Array.isArray(p.env) ? (p.env as string[]).filter((e) => typeof e === "string") : [],
      });
    });
  }

  const a = raw.auth === undefined ? {} : raw.auth;
  let auth: ServerConfig["auth"] = { mode: "password", sessionTtlHours: 168, sessionMaxHours: 720, proxyHeader: "x-forwarded-user", admins: [], trustedProxyHops: 0 };
  if (!isObject(a)) problems.push("auth はオブジェクトにしてください。");
  else {
    const mode = a.mode ?? "password";
    if (mode !== "password" && mode !== "proxy") problems.push(`auth.mode は "password" か "proxy" にしてください（"${String(mode)}"）。`);
    const ttl = a.sessionTtlHours ?? 168;
    if (typeof ttl !== "number" || !(ttl > 0)) problems.push("auth.sessionTtlHours は正の数にしてください。");
    const header = a.proxyHeader ?? "x-forwarded-user";
    if (typeof header !== "string" || !/^[A-Za-z0-9-]+$/.test(header)) problems.push("auth.proxyHeader は HTTP ヘッダーの名前にしてください。");
    const admins = a.admins ?? [];
    if (!Array.isArray(admins) || admins.some((x) => typeof x !== "string" || x === "")) problems.push("auth.admins はログイン名の配列にしてください。");
    const max = a.sessionMaxHours ?? 720;
    if (typeof max !== "number" || !(max > 0)) problems.push("auth.sessionMaxHours は正の数にしてください。");
    const hops = a.trustedProxyHops ?? 0;
    if (typeof hops !== "number" || !Number.isInteger(hops) || hops < 0 || hops > 10) problems.push("auth.trustedProxyHops は 0〜10 の整数にしてください。");
    const secretHeader = a.proxySecretHeader;
    const secretEnv = a.proxySecretEnv;
    if (secretHeader !== undefined && (typeof secretHeader !== "string" || !/^[A-Za-z0-9-]+$/.test(secretHeader))) problems.push("auth.proxySecretHeader は HTTP ヘッダーの名前にしてください。");
    if (secretEnv !== undefined && (typeof secretEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv))) problems.push("auth.proxySecretEnv は環境変数の名前にしてください。");
    if ((secretHeader === undefined) !== (secretEnv === undefined)) problems.push("auth.proxySecretHeader と auth.proxySecretEnv は両方書いてください。");
    auth = {
      mode: mode as "password" | "proxy",
      sessionTtlHours: Number(ttl),
      sessionMaxHours: Number(max),
      proxyHeader: String(header).toLowerCase(),
      admins: Array.isArray(admins) ? (admins as string[]) : [],
      trustedProxyHops: Number(hops),
      ...(typeof secretHeader === "string" ? { proxySecretHeader: secretHeader.toLowerCase() } : {}),
      ...(typeof secretEnv === "string" ? { proxySecretEnv: secretEnv } : {}),
    };
  }

  let serverDb: ServerDbConfig = { driver: "sqlite", path: path.join(opts.baseDir, "server.db") };
  const db = raw.serverDb;
  if (db !== undefined) {
    if (!isObject(db)) problems.push("serverDb はオブジェクトにしてください。");
    else if (db.driver === "sqlite" || db.driver === undefined) {
      if (db.path !== undefined && (typeof db.path !== "string" || db.path === "")) problems.push("serverDb.path は空でない文字列にしてください。");
      else if (typeof db.path === "string") serverDb = { driver: "sqlite", path: path.resolve(opts.baseDir, expand(db.path, "serverDb.path")) };
    } else if (db.driver === "postgres") {
      if (typeof db.url !== "string" || db.url === "") problems.push("serverDb.url に Postgres の接続先を書いてください（${env:NAME} が使えます）。");
      else {
        serverDb = { driver: "postgres", url: expand(db.url, "serverDb.url") };
        if (db.schema !== undefined) {
          if (typeof db.schema !== "string" || db.schema === "") problems.push("serverDb.schema は空でない文字列にしてください。");
          else serverDb.schema = db.schema;
        }
      }
    } else problems.push(`serverDb.driver は "sqlite" か "postgres" にしてください（"${String(db.driver)}"）。`);
  }

  if (problems.length > 0) throw new Error(`${where} に問題があります:\n- ${problems.join("\n- ")}`);
  return { projects, auth, serverDb };
}

/** server.json を読む。 */
export function loadServerConfig(file: string, env: Record<string, string | undefined> = process.env): ServerConfig {
  const abs = path.resolve(file);
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`サーバーの設定ファイル ${abs} を読めませんでした: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(`サーバーの設定ファイル ${abs} の JSON が壊れています: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseServerConfig(raw, { baseDir: path.dirname(abs), env, where: `サーバーの設定ファイル ${abs}` });
}

/**
 * 要求の接続元のアドレス（ログインの総当たり対策の鍵）。
 * trustedProxyHops が 0 なら接続そのもののアドレス（X-Forwarded-For は誰でも付けられるので信じない）。
 * N なら、X-Forwarded-For の右から N 番目（自分の前の N 段のプロキシが付けたもの）を使う。
 */
export function clientAddressFrom(req: { remoteAddress?: string; forwardedFor?: string | string[] }, trustedProxyHops = 0): string {
  const remote = (req.remoteAddress ?? "").trim() || "unknown";
  if (!trustedProxyHops) return remote;
  const header = Array.isArray(req.forwardedFor) ? req.forwardedFor.join(",") : (req.forwardedFor ?? "");
  const chain = [...header.split(",").map((s) => s.trim()).filter((s) => s !== ""), remote];
  const i = chain.length - 1 - trustedProxyHops;
  return i >= 0 ? chain[i]! : (chain[0] ?? remote);
}

/** 設定ファイルの場所: LOC_STUDIO_SERVER_CONFIG、なければ <LOC_STUDIO_USER_DATA_DIR または dataDir>/server.json。 */
export function serverConfigPath(env: Record<string, string | undefined>, dataDir: string): string {
  return env["LOC_STUDIO_SERVER_CONFIG"] || path.join(env["LOC_STUDIO_USER_DATA_DIR"] || dataDir, "server.json");
}
