/**
 * CSV / TSV のフォーマット（ロスレスな書き戻し）。
 *
 * 方針:
 * - ファイルが正。書き戻しでは、変更したフィールドの生のテキスト以外は 1 文字も変えない。
 * - 解析は「デコード済みの文字列」の上で行い、位置もすべて UTF-16 の添字で扱う。
 *   エンコードは最後に 1 回だけ行うので、多バイト文字（日本語、絵文字）でも位置がずれない。
 * - UTF-8 として不正なバイト列は、デコードし直すと元に戻らないため、例外にする。
 */
import type {
  Change,
  Diagnostic,
  EntryData,
  FieldRef,
  Format,
  FormatContext,
  LanguageId,
  ParsedDocument,
  ResourceRef,
} from "@loc-studio/sdk";

// ---------------------------------------------------------------------------
// 公開する型
// ---------------------------------------------------------------------------

/** `ctx.options` で受け取る値。すべて省略できる。 */
export interface DelimitedOptions {
  /** キーの列の見出し。省略時は先頭の列。 */
  key?: string;
  /** 言語 ID → 見出し。省略時は、言語 ID と同じ見出しの列をその言語の本文とみなす。 */
  text?: Record<LanguageId, string>;
  /** "列 ID" または "列 ID@言語 ID" → 見出し。値は meta / languageMeta に文字列で入る。 */
  columns?: Record<string, string>;
  /** 安定 ID の列の見出し。 */
  stableId?: string;
  /** 区切り文字。フォーマットの既定を上書きする。 */
  delimiter?: string;
  /**
   * 変更に必要な列が見出しにないときの扱い。既定は "all-rows"。
   * - "all-rows": 見出しの末尾に列を足し、各レコードの末尾にも空のフィールドを足す（表を長方形に保つ）。
   * - "header-only": 見出しと、値を入れるレコードにだけ足す。
   * - "never": 列を足さず、例外にする。
   */
  addColumns?: AddColumnsMode;
}

export type AddColumnsMode = "all-rows" | "header-only" | "never";

export interface DelimitedFormatSpec {
  id: string;
  delimiter: string;
  extensions: string[];
}

// ---------------------------------------------------------------------------
// 字句解析
// ---------------------------------------------------------------------------

const QUOTE = 34; // "
const LF = 10;
const CR = 13;

interface RawCell {
  /** 生のテキストの範囲（引用符を含む）。end は含まない。 */
  start: number;
  end: number;
  quoted: boolean;
  value: string;
}

interface RawRecord {
  /** レコードの中身の範囲（改行を含まない）。 */
  start: number;
  end: number;
  /** 改行の後ろ。 */
  termEnd: number;
  /** レコードが始まる行（1 始まり）。 */
  line: number;
  cells: RawCell[];
  blank: boolean;
  /** 引用符が閉じないままファイルが終わった（最後のレコードだけ）。末尾に区切りを足すと値が変わる。 */
  unclosed?: boolean;
}

interface ScanResult {
  records: RawRecord[];
  diagnostics: Diagnostic[];
  /** 最も多い改行。改行が 1 つもなければ "\n"。 */
  eol: string;
}

function scan(text: string, delim: string): ScanResult {
  const records: RawRecord[] = [];
  const diagnostics: Diagnostic[] = [];
  const n = text.length;
  const d0 = delim.charCodeAt(0);
  const dl = delim.length;
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  let p = 0;
  let line = 1;

  const isDelimAt = (i: number): boolean =>
    text.charCodeAt(i) === d0 && (dl === 1 || text.startsWith(delim, i));

  while (p < n) {
    const recStart = p;
    const recLine = line;
    const cells: RawCell[] = [];
    let unclosed = false;
    for (;;) {
      const fStart = p;
      if (p < n && text.charCodeAt(p) === QUOTE) {
        p++;
        let value = "";
        let segStart = p;
        let closed = false;
        while (p < n) {
          const c = text.charCodeAt(p);
          if (c === QUOTE) {
            if (text.charCodeAt(p + 1) === QUOTE) {
              value += text.slice(segStart, p + 1);
              p += 2;
              segStart = p;
              continue;
            }
            value += text.slice(segStart, p);
            p++;
            closed = true;
            break;
          }
          if (c === LF) line++;
          else if (c === CR && text.charCodeAt(p + 1) !== LF) line++;
          p++;
        }
        if (!closed) {
          unclosed = true;
          value += text.slice(segStart, p);
          diagnostics.push({
            severity: "warning",
            message: "引用符が閉じられていないまま、ファイルの終わりに達しました。",
            line: recLine,
          });
        }
        // 閉じ引用符の後ろに余計な文字があっても、区切りまでを同じフィールドとして扱う（生のテキストは保つ）。
        const junkStart = p;
        while (p < n) {
          const c = text.charCodeAt(p);
          if (c === LF || c === CR || isDelimAt(p)) break;
          p++;
        }
        if (p > junkStart) {
          value += text.slice(junkStart, p);
          diagnostics.push({
            severity: "warning",
            message: "閉じ引用符の後ろに文字があります。",
            line: recLine,
          });
        }
        cells.push({ start: fStart, end: p, quoted: true, value });
      } else {
        while (p < n) {
          const c = text.charCodeAt(p);
          if (c === LF || c === CR || isDelimAt(p)) break;
          p++;
        }
        cells.push({ start: fStart, end: p, quoted: false, value: text.slice(fStart, p) });
      }
      if (p < n && isDelimAt(p)) {
        p += dl;
        continue;
      }
      break;
    }
    const recEnd = p;
    if (p < n) {
      if (text.charCodeAt(p) === CR && text.charCodeAt(p + 1) === LF) {
        p += 2;
        crlf++;
      } else {
        if (text.charCodeAt(p) === CR) cr++;
        else lf++;
        p += 1;
      }
      line++;
    }
    const rec: RawRecord = { start: recStart, end: recEnd, termEnd: p, line: recLine, cells, blank: recEnd === recStart };
    if (unclosed) rec.unclosed = true;
    records.push(rec);
  }

  let eol = "\n";
  if (crlf > lf && crlf >= cr) eol = "\r\n";
  else if (cr > lf && cr > crlf) eol = "\r";
  return { records, diagnostics, eol };
}

// ---------------------------------------------------------------------------
// エンコーディング
// ---------------------------------------------------------------------------

interface Decoded {
  text: string;
  bom: boolean;
}

function decode(input: Uint8Array, resource: ResourceRef): Decoded {
  let text: string;
  try {
    // ignoreBOM: BOM を文字として残し、自分で判定して書き戻しに使う。
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch (e) {
    throw new Error(`UTF-8 として読めないファイルです: ${resource.path}`, { cause: e });
  }
  if (text.charCodeAt(0) === 0xfeff) return { text: text.slice(1), bom: true };
  return { text, bom: false };
}

function encode(text: string, bom: boolean): Uint8Array {
  return new TextEncoder().encode(bom ? "﻿" + text : text);
}

// ---------------------------------------------------------------------------
// 設定の読み取り
// ---------------------------------------------------------------------------

interface ResolvedOptions {
  key?: string;
  text?: Record<string, string>;
  columns?: Record<string, string>;
  stableId?: string;
  delimiter: string;
  addColumns: AddColumnsMode;
}

function readStringRecord(value: unknown, name: string, resource: ResourceRef): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`設定の ${name} はオブジェクトで指定してください（${resource.path}）。`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") {
      throw new Error(`設定の ${name}.${k} は文字列で指定してください（${resource.path}）。`);
    }
    out[k] = v;
  }
  return out;
}

function readOptionalString(value: unknown, name: string, resource: ResourceRef): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`設定の ${name} は文字列で指定してください（${resource.path}）。`);
  }
  return value;
}

function resolveOptions(ctx: FormatContext, defaultDelimiter: string): ResolvedOptions {
  const o = ctx.options ?? {};
  const r = ctx.resource;
  const delimiter = readOptionalString(o.delimiter, "delimiter", r) ?? defaultDelimiter;
  if (delimiter === "" || /["\r\n]/.test(delimiter)) {
    throw new Error(`区切り文字が不正です（空、引用符、改行は使えません）: ${JSON.stringify(delimiter)}（${r.path}）`);
  }
  const addColumns = readOptionalString(o.addColumns, "addColumns", r) ?? "all-rows";
  if (addColumns !== "all-rows" && addColumns !== "header-only" && addColumns !== "never") {
    throw new Error(
      `設定の addColumns は "all-rows"、"header-only"、"never" のいずれかで指定してください: ${JSON.stringify(addColumns)}（${r.path}）`,
    );
  }
  const resolved: ResolvedOptions = { delimiter, addColumns };
  const key = readOptionalString(o.key, "key", r);
  if (key !== undefined) resolved.key = key;
  const text = readStringRecord(o.text, "text", r);
  if (text !== undefined) resolved.text = text;
  const columns = readStringRecord(o.columns, "columns", r);
  if (columns !== undefined) resolved.columns = columns;
  const stableId = readOptionalString(o.stableId, "stableId", r);
  if (stableId !== undefined) resolved.stableId = stableId;
  return resolved;
}

/** "列 ID@言語 ID" を分ける。 */
function splitColumnSpec(spec: string): { column: string; language?: string } {
  const at = spec.indexOf("@");
  if (at < 0) return { column: spec };
  return { column: spec.slice(0, at), language: spec.slice(at + 1) };
}

// ---------------------------------------------------------------------------
// 見出しと列の対応
// ---------------------------------------------------------------------------

interface ColumnMap {
  header: string;
  /** 見出しにない場合は -1。 */
  index: number;
}

interface Layout {
  headers: string[];
  keyHeader: string;
  keyIndex: number;
  /** 言語 ID → 列。 */
  text: Map<string, ColumnMap>;
  /** "列 ID" / "列 ID@言語 ID" → 列。 */
  meta: Map<string, ColumnMap & { column: string; language?: string }>;
  stableId?: ColumnMap;
}

function buildLayout(headers: string[], opts: ResolvedOptions, ctx: FormatContext): Layout {
  const indexOf = new Map<string, number>();
  headers.forEach((h, i) => {
    // 同じ見出しが複数あれば先頭を使う。
    if (!indexOf.has(h)) indexOf.set(h, i);
  });
  const find = (header: string): ColumnMap => ({ header, index: indexOf.get(header) ?? -1 });

  const keyCol = opts.key !== undefined ? find(opts.key) : { header: headers[0] ?? "", index: headers.length > 0 ? 0 : -1 };

  const text = new Map<string, ColumnMap>();
  const explicitHeaders = new Set<string>();
  for (const [lang, header] of Object.entries(opts.text ?? {})) {
    text.set(lang, find(header));
    explicitHeaders.add(header);
  }
  // text に対応がない言語は、言語 ID と同じ見出しを本文とみなす（列の自動追加で足した列も読み戻せるように）。
  for (const lang of ctx.languages) {
    if (text.has(lang.id) || explicitHeaders.has(lang.id)) continue;
    const col = find(lang.id);
    if (col.index >= 0) text.set(lang.id, col);
  }

  const meta = new Map<string, ColumnMap & { column: string; language?: string }>();
  if (opts.columns) {
    for (const [spec, header] of Object.entries(opts.columns)) {
      meta.set(spec, { ...find(header), ...splitColumnSpec(spec) });
    }
  }

  const layout: Layout = { headers, keyHeader: keyCol.header, keyIndex: keyCol.index, text, meta };
  if (opts.stableId !== undefined) layout.stableId = find(opts.stableId);
  return layout;
}

// ---------------------------------------------------------------------------
// 引用符
// ---------------------------------------------------------------------------

function needsQuote(value: string, delim: string): boolean {
  if (value.includes(delim) || /["\r\n]/.test(value)) return true;
  return /^\s|\s$/.test(value);
}

function quote(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function toRaw(value: string, delim: string, forceQuote: boolean): string {
  return forceQuote || needsQuote(value, delim) ? quote(value) : value;
}

function valueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface Document {
  text: string;
  bom: boolean;
  scan: ScanResult;
  /** 見出しのレコードの添字。見出しがなければ -1。 */
  headerIndex: number;
  layout: Layout | undefined;
}

function loadDocument(input: Uint8Array, ctx: FormatContext, opts: ResolvedOptions): Document {
  const { text, bom } = decode(input, ctx.resource);
  const scanned = scan(text, opts.delimiter);
  const headerIndex = scanned.records.findIndex((r) => !r.blank);
  const headerRec = headerIndex >= 0 ? scanned.records[headerIndex] : undefined;
  const layout = headerRec ? buildLayout(headerRec.cells.map((c) => c.value), opts, ctx) : undefined;
  return { text, bom, scan: scanned, headerIndex, layout };
}

function cellValue(rec: RawRecord, index: number): string {
  return index >= 0 ? (rec.cells[index]?.value ?? "") : "";
}

function parseDocument(input: Uint8Array, ctx: FormatContext, defaultDelimiter: string): ParsedDocument {
  const opts = resolveOptions(ctx, defaultDelimiter);
  const doc = loadDocument(input, ctx, opts);
  const diagnostics: Diagnostic[] = [...doc.scan.diagnostics];
  const entries: EntryData[] = [];
  const layout = doc.layout;
  if (!layout) return { entries, diagnostics };

  const headerLine = doc.scan.records[doc.headerIndex]?.line;
  if (layout.keyIndex < 0) {
    diagnostics.push({
      severity: "error",
      message: `キーの列「${layout.keyHeader}」が見出しにありません（${ctx.resource.path}）。`,
      ...(headerLine !== undefined ? { line: headerLine } : {}),
    });
    return { entries, diagnostics };
  }
  const missing: string[] = [];
  for (const col of layout.text.values()) if (col.index < 0) missing.push(col.header);
  for (const col of layout.meta.values()) if (col.index < 0) missing.push(col.header);
  if (layout.stableId && layout.stableId.index < 0) missing.push(layout.stableId.header);
  for (const header of missing) {
    diagnostics.push({
      severity: "warning",
      message: `設定にある列「${header}」が見出しにありません。`,
      ...(headerLine !== undefined ? { line: headerLine } : {}),
    });
  }

  const textCols = [...layout.text.entries()].filter(([, c]) => c.index >= 0);
  const metaCols = [...layout.meta.values()].filter((c) => c.index >= 0);
  const seen = new Map<string, number>();
  const records = doc.scan.records;
  for (let i = doc.headerIndex + 1; i < records.length; i++) {
    const rec = records[i];
    if (!rec || rec.blank) continue;
    const key = cellValue(rec, layout.keyIndex);
    if (key === "") {
      diagnostics.push({ severity: "warning", message: "キーが空の行を読み飛ばしました。", line: rec.line });
      continue;
    }
    const firstLine = seen.get(key);
    if (firstLine !== undefined) {
      diagnostics.push({
        severity: "warning",
        message: `キー「${key}」が重複しています（最初は ${firstLine} 行目）。この行は読み飛ばしました。`,
        line: rec.line,
      });
      continue;
    }
    seen.set(key, rec.line);

    const entry: EntryData = { key, text: {}, location: { line: rec.line } };
    for (const [lang, col] of textCols) entry.text[lang] = cellValue(rec, col.index);
    for (const col of metaCols) {
      const v = cellValue(rec, col.index);
      if (col.language === undefined) {
        (entry.meta ??= {})[col.column] = v;
      } else {
        const lm = (entry.languageMeta ??= {});
        (lm[col.language] ??= {})[col.column] = v;
      }
    }
    if (layout.stableId && layout.stableId.index >= 0) {
      const sid = cellValue(rec, layout.stableId.index);
      if (sid !== "") entry.stableId = sid;
    }
    entries.push(entry);
  }
  return { entries, diagnostics };
}

// ---------------------------------------------------------------------------
// 書き戻し
// ---------------------------------------------------------------------------

interface EditCell {
  raw: string;
  quoted: boolean;
}

/** 書き戻し中のレコード。順番の入れ替えを O(1) で行うため双方向リストにする。 */
interface Item {
  rec?: RawRecord;
  /** 変更したレコードだけが持つ。持たないレコードは元のテキストをそのまま出す。 */
  cells?: EditCell[];
  term: string;
  blank: boolean;
  /** 引用符が閉じていないレコード。末尾にフィールドを足せない。 */
  unclosed?: boolean;
  prev: Item | null;
  next: Item | null;
}

const emptyCell = (): EditCell => ({ raw: "", quoted: false });

class Editor {
  private head: Item | null = null;
  private tail: Item | null = null;
  /** キー → そのキーを持つレコード（文書順）。先頭が有効なエントリ。 */
  private readonly byKey = new Map<string, Item[]>();
  private readonly headerItem: Item | null = null;
  private readonly layout: Layout;
  private readonly delim: string;
  /** 元の見出しのフィールド数。 */
  private readonly headerWidth: number;
  /** 新しい列を置き始める位置。見出しより長いレコードがあれば、その余りのフィールドと重ならない位置にする。 */
  private baseWidth: number | undefined;
  /** この呼び出しで足した列: 見出し → 位置。 */
  private readonly created = new Map<string, number>();

  constructor(
    private readonly doc: Document,
    private readonly opts: ResolvedOptions,
    private readonly ctx: FormatContext,
  ) {
    this.delim = opts.delimiter;
    const path = ctx.resource.path;
    if (!doc.layout) throw new Error(`見出しの行がないため変更できません: ${path}`);
    this.layout = doc.layout;
    if (this.layout.keyIndex < 0) {
      throw new Error(`キーの列「${this.layout.keyHeader}」が見出しにありません: ${path}`);
    }
    this.headerWidth = this.layout.headers.length;
    const records = doc.scan.records;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec) continue;
      const item: Item = {
        rec,
        term: doc.text.slice(rec.end, rec.termEnd),
        blank: rec.blank,
        prev: null,
        next: null,
      };
      if (rec.unclosed) item.unclosed = true;
      this.append(item);
      if (i === doc.headerIndex) this.headerItem = item;
      else if (i > doc.headerIndex && !rec.blank) {
        const key = cellValue(rec, this.layout.keyIndex);
        if (key !== "") this.index(key, item);
      }
    }
  }

  private append(item: Item): void {
    item.prev = this.tail;
    item.next = null;
    if (this.tail) this.tail.next = item;
    else this.head = item;
    this.tail = item;
  }

  private insertAfter(anchor: Item, item: Item): void {
    item.prev = anchor;
    item.next = anchor.next;
    if (anchor.next) anchor.next.prev = item;
    else this.tail = item;
    anchor.next = item;
  }

  private unlink(item: Item): void {
    if (item.prev) item.prev.next = item.next;
    else this.head = item.next;
    if (item.next) item.next.prev = item.prev;
    else this.tail = item.prev;
    item.prev = item.next = null;
  }

  private index(key: string, item: Item): void {
    const list = this.byKey.get(key);
    if (list) list.push(item);
    else this.byKey.set(key, [item]);
  }

  private unindex(key: string, item: Item): void {
    const list = this.byKey.get(key);
    if (!list) return;
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.byKey.delete(key);
  }

  private find(key: string, change: string): Item {
    const item = this.byKey.get(key)?.[0];
    if (!item) {
      throw new Error(`${change}: キー「${key}」のエントリが見つかりません（${this.ctx.resource.path}）。`);
    }
    return item;
  }

  private cellsOf(item: Item): EditCell[] {
    if (!item.cells) {
      const text = this.doc.text;
      item.cells = item.rec ? item.rec.cells.map((c) => ({ raw: text.slice(c.start, c.end), quoted: c.quoted })) : [];
    }
    return item.cells;
  }

  private setCell(item: Item, index: number, value: string): void {
    const cells = this.cellsOf(item);
    if (cells.length <= index) this.extend(item, index + 1);
    const cell = cells[index];
    if (!cell) return;
    cell.raw = toRaw(value, this.delim, cell.quoted);
    cell.quoted = cell.raw.startsWith('"');
  }

  /** レコードのフィールドを width 個まで空のフィールドで埋める。 */
  private extend(item: Item, width: number): void {
    const cells = this.cellsOf(item);
    if (cells.length >= width) return;
    if (item.unclosed) {
      // 閉じていない引用符の後ろに区切りを足すと、区切りが値の一部になってしまう。
      throw new Error(
        `引用符が閉じていないレコード（${item.rec?.line ?? "?"} 行目）にはフィールドを足せません（${this.ctx.resource.path}）。`,
      );
    }
    while (cells.length < width) cells.push(emptyCell());
  }

  private computeBaseWidth(): number {
    let width = this.headerWidth;
    const records = this.doc.scan.records;
    for (let i = this.doc.headerIndex + 1; i < records.length; i++) {
      const rec = records[i];
      if (rec && !rec.blank && rec.cells.length > width) width = rec.cells.length;
    }
    return width;
  }

  /** 見出しの末尾に列を足し、その位置を返す。同じ見出しを 2 度足さない。 */
  private createColumn(header: string): number {
    const path = this.ctx.resource.path;
    const existing = this.created.get(header);
    if (existing !== undefined) return existing;
    if (this.opts.addColumns === "never") {
      throw new Error(`列「${header}」が見出しにありません（${path}）。設定 addColumns が "never" のため列は足しません。`);
    }
    if (this.layout.headers.includes(header)) {
      // 対応の設定と見出しが食い違っている（同じ見出しが別の用途で使われている）。足すと読み戻しが曖昧になる。
      throw new Error(`列「${header}」は見出しに既にあり、別の列として使われています（${path}）。`);
    }
    this.baseWidth ??= this.computeBaseWidth();
    const index = this.baseWidth + this.created.size;
    const headerItem = this.headerItem;
    if (!headerItem) throw new Error(`見出しの行がないため列を足せません: ${path}`);
    this.extend(headerItem, index);
    this.cellsOf(headerItem).push({ raw: toRaw(header, this.delim, false), quoted: needsQuote(header, this.delim) });
    this.created.set(header, index);
    return index;
  }

  /** 変更対象の列の対応。対応の設定がなく、既定の見出しも決められない場合は例外。 */
  private columnMap(field: FieldRef): ColumnMap {
    const path = this.ctx.resource.path;
    if (field.kind === "text") {
      let col = this.layout.text.get(field.language);
      if (!col) {
        // 対応がない言語は、言語 ID を見出しにする（parse の「言語 ID と同じ見出し」の規則で読み戻せる）。
        if (!this.ctx.languages.some((l) => l.id === field.language)) {
          throw new Error(`言語「${field.language}」はプロジェクトの言語になく、本文の列の対応（text）もありません（${path}）。`);
        }
        col = { header: field.language, index: -1 };
        this.layout.text.set(field.language, col);
      }
      return col;
    }
    const spec = field.language === undefined ? field.column : `${field.column}@${field.language}`;
    const col = this.layout.meta.get(spec);
    if (!col) throw new Error(`列「${spec}」に対応する見出しが設定（columns）にありません（${path}）。`);
    return col;
  }

  /** 列の位置。見出しになければ（設定が許せば）列を足す。 */
  private ensureIndex(col: ColumnMap): number {
    if (col.index < 0) col.index = this.createColumn(col.header);
    return col.index;
  }

  set(key: string, field: FieldRef, value: unknown): void {
    const item = this.find(key, "set");
    const col = this.columnMap(field);
    const s = valueToString(value);
    // 列がない状態で空を入れるのは、読み戻した値が変わらないので何もしない（列も足さない）。
    if (col.index < 0 && s === "" && !this.created.has(col.header)) return;
    this.setCell(item, this.ensureIndex(col), s);
  }

  rename(key: string, newKey: string): void {
    const path = this.ctx.resource.path;
    const item = this.find(key, "rename");
    if (newKey === "") throw new Error(`rename: 新しいキーが空です（${path}）。`);
    if (newKey === key) return;
    if (this.byKey.has(newKey)) {
      throw new Error(`rename: キー「${newKey}」は既にあります（${path}）。`);
    }
    this.setCell(item, this.layout.keyIndex, newKey);
    this.unindex(key, item);
    this.index(newKey, item);
  }

  remove(key: string): void {
    const item = this.find(key, "remove");
    // 末尾に改行がないファイルの最後のレコードを消すときは、「末尾に改行がない」状態を保つ。
    if (item === this.tail && item.term === "" && item.prev) item.prev.term = "";
    this.unlink(item);
    this.unindex(key, item);
  }

  add(entry: EntryData, after: string | undefined): void {
    const path = this.ctx.resource.path;
    const key = entry.key;
    if (typeof key !== "string" || key === "") throw new Error(`add: キーが空です（${path}）。`);
    if (this.byKey.has(key)) throw new Error(`add: キー「${key}」は既にあります（${path}）。`);

    const item: Item = { cells: [], term: "", blank: false, prev: null, next: null };
    this.extend(item, this.headerWidth);
    this.setCell(item, this.layout.keyIndex, key);

    for (const [lang, value] of Object.entries(entry.text ?? {})) {
      if (value === undefined) continue;
      const s = valueToString(value);
      // 空の値は既定の空フィールドと同じなので、列の有無を問わず書かない。
      if (s === "") continue;
      this.setCell(item, this.ensureIndex(this.columnMap({ kind: "text", language: lang })), s);
    }
    for (const [column, value] of Object.entries(entry.meta ?? {})) {
      if (value === undefined) continue;
      const s = valueToString(value);
      if (s === "") continue;
      this.setCell(item, this.ensureIndex(this.columnMap({ kind: "meta", column })), s);
    }
    for (const [lang, metas] of Object.entries(entry.languageMeta ?? {})) {
      for (const [column, value] of Object.entries(metas ?? {})) {
        if (value === undefined) continue;
        const s = valueToString(value);
        if (s === "") continue;
        this.setCell(item, this.ensureIndex(this.columnMap({ kind: "meta", column, language: lang })), s);
      }
    }
    if (entry.stableId !== undefined && entry.stableId !== "") {
      const col = this.layout.stableId;
      if (!col) throw new Error(`add: 安定 ID の列が設定（stableId）にありません（${path}）。`);
      this.setCell(item, this.ensureIndex(col), entry.stableId);
    }

    let anchor: Item;
    if (after !== undefined) {
      anchor = this.find(after, "add");
    } else {
      // 末尾の空行は末尾に残したいので、最後の空でないレコードの後ろに入れる。
      let a = this.tail;
      while (a && a.blank) a = a.prev;
      anchor = a ?? this.headerItem ?? (this.tail as Item);
    }
    if (anchor.term === "") {
      // 末尾に改行がないファイル: 区切りの改行を足し、新しいレコードを改行なしの最後にする。
      anchor.term = this.doc.scan.eol;
      item.term = "";
    } else {
      item.term = this.doc.scan.eol;
    }
    this.insertAfter(anchor, item);
    this.index(key, item);
  }

  output(): string {
    const text = this.doc.text;
    const parts: string[] = [];
    // "all-rows" で列を足したときは、各レコードの末尾に空のフィールドを足して長方形に保つ。
    const padTo =
      this.created.size > 0 && this.opts.addColumns === "all-rows" && this.baseWidth !== undefined
        ? this.baseWidth + this.created.size
        : 0;
    for (let it = this.head; it; it = it.next) {
      if (it.cells) {
        // 変更したレコードと追加したレコードは全幅まで埋める（元が短いレコードも、手を入れたついでに揃える）。
        if (padTo > 0 && !it.blank && !it.unclosed && it.cells.length < padTo) {
          while (it.cells.length < padTo) it.cells.push(emptyCell());
        }
        parts.push(it.cells.map((c) => c.raw).join(this.delim));
      } else if (it.rec) {
        parts.push(text.slice(it.rec.start, it.rec.end));
        // 手を入れていないレコードは、元の見出しの幅以上のものにだけ区切りを足す。
        // 元から短いレコードは、足した列も空として読まれるので、触らない。
        const width = it.rec.cells.length;
        if (padTo > 0 && !it.blank && !it.unclosed && width >= this.headerWidth && width < padTo) {
          parts.push(this.delim.repeat(padTo - width));
        }
      }
      parts.push(it.term);
    }
    return parts.join("");
  }
}

function applyChanges(
  original: Uint8Array,
  changes: Change[],
  ctx: FormatContext,
  defaultDelimiter: string,
): Uint8Array {
  // 変更がなければ、デコードもせずにそのまま返す（1 バイトも変えない）。
  if (changes.length === 0) return original.slice();
  const opts = resolveOptions(ctx, defaultDelimiter);
  const doc = loadDocument(original, ctx, opts);
  const editor = new Editor(doc, opts, ctx);
  for (const change of changes) {
    switch (change.type) {
      case "set":
        editor.set(change.key, change.field, change.value);
        break;
      case "rename":
        editor.rename(change.key, change.newKey);
        break;
      case "remove":
        editor.remove(change.key);
        break;
      case "add":
        editor.add(change.entry, change.after);
        break;
      default: {
        const unknown: never = change;
        throw new Error(`未対応の変更です: ${JSON.stringify(unknown)}（${ctx.resource.path}）`);
      }
    }
  }
  return encode(editor.output(), doc.bom);
}

// ---------------------------------------------------------------------------
// 新規作成
// ---------------------------------------------------------------------------

function createDocument(entries: EntryData[], ctx: FormatContext, defaultDelimiter: string): Uint8Array {
  const opts = resolveOptions(ctx, defaultDelimiter);
  const path = ctx.resource.path;
  const delim = opts.delimiter;

  type Getter = (e: EntryData) => unknown;
  const headers: string[] = [opts.key ?? "key"];
  const getters: Getter[] = [(e) => e.key];
  for (const lang of ctx.languages) {
    const header = opts.text ? opts.text[lang.id] : lang.id;
    if (header === undefined) continue;
    headers.push(header);
    getters.push((e) => e.text?.[lang.id]);
  }
  for (const [spec, header] of Object.entries(opts.columns ?? {})) {
    const { column, language } = splitColumnSpec(spec);
    headers.push(header);
    getters.push(language === undefined ? (e) => e.meta?.[column] : (e) => e.languageMeta?.[language]?.[column]);
  }
  if (opts.stableId !== undefined) {
    headers.push(opts.stableId);
    getters.push((e) => e.stableId);
  }

  const lines: string[] = [headers.map((h) => toRaw(h, delim, false)).join(delim)];
  const seen = new Set<string>();
  for (const e of entries) {
    if (typeof e.key !== "string" || e.key === "") throw new Error(`キーが空のエントリは書き出せません（${path}）。`);
    if (seen.has(e.key)) throw new Error(`キー「${e.key}」が重複しています（${path}）。`);
    seen.add(e.key);
    lines.push(getters.map((g) => toRaw(valueToString(g(e)), delim, false)).join(delim));
  }
  return encode(lines.map((l) => l + "\n").join(""), false);
}

// ---------------------------------------------------------------------------
// フォーマット
// ---------------------------------------------------------------------------

export function createDelimitedFormat(spec: DelimitedFormatSpec): Format {
  const extensions = spec.extensions.map((e) => e.toLowerCase());
  return {
    id: spec.id,
    match(resource: ResourceRef, _head: Uint8Array): boolean {
      const name = (resource.path || resource.name).toLowerCase();
      return extensions.some((ext) => name.endsWith(ext));
    },
    parse(input, ctx) {
      return parseDocument(input, ctx, spec.delimiter);
    },
    apply(original, changes, ctx) {
      return applyChanges(original, changes, ctx, spec.delimiter);
    },
    create(entries, ctx) {
      return createDocument(entries, ctx, spec.delimiter);
    },
  };
}

export const csvFormat: Format = createDelimitedFormat({ id: "builtin.csv", delimiter: ",", extensions: [".csv"] });

export const tsvFormat: Format = createDelimitedFormat({ id: "builtin.tsv", delimiter: "\t", extensions: [".tsv"] });
