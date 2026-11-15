import { describe, expect, it } from "vitest";
import { bracesSyntax, builtinSyntaxes, printfSyntax, tagsSyntax } from "./syntax.js";

const summarize = (tokens: { kind: string; value: string }[]) => tokens.map((t) => [t.kind, t.value]);

describe.each(builtinSyntaxes)("$id 共通", (syntax) => {
  const inputs = [
    "",
    "plain",
    "{a} %s <b>x</b> %% {",
    "こんにちは{name}さん、%dコ<b>太字</b>です",
    "😀{x}😀%s😀<i>😀</i>",
    "a < b > c { } 100%",
    "{{a}}<<b>>%%%s",
  ];
  it.each(inputs)("range をつなげると本文になる: %j", (text) => {
    const tokens = syntax.tokenize(text);
    expect(tokens.map((t) => text.slice(t.range.start, t.range.end))).toEqual(tokens.map((t) => t.value));
    expect(tokens.map((t) => t.value).join("")).toBe(text);
    let pos = 0;
    for (const t of tokens) {
      expect(t.range.start).toBe(pos);
      expect(t.range.end).toBeGreaterThan(t.range.start);
      pos = t.range.end;
    }
    expect(pos).toBe(text.length);
  });
  it("空文字は [] を返す", () => {
    expect(syntax.tokenize("")).toEqual([]);
  });
});

describe("bracesSyntax", () => {
  it("id", () => expect(bracesSyntax.id).toBe("builtin.braces"));
  it("名前・数字・ドット付きを変数にする", () => {
    expect(summarize(bracesSyntax.tokenize("{name} {0} {player.name} {a:b-c_d}"))).toEqual([
      ["variable", "{name}"],
      ["text", " "],
      ["variable", "{0}"],
      ["text", " "],
      ["variable", "{player.name}"],
      ["text", " "],
      ["variable", "{a:b-c_d}"],
    ]);
  });
  it("単独の { } や空の {} は本文", () => {
    expect(summarize(bracesSyntax.tokenize("a { b } {} {x y}"))).toEqual([["text", "a { b } {} {x y}"]]);
  });
  it("CJK の間でも取れる", () => {
    expect(summarize(bracesSyntax.tokenize("勇者{name}は{0}Gを得た"))).toEqual([
      ["text", "勇者"],
      ["variable", "{name}"],
      ["text", "は"],
      ["variable", "{0}"],
      ["text", "Gを得た"],
    ]);
  });
  it("入れ子は内側だけが変数", () => {
    expect(summarize(bracesSyntax.tokenize("{{a}}"))).toEqual([
      ["text", "{"],
      ["variable", "{a}"],
      ["text", "}"],
    ]);
  });
});

describe("printfSyntax", () => {
  it("id", () => expect(printfSyntax.id).toBe("builtin.printf"));
  it.each(["%s", "%d", "%i", "%f", "%.2f", "%1$s", "%05d"])("%s は変数", (v) => {
    expect(summarize(printfSyntax.tokenize(`a${v}b`))).toEqual([
      ["text", "a"],
      ["variable", v],
      ["text", "b"],
    ]);
  });
  it("%% は本文で、直後の文字を巻き込まない", () => {
    expect(summarize(printfSyntax.tokenize("100%% done %%s"))).toEqual([["text", "100%% done %%s"]]);
  });
  it("%%%s は本文 + 変数", () => {
    expect(summarize(printfSyntax.tokenize("%%%s"))).toEqual([
      ["text", "%%"],
      ["variable", "%s"],
    ]);
  });
  it("孤立した % は本文", () => {
    expect(summarize(printfSyntax.tokenize("50% off"))).toEqual([["text", "50% off"]]);
  });
  it("CJK の隣", () => {
    expect(summarize(printfSyntax.tokenize("残り%d回です"))).toEqual([
      ["text", "残り"],
      ["variable", "%d"],
      ["text", "回です"],
    ]);
  });
});

describe("tagsSyntax", () => {
  it("id", () => expect(tagsSyntax.id).toBe("builtin.tags"));
  it("各種タグ", () => {
    const text = '<b>x</b><color=#ff0000>y<br/><ruby text="x">';
    expect(summarize(tagsSyntax.tokenize(text)).filter(([k]) => k === "tag")).toEqual([
      ["tag", "<b>"],
      ["tag", "</b>"],
      ["tag", "<color=#ff0000>"],
      ["tag", "<br/>"],
      ["tag", '<ruby text="x">'],
    ]);
  });
  it("< の後ろが空白・数字なら本文", () => {
    expect(summarize(tagsSyntax.tokenize("a < b, 1<2 > 0"))).toEqual([["text", "a < b, 1<2 > 0"]]);
  });
  it("閉じていない < は本文", () => {
    expect(summarize(tagsSyntax.tokenize("<b unclosed"))).toEqual([["text", "<b unclosed"]]);
  });
  it("<< は後ろの方だけがタグ", () => {
    expect(summarize(tagsSyntax.tokenize("<<b>"))).toEqual([
      ["text", "<"],
      ["tag", "<b>"],
    ]);
  });
  it("CJK に囲まれたタグ", () => {
    expect(summarize(tagsSyntax.tokenize("これは<b>重要</b>です"))).toEqual([
      ["text", "これは"],
      ["tag", "<b>"],
      ["text", "重要"],
      ["tag", "</b>"],
      ["text", "です"],
    ]);
  });
});
