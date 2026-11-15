/*
 * 状態を変える要求（POST）と、モジュールの GET の「同じオリジンから来たか」の判定。
 * - Sec-Fetch-Site があれば "same-origin" でなければ断る（ブラウザは必ず付ける）。
 * - Origin があれば、確かめた Host と同じでなければ断る。
 * - どちらもない（ブラウザ以外の道具。curl やスモークテスト）ときは、認証のクッキー（ローカルモードの起動の合言葉、
 *   Web モードのセッション）があれば通す。ブラウザからの別サイトの要求は、必ずどちらかのヘッダーを持つので、この規則で通らない。
 *   ログインだけはクッキーがまだないので、どちらのヘッダーもない要求を通す（ブラウザ以外の道具からのログイン）。
 */

export interface OriginInput {
  origin: string | null;
  secFetchSite: string | null;
  /** 許可リストで確かめた Host（ポートつき）。 */
  host: string | null;
  /** 認証のクッキーがあって正しいか。 */
  authenticated: boolean;
  /** ログインのように、認証の前に受ける要求か。 */
  allowAnonymous?: boolean;
}

export type OriginVerdict = { ok: true } | { ok: false; reason: string };

export function checkSameOrigin(input: OriginInput): OriginVerdict {
  const site = input.secFetchSite?.toLowerCase() ?? null;
  if (site !== null && site !== "same-origin") return { ok: false, reason: `Sec-Fetch-Site が ${site} です` };
  if (input.origin !== null) {
    if (input.origin === "null") return { ok: false, reason: "Origin が null です" };
    let originHost: string;
    try {
      originHost = new URL(input.origin).host.toLowerCase();
    } catch {
      return { ok: false, reason: "Origin の形が正しくありません" };
    }
    if (!input.host || originHost !== input.host.toLowerCase()) return { ok: false, reason: "Origin が違います" };
    return { ok: true };
  }
  if (site === "same-origin") return { ok: true };
  // どちらのヘッダーもない: ブラウザ以外の道具
  if (input.authenticated || input.allowAnonymous) return { ok: true };
  return { ok: false, reason: "Origin も Sec-Fetch-Site もなく、認証もありません" };
}
