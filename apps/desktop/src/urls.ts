/** プロジェクトを開く URL。Web 側は `?project=` を読む（components/App.tsx）。 */
export function buildProjectUrl(baseUrl: string, projectPath?: string): string {
  const url = new URL("/", baseUrl);
  if (projectPath) url.searchParams.set("project", projectPath);
  return url.toString();
}

/** ウィンドウ内で表示してよい URL（ローカルサーバーと同じオリジン）か。 */
export function isLocalUrl(target: string, baseUrl: string): boolean {
  try {
    return new URL(target).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** システムのブラウザに渡してよい URL か（http と https だけ）。 */
export function isExternalUrl(target: string): boolean {
  try {
    const p = new URL(target).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}
