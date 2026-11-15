/*
 * 動作モード（LOC_STUDIO_MODE）。"local"（または未設定）と "web" だけを受け付ける。
 * ほかの値は設定の誤りとして扱い、認証のないローカルモードに落とさない（起動を断る / すべての要求に 500）。
 */
export type Mode = "local" | "web";

export class ModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeError";
  }
}

export function parseMode(value: string | undefined): Mode {
  if (value === undefined || value === "" || value === "local") return "local";
  if (value === "web") return "web";
  throw new ModeError(`LOC_STUDIO_MODE は "local" か "web" にしてください（いまの値: "${value.slice(0, 40)}"）。サーバーは動きません。`);
}
