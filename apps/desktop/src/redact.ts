/** 起動の合言葉（トークン）をログやエラー表示に出さないための置き換え。 */
export const REDACTED = "[token]";

export function redactToken(text: string, token?: string): string {
  let out = text;
  if (token) {
    for (const v of new Set([token, encodeURIComponent(token)])) out = out.split(v).join(REDACTED);
  }
  // 値が分からない場合や別の形で出た場合に備え、?token=… の形も消す
  return out.replace(/([?&]token=)[^\s&"'<>]+/gi, `$1${REDACTED}`);
}
