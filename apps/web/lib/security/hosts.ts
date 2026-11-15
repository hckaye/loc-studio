/*
 * Host の許可リスト（DNS リバインディング対策）。ページも API も、ほかの処理の前に確かめる。
 * - local: ループバックの名前（localhost、127.0.0.1、[::1]、ポートは問わない）と LOC_STUDIO_ALLOWED_HOSTS。
 * - web: サーバーの設定の allowedHosts と LOC_STUDIO_ALLOWED_HOSTS。どちらもなければループバックだけ。
 * X-Forwarded-Host は auth.trustedProxyHops > 0 のときだけ使う（それ以外は誰でも付けられるので無視する）。
 */

export interface HostParts {
  hostname: string;
  port?: string;
}

/** Host ヘッダーを名前とポートに分ける。形が正しくなければ undefined。 */
export function parseHost(value: string | null | undefined): HostParts | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v.length > 255 || /[\s/\\@?#]/.test(v)) return undefined;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return undefined;
  // 末尾の点（"localhost."）は受け付けない（別の名前として解決されうるため、正規化せずに断る）
  if (m[1]!.endsWith(".")) return undefined;
  const hostname = m[1]!;
  return m[2] !== undefined ? { hostname, port: m[2] } : { hostname };
}

/** ループバックの名前: localhost、127.0.0.0/8 の数字の書き方、[::1] だけ（*.localhost は受け付けない）。 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "[::1]") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((x) => Number(x) <= 255);
}

/** バインドするアドレスがループバックか（0.0.0.0 や :: は違う）。 */
export function isLoopbackBind(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** LOC_STUDIO_ALLOWED_HOSTS（カンマ区切り）などを名前の一覧にする。ポートは見ない。 */
export function parseHostList(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => parseHost(s)?.hostname)
    .filter((s): s is string => !!s);
}

export interface HostPolicy {
  /** ループバックに加えて許す名前。 */
  extra: string[];
}

export function hostAllowed(host: string | null | undefined, policy: HostPolicy): boolean {
  const parts = parseHost(host);
  if (!parts) return false;
  if (isLoopbackHostname(parts.hostname)) return true;
  return policy.extra.includes(parts.hostname);
}

/** 確かめる Host。X-Forwarded-Host は前段のプロキシを信じる設定のときだけ。 */
export function effectiveHost(headers: { get(name: string): string | null }, trustedProxyHops: number): string | null {
  if (trustedProxyHops > 0) {
    const fwd = headers.get("x-forwarded-host");
    if (fwd) {
      // 複数段のときは、いちばん外側（クライアントに近い）のプロキシが付けたもの
      const list = fwd.split(",").map((s) => s.trim()).filter(Boolean);
      const i = Math.max(0, list.length - trustedProxyHops);
      return list[i] ?? list[0] ?? null;
    }
  }
  return headers.get("host");
}
