import type { TextSyntax, TextToken } from "@loc-studio/sdk";

/**
 * 正規表現に一致した部分を指定の kind のトークンにし、間を "text" で埋める。
 * range をつなげると本文全体になる（検証と色分けの前提）。
 * accept が false を返した一致は、トークンにせず本文として扱う。
 */
function tokenizeWith(
  text: string,
  pattern: RegExp,
  kind: TextToken["kind"],
  accept: (match: string) => boolean = () => true,
): TextToken[] {
  const tokens: TextToken[] = [];
  let textStart = 0;
  const flushText = (end: number): void => {
    if (end > textStart) {
      tokens.push({ kind: "text", value: text.slice(textStart, end), range: { start: textStart, end } });
    }
  };
  for (const m of text.matchAll(pattern)) {
    const value = m[0];
    if (!accept(value)) continue;
    const start = m.index;
    flushText(start);
    tokens.push({ kind, value, range: { start, end: start + value.length } });
    textStart = start + value.length;
  }
  flushText(text.length);
  return tokens;
}

/** `{name}` `{0}` `{player.name}` 形式の変数。 */
export const bracesSyntax: TextSyntax = {
  id: "builtin.braces",
  tokenize: (text) => tokenizeWith(text, /\{[A-Za-z0-9_.:-]+\}/g, "variable"),
};

// "%%" を先に消費させ、直後の文字が変数と誤認されないようにする。
const PRINTF_PATTERN = /%%|%(?:\d+\$)?[-+#0]*\d*(?:\.\d+)?[sdifuxXeEgGc]/g;

/** printf 形式の変数。`%%`（% そのもの）は本文として扱う。 */
export const printfSyntax: TextSyntax = {
  id: "builtin.printf",
  tokenize: (text) => tokenizeWith(text, PRINTF_PATTERN, "variable", (m) => m !== "%%"),
};

/** `<b>` `</b>` `<color=#ff0000>` `<br/>` 形式のタグ。 */
export const tagsSyntax: TextSyntax = {
  id: "builtin.tags",
  tokenize: (text) => tokenizeWith(text, /<\/?[A-Za-z][^<>]*>/g, "tag"),
};

export const builtinSyntaxes: TextSyntax[] = [bracesSyntax, printfSyntax, tagsSyntax];
