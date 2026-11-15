/**
 * 表の読み出し: rows / rowDetail / stats / tree。
 */
import { severityAtLeast } from "@loc-studio/core";
import { cellValueText, stableStringify } from "@loc-studio/core";
import type { ColumnDef, EntryData, LanguageDef, TreeNode } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { ProgressCount, ResourceStats, RowInfo, RowsRequest, RowsResponse, TreeNodeInfo } from "./api-types.js";
import { buildCells, metaIssuesOf } from "./cells.js";
import type { WsContext } from "./context.js";
import { enumOf } from "./context.js";
import { lowerOf } from "./documents.js";
import type { DocState } from "./documents.js";
import { issueKey, validateEntries } from "./issues.js";
import { hasResourceScope } from "./permissions.js";

/** 1 回の rows で返す行の上限。 */
const MAX_LIMIT = 2000;
/** 絞り込みの条件の数の上限。 */
const MAX_FILTERS = 50;
/** stats で一度に求めるリソースの数の上限。 */
const MAX_STATS_RESOURCES = 500;

/** 表に出す列（アクション列は値を持たないので除く）。 */
const valueColumns = (ctx: WsContext): ColumnDef[] => ctx.columns().filter((c) => c.kind !== "actions");

function requireLanguages(ctx: WsContext, ids: unknown): LanguageDef[] {
  if (!Array.isArray(ids)) throw new ApiError("invalid", "languages は言語 ID の配列で指定してください。");
  // 同じ言語を何度も並べて仕事を増やせないよう、重複を除く。
  return [...new Set(ids.map((id) => String(id)))].map((id) => ctx.requireLanguage(id));
}

const sameValue = (a: unknown, b: unknown): boolean => a === b || stableStringify(a ?? null) === stableStringify(b ?? null);

export async function rows(ctx: WsContext, req: RowsRequest): Promise<RowsResponse> {
  if (typeof req !== "object" || req === null) throw new ApiError("invalid", "rows の引数がありません。");
  const languages = requireLanguages(ctx, req.languages);
  const offset = Math.max(0, Math.floor(Number(req.offset ?? 0)) || 0);
  const limit = Math.min(MAX_LIMIT, Math.max(0, Math.floor(Number(req.limit ?? 100)) || 0));
  const doc = await ctx.docs.get(req.resourceId);
  const rid = doc.resource.id;
  const langIds = languages.map((l) => l.id);
  const textCol = ctx.textColumn();
  const textLangs = textCol ? langIds.filter((l) => ctx.applies(textCol, l)) : [];

  let candidates: EntryData[] = doc.entries;

  const q = typeof req.search === "string" ? req.search.trim().toLowerCase() : "";
  if (q !== "") {
    const lower = lowerOf(doc, textLangs);
    const drafts = ctx.drafts.mapOf(rid);
    const out: EntryData[] = [];
    doc.entries.forEach((data, i) => {
      if (lower.keys[i]!.includes(q)) return void out.push(data);
      for (const lang of textLangs) {
        const d = drafts?.get(`${data.key}\u0000${lang}`);
        const t = d ? d.value.toLowerCase() : lower.texts.get(lang)![i]!;
        if (t.includes(q)) return void out.push(data);
      }
    });
    candidates = out;
  }

  if (req.onlyUnsaved) {
    const drafts = ctx.drafts.mapOf(rid);
    if (!drafts) candidates = [];
    else {
      const keys = new Set([...drafts.values()].map((d) => d.key));
      candidates = candidates.filter((e) => keys.has(e.key));
    }
  }

  if (req.onlyUntranslated) {
    candidates = candidates.filter((e) => textLangs.some((l) => (ctx.effectiveText(rid, e, l) ?? "") === ""));
  }

  if (req.filters !== undefined) {
    if (!Array.isArray(req.filters)) throw new ApiError("invalid", "filters は配列で指定してください。");
    if (req.filters.length > MAX_FILTERS) throw new ApiError("invalid", `filters は ${MAX_FILTERS} 個までにしてください。`);
    const parsed = req.filters.map((f) => {
      const where = `絞り込み "${String(f?.cellId)}"`;
      if (f?.values !== undefined && !Array.isArray(f.values)) throw new ApiError("invalid", `${where} の values は配列で指定してください。`);
      if (f?.contains !== undefined && typeof f.contains !== "string") throw new ApiError("invalid", `${where} の contains は文字列で指定してください。`);
      if (f?.values === undefined && f?.contains === undefined) throw new ApiError("invalid", `${where} には values か contains を指定してください。`);
      return { ...ctx.parseCellId(f.cellId), cellId: f.cellId, values: f.values, contains: f.contains?.toLowerCase() };
    });
    if (parsed.length > 0 && candidates.length > 0) {
      const cols = [...new Map(parsed.map((p) => [p.column.id, p.column])).values()];
      const langs = [...new Map(parsed.filter((p) => p.language).map((p) => [p.language!.id, p.language!])).values()];
      const cells = await buildCells(ctx, doc, candidates, { columns: cols, languages: langs, issues: false });
      candidates = candidates.filter((_, i) =>
        parsed.every((p) => {
          const v = cells[i]![p.cellId]?.value;
          if (p.values !== undefined && !p.values.some((want) => sameValue(want, v))) return false;
          return p.contains === undefined || cellValueText(v).toLowerCase().includes(p.contains);
        }),
      );
    }
  }

  if (req.onlyIssues !== undefined && candidates.length > 0) {
    const threshold = req.onlyIssues;
    if (threshold !== "error" && threshold !== "warning" && threshold !== "info") {
      throw new ApiError("invalid", `onlyIssues は "error" / "warning" / "info" のどれかにしてください（"${String(threshold)}"）。`);
    }
    const textLangDefs = languages.filter((l) => textLangs.includes(l.id));
    const found = await validateEntries(ctx, doc, candidates, textLangDefs);
    // 本文以外の列の問題（表示中の言語の列と、行に 1 つの列）も数える。
    const meta = await metaIssuesOf(ctx, doc, candidates, languages);
    const heavy = (list: { severity: "error" | "warning" | "info" }[] | undefined): boolean => list?.some((iss) => severityAtLeast(iss.severity, threshold)) ?? false;
    candidates = candidates.filter(
      (e) => textLangs.some((l) => heavy(found.get(issueKey(e.key, l)))) || [...(meta.get(e.key)?.values() ?? [])].some(heavy),
    );
  }

  if (req.onlyStale && candidates.length > 0) {
    const cols = ctx.columns().filter((c) => c.kind === "text" || c.kind === "review" || c.kind === "generated" || c.basis === "text");
    const cells = await buildCells(ctx, doc, candidates, { columns: cols, languages, issues: false });
    candidates = candidates.filter((_, i) => Object.values(cells[i]!).some((c) => c.stale || c.needsRecheck));
  }

  if (req.sort !== undefined) candidates = await sortEntries(ctx, doc, candidates, req.sort);

  const page = candidates.slice(offset, offset + limit);
  const pageCells = await buildCells(ctx, doc, page, { columns: valueColumns(ctx), languages, issues: true });
  const result: RowsResponse = {
    total: candidates.length,
    totalAll: doc.entries.length,
    rows: page.map((data, i) => rowInfo(doc, data, pageCells[i]!)),
    diagnostics: doc.diagnostics,
  };
  if (doc.revision !== undefined) result.revision = doc.revision;
  return result;
}

const isEmptyValue = (v: unknown): boolean => v === undefined || v === null || v === "";

/** 列の値の順に並べる（値のない行は最後。同じ値の行は、渡された順のまま）。 */
async function sortEntries(ctx: WsContext, doc: DocState, entries: EntryData[], sort: NonNullable<RowsRequest["sort"]>): Promise<EntryData[]> {
  if (typeof sort !== "object" || sort === null) throw new ApiError("invalid", "sort は { cellId, dir? } の形で指定してください。");
  const dir = sort.dir ?? "asc";
  if (dir !== "asc" && dir !== "desc") throw new ApiError("invalid", `sort.dir は "asc" か "desc" にしてください（"${String(dir)}"）。`);
  const { column, language } = ctx.parseCellId(sort.cellId);
  if (column.kind === "actions") throw new ApiError("invalid", `列 "${column.id}" はアクション列で、値を持たないため、並べ替えに使えません。`);
  if (entries.length < 2) return entries;
  const cells = await buildCells(ctx, doc, entries, { columns: [column], languages: language ? [language] : [], issues: false });
  // 選択式の列は、選択肢の並び順（設定に書いた順）で比べる。
  const order = new Map((enumOf(column)?.enum ?? []).map((o, i) => [o.value, i] as const));
  const keyOf = (v: unknown): unknown => (typeof v === "string" && order.has(v) ? order.get(v) : v);
  const compare = (a: unknown, b: unknown): number => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
    return cellValueText(a).localeCompare(cellValueText(b), undefined, { numeric: true });
  };
  const sign = dir === "asc" ? 1 : -1;
  return entries
    .map((entry, i) => ({ entry, i, value: cells[i]![sort.cellId]?.value }))
    .sort((a, b) => {
      const ea = isEmptyValue(a.value);
      const eb = isEmptyValue(b.value);
      if (ea || eb) return ea === eb ? a.i - b.i : ea ? 1 : -1;
      return sign * compare(keyOf(a.value), keyOf(b.value)) || a.i - b.i;
    })
    .map((x) => x.entry);
}

function rowInfo(doc: DocState, data: EntryData, cells: RowInfo["cells"]): RowInfo {
  const row: RowInfo = { key: data.key, index: doc.index.get(data.key) ?? -1, cells };
  if (data.location?.line !== undefined) row.line = data.location.line;
  if (data.stableId !== undefined) row.stableId = data.stableId;
  return row;
}

export async function rowDetail(
  ctx: WsContext,
  params: { resourceId: string; key: string },
): Promise<{ row: RowInfo; languages: string[] }> {
  const doc = await ctx.docs.get(params.resourceId);
  const data = ctx.entryOf(doc, params.key);
  const languages = ctx.project.languages;
  const [cells] = await buildCells(ctx, doc, [data], { columns: valueColumns(ctx), languages, issues: true });
  return { row: rowInfo(doc, data, cells!), languages: languages.map((l) => l.id) };
}

// ---------------------------------------------------------------------------
// 統計
// ---------------------------------------------------------------------------

const statsCache = new WeakMap<WsContext, Map<string, { key: string; stats: ResourceStats }>>();

export async function stats(ctx: WsContext, params: { resourceIds: string[] }): Promise<ResourceStats[]> {
  if (!Array.isArray(params?.resourceIds)) throw new ApiError("invalid", "resourceIds は配列で指定してください。");
  let cache = statsCache.get(ctx);
  if (!cache) {
    cache = new Map();
    statsCache.set(ctx, cache);
  }
  const changeSeq = await ctx.shared.changeSeq();
  const out: ResourceStats[] = [];
  const ids = [...new Set(params.resourceIds.map(String))];
  if (ids.length > MAX_STATS_RESOURCES) throw new ApiError("invalid", `resourceIds は ${MAX_STATS_RESOURCES} 個までにしてください。`);
  for (const id of ids) {
    const doc = await ctx.docs.get(id);
    const key = `${doc.version}:${ctx.drafts.version(id)}:${changeSeq}:${ctx.sourceSeq}:${ctx.configGen}`;
    const hit = cache.get(id);
    if (hit && hit.key === key) {
      out.push(hit.stats);
      continue;
    }
    const s = await computeStats(ctx, doc);
    cache.set(id, { key, stats: s });
    out.push(s);
  }
  return out;
}

async function computeStats(ctx: WsContext, doc: DocState): Promise<ResourceStats> {
  const languages = ctx.project.languages;
  const enumCols = ctx.columns().filter((c) => enumOf(c) !== undefined && (c.kind === "meta" || c.kind === "review"));
  const progress: Record<string, Record<string, ProgressCount>> = {};
  // 進捗の重み。行数なら 1 行 1、文字数・語数なら、その行の原文の量。
  const unit = ctx.progressUnit();
  // 原文: その言語の基になる言語。原文の言語自身は、その言語の本文。行に 1 つの列は、最初の原文の言語の本文。
  const firstSource = languages.find((l) => l.basedOn === undefined)?.id;
  const sourceOf = (lang: string | undefined): string | undefined => (lang !== undefined ? (ctx.language(lang)?.basedOn ?? lang) : firstSource);
  const weightCache = new Map<string, number[]>();
  const weightsOf = (lang: string | undefined): number[] => {
    const source = unit === "rows" ? undefined : sourceOf(lang);
    const key = source ?? "";
    let w = weightCache.get(key);
    if (!w) {
      w = doc.entries.map((data) => {
        if (source === undefined) return 1;
        const text = ctx.effectiveText(doc.resource.id, data, source) ?? "";
        return unit === "characters" ? Array.from(text).length : text.split(/\s+/).filter((s) => s !== "").length;
      });
      weightCache.set(key, w);
    }
    return w;
  };
  if (enumCols.length > 0 && doc.entries.length > 0) {
    const cells = await buildCells(ctx, doc, doc.entries, { columns: enumCols, languages, issues: false });
    for (const column of enumCols) {
      const complete = new Set(enumOf(column)!.enum.filter((o) => o.complete).map((o) => o.value));
      const perLang: Record<string, ProgressCount> = {};
      const langs = column.scope === "entry" ? [undefined] : languages.map((l) => l.id).filter((l) => ctx.applies(column, l));
      for (const lang of langs) {
        const id = ctx.cellId(column, lang);
        const weights = weightsOf(lang);
        let done = 0;
        let total = 0;
        cells.forEach((row, i) => {
          const weight = weights[i]!;
          total += weight;
          const c = row[id];
          if (c && !c.stale && typeof c.value === "string" && complete.has(c.value)) done += weight;
        });
        perLang[lang ?? "*"] = { complete: done, total };
      }
      progress[column.id] = perLang;
    }
  } else {
    for (const column of enumCols) progress[column.id] = {};
  }
  const issues = { error: 0, warning: 0, info: 0 };
  const found = await validateEntries(ctx, doc, doc.entries, languages);
  for (const list of found.values()) for (const iss of list) issues[iss.severity]++;
  for (const cells of (await metaIssuesOf(ctx, doc, doc.entries, languages)).values()) {
    for (const list of cells.values()) for (const iss of list) issues[iss.severity]++;
  }
  return { resourceId: doc.resource.id, entries: doc.entries.length, unsaved: ctx.drafts.count(doc.resource.id), progress, issues };
}

// ---------------------------------------------------------------------------
// ツリー
// ---------------------------------------------------------------------------

export async function tree(ctx: WsContext): Promise<TreeNodeInfo[]> {
  const nodes = await ctx.docs.refreshTree();
  // 役割の resources で見えないリソースと、見えるものが 1 つもないフォルダは出さない。
  const visible = (n: TreeNode): boolean =>
    n.kind === "resource" ? n.resource !== undefined && ctx.docs.visible(n.resource) : (n.children ?? []).some(visible);
  const scoped = hasResourceScope();
  const convert = (n: TreeNode): TreeNodeInfo => {
    const info: TreeNodeInfo = { id: n.id, name: n.name, kind: n.kind };
    let unsaved = 0;
    if (n.resource) {
      info.resource = n.resource;
      unsaved += ctx.drafts.count(n.resource.id);
    }
    if (n.children) {
      info.children = (scoped ? n.children.filter(visible) : n.children).map(convert);
      for (const c of info.children) unsaved += c.unsaved ?? 0;
    }
    if (unsaved > 0) info.unsaved = unsaved;
    return info;
  };
  return (scoped ? nodes.filter(visible) : nodes).map(convert);
}
