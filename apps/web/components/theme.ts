/* テーマ（ローカル設定 ui.theme）。<html data-theme> を切り替える。"system" は OS の設定に合わせる。 */
let mediaCleanup: (() => void) | undefined;

export function applyTheme(theme: string): void {
  if (typeof document === "undefined") return;
  mediaCleanup?.();
  mediaCleanup = undefined;
  const root = document.documentElement;
  if (theme === "dark" || theme === "light") {
    root.dataset["theme"] = theme;
    return;
  }
  if (theme === "system" || theme === "os" || theme === "auto") {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const set = () => (root.dataset["theme"] = mq?.matches ? "dark" : "light");
    set();
    mq?.addEventListener?.("change", set);
    mediaCleanup = () => mq?.removeEventListener?.("change", set);
    return;
  }
  root.dataset["theme"] = "light";
}
