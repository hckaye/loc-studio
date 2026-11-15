import { describe, expect, it } from "vitest";
import { countText } from "./count";

describe("countText", () => {
  // "aあ😀\n" は、コードポイント 4、UTF-16 の単位 5（絵文字はサロゲートペア）、UTF-8 で 1 + 3 + 4 + 1 = 9 バイト。
  const text = "aあ😀\n";

  it("codepoints: サロゲートペアの文字も 1 と数える（改行も 1）", () => {
    expect(countText(text, "codepoints")).toBe(4);
    expect(countText("", "codepoints")).toBe(0);
  });

  it("utf16: UTF-16 の単位の数（サロゲートペアは 2）", () => {
    expect(countText(text, "utf16")).toBe(5);
  });

  it("bytes: UTF-8 のバイト数", () => {
    expect(countText(text, "bytes")).toBe(9);
  });

  it("width: 全角を 2、半角を 1 と数え、改行は数えない", () => {
    expect(countText("abc", "width")).toBe(3);
    expect(countText("日本語", "width")).toBe(6);
    expect(countText("ｶﾅ", "width")).toBe(2); // 半角カナは 1 ずつ
    expect(countText("ＡＢ", "width")).toBe(4); // 全角英字
    expect(countText("한글", "width")).toBe(4);
    expect(countText("aあ😀\r\nb", "width")).toBe(1 + 2 + 2 + 1);
  });
});
