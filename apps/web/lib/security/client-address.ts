/*
 * 起動の仕組み（scripts/launch.mjs）が付ける、接続そのもののアドレスのヘッダー。合言葉（LOC_STUDIO_INTERNAL_SECRET）が合うときだけ信じる。
 * 接続元のアドレスの決め方そのもの（X-Forwarded-For をいつ信じるか）は、サービス層の clientAddressFrom を使う（規則は 1 か所）。
 */
export const REMOTE_HEADER = "x-loc-studio-remote-address";
export const INTERNAL_HEADER = "x-loc-studio-internal";
