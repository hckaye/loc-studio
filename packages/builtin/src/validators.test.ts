import type { LanguageDef, TextSyntax, ValidateContext, ValidationIssue, Validator } from "@loc-studio/sdk";
import { describe, expect, it } from "vitest";
import { bracesSyntax, tagsSyntax } from "./syntax.js";
import {
  builtinValidators,
  maxLengthValidator,
  placeholdersValidator,
  tagBalanceValidator,
  untranslatedValidator,
  whitespaceValidator,
} from "./validators.js";

const combined: TextSyntax = {
  id: "test.combined",
  tokenize(text) {
    // 括弧とタグの両方を見つけるため、タグ → 変数の順に分解し直す。
    return tagsSyntax.tokenize(text).flatMap((t) => {
      if (t.kind !== "text") return [t];
      return bracesSyntax
        .tokenize(t.value)
        .map((u) => ({ ...u, range: { start: u.range.start + t.range.start, end: u.range.end + t.range.start } }));
    });
  },
};

const lang = (id: string): LanguageDef => ({ id, label: id });

function ctx(
  value: string,
  opts: { base?: string; options?: Record<string, unknown>; meta?: Record<string, unknown> } = {},
): ValidateContext {
  const c: ValidateContext = {
    entry: {
      key: "k",
      resource: { id: "r", path: "r", name: "r" },
      ...(opts.meta ? { meta: opts.meta } : {}),
    },
    column: { id: "text", kind: "text", scope: "language" },
    language: lang("ja"),
    value,
    tokens: combined.tokenize(value),
    row: { text: () => undefined, get: () => undefined },
    options: opts.options ?? {},
  };
  if (opts.base !== undefined) {
    c.base = { language: lang("en"), value: opts.base, tokens: combined.tokenize(opts.base) };
  }
  return c;
}

// 同梱のバリデータはすべて同期で、セルごとの validate を持つ。
const run = (v: Validator, c: ValidateContext): ValidationIssue[] => v.validate!(c) as ValidationIssue[];
const slice = (c: ValidateContext, r?: { start: number; end: number }) => (r ? c.value.slice(r.start, r.end) : undefined);

describe("メタ情報", () => {
  it("5 つ、version 1、日本語 label", () => {
    expect(builtinValidators.map((v) => v.id)).toEqual([
      "builtin.placeholders",
      "builtin.tagBalance",
      "builtin.maxLength",
      "builtin.whitespace",
      "builtin.untranslated",
    ]);
    for (const v of builtinValidators) {
      expect(v.version).toBe("1");
      expect(v.label).toMatch(/[぀-ヿ一-鿿]/);
    }
    expect(builtinValidators.map((v) => v.severity)).toEqual(["error", "error", "error", "warning", "warning"]);
  });
});

describe("placeholdersValidator", () => {
  it("一致していれば問題なし（順序違いも可）", () => {
    expect(run(placeholdersValidator, ctx("{b}と{a}", { base: "{a} and {b}" }))).toEqual([]);
  });
  it("不足は distinct ごとに 1 件", () => {
    const issues = run(placeholdersValidator, ctx("こんにちは", { base: "Hi {name} {name} <b>x</b>" }));
    expect(issues.map((i) => i.code)).toEqual(["placeholder-missing", "placeholder-missing", "placeholder-missing"]);
    expect(issues[0]?.message).toContain("{name}");
    expect(issues.some((i) => i.message.includes("<b>"))).toBe(true);
  });
  it("個数が足りない場合も不足", () => {
    const issues = run(placeholdersValidator, ctx("{a}", { base: "{a} {a}" }));
    expect(issues.map((i) => i.code)).toEqual(["placeholder-missing"]);
  });
  it("余分は最初の余分な出現の range", () => {
    const c = ctx("{a}と{b}と{b}", { base: "{a} {b}" });
    const issues = run(placeholdersValidator, c);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("placeholder-extra");
    expect(slice(c, issues[0]?.range)).toBe("{b}");
    expect(issues[0]?.range?.start).toBe(c.value.lastIndexOf("{b}"));
  });
  it("原文にない変数は余分", () => {
    const c = ctx("あ{x}", { base: "a" });
    const issues = run(placeholdersValidator, c);
    expect(issues.map((i) => i.code)).toEqual(["placeholder-extra"]);
    expect(slice(c, issues[0]?.range)).toBe("{x}");
  });
  it("base がない・値が空ならスキップ", () => {
    expect(run(placeholdersValidator, ctx("{a}"))).toEqual([]);
    expect(run(placeholdersValidator, ctx("", { base: "{a}" }))).toEqual([]);
  });
  it("ignoreTags でタグを無視", () => {
    const c = ctx("あ{a}", { base: "<b>{a}</b>" });
    expect(run(placeholdersValidator, c)).toHaveLength(2);
    expect(run(placeholdersValidator, ctx("あ{a}", { base: "<b>{a}</b>", options: { ignoreTags: true } }))).toEqual([]);
  });
});

describe("tagBalanceValidator", () => {
  it("正しい入れ子と br は問題なし", () => {
    expect(run(tagBalanceValidator, ctx("<b>a<i>b</i></b><br>c<br/><color=#fff>d</color>"))).toEqual([]);
  });
  it("閉じ忘れ", () => {
    const c = ctx("a<b>bold");
    const issues = run(tagBalanceValidator, c);
    expect(issues.map((i) => i.code)).toEqual(["tag-unclosed"]);
    expect(slice(c, issues[0]?.range)).toBe("<b>");
  });
  it("対応のない閉じタグ", () => {
    const c = ctx("a</b>");
    const issues = run(tagBalanceValidator, c);
    expect(issues.map((i) => i.code)).toEqual(["tag-unexpected-close"]);
    expect(slice(c, issues[0]?.range)).toBe("</b>");
  });
  it("入れ子の誤り", () => {
    const c = ctx("<b><i>x</b></i>");
    const issues = run(tagBalanceValidator, c);
    expect(issues.some((i) => i.code === "tag-unexpected-close" && slice(c, i.range) === "</b>")).toBe(true);
  });
  it("属性付きは名前だけで対応させる", () => {
    expect(run(tagBalanceValidator, ctx("<color=#ff0000>x</color>"))).toEqual([]);
    expect(run(tagBalanceValidator, ctx('<ruby text="x">漢字</ruby>'))).toEqual([]);
  });
  it("voidTags の指定", () => {
    expect(run(tagBalanceValidator, ctx("a<hr>b", { options: { voidTags: ["hr"] } }))).toEqual([]);
    const issues = run(tagBalanceValidator, ctx("a<br>b", { options: { voidTags: ["hr"] } }));
    expect(issues.map((i) => i.code)).toEqual(["tag-unclosed"]);
  });
});

describe("maxLengthValidator", () => {
  it("上限なしなら問題なし", () => {
    expect(run(maxLengthValidator, ctx("あいうえお"))).toEqual([]);
  });
  it("options.max（text: 変数・タグを除く）", () => {
    expect(run(maxLengthValidator, ctx("あい{name}<b>う</b>", { options: { max: 3 } }))).toEqual([]);
    const issues = run(maxLengthValidator, ctx("あいうえ{name}", { options: { max: 3 } }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("too-long");
    expect(issues[0]?.message).toContain("4");
    expect(issues[0]?.message).toContain("3");
    expect(issues[0]?.range).toBeUndefined();
  });
  it("meta の maxLength（数値・文字列）と metaKey", () => {
    expect(run(maxLengthValidator, ctx("あいう", { meta: { maxLength: 2 } }))).toHaveLength(1);
    expect(run(maxLengthValidator, ctx("あいう", { meta: { maxLength: "2" } }))).toHaveLength(1);
    expect(run(maxLengthValidator, ctx("あいう", { meta: { maxLength: "3" } }))).toEqual([]);
    expect(run(maxLengthValidator, ctx("あいう", { meta: { limit: 1 }, options: { metaKey: "limit" } }))).toHaveLength(1);
  });
  it("options.max が meta より優先、使えない meta は無視", () => {
    expect(run(maxLengthValidator, ctx("あいう", { meta: { maxLength: 1 }, options: { max: 5 } }))).toEqual([]);
    expect(run(maxLengthValidator, ctx("あいう", { meta: { maxLength: "abc" } }))).toEqual([]);
    expect(run(maxLengthValidator, ctx("あいう", { meta: { maxLength: "" } }))).toEqual([]);
  });
  it("コードポイントで数える（サロゲートペア）", () => {
    expect(run(maxLengthValidator, ctx("😀😀😀", { options: { max: 3 } }))).toEqual([]);
    expect(run(maxLengthValidator, ctx("😀😀😀", { options: { max: 2 } }))).toHaveLength(1);
  });
  it('count: "all" は変数・タグも数え、超えた位置から末尾までの range', () => {
    const c = ctx("ab{x}cd", { options: { max: 3, count: "all" } });
    const issues = run(maxLengthValidator, c);
    expect(issues).toHaveLength(1);
    expect(slice(c, issues[0]?.range)).toBe("x}cd");
  });
  it('count: "all" でサロゲートペアの位置', () => {
    const c = ctx("😀😀😀", { options: { max: 2, count: "all" } });
    const issues = run(maxLengthValidator, c);
    expect(slice(c, issues[0]?.range)).toBe("😀");
  });
});

describe("whitespaceValidator", () => {
  it("問題なし・空", () => {
    expect(run(whitespaceValidator, ctx("a b"))).toEqual([]);
    expect(run(whitespaceValidator, ctx(""))).toEqual([]);
  });
  it("先頭（全角スペース含む）", () => {
    const c = ctx("　 あい");
    const issues = run(whitespaceValidator, c);
    expect(issues.map((i) => i.code)).toEqual(["leading-space"]);
    expect(slice(c, issues[0]?.range)).toBe("　 ");
    expect(issues[0]?.fix?.value).toBe("あい");
  });
  it("末尾", () => {
    const c = ctx("あい \n");
    const issues = run(whitespaceValidator, c);
    expect(issues.map((i) => i.code)).toEqual(["trailing-space"]);
    expect(slice(c, issues[0]?.range)).toBe(" \n");
    expect(issues[0]?.fix?.value).toBe("あい");
  });
  it("連続スペースは最初の出現の range、fix は全体を畳む", () => {
    const c = ctx("a  b   c");
    const issues = run(whitespaceValidator, c);
    expect(issues.map((i) => i.code)).toEqual(["double-space"]);
    expect(slice(c, issues[0]?.range)).toBe("  ");
    expect(issues[0]?.fix?.value).toBe("a b c");
  });
  it("複合", () => {
    const issues = run(whitespaceValidator, ctx(" a  b "));
    expect(issues.map((i) => i.code)).toEqual(["leading-space", "trailing-space", "double-space"]);
  });
  it("空白だけの値は重複して報告しない", () => {
    const issues = run(whitespaceValidator, ctx("   "));
    expect(issues.map((i) => i.code)).toEqual(["leading-space"]);
    expect(issues[0]?.fix?.value).toBe("");
  });
});

describe("untranslatedValidator", () => {
  it("base がなければスキップ", () => {
    expect(run(untranslatedValidator, ctx(""))).toEqual([]);
  });
  it("空・空白のみは empty", () => {
    expect(run(untranslatedValidator, ctx("", { base: "Hello" })).map((i) => i.code)).toEqual(["empty"]);
    expect(run(untranslatedValidator, ctx(" 　", { base: "Hello" })).map((i) => i.code)).toEqual(["empty"]);
  });
  it("base も空なら empty にしない", () => {
    expect(run(untranslatedValidator, ctx("", { base: "  " }))).toEqual([]);
  });
  it("原文と同じは same-as-base", () => {
    expect(run(untranslatedValidator, ctx("Hello", { base: "Hello" })).map((i) => i.code)).toEqual(["same-as-base"]);
    expect(run(untranslatedValidator, ctx("勇者{name}", { base: "勇者{name}" })).map((i) => i.code)).toEqual([
      "same-as-base",
    ]);
  });
  it("数字だけ・変数だけ・記号だけは報告しない", () => {
    expect(run(untranslatedValidator, ctx("123", { base: "123" }))).toEqual([]);
    expect(run(untranslatedValidator, ctx("{a}", { base: "{a}" }))).toEqual([]);
    expect(run(untranslatedValidator, ctx("<b>{a}</b> 10%", { base: "<b>{a}</b> 10%" }))).toEqual([]);
  });
  it("違う文字列は問題なし", () => {
    expect(run(untranslatedValidator, ctx("こんにちは", { base: "Hello" }))).toEqual([]);
  });
});
