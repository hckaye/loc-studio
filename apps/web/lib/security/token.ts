import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * ローカルモードの起動ごとの合言葉（Jupyter と同じ考え方）。起動したときの URL の ?token= を一度だけクッキーに換える。
 * 比べるのは一定時間（長さの違いも漏らさないよう、ハッシュどうしを比べる）。
 */

export const TOKEN_PARAM = "token";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** 同じ PC の別のポートで動く loc-studio とクッキーが混ざらないよう、名前にポートを入れる。 */
export function localCookieName(port: string | undefined): string {
  return `loc_studio_local_${port && /^\d+$/.test(port) ? port : "default"}`;
}

/** 合言葉の設定。"off" は開発用（ループバックにバインドしたローカルモードだけ）。 */
export type TokenSetting = { kind: "token"; token: string } | { kind: "off" } | { kind: "missing" };

export function tokenSetting(env: Record<string, string | undefined>): TokenSetting {
  const t = env["LOC_STUDIO_LOCAL_TOKEN"];
  if (!t) return { kind: "missing" };
  if (t === "off") return { kind: "off" };
  return { kind: "token", token: t };
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}
