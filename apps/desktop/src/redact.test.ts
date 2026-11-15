import { describe, expect, it } from "vitest";
import { redactToken, REDACTED } from "./redact";

describe("redactToken", () => {
  const token = "abcDEF_123-xyz".repeat(3);
  it("合言葉そのものと URL エンコードした形を伏せる", () => {
    expect(redactToken(`x ${token} y`, token)).toBe(`x ${REDACTED} y`);
    const odd = "a+b/c=";
    expect(redactToken(`u ${encodeURIComponent(odd)} ${odd}`, odd)).toBe(`u ${REDACTED} ${REDACTED}`);
  });
  it("loc-studio の起動メッセージの URL を伏せる", () => {
    expect(redactToken(`loc-studio: http://127.0.0.1:3000/?token=${token}\n（この URL から`, token)).toBe(`loc-studio: http://127.0.0.1:3000/?token=${REDACTED}\n（この URL から`);
  });
  it("値が分からなくても ?token= の値を伏せる", () => {
    expect(redactToken("GET /?a=1&token=secret123 200")).toBe(`GET /?a=1&token=${REDACTED} 200`);
  });
  it("関係ない文字列はそのまま", () => {
    expect(redactToken("起動しました", token)).toBe("起動しました");
  });
});
