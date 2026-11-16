/**
 * 行の条件式（rows / query の where）の構文解析。ここでは文字列を木にするだけで、列や言語は見ない
 * （列の解決と評価は query.ts）。
 *
 *   式      := 項 { "or" 項 }
 *   項      := 因子 { "and" 因子 }
 *   因子    := "not" 因子 | "(" 式 ")" | 条件
 *   条件    := 欄 [ 比較 値 | "is" ["not"] "empty" | ["not"] "in" "(" 値 { "," 値 } ")" ]
 *   比較    := "=" | "!=" | "<" | "<=" | ">" | ">=" | "~"（含む） | "!~"（含まない）
 *   値      := 引用符で囲んだ文字列 | 引用符なしの語
 */

export type CompareOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "~" | "!~";

/** 欄（列の ID、"列 ID@言語"、key / issues などの組み込みの欄）。書かれたままの文字列で持つ。 */
export interface QueryField {
  raw: string;
  pos: number;
}

/** quoted: 引用符で囲んだ値（数や true / false として読まない）。 */
export interface QueryValue {
  text: string;
  quoted: boolean;
  pos: number;
}

export type QueryNode =
  | { type: "and" | "or"; items: QueryNode[] }
  | { type: "not"; item: QueryNode }
  | { type: "compare"; field: QueryField; op: CompareOp; value: QueryValue }
  | { type: "in"; field: QueryField; values: QueryValue[]; negate: boolean }
  | { type: "empty"; field: QueryField; negate: boolean }
  | { type: "truthy"; field: QueryField };

/** 条件式の書き方の誤り。pos は式の中の位置（0 始まり）。 */
export class QuerySyntaxError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = "QuerySyntaxError";
    this.pos = pos;
  }
}

/** 式の長さと、条件の数の上限（1 回の要求の仕事を抑える）。 */
export const MAX_QUERY_LENGTH = 4000;
export const MAX_QUERY_TERMS = 200;
const MAX_DEPTH = 40;

type Token =
  | { kind: "word"; text: string; pos: number }
  | { kind: "string"; text: string; pos: number }
  | { kind: "op"; text: CompareOp; pos: number }
  | { kind: "(" | ")" | ","; pos: number };

const OPS: [string, CompareOp][] = [
  ["!=", "!="],
  ["<=", "<="],
  [">=", ">="],
  ["!~", "!~"],
  ["==", "="],
  ["=", "="],
  ["<", "<"],
  [">", ">"],
  ["~", "~"],
];
const ESCAPES: Record<string, string> = { n: "\n", t: "\t" };
/** 語を切る文字（空白のほか）。 */
const WORD_END = new Set(["(", ")", ",", '"', "'", "=", "<", ">", "~", "!"]);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ kind: ch, pos: i });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      let text = "";
      i++;
      for (;;) {
        if (i >= input.length) throw new QuerySyntaxError(`引用符 ${ch} が閉じていません。`, start);
        const c = input[i]!;
        if (c === "\\" && i + 1 < input.length) {
          const next = input[i + 1]!;
          text += ESCAPES[next] ?? next;
          i += 2;
          continue;
        }
        if (c === ch) break;
        text += c;
        i++;
      }
      i++;
      tokens.push({ kind: "string", text, pos: start });
      continue;
    }
    const op = OPS.find(([s]) => input.startsWith(s, i));
    if (op) {
      tokens.push({ kind: "op", text: op[1], pos: i });
      i += op[0].length;
      continue;
    }
    if (ch === "!") throw new QuerySyntaxError('"!" は "!="（等しくない）か "!~"（含まない）の形で書いてください。否定は "not" です。', i);
    const start = i;
    while (i < input.length && !/\s/.test(input[i]!) && !WORD_END.has(input[i]!)) i++;
    tokens.push({ kind: "word", text: input.slice(start, i), pos: start });
  }
  return tokens;
}

const describe = (t: Token | undefined): string => (t === undefined ? "式の終わり" : t.kind === "word" || t.kind === "string" || t.kind === "op" ? `"${t.text}"` : `"${t.kind}"`);

/** 条件式を木にする。空の式（空白だけ）は undefined。 */
export function parseQuery(input: string): QueryNode | undefined {
  if (input.length > MAX_QUERY_LENGTH) throw new QuerySyntaxError(`条件式が長すぎます（${MAX_QUERY_LENGTH} 文字まで）。`, MAX_QUERY_LENGTH);
  const tokens = tokenize(input);
  if (tokens.length === 0) return undefined;
  let at = 0;
  let terms = 0;
  const peek = (): Token | undefined => tokens[at];
  const isWord = (t: Token | undefined, word: string): boolean => t?.kind === "word" && t.text.toLowerCase() === word;
  const endPos = (): number => tokens[at]?.pos ?? input.length;

  const value = (after: string): QueryValue => {
    const t = peek();
    if (t?.kind === "string" || t?.kind === "word") {
      at++;
      return { text: t.text, quoted: t.kind === "string", pos: t.pos };
    }
    throw new QuerySyntaxError(`${after} のあとに値がありません（${describe(t)} があります）。`, endPos());
  };

  const condition = (): QueryNode => {
    const t = peek();
    if (t?.kind !== "word") throw new QuerySyntaxError(`列の ID が要るところに ${describe(t)} があります。`, endPos());
    if (++terms > MAX_QUERY_TERMS) throw new QuerySyntaxError(`条件が多すぎます（${MAX_QUERY_TERMS} 個まで）。`, t.pos);
    at++;
    const field: QueryField = { raw: t.text, pos: t.pos };
    const next = peek();
    if (next?.kind === "op") {
      at++;
      return { type: "compare", field, op: next.text, value: value(`"${next.text}"`) };
    }
    if (isWord(next, "is")) {
      at++;
      const negate = isWord(peek(), "not");
      if (negate) at++;
      if (!isWord(peek(), "empty")) throw new QuerySyntaxError(`"is" のあとは "empty" か "not empty" です（${describe(peek())} があります）。`, endPos());
      at++;
      return { type: "empty", field, negate };
    }
    const negate = isWord(next, "not") && isWord(tokens[at + 1], "in");
    if (negate || isWord(next, "in")) {
      at += negate ? 2 : 1;
      if (peek()?.kind !== "(") throw new QuerySyntaxError(`"in" のあとは "(" です（${describe(peek())} があります）。`, endPos());
      at++;
      const values = [value('"in ("')];
      while (peek()?.kind === ",") {
        at++;
        values.push(value('","'));
      }
      if (peek()?.kind !== ")") throw new QuerySyntaxError(`"in (...)" の ")" がありません（${describe(peek())} があります）。`, endPos());
      at++;
      return { type: "in", field, values, negate };
    }
    return { type: "truthy", field };
  };

  const factor = (depth: number): QueryNode => {
    if (depth > MAX_DEPTH) throw new QuerySyntaxError("かっこと not の入れ子が深すぎます。", endPos());
    const t = peek();
    if (isWord(t, "not")) {
      at++;
      return { type: "not", item: factor(depth + 1) };
    }
    if (t?.kind === "(") {
      at++;
      const inner = expression(depth + 1);
      if (peek()?.kind !== ")") throw new QuerySyntaxError(`")" がありません（${describe(peek())} があります）。`, endPos());
      at++;
      return inner;
    }
    return condition();
  };

  const term = (depth: number): QueryNode => {
    const items = [factor(depth)];
    while (isWord(peek(), "and")) {
      at++;
      items.push(factor(depth));
    }
    return items.length === 1 ? items[0]! : { type: "and", items };
  };

  function expression(depth: number): QueryNode {
    const items = [term(depth)];
    while (isWord(peek(), "or")) {
      at++;
      items.push(term(depth));
    }
    return items.length === 1 ? items[0]! : { type: "or", items };
  }

  const tree = expression(0);
  const rest = peek();
  if (rest !== undefined) {
    throw new QuerySyntaxError(
      rest.kind === ")" ? '対応する "(" のない ")" があります。' : `条件のあとに ${describe(rest)} があります。条件は "and" か "or" でつないでください。`,
      rest.pos,
    );
  }
  return tree;
}
