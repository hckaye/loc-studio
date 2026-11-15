/**
 * テキストファイルの文字コード（UTF-8、UTF-16、Shift_JIS）。
 *
 * 書き戻しはロスレスでなければならない（触っていない部分のバイトを変えない）。読んだ文字列を同じ文字コードで
 * 書き直したときに元のバイト列に戻らないファイルは、読む時点で断る。
 */

export type TextEncoding = "utf-8" | "utf-16le" | "utf-16be" | "shift_jis";

/** 設定に書ける名前（よくある別名も受け付ける）。 */
const ALIASES: Record<string, TextEncoding | "auto"> = {
  auto: "auto",
  "utf-8": "utf-8",
  utf8: "utf-8",
  "utf-16le": "utf-16le",
  utf16le: "utf-16le",
  "utf-16": "utf-16le",
  utf16: "utf-16le",
  "utf-16be": "utf-16be",
  utf16be: "utf-16be",
  shift_jis: "shift_jis",
  "shift-jis": "shift_jis",
  sjis: "shift_jis",
  cp932: "shift_jis",
  "windows-31j": "shift_jis",
};

/** 設定の encoding を確かめる。省略時は "auto"（BOM で UTF-16 と見分け、なければ UTF-8）。 */
export function parseEncodingOption(value: unknown, where: string): TextEncoding | "auto" {
  if (value === undefined) return "auto";
  const found = typeof value === "string" ? ALIASES[value.toLowerCase()] : undefined;
  if (!found) {
    throw new Error(`設定の encoding は "auto"、"utf-8"、"utf-16le"、"utf-16be"、"shift_jis" のいずれかで指定してください: ${JSON.stringify(value)}（${where}）`);
  }
  return found;
}

export interface DecodedText {
  text: string;
  /** 先頭に BOM があった（書き戻すときに付け直す）。 */
  bom: boolean;
  encoding: TextEncoding;
}

const LABEL: Record<TextEncoding, string> = { "utf-8": "UTF-8", "utf-16le": "UTF-16LE", "utf-16be": "UTF-16BE", shift_jis: "Shift_JIS" };

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * バイト列を文字列にする。"auto" は、先頭が UTF-16 の BOM ならその UTF-16、それ以外は UTF-8。
 * その文字コードとして読めないバイト列と、書き戻すと元に戻らないバイト列は、例外にする。
 */
export function decodeText(input: Uint8Array, encoding: TextEncoding | "auto", what: string): DecodedText {
  let enc: TextEncoding;
  if (encoding !== "auto") enc = encoding;
  else if (input[0] === 0xff && input[1] === 0xfe) enc = "utf-16le";
  else if (input[0] === 0xfe && input[1] === 0xff) enc = "utf-16be";
  else enc = "utf-8";

  let text: string;
  try {
    // ignoreBOM: BOM を文字として残し、自分で判定して書き戻しに使う。
    text = new TextDecoder(enc, { fatal: true, ignoreBOM: true }).decode(input);
  } catch (e) {
    throw new Error(`${LABEL[enc]} として読めないファイルです: ${what}`, { cause: e });
  }
  const bom = enc !== "shift_jis" && text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  if (enc === "shift_jis") {
    // Shift_JIS には、同じ文字を表すバイト列が複数ある（機種依存文字の重複など）。
    // 書き戻しで別のバイト列になってしまうファイルは、ここで断る。
    let back: Uint8Array;
    try {
      back = encodeText(text, false, enc);
    } catch (e) {
      throw new Error(`${what} は、Shift_JIS として読んだ文字を Shift_JIS で書き戻せません: ${(e as Error).message}`);
    }
    if (!sameBytes(back, input)) {
      throw new Error(`${what} は、Shift_JIS として読んで書き戻すと、元のバイト列に戻りません（同じ文字に別のバイト列を使う機種依存文字などを含んでいます）。UTF-8 か UTF-16 に変換してから使ってください。`);
    }
  }
  return { text, bom, encoding: enc };
}

/** 文字列をバイト列にする。その文字コードで表せない文字があれば例外にする。 */
export function encodeText(text: string, bom: boolean, encoding: TextEncoding): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(bom ? "﻿" + text : text);
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    const s = bom ? "﻿" + text : text;
    const out = new Uint8Array(s.length * 2);
    const little = encoding === "utf-16le";
    for (let i = 0; i < s.length; i++) {
      const unit = s.charCodeAt(i);
      out[i * 2 + (little ? 0 : 1)] = unit & 0xff;
      out[i * 2 + (little ? 1 : 0)] = unit >> 8;
    }
    return out;
  }
  const table = shiftJisTable();
  const out: number[] = [];
  for (const ch of text) {
    const bytes = table.get(ch);
    if (bytes === undefined) {
      throw new Error(`文字「${ch}」（U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}）は Shift_JIS で表せません。`);
    }
    if (bytes > 0xff) out.push(bytes >> 8, bytes & 0xff);
    else out.push(bytes);
  }
  return Uint8Array.from(out);
}

let sjisTable: Map<string, number> | undefined;

/**
 * 文字 → Shift_JIS のバイト列（1 バイトはそのまま、2 バイトは上位 << 8 | 下位）。
 * 実行環境のデコーダ（Windows-31J）で、ありうるバイト列をすべて読んで作る。同じ文字に複数のバイト列があるときは、
 * 小さいほう（先に見つかったほう）を使う。
 */
function shiftJisTable(): Map<string, number> {
  if (sjisTable) return sjisTable;
  const decoder = new TextDecoder("shift_jis", { fatal: true });
  const table = new Map<string, number>();
  const tryAdd = (bytes: number[]): void => {
    let ch: string;
    try {
      ch = decoder.decode(Uint8Array.from(bytes));
    } catch {
      return;
    }
    // 1 つの文字（コードポイント 1 つ）になるものだけを使う。
    if ([...ch].length !== 1 || table.has(ch)) return;
    table.set(ch, bytes.length === 1 ? bytes[0]! : (bytes[0]! << 8) | bytes[1]!);
  };
  for (let b = 0x00; b <= 0x7f; b++) tryAdd([b]);
  for (let b = 0xa1; b <= 0xdf; b++) tryAdd([b]);
  for (const [from, to] of [[0x81, 0x9f], [0xe0, 0xfc]] as const) {
    for (let lead = from; lead <= to; lead++) {
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail !== 0x7f) tryAdd([lead, trail]);
      }
    }
  }
  sjisTable = table;
  return table;
}
