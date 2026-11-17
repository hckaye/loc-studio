/**
 * セルの値の読み出し: 列ソースの値をページ単位でまとめて読み、本文・ドラフト・生成結果・
 * 変更あり（stale）・要再確認（needsRecheck）・バリデーションの結果を CellInfo にまとめる。
 */
import type { CellRef, CellValue, ColumnDef, ComputeContext, EntryData, GeneratorInput, LanguageDef, LanguageId, RowReader } from "@loc-studio/sdk";
import type { CellInfo, IssueInfo } from "./api-types.js";
import type { WsContext } from "./context.js";
import { defaultValue, errorText, GENERATED_CELLS_NS, GENERATED_NS, isFileColumn, TEXT_BASIS_NS } from "./context.js";
import type { DocState } from "./documents.js";
import { generatorCacheKey, textHash, valueHash } from "./hash.js";
import { basicRowReader, issueKey, validatedColumns, validateEntries, validateMetaCells } from "./issues.js";
import type { IssuesByEntry } from "./issues.js";

/** 行の中のセルを表すキー。 */
export const rowCellKey = (key: string, cellId: string): string => `${key}\u0000${cellId}`;

/** 生成列のセルごとの記録（cells("core.generated-cells") の値）。 */
export interface GeneratedCellRecord {
  key: string;
  inputHash: string;
}

/** 生成結果（kv("core.generated") の値）。 */
export interface GeneratedValue {
  value: string;
  /** 生成器が値に添えた説明（判定の理由など）。 */
  comment?: string;
  meta?: Record<string, unknown>;
  generatorId: string;
  at: string;
}

export type ColumnValues = Map<string, CellValue>;

/** その列がその言語集合で持つセルの言語（entry スコープは [undefined]）。 */
export function cellLanguages(ctx: WsContext, column: ColumnDef, languages: LanguageId[]): (LanguageId | undefined)[] {
  if (column.scope === "entry") return [undefined];
  return languages.filter((l) => ctx.applies(column, l));
}

/**
 * 列ソースの値を、列ソースごとに 1 回の呼び出しで読む。
 * 戻り値のキーは rowCellKey(key, cellId)。
 */
export async function loadSourceValues(
  ctx: WsContext,
  resourceId: string,
  keys: string[],
  specs: { column: ColumnDef; languages: (LanguageId | undefined)[] }[],
): Promise<ColumnValues> {
  const groups = new Map<string, { refs: CellRef[]; resolved: NonNullable<ReturnType<WsContext["columnSource"]>> }>();
  for (const { column, languages } of specs) {
    const resolved = ctx.columnSource(column);
    if (!resolved) continue;
    let g = groups.get(resolved.name);
    if (!g) {
      g = { refs: [], resolved };
      groups.set(resolved.name, g);
    }
    for (const key of keys) for (const lang of languages) g.refs.push(ctx.cellRef(resourceId, key, column, lang));
  }
  const out: ColumnValues = new Map();
  await Promise.all(
    [...groups.values()].map(async ({ refs, resolved }) => {
      if (refs.length === 0) return;
      let values: CellValue[];
      try {
        values = await resolved.source.load(refs, ctx.project.sourceContext(resolved));
      } catch (err) {
        throw new Error(`列ソース "${resolved.name}"（${resolved.source.id}）から値を読めませんでした（リソース ${resourceId}）: ${errorText(err)}`);
      }
      for (const v of values) {
        const column = ctx.column(v.columnId);
        if (!column) continue;
        out.set(rowCellKey(v.entryKey, ctx.cellId(column, v.language)), v);
      }
    }),
  );
  return out;
}

/** ページで読んだ値も返す RowReader。 */
export function pageRowReader(ctx: WsContext, doc: DocState, data: EntryData, values: ColumnValues): RowReader {
  return basicRowReader(ctx, doc, data, (columnId, language) => {
    const column = ctx.column(columnId);
    if (!column) return undefined;
    return values.get(rowCellKey(data.key, ctx.cellId(column, language)))?.value;
  });
}

/** 列の値（本文はドラフト込み、未設定は既定値）。 */
export function currentValue(
  ctx: WsContext,
  doc: DocState,
  data: EntryData,
  column: ColumnDef,
  language: LanguageId | undefined,
  values: ColumnValues,
): unknown {
  const rid = doc.resource.id;
  switch (column.kind) {
    case "key":
      return data.key;
    case "text":
      return language === undefined ? undefined : (ctx.effectiveText(rid, data, language) ?? "");
    default:
      if (isFileColumn(column)) {
        const v = language === undefined ? data.meta?.[column.id] : data.languageMeta?.[language]?.[column.id];
        return v === undefined ? defaultValue(column) : v;
      }
      {
        const v = values.get(rowCellKey(data.key, ctx.cellId(column, language)));
        return v === undefined ? defaultValue(column) : v.value;
      }
  }
}

/** レビュー列や basis: "text" の列にとっての「対象のいまの値の版」。対象がなければ undefined。 */
export function targetHash(
  ctx: WsContext,
  doc: DocState,
  data: EntryData,
  column: ColumnDef,
  language: LanguageId | undefined,
  values: ColumnValues,
): string | undefined {
  if (column.kind === "review") {
    const target = column.of !== undefined ? ctx.column(column.of) : undefined;
    if (!target) return undefined;
    const tlang = target.scope === "language" ? language : undefined;
    if (target.scope === "language" && tlang === undefined) return undefined;
    if (target.kind === "text") return textHash(ctx.effectiveText(doc.resource.id, data, tlang!) ?? "");
    return valueHash(currentValue(ctx, doc, data, target, tlang, values));
  }
  if (column.basis === "text" && language !== undefined) {
    return textHash(ctx.effectiveText(doc.resource.id, data, language) ?? "");
  }
  return undefined;
}

/** レビュー列の対象（列ソースの列なら読む必要がある）。 */
function reviewTargetSpec(ctx: WsContext, column: ColumnDef, languages: (LanguageId | undefined)[]) {
  if (column.kind !== "review" || column.of === undefined) return undefined;
  const target = ctx.column(column.of);
  if (!target || !ctx.columnSource(target)) return undefined;
  return { column: target, languages: target.scope === "language" ? languages : [undefined] };
}

interface GenState {
  value?: unknown;
  comment?: string;
  state?: "fresh" | "stale" | "missing";
}

/** 生成列のセルの状態をまとめて求める。 */
async function loadGenerated(
  ctx: WsContext,
  doc: DocState,
  entries: EntryData[],
  column: ColumnDef,
  languages: (LanguageId | undefined)[],
  values: ColumnValues,
): Promise<Map<string, GenState>> {
  const out = new Map<string, GenState>();
  const spec = ctx.generatorFor(column);
  if (!spec) return out;
  const { generator, options } = spec;
  const rid = doc.resource.id;
  let params: unknown;
  try {
    params = generator.cacheParams(options);
  } catch (err) {
    ctx.warn(`生成器 "${generator.id}" の cacheParams が失敗しました: ${errorText(err)}`);
    return out;
  }
  const cells: { k: string; ref: CellRef; key?: string }[] = [];
  let inputError: string | undefined;
  for (const data of entries) {
    let row: RowReader | undefined;
    for (const lang of languages) {
      row ??= pageRowReader(ctx, doc, data, values);
      const language = lang !== undefined ? ctx.language(lang) : undefined;
      let input: GeneratorInput | null = null;
      try {
        input = generator.input({ entry: ctx.toEntry(doc, data), column, ...(language ? { language } : {}), row, options });
      } catch (err) {
        inputError ??= errorText(err);
      }
      const c: { k: string; ref: CellRef; key?: string } = {
        k: rowCellKey(data.key, ctx.cellId(column, lang)),
        ref: ctx.cellRef(rid, data.key, column, lang),
      };
      if (input) c.key = generatorCacheKey(generator.id, generator.version, params, input);
      cells.push(c);
    }
  }
  if (inputError !== undefined) ctx.warn(`生成器 "${generator.id}" の input が失敗しました: ${inputError}`);
  if (cells.length === 0) return out;

  const records = await ctx.shared.cells(GENERATED_CELLS_NS).get(cells.map((c) => c.ref));
  const recordOf = new Map<string, GeneratedCellRecord>();
  for (const r of records) {
    const rec = r.value as GeneratedCellRecord | null;
    if (rec && typeof rec.key === "string") recordOf.set(rowCellKey(r.entryKey, ctx.cellId(column, r.language)), rec);
  }
  const kvKeys = new Set<string>();
  for (const c of cells) {
    if (c.key) kvKeys.add(c.key);
    const rec = recordOf.get(c.k);
    if (rec) kvKeys.add(rec.key);
  }
  const cached = kvKeys.size > 0 ? await ctx.shared.kv(GENERATED_NS).getMany([...kvKeys]) : {};
  const at = (key: string, state: "fresh" | "stale"): GenState => {
    const hit = cached[key] as GeneratedValue | undefined;
    const g: GenState = { value: hit?.value, state };
    if (typeof hit?.comment === "string" && hit.comment !== "") g.comment = hit.comment;
    return g;
  };
  for (const c of cells) {
    const rec = recordOf.get(c.k);
    if (c.key === undefined) {
      // 生成しないセル（入力がない）。前に生成した結果があれば古いものとして見せる。
      if (rec && rec.key in cached) out.set(c.k, at(rec.key, "stale"));
      continue;
    }
    if (c.key in cached) out.set(c.k, at(c.key, "fresh"));
    else if (rec && rec.key in cached) out.set(c.k, at(rec.key, "stale"));
    else out.set(c.k, { state: "missing" });
  }
  return out;
}

export interface BuildSpec {
  /** 返す列。 */
  columns: ColumnDef[];
  languages: LanguageDef[];
  /** 本文のセルにバリデーションの結果を付けるか。 */
  issues: boolean;
}

/** 行ごとのセル（entries と同じ順）。 */
export async function buildCells(
  ctx: WsContext,
  doc: DocState,
  entries: EntryData[],
  spec: BuildSpec,
): Promise<Record<string, CellInfo>[]> {
  const rid = doc.resource.id;
  const langIds = spec.languages.map((l) => l.id);
  const keys = entries.map((e) => e.key);
  const columns = spec.columns.filter((c) => c.kind !== "actions");
  const colLangs = new Map(columns.map((c) => [c.id, cellLanguages(ctx, c, langIds)]));

  // 列ソースから読む列（レビュー列の対象も含む）。
  const loadSpecs = new Map<string, { column: ColumnDef; languages: Set<LanguageId | undefined> }>();
  const addLoad = (column: ColumnDef, langs: (LanguageId | undefined)[]): void => {
    let s = loadSpecs.get(column.id);
    if (!s) {
      s = { column, languages: new Set() };
      loadSpecs.set(column.id, s);
    }
    for (const l of langs) s.languages.add(l);
  };
  for (const column of columns) {
    const langs = colLangs.get(column.id)!;
    if (ctx.columnSource(column)) addLoad(column, langs);
    const t = reviewTargetSpec(ctx, column, langs);
    if (t) addLoad(t.column, t.languages);
  }
  const values =
    loadSpecs.size > 0 && entries.length > 0
      ? await loadSourceValues(
          ctx,
          rid,
          keys,
          [...loadSpecs.values()].map((s) => ({ column: s.column, languages: [...s.languages] })),
        )
      : new Map<string, CellValue>();

  // 生成列。
  const generated = new Map<string, Map<string, GenState>>();
  for (const column of columns) {
    if (column.kind === "generated") {
      generated.set(column.id, await loadGenerated(ctx, doc, entries, column, colLangs.get(column.id)!, values));
    }
  }

  // 要再確認: 訳文を保存したときの、基になる言語の本文の版。
  const textCol = columns.find((c) => c.kind === "text");
  const basis = new Map<string, string>();
  if (textCol && ctx.recheckEnabled()) {
    const translated = colLangs.get(textCol.id)!.filter((l) => l !== undefined && ctx.language(l)?.basedOn !== undefined);
    if (translated.length > 0 && entries.length > 0) {
      const refs: CellRef[] = [];
      for (const key of keys) for (const l of translated) refs.push(ctx.cellRef(rid, key, textCol, l));
      for (const r of await ctx.shared.cells(TEXT_BASIS_NS).get(refs)) {
        if (typeof r.value === "string") basis.set(rowCellKey(r.entryKey, ctx.cellId(textCol, r.language)), r.value);
      }
    }
  }

  const issues: Map<string, IssueInfo[]> | undefined =
    spec.issues && textCol ? await validateEntries(ctx, doc, entries, spec.languages) : undefined;
  // 本文以外の列の検証結果（対象の列が、返す列の中にあるときだけ）。
  let metaIssues: IssuesByEntry | undefined;
  if (spec.issues) {
    const shown = new Set(columns.map((c) => c.id));
    const metaCols = (await validatedColumns(ctx, doc)).filter((c) => shown.has(c.id));
    if (metaCols.length > 0) {
      metaIssues = await validateMetaCells(
        ctx,
        doc,
        entries,
        spec.languages,
        metaCols,
        (data, column, language) => currentValue(ctx, doc, data, column, language, values),
        (data) => pageRowReader(ctx, doc, data, values),
      );
    }
  }

  const baseHashCache = new Map<string, string>();
  const savedBaseHash = (data: EntryData, lang: LanguageId): string => {
    const k = issueKey(data.key, lang);
    let h = baseHashCache.get(k);
    if (h === undefined) {
      h = textHash(data.text[lang] ?? "");
      baseHashCache.set(k, h);
    }
    return h;
  };

  return entries.map((data) => {
    const cells: Record<string, CellInfo> = {};
    for (const column of columns) {
      for (const lang of colLangs.get(column.id)!) {
        const id = ctx.cellId(column, lang);
        const k = rowCellKey(data.key, id);
        let cell: CellInfo;
        if (column.kind === "key") {
          cell = { value: data.key };
        } else if (column.kind === "text") {
          const l = lang!;
          const saved = data.text[l] ?? "";
          const draft = ctx.drafts.get(rid, data.key, l);
          cell = draft ? { value: draft.value, saved, draft: true } : { value: saved };
          if (draft?.by !== undefined) cell.draftBy = draft.by;
          const rec = basis.get(k);
          const baseLang = ctx.language(l)?.basedOn;
          if (rec !== undefined && baseLang !== undefined && rec !== savedBaseHash(data, baseLang)) cell.needsRecheck = true;
          const found = issues?.get(issueKey(data.key, l));
          if (found) cell.issues = found;
        } else if (column.kind === "generated") {
          const g = generated.get(column.id)?.get(k);
          cell = { value: g?.value };
          if (g?.comment !== undefined) cell.comment = g.comment;
          if (g?.state) {
            cell.generated = g.state;
            if (g.state === "stale") cell.stale = true;
          }
        } else if (column.kind === "computed") {
          cell = computeCell(ctx, doc, data, column, lang, values);
        } else if (isFileColumn(column)) {
          cell = { value: currentValue(ctx, doc, data, column, lang, values) };
        } else if (ctx.columnSource(column)) {
          const v = values.get(k);
          if (v) {
            cell = { value: v.value };
            if (v.version !== undefined) cell.version = v.version;
            if (v.updatedAt !== undefined) cell.updatedAt = v.updatedAt;
            if (v.updatedBy !== undefined) cell.updatedBy = v.updatedBy;
            if (typeof v.comment === "string" && v.comment !== "") cell.comment = v.comment;
            if (v.basisHash !== undefined) {
              cell.basisHash = v.basisHash;
              const current = targetHash(ctx, doc, data, column, lang, values);
              if (current !== undefined && current !== v.basisHash) cell.stale = true;
            }
          } else {
            cell = { value: defaultValue(column) };
          }
        } else {
          cell = { value: defaultValue(column) };
        }
        if (column.kind !== "text") {
          const found = metaIssues?.get(data.key)?.get(id);
          if (found) cell.issues = found;
        }
        cells[id] = cell;
      }
    }
    return cells;
  });
}

/**
 * 本文以外の列の検証結果（列ソースの値を読んで確かめる）。検証の対象の列がなければ、何も読まずに空を返す。
 * 表示用の buildCells を通さない読み出し（絞り込み、統計、一括の検証）が使う。
 */
export async function metaIssuesOf(ctx: WsContext, doc: DocState, entries: EntryData[], languages: LanguageDef[]): Promise<IssuesByEntry> {
  const columns = await validatedColumns(ctx, doc);
  if (columns.length === 0 || entries.length === 0) return new Map();
  const langIds = languages.map((l) => l.id);
  const specs = columns.filter((c) => ctx.columnSource(c)).map((c) => ({ column: c, languages: cellLanguages(ctx, c, langIds) }));
  const values = specs.length > 0 ? await loadSourceValues(ctx, doc.resource.id, entries.map((e) => e.key), specs) : new Map<string, CellValue>();
  return validateMetaCells(
    ctx,
    doc,
    entries,
    languages,
    columns,
    (data, column, language) => currentValue(ctx, doc, data, column, language, values),
    (data) => pageRowReader(ctx, doc, data, values),
  );
}

/** 計算列の値。compute が投げても表は壊さず、セルに error を付ける。 */
function computeCell(
  ctx: WsContext,
  doc: DocState,
  data: EntryData,
  column: ColumnDef,
  lang: LanguageId | undefined,
  values: ColumnValues,
): CellInfo {
  if (typeof column.compute !== "function") return { value: undefined };
  const language = lang !== undefined ? ctx.language(lang) : undefined;
  const cctx: ComputeContext = { entry: ctx.toEntry(doc, data), row: pageRowReader(ctx, doc, data, values), options: column.options ?? {} };
  if (language) {
    cctx.language = language;
    cctx.text = ctx.effectiveText(doc.resource.id, data, language.id) ?? "";
  }
  try {
    const r = column.compute(cctx);
    if (typeof r !== "object" || r === null) throw new Error("compute の戻り値が { value } の形ではありません。");
    const cell: CellInfo = { value: r.value };
    if (r.error !== undefined) cell.error = String(r.error);
    return cell;
  } catch (err) {
    return { value: undefined, error: `計算列 "${column.id}" の計算に失敗しました: ${errorText(err)}` };
  }
}

/** 1 つのセルの CellInfo。 */
export async function buildCell(
  ctx: WsContext,
  doc: DocState,
  data: EntryData,
  column: ColumnDef,
  language: LanguageDef | undefined,
): Promise<CellInfo> {
  const [cells] = await buildCells(ctx, doc, [data], {
    columns: [column],
    languages: language ? [language] : [],
    issues: column.kind === "text",
  });
  return cells?.[ctx.cellId(column, language?.id)] ?? { value: undefined };
}
