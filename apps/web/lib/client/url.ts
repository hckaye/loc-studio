/*
 * プラグインやレビュー先から来た URL を、リンクにしてよいか。http / https で、URL として正しく読めるものだけ。
 * それ以外（javascript: や data:、壊れた文字列）は、ただの文字として出す。
 */
export function safeHttpUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!/^https?:\/\//i.test(s)) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** 新しいタブで開く（開いた先から元の画面を操作されないよう noopener,noreferrer）。 */
export function openExternal(url: string): boolean {
  const safe = safeHttpUrl(url);
  if (!safe) return false;
  window.open(safe, "_blank", "noopener,noreferrer");
  return true;
}
