import { describe, expect, it } from "vitest";
import type { Change, FormatContext } from "@loc-studio/sdk";
import { csvFormat } from "./csv.js";
import { decodeText, encodeText, parseEncodingOption } from "./encoding.js";

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const hex = (b: Uint8Array): string => [...b].map((v) => v.toString(16).padStart(2, "0")).join(" ");

// 期待するバイト列は、ここに 16 進で書き下す（実装の encodeText で作ると、実装の誤りに気づけない）。
// 「あ」= 82 A0、「表」= 95 5C（2 バイト目が ASCII の「\」と同じ値）、「ｱ」（半角カナ）= B1、「①」= 87 40。
const SJIS_A_HYO = bytes(0x82, 0xa0, 0x41, 0x95, 0x5c, 0xb1, 0x87, 0x40);

describe("parseEncodingOption", () => {
  it("省略時は auto。よくある別名を、大文字小文字を区別せずに受け付ける", () => {
    expect(parseEncodingOption(undefined, "a.csv")).toBe("auto");
    expect(["UTF-8", "utf8", "auto"].map((v) => parseEncodingOption(v, "a.csv"))).toEqual(["utf-8", "utf-8", "auto"]);
    expect(["utf-16", "UTF-16LE", "utf16be"].map((v) => parseEncodingOption(v, "a.csv"))).toEqual(["utf-16le", "utf-16le", "utf-16be"]);
    expect(["Shift_JIS", "shift-jis", "sjis", "CP932", "windows-31j"].map((v) => parseEncodingOption(v, "a.csv"))).toEqual(Array(5).fill("shift_jis"));
  });

  it("知らない名前と、文字列でない値は、ファイルの場所つきで断る", () => {
    for (const bad of ["euc-jp", "", 932, null]) {
      expect(() => parseEncodingOption(bad, "text/a.csv"), String(bad)).toThrow(/encoding.*text\/a\.csv/);
    }
  });
});

describe("decodeText / encodeText", () => {
  it("auto: BOM のないものと UTF-8 の BOM は UTF-8、UTF-16 の BOM はその UTF-16 として読む（BOM は文字列から外して覚える）", () => {
    expect(decodeText(bytes(0xe3, 0x81, 0x82, 0x41), "auto", "f")).toEqual({ text: "あA", bom: false, encoding: "utf-8" });
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0xe3, 0x81, 0x82), "auto", "f")).toEqual({ text: "あ", bom: true, encoding: "utf-8" });
    expect(decodeText(bytes(0xff, 0xfe, 0x42, 0x30, 0x41, 0x00), "auto", "f")).toEqual({ text: "あA", bom: true, encoding: "utf-16le" });
    expect(decodeText(bytes(0xfe, 0xff, 0x30, 0x42, 0x00, 0x41), "auto", "f")).toEqual({ text: "あA", bom: true, encoding: "utf-16be" });
    expect(decodeText(bytes(), "auto", "f")).toEqual({ text: "", bom: false, encoding: "utf-8" });
  });

  it("UTF-16: BOM の有無と、サロゲートペア（絵文字）を保って書き戻す", () => {
    // 😀 = U+1F600 = D83D DE00
    const le = bytes(0x3d, 0xd8, 0x00, 0xde, 0x0a, 0x00);
    expect(decodeText(le, "utf-16le", "f")).toEqual({ text: "😀\n", bom: false, encoding: "utf-16le" });
    expect(hex(encodeText("😀\n", false, "utf-16le"))).toBe(hex(le));
    expect(hex(encodeText("😀\n", true, "utf-16le"))).toBe("ff fe " + hex(le));
    expect(hex(encodeText("あA", true, "utf-16be"))).toBe("fe ff 30 42 00 41");
  });

  it("Shift_JIS: 2 バイト目が「\\」と同じ値の文字、半角カナ、機種依存文字を読み、同じバイト列に書き戻す", () => {
    expect(decodeText(SJIS_A_HYO, "shift_jis", "f")).toEqual({ text: "あA表ｱ①", bom: false, encoding: "shift_jis" });
    expect(hex(encodeText("あA表ｱ①", false, "shift_jis"))).toBe(hex(SJIS_A_HYO));
    // ASCII はそのまま（「\」と「~」も）。
    expect(hex(encodeText("a\\~\r\n", false, "shift_jis"))).toBe("61 5c 7e 0d 0a");
  });

  it("その文字コードとして読めないバイト列は、ファイルの場所つきで断る", () => {
    expect(() => decodeText(bytes(0xff, 0x41), "utf-8", "text/a.csv")).toThrow("UTF-8 として読めないファイルです: text/a.csv");
    expect(() => decodeText(bytes(0x82, 0xa0), "utf-8", "text/a.csv")).toThrow("UTF-8 として読めない");
    expect(() => decodeText(bytes(0x41, 0x00, 0x42), "utf-16le", "text/a.csv")).toThrow("UTF-16LE として読めない");
    expect(() => decodeText(bytes(0x82), "shift_jis", "text/a.csv")).toThrow("Shift_JIS として読めない");
  });

  it("Shift_JIS: 書き戻すと元のバイト列に戻らないファイル（同じ文字の別のバイト列）は、読む時点で断る", () => {
    // 「Ⅰ」は NEC の 87 54 と、IBM 拡張の FA 4A の 2 通りがある。書き戻しは 87 54 になるので、FA 4A のファイルは変えてしまう。
    expect(decodeText(bytes(0x87, 0x54), "shift_jis", "f").text).toBe("Ⅰ");
    expect(() => decodeText(bytes(0x41, 0xfa, 0x4a), "shift_jis", "text/a.csv")).toThrow(/text\/a\.csv.*元のバイト列に戻りません/);
  });

  it("Shift_JIS で表せない文字は、文字とコードポイントを示して断る", () => {
    expect(() => encodeText("OK 확인", false, "shift_jis")).toThrow("文字「확」（U+D655）は Shift_JIS で表せません。");
    expect(() => encodeText("😀", false, "shift_jis")).toThrow("U+1F600");
  });
});

describe("CSV のフォーマットでの文字コード", () => {
  const ctx = (options: Record<string, unknown> = {}): FormatContext => ({
    resource: { id: "text/a.csv", path: "text/a.csv", name: "a.csv" },
    languages: [{ id: "ja", label: "ja" }, { id: "en", label: "en" }],
    options,
  });
  const set = (key: string, language: string, value: string): Change => ({ type: "set", key, field: { kind: "text", language }, value });
  const utf16 = (s: string): Uint8Array => encodeText(s, true, "utf-16le");

  it("UTF-16（BOM つき）は設定なしで読め、変えたセル以外のバイトを変えずに UTF-16 のまま書き戻す", () => {
    const input = utf16("key,ja,en\r\na,あ,A\r\nb,い,B\r\n");
    expect(csvFormat.parse(input, ctx()).entries.map((e) => [e.key, e.text])).toEqual([
      ["a", { ja: "あ", en: "A" }],
      ["b", { ja: "い", en: "B" }],
    ]);
    const out = csvFormat.apply(input, [set("b", "en", "ビー")], ctx());
    expect(hex(out.subarray(0, 2))).toBe("ff fe");
    expect(decodeText(out, "auto", "f")).toEqual({ text: "key,ja,en\r\na,あ,A\r\nb,い,ビー\r\n", bom: true, encoding: "utf-16le" });
    // 変えたセルより前のバイトは、そのまま。
    const unchanged = utf16("key,ja,en\r\na,あ,A\r\nb,い,").length;
    expect(hex(out.subarray(0, unchanged))).toBe(hex(input.subarray(0, unchanged)));
  });

  it("Shift_JIS は encoding を指定して読む。指定がなければ UTF-8 として読めずに断る（自動では見分けない）", () => {
    // key,ja,en / a,表,A（表 = 95 5C。引用符や区切りと取り違えない）
    const input = bytes(...[..."key,ja,en\r\na,"].map((c) => c.charCodeAt(0)), 0x95, 0x5c, ...[...",A\r\n"].map((c) => c.charCodeAt(0)));
    expect(() => csvFormat.parse(input, ctx())).toThrow("UTF-8 として読めないファイルです: text/a.csv");
    const sjis = ctx({ encoding: "shift_jis" });
    expect(csvFormat.parse(input, sjis).entries).toMatchObject([{ key: "a", text: { ja: "表", en: "A" } }]);
    // 英語のセルを変えても、Shift_JIS の部分のバイトはそのまま。
    const out = csvFormat.apply(input, [set("a", "en", "Table")], sjis);
    expect(hex(out)).toBe(hex(input).replace(/ 41 0d 0a$/, " 54 61 62 6c 65 0d 0a"));
    // 日本語を入れると、Shift_JIS のバイト列で書く（あ = 82 A0）。
    expect(hex(csvFormat.apply(input, [set("a", "ja", "あ")], sjis))).toBe(hex(input).replace("95 5c", "82 a0"));
  });

  it("Shift_JIS のファイルに、Shift_JIS で表せない文字は書けない（元のバイト列は返さず、理由を示して断る）", () => {
    const input = bytes(...[..."key,ja,en\na,x,A\n"].map((c) => c.charCodeAt(0)));
    expect(() => csvFormat.apply(input, [set("a", "ja", "확인")], ctx({ encoding: "sjis" }))).toThrow("Shift_JIS で表せません");
  });

  it("新しいリソースは、設定の文字コードで作る（UTF-16 は BOM つき、指定なしは BOM なしの UTF-8）", () => {
    expect(hex(csvFormat.create!([], ctx()))).toBe(hex(new TextEncoder().encode("key,ja,en\n")));
    expect(decodeText(csvFormat.create!([], ctx({ encoding: "utf-16le" })), "auto", "f")).toEqual({ text: "key,ja,en\n", bom: true, encoding: "utf-16le" });
    const created = csvFormat.create!([{ key: "a", text: { ja: "表" } }], ctx({ encoding: "shift_jis" }));
    expect(hex(created)).toBe(hex(bytes(...[..."key,ja,en\na,"].map((c) => c.charCodeAt(0)), 0x95, 0x5c, 0x2c, 0x0a)));
  });

  it("知らない encoding は、読む前に断る", () => {
    expect(() => csvFormat.parse(bytes(0x41), ctx({ encoding: "euc-jp" }))).toThrow(/encoding/);
  });
});
