/**
 * リソースをまたぐ問い合わせ: 条件に合う行を数え（リソースごと）、集計し、一覧にする。CSV / TSV への書き出しも行う。
 * 条件は rows と同じ（RowFilter）。ツリーの件数、検索結果の表示、コマンドラインの query が使う。
 */
import { cellValueText, stableStringify } from "@loc-studio/core";
import type { ColumnDef, EntryData, LanguageDef, ResourceRef } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { ExportQueryRequest, ExportQueryResponse, QueryRequest, QueryResponse, QueryRow, QueryVolume } from "./api-types.js";
import { buildCells } from "./cells.js";
import type { WsContext } from "./context.js";
import { enumOf, errorText } from "./context.js";
import type { DocState } from "./documents.js";
import { emptyNeeds, readFacts, resolveSingleField } from "./query.js";
import { matchEntries, prepareFilter, requireLanguages, valueColumns } from "./rows.js";
import type { PreparedFilter } from "./rows.js";

/** 1 回の query で返す行の上限。 */
const MAX_ROWS = 2000;
/** 1 回の書き出しの行の上限（超えたら打ち切って、truncated で知らせる）。 */
export const MAX_EXPORT_ROWS = 200_000;
const MAX_RESOURCES = 10_000;
const MAX_GROUP_FIELDS = 4;
const MAX_CELLS = 500;

type GroupField = ReturnType<typeof resolveSingleField>;

interface Plan {
  filter: PreparedFilter;
  resources: ResourceRef[];
  groupFields: GroupField[];
  groupNeeds: ReturnType<typeof emptyNeeds>;
  /** 行ごとに返すセルの ID（順に）と、その列・言語。 */
  cellIds: string[];
  cellColumns: ColumnDef[];
  cellLanguages: LanguageDef[];
  /** 原文の量を量る言語（最初の原文の言語）。 */
  sourceLanguage: LanguageDef | undefined;
}

async function plan(ctx: WsContext, req: QueryRequest): Promise<Plan> {
  if (typeof req !== "object" || req === null) throw new ApiError("invalid", "query の引数がありません。");
  const languages = requireLanguages(ctx, req.languages);
  const filter = prepareFilter(ctx, req, languages);

  let resources: ResourceRef[];
  if (req.resourceIds !== undefined) {
    if (!Array.isArray(req.resourceIds)) throw new ApiError("invalid", "resourceIds は配列で指定してください。");
    if (req.resourceIds.length > MAX_RESOURCES) throw new ApiError("invalid", `resourceIds は ${MAX_RESOURCES} 個までにしてください。`);
    resources = [];
    // 見えないリソースや、ないリソースを名指ししたら、ここで not-found になる。
    for (const id of new Set(req.resourceIds.map(String))) resources.push(await ctx.docs.resource(id));
  } else {
    resources = await ctx.docs.allResources();
  }

  const groupNeeds = emptyNeeds();
  let groupFields: GroupField[] = [];
  if (req.groupBy !== undefined) {
    if (!Array.isArray(req.groupBy)) throw new ApiError("invalid", "groupBy は欄の配列で指定してください。");
    if (req.groupBy.length > MAX_GROUP_FIELDS) throw new ApiError("invalid", `groupBy は ${MAX_GROUP_FIELDS} 個までにしてください。`);
    groupFields = req.groupBy.map((raw) => resolveSingleField(ctx, raw, languages, groupNeeds, "groupBy"));
  }

  let cellIds: string[];
  let cellColumns: ColumnDef[];
  let cellLanguages: LanguageDef[];
  if (req.cells !== undefined) {
    if (!Array.isArray(req.cells)) throw new ApiError("invalid", "cells はセルの ID の配列で指定してください。");
    if (req.cells.length > MAX_CELLS) throw new ApiError("invalid", `cells は ${MAX_CELLS} 個までにしてください。`);
    const parsed = [...new Set(req.cells.map(String))].map((id) => ({ id, ...ctx.parseCellId(id) }));
    for (const p of parsed) {
      if (p.column.kind === "actions") throw new ApiError("invalid", `列 "${p.column.id}" はアクション列で、値を持たないため、cells に書けません。`);
    }
    cellIds = parsed.map((p) => p.id);
    cellColumns = [...new Map(parsed.map((p) => [p.column.id, p.column])).values()];
    cellLanguages = [...new Map(parsed.filter((p) => p.language).map((p) => [p.language!.id, p.language!])).values()];
  } else {
    // 省略時は、対象の言語のすべての列（キーの列は、行の key と同じなので入れない）。
    cellColumns = valueColumns(ctx).filter((c) => c.kind !== "key");
    cellLanguages = languages;
    cellIds = cellColumns.flatMap((c) => (c.scope === "entry" ? [c.id] : languages.filter((l) => ctx.applies(c, l.id)).map((l) => ctx.cellId(c, l.id))));
  }
  return { filter, resources, groupFields, groupNeeds, cellIds, cellColumns, cellLanguages, sourceLanguage: ctx.project.languages.find((l) => l.basedOn === undefined) };
}

const volumeOf = (text: string): { characters: number; words: number } => ({
  characters: Array.from(text).length,
  words: text.split(/\s+/).filter((s) => s !== "").length,
});

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** 集計の区切りの値の表示名（選択式の列は選択肢の表示名）。 */
function groupLabel(field: GroupField, value: unknown): string {
  if (isEmpty(value)) return "（空）";
  const option = field.column ? enumOf(field.column)?.enum.find((o) => o.value === value) : undefined;
  if (option) return option.label ?? option.value;
  return Array.isArray(value) ? value.map((v) => cellValueText(v)).join(", ") : cellValueText(value);
}

/** 集計の並び順: 選択式の列は選択肢の順、issues は重さの順、そのほかは値の順。空は最後。 */
function groupOrder(field: GroupField): (a: unknown, b: unknown) => number {
  const options = field.column ? enumOf(field.column)?.enum.map((o) => o.value) : field.kind === "issues" ? ["none", "info", "warning", "error"] : undefined;
  return (a, b) => {
    const ea = isEmpty(a);
    const eb = isEmpty(b);
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    if (options) {
      const ia = options.indexOf(String(a));
      const ib = options.indexOf(String(b));
      if (ia >= 0 && ib >= 0) return ia - ib;
    }
    if (typeof a === "number" && typeof b === "number") return a - b;
    return cellValueText(a).localeCompare(cellValueText(b), undefined, { numeric: true });
  };
}

async function run(ctx: WsContext, p: Plan, offset: number, limit: number): Promise<QueryResponse> {
  const matched: QueryVolume = { rows: 0, characters: 0, words: 0 };
  const result: QueryResponse = { matched, totalRows: 0, resources: [], unreadable: [], rows: [] };
  const groups = new Map<string, QueryVolume & { values: unknown[] }>();
  let seen = 0;

  for (const resource of p.resources) {
    let doc: DocState;
    try {
      doc = await ctx.docs.get(resource.id);
    } catch (err) {
      // 読めないリソースがあっても、ほかのリソースは続ける（どれが読めなかったかは返す）。
      result.unreadable.push({ resourceId: resource.id, path: resource.path, error: errorText(err) });
      continue;
    }
    const entries: EntryData[] = await matchEntries(ctx, doc, p.filter);
    result.totalRows += doc.entries.length;
    result.resources.push({ resourceId: resource.id, path: resource.path, matched: entries.length, total: doc.entries.length });
    if (entries.length === 0) continue;

    const volumes = entries.map((data) => volumeOf(p.sourceLanguage ? (ctx.effectiveText(resource.id, data, p.sourceLanguage.id) ?? "") : ""));
    matched.rows += entries.length;
    for (const v of volumes) {
      matched.characters += v.characters;
      matched.words += v.words;
    }

    if (p.groupFields.length > 0) {
      const facts = await readFacts(ctx, doc, entries, p.groupNeeds);
      facts.forEach((row, i) => {
        // 空の値（未設定、空文字）は、null の 1 つの組にまとめる。
        const values = p.groupFields.map((f) => {
          const v = f.read(row);
          return isEmpty(v) ? null : v;
        });
        const key = stableStringify(values);
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { values, rows: 0, characters: 0, words: 0 }));
        g.rows++;
        g.characters += volumes[i]!.characters;
        g.words += volumes[i]!.words;
      });
    }

    // 返す行: 全体の並び（リソースの順、その中の行の順）の offset から limit 個。
    const from = Math.max(0, offset - seen);
    const to = Math.min(entries.length, offset + limit - seen);
    if (from < to) {
      const page = entries.slice(from, to);
      const cells = await buildCells(ctx, doc, page, { columns: p.cellColumns, languages: p.cellLanguages, issues: true });
      page.forEach((data, i) => {
        const row: QueryRow = { resourceId: resource.id, path: resource.path, key: data.key, cells: {} };
        for (const id of p.cellIds) {
          const cell = cells[i]![id];
          if (cell) row.cells[id] = cell;
        }
        result.rows.push(row);
      });
    }
    seen += entries.length;
  }

  if (p.groupFields.length > 0) {
    const orders = p.groupFields.map(groupOrder);
    result.groups = [...groups.values()]
      .sort((a, b) => {
        for (let i = 0; i < orders.length; i++) {
          const c = orders[i]!(a.values[i], b.values[i]);
          if (c !== 0) return c;
        }
        return 0;
      })
      .map((g) => ({ ...g, labels: g.values.map((v, i) => groupLabel(p.groupFields[i]!, v)) }));
  }
  return result;
}

const toCount = (value: unknown, fallback: number): number => (value === undefined ? fallback : Math.max(0, Math.floor(Number(value)) || 0));

export async function query(ctx: WsContext, req: QueryRequest): Promise<QueryResponse> {
  const p = await plan(ctx, req);
  return run(ctx, p, toCount(req.offset, 0), Math.min(MAX_ROWS, toCount(req.limit, 0)));
}

/** 表を、区切り文字の文字列にする。区切り文字、引用符、改行を含む値と、前後に空白のある値は、引用符で囲む。行の終わりは CRLF。 */
export function toDelimited(table: string[][], delimiter: string): string {
  const cell = (value: string): string =>
    value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return table.map((row) => `${row.map(cell).join(delimiter)}\r\n`).join("");
}

export async function exportQuery(ctx: WsContext, req: ExportQueryRequest): Promise<ExportQueryResponse> {
  if (req?.format !== "csv" && req?.format !== "tsv") throw new ApiError("invalid", `format は "csv" か "tsv" にしてください（"${String(req?.format)}"）。`);
  const table = req.table ?? "rows";
  if (table !== "rows" && table !== "groups") throw new ApiError("invalid", `table は "rows" か "groups" にしてください（"${String(table)}"）。`);
  const delimiter = req.format === "csv" ? "," : "\t";
  const p = await plan(ctx, req);
  if (table === "groups") {
    if (p.groupFields.length === 0) throw new ApiError("invalid", '集計を書き出すには、groupBy に区切りの欄を指定してください（例: ["textStatus@ja"]）。');
    const r = await run(ctx, p, 0, 0);
    const lines = (r.groups ?? []).map((g) => [...g.values.map((v) => (Array.isArray(v) ? v.join(" ") : cellValueText(v))), String(g.rows), String(g.characters), String(g.words)]);
    return { text: toDelimited([[...p.groupFields.map((f) => f.raw), "rows", "characters", "words"], ...lines], delimiter), rows: lines.length, truncated: false };
  }
  const r = await run(ctx, p, 0, MAX_EXPORT_ROWS);
  const lines = r.rows.map((row) => [row.path, row.key, ...p.cellIds.map((id) => cellValueText(row.cells[id]?.value))]);
  return { text: toDelimited([["resource", "key", ...p.cellIds], ...lines], delimiter), rows: lines.length, truncated: r.matched.rows > lines.length };
}
