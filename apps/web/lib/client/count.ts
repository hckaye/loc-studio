/*
 * 本文の長さの数え方。スタジオによって「文字数」の意味が違う（コードポイント、UTF-16、バイト、全角を 2 と数える幅）ので、
 * プロジェクト設定の editor.count で選ぶ。
 */

export type CountUnit = "codepoints" | "utf16" | "bytes" | "width";

export const COUNT_LABEL: Record<CountUnit, string> = { codepoints: "文字", utf16: "UTF-16", bytes: "バイト", width: "幅" };

/** 全角として 2 と数える文字（東アジアの文字幅が Wide / Fullwidth のおもな範囲）。 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // ハングル字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首、記号、句読点
    (cp >= 0x3041 && cp <= 0x33ff) || // かな、CJK 互換
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 拡張 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 統合漢字
    (cp >= 0xa000 && cp <= 0xa4cf) || // イ文字
    (cp >= 0xac00 && cp <= 0xd7a3) || // ハングル音節
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 互換漢字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 互換形
    (cp >= 0xff00 && cp <= 0xff60) || // 全角英数・記号
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角記号
    (cp >= 0x1f300 && cp <= 0x1f64f) || // 絵文字
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 拡張 B 以降
  );
}

/** 本文の長さ。幅（width）では改行を数えず、全角を 2、それ以外を 1 と数える。 */
export function countText(text: string, unit: CountUnit): number {
  switch (unit) {
    case "utf16":
      return text.length;
    case "bytes":
      return new TextEncoder().encode(text).length;
    case "width": {
      let n = 0;
      for (const ch of text) {
        if (ch === "\n" || ch === "\r") continue;
        n += isWide(ch.codePointAt(0)!) ? 2 : 1;
      }
      return n;
    }
    default:
      return Array.from(text).length;
  }
}
