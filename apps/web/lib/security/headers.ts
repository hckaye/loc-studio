/*
 * すべての応答に付ける守りのヘッダー。ページには nonce つきの CSP（Next のスクリプトに nonce が付く）。
 * 独自描画のモジュールは同じオリジンから import するので script-src 'self' と 'strict-dynamic' で動く。
 */

export function baseSecurityHeaders(): Record<string, string> {
  return {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

export function pageCsp(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // React の style 属性（要素の style）に必要。スクリプトではないので危険は小さい
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** API とモジュール、断りのページに付ける CSP（スクリプトは動かさない）。 */
export function apiCsp(): string {
  return "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
}
