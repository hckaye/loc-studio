/**
 * 書き込み: 本文のドラフトと保存（setText / discardDrafts / save / saveAll）、
 * 列の値（setCell / setCells）、アクションの変更点の反映。
 */
import { severityAtLeast } from "@loc-studio/core";
import { RevisionConflictError, StoreConflictError } from "@loc-studio/sdk";
import type { CellPatch, CellValue, CellWrite, Change, ColumnDef, EntryData, FormatContext, LanguageDef, LanguageId, ResourceRef } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { CellInfo, HistoryCause, SetTextParams } from "./api-types.js";
import { buildCell, loadSourceValues, rowCellKey } from "./cells.js";
import type { WsContext, HistoryData } from "./context.js";
import { defaultValue, enumOf, errorText, isFileColumn, TEXT_BASIS_NS } from "./context.js";
import type { DocState } from "./documents.js";
import type { Draft } from "./drafts.js";
import { textHash } from "./hash.js";
import { validateEntries } from "./issues.js";
import { currentCall } from "./call-context.js";
import { assertCan, languageAllowed } from "./permissions.js";
import { HISTORY_NS } from "./context.js";

export interface WriteCause {
  cause: HistoryCause;
  causeRef?: string;
}

const MANUAL: WriteCause = { cause: "manual" };

/** 版の競合（RevisionConflictError）のときに、読み直して当て直す回数の上限（最初の試行を含む）。 */
export const MAX_WRITE_ATTEMPTS = 3;

const isRevisionConflict = (err: unknown): boolean =>
  err instanceof RevisionConflictError || (err instanceof Error && err.name === "RevisionConflictError");

/**
 * リソースを書く。版の競合なら "retry" を返し（呼び出し側が読み直して当て直す）、
 * それ以外の失敗（認証、通信など）はやり直さず、TreeProvider のメッセージのまま ApiError("failed") にする。
 */
async function writeResource(
  ctx: WsContext,
  resource: ResourceRef,
  data: Uint8Array,
  revision: string | undefined,
  attempt: number,
): Promise<"ok" | "retry"> {
  try {
    await ctx.project.writeBytes(resource, data, revision !== undefined ? { expectedRevision: revision } : undefined);
    return "ok";
  } catch (err) {
    if (isRevisionConflict(err)) {
      if (attempt + 1 < MAX_WRITE_ATTEMPTS) return "retry";
      throw new ApiError(
        "conflict",
        `リソース ${resource.path} は保存のたびにほかで書き換えられたため、${MAX_WRITE_ATTEMPTS} 回試しても保存できませんでした: ${errorText(err)}`,
      );
    }
    throw new ApiError("failed", `リソース ${resource.path} を書き込めませんでした: ${errorText(err)}`);
  }
}

/** 書いたあとの版。取れなくても保存は済んでいるので、キャッシュを捨てて次に読み直す。 */
async function revisionAfterWrite(ctx: WsContext, resource: ResourceRef): Promise<{ revision?: string; ok: boolean }> {
  try {
    const revision = await ctx.project.revision(resource);
    return revision !== undefined ? { revision, ok: true } : { ok: true };
  } catch (err) {
    ctx.warn(`保存したリソース ${resource.path} の版を確かめられませんでした: ${errorText(err)}`);
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// 本文
// ---------------------------------------------------------------------------

export async function setText(
  ctx: WsContext,
  params: SetTextParams,
  why: WriteCause = MANUAL,
): Promise<{ cell: CellInfo; unsaved: number }> {
  const { resourceId, key, value } = params ?? ({} as SetTextParams);
  if (typeof value !== "string") throw new ApiError("invalid", "本文（value）は文字列で指定してください。");
  const textCol = ctx.requireTextColumn();
  const language = ctx.requireLanguage(params.language);
  if (!ctx.applies(textCol, language.id)) throw new ApiError("invalid", `本文の列は言語 "${language.id}" にはありません。`);
  if (language.editable === false) {
    throw new ApiError("blocked", `言語「${language.label}」（${language.id}）は読み取り専用です。`);
  }
  assertCan("edit", language.id);
  if (params.baseValue !== undefined && typeof params.baseValue !== "string") throw new ApiError("invalid", "baseValue は文字列で指定してください。");
  const resource = await ctx.docs.resource(resourceId);
  return ctx.locks.run(resource.id, async () => {
    const doc = await ctx.docs.get(resource.id);
    const data = ctx.entryOf(doc, key);
    const saved = data.text[language.id] ?? "";
    const existing = ctx.drafts.get(resource.id, key, language.id);
    if (params.baseValue !== undefined) {
      // 編集を始めたあとで、ほかの人がこのセルを変えていたら上書きしない。
      const current = existing ? existing.value : saved;
      if (current !== params.baseValue && current !== value) {
        let by = existing?.by;
        if (by === undefined) {
          const [rec] = await ctx.shared.log(HISTORY_NS).latest([ctx.cellRef(resource.id, key, textCol, language.id)]);
          by = rec?.by;
        }
        throw new ApiError(
          "conflict",
          `このセルは編集を始めたあとで${by ? `「${by}」が` : "ほかで"}変更しています。いまの値を確かめてからやり直してください。`,
          by !== undefined ? { value: current, by } : { value: current },
        );
      }
    }
    if (value === saved) {
      if (ctx.drafts.get(resource.id, key, language.id)) {
        await ctx.drafts.remove([{ resourceId: resource.id, key, language: language.id }]);
      }
    } else {
      const draft: Draft = {
        resourceId: resource.id,
        key,
        language: language.id,
        value,
        savedHash: textHash(saved),
        cause: why.cause,
        by: ctx.userName(),
      };
      if (why.causeRef !== undefined) draft.causeRef = why.causeRef;
      await ctx.drafts.put(draft);
    }
    ctx.bump();
    const cell = await buildCell(ctx, doc, data, textCol, language);
    return { cell, unsaved: ctx.drafts.count(resource.id) };
  });
}

export async function discardDrafts(ctx: WsContext, params: { resourceId: string; keys?: string[] }): Promise<{ unsaved: number }> {
  const rid = params?.resourceId;
  if (typeof rid !== "string" || rid === "") throw new ApiError("invalid", "resourceId を指定してください。");
  if (params.keys !== undefined && !Array.isArray(params.keys)) throw new ApiError("invalid", "keys は配列で指定してください。");
  return ctx.locks.run(rid, async () => {
    const keys = params.keys ? new Set(params.keys) : undefined;
    // 言語の制限がある利用者は、自分の言語のドラフトだけを捨てる（ほかは残す）。
    const call = currentCall();
    const targets = ctx.drafts.list(rid).filter((d) => (!keys || keys.has(d.key)) && languageAllowed(call, d.language));
    await ctx.drafts.remove(targets);
    if (targets.length > 0) ctx.bump();
    return { unsaved: ctx.drafts.count(rid) };
  });
}

export async function save(
  ctx: WsContext,
  params: { resourceId: string },
): Promise<{ saved: number; conflicts: { key: string; language: LanguageId }[] }> {
  const rid = params?.resourceId;
  if (typeof rid !== "string" || rid === "") throw new ApiError("invalid", "resourceId を指定してください。");
  return ctx.locks.run(rid, async () => {
    // 言語の制限がある利用者は、自分の言語のドラフトだけを保存する（ほかの人のほかの言語のドラフトは残す）。
    const call = currentCall();
    const drafts = ctx.drafts.list(rid).filter((d) => languageAllowed(call, d.language));
    if (drafts.length === 0) return { saved: 0, conflicts: [] };
    const textCol = ctx.requireTextColumn();
    const resource = await ctx.docs.resource(rid);
    const project = ctx.project;

    for (let attempt = 0; ; attempt++) {
      let fresh;
      try {
        // 外部で書き換えられていても、いまの中身にドラフトを当てる。
        fresh = await project.readDocument(resource);
      } catch (err) {
        throw new ApiError("failed", errorText(err));
      }
      const byKey = new Map<string, EntryData>();
      for (const e of fresh.document.entries) if (!byKey.has(e.key)) byKey.set(e.key, e);

      const changes: Change[] = [];
      const written: { draft: Draft; old: string }[] = [];
      const dropped: Draft[] = [];
      const conflicts: { key: string; language: LanguageId }[] = [];
      for (const d of drafts) {
        const e = byKey.get(d.key);
        if (!e) {
          conflicts.push({ key: d.key, language: d.language });
          continue;
        }
        const cur = e.text[d.language] ?? "";
        if (cur === d.value) {
          dropped.push(d);
          continue;
        }
        if (textHash(cur) !== d.savedHash) {
          // ドラフトを作ったあとでリソースの値が変わった。上書きせずに残す。
          conflicts.push({ key: d.key, language: d.language });
          continue;
        }
        changes.push({ type: "set", key: d.key, field: { kind: "text", language: d.language }, value: d.value });
        written.push({ draft: d, old: cur });
      }

      const fctx: FormatContext = { resource, languages: project.languages, options: fresh.options };
      let parsed = fresh.document;
      let after: { revision?: string; ok: boolean } = fresh.revision !== undefined ? { revision: fresh.revision, ok: true } : { ok: true };
      if (changes.length > 0) {
        let out: Uint8Array;
        try {
          out = fresh.format.apply(fresh.bytes, changes, fctx);
        } catch (err) {
          throw new ApiError("failed", `リソース ${resource.path} に変更を当てられませんでした: ${errorText(err)}`);
        }
        // 版の競合のときだけ読み直して当て直す。ほかの失敗はドラフトを残したまま、すぐ失敗にする。
        if ((await writeResource(ctx, resource, out, fresh.revision, attempt)) === "retry") continue;
        parsed = fresh.format.parse(out, fctx);
        after = await revisionAfterWrite(ctx, resource);
      }
      const doc = ctx.docs.setParsed(resource, parsed, fresh.format, fresh.options, after.revision);
      if (!after.ok) ctx.docs.invalidate(rid);

      if (written.length > 0) {
        await ctx.rememberTexts(written.flatMap((w) => [w.old, w.draft.value]));
        if (ctx.recordsHistory(textCol)) {
          await ctx.appendHistory(
            written.map((w) => {
              const data: HistoryData = { oldValue: w.old, newValue: w.draft.value, cause: w.draft.cause };
              if (w.draft.causeRef !== undefined) data.causeRef = w.draft.causeRef;
              return { cell: ctx.cellRef(rid, w.draft.key, textCol, w.draft.language), data };
            }),
          );
        }
        await recordTextBasis(ctx, doc, textCol, written.map((w) => ({ key: w.draft.key, language: w.draft.language })));
      }
      await ctx.drafts.remove([...written.map((w) => w.draft), ...dropped]);
      ctx.bump();
      return { saved: written.length, conflicts };
    }
  });
}

/** 訳文を保存したときの、基になる言語の本文の版を残す（要再確認の判定に使う）。 */
async function recordTextBasis(
  ctx: WsContext,
  doc: DocState,
  textCol: ColumnDef,
  cells: { key: string; language: LanguageId }[],
): Promise<void> {
  const writes: CellWrite[] = [];
  const texts: string[] = [];
  for (const { key, language } of cells) {
    const base = ctx.language(language)?.basedOn;
    if (base === undefined) continue;
    const i = doc.index.get(key);
    const data = i === undefined ? undefined : doc.entries[i];
    if (!data) continue;
    const baseText = data.text[base] ?? "";
    texts.push(baseText);
    const hash = textHash(baseText);
    writes.push({ ...ctx.cellRef(doc.resource.id, key, textCol, language), value: hash, basisHash: hash });
  }
  if (writes.length === 0) return;
  await ctx.rememberTexts(texts);
  await ctx.shared.cells(TEXT_BASIS_NS).set(writes);
}

export async function saveAll(ctx: WsContext): Promise<{
  resources: number;
  saved: number;
  conflicts: number;
  conflictList: { resourceId: string; key: string; language: LanguageId }[];
}> {
  let resources = 0;
  let saved = 0;
  const conflictList: { resourceId: string; key: string; language: LanguageId }[] = [];
  for (const rid of ctx.drafts.resourcesWithDrafts()) {
    const r = await save(ctx, { resourceId: rid });
    resources++;
    saved += r.saved;
    for (const c of r.conflicts) conflictList.push({ resourceId: rid, ...c });
  }
  return { resources, saved, conflicts: conflictList.length, conflictList };
}

// ---------------------------------------------------------------------------
// 列の値
// ---------------------------------------------------------------------------

/** setCell で書ける列か確かめる。 */
function writableColumn(ctx: WsContext, column: ColumnDef): void {
  if (column.kind === "text") throw new ApiError("invalid", `列 "${column.id}" は本文の列です。本文は setText で変えてください。`);
  if (column.kind === "review") throw new ApiError("invalid", `列 "${column.id}" はレビュー列です。判定は postReview で投稿してください。`);
  if (column.kind === "key" || column.kind === "generated" || column.kind === "actions" || column.kind === "computed") {
    throw new ApiError("invalid", `列 "${column.id}"（kind: ${column.kind}）の値は直接変えられません。`);
  }
  if (!isFileColumn(column) && !ctx.columnSource(column)) {
    throw new ApiError("invalid", `列 "${column.id}" の出所 "${column.source ?? ""}" が見つからないため、値を保存できません。`);
  }
}

function checkValue(column: ColumnDef, value: unknown): void {
  const e = enumOf(column);
  if (e) {
    if (value !== null && !e.enum.some((o) => o.value === value)) {
      throw new ApiError(
        "invalid",
        `列 "${column.id}" に "${String(value)}" は選べません（選択肢: ${e.enum.map((o) => o.value).join(", ")}）。`,
      );
    }
    return;
  }
  if (value === null || value === undefined) return;
  const t = column.type;
  if ((t === "string" && typeof value !== "string") || (t === "number" && typeof value !== "number") || (t === "boolean" && typeof value !== "boolean")) {
    throw new ApiError("invalid", `列 "${column.id}" の値は ${t} で指定してください（${JSON.stringify(value)}）。`);
  }
}

/** blockComplete: complete の選択肢への変更で、その言語の本文に問題があれば問題の一覧を返す。 */
async function blockingIssues(
  ctx: WsContext,
  doc: DocState,
  entries: EntryData[],
  column: ColumnDef,
  language: LanguageDef | undefined,
  value: unknown,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const block = ctx.project.config.validation?.blockComplete ?? false;
  if (!block || !language) return out;
  const option = enumOf(column)?.enum.find((o) => o.value === value);
  if (!option?.complete) return out;
  const found = await validateEntries(ctx, doc, entries, [language]);
  for (const data of entries) {
    const issues = (found.get(`${data.key}\u0000${language.id}`) ?? []).filter((i) => severityAtLeast(i.severity, block));
    if (issues.length > 0) out.set(data.key, issues.map((i) => i.message));
  }
  return out;
}

function conflictError(ctx: WsContext, err: StoreConflictError | Error): ApiError {
  const conflicts = (err as StoreConflictError).conflicts ?? [];
  const current = conflicts.map((c) => {
    const column = ctx.column(c.cell.columnId);
    return {
      key: c.cell.entryKey,
      cellId: column ? ctx.cellId(column, c.cell.language) : c.cell.columnId,
      current: c.current
        ? { value: c.current.value, version: c.current.version, updatedAt: c.current.updatedAt, updatedBy: c.current.updatedBy }
        : undefined,
    };
  });
  return new ApiError("conflict", err.message, current.length === 1 ? current[0] : current);
}

const isConflict = (err: unknown): err is StoreConflictError =>
  err instanceof StoreConflictError || (err instanceof Error && err.name === "StoreConflictError");

export async function setCell(
  ctx: WsContext,
  params: { resourceId: string; key: string; cellId: string; value: unknown; expectedVersion?: number },
  why: WriteCause = MANUAL,
): Promise<CellInfo> {
  const { column, language } = ctx.parseCellId(params?.cellId);
  writableColumn(ctx, column);
  assertCan("edit", column.scope === "language" ? language?.id : undefined);
  const value = params.value === undefined ? null : params.value;
  checkValue(column, value);
  const doc0 = await ctx.docs.get(params.resourceId);
  const data0 = ctx.entryOf(doc0, params.key);
  const blocked = await blockingIssues(ctx, doc0, [data0], column, language, value);
  if (blocked.size > 0) {
    const messages = blocked.get(data0.key)!;
    throw new ApiError("blocked", `本文に問題があるため「${String(value)}」にできません: ${messages.join(" / ")}`, { issues: messages });
  }

  if (isFileColumn(column)) {
    await writeFileCells(ctx, doc0.resource.id, [data0.key], column, language?.id, value, why);
    const doc = await ctx.docs.get(doc0.resource.id);
    return buildCell(ctx, doc, ctx.entryOf(doc, params.key), column, language);
  }

  const resolved = ctx.columnSource(column)!;
  const rid = doc0.resource.id;
  const ref = ctx.cellRef(rid, data0.key, column, language?.id);
  const before = await loadSourceValues(ctx, rid, [data0.key], [{ column, languages: [language?.id] }]);
  const old = before.get(rowCellKey(data0.key, ctx.cellId(column, language?.id)));
  const write: CellWrite = { ...ref, value };
  if (params.expectedVersion !== undefined && params.expectedVersion !== null) {
    if (typeof params.expectedVersion !== "number") throw new ApiError("invalid", "expectedVersion は数値で指定してください。");
    write.expectedVersion = params.expectedVersion;
  }
  if (column.basis === "text" && language) {
    [write.basisHash] = await ctx.rememberTexts([ctx.effectiveText(rid, data0, language.id) ?? ""]);
  }
  try {
    await resolved.source.save([write], ctx.project.sourceContext(resolved));
  } catch (err) {
    if (isConflict(err)) throw conflictError(ctx, err);
    throw new ApiError("failed", `列 "${column.id}" の値を保存できませんでした: ${errorText(err)}`);
  }
  if (ctx.recordsHistory(column)) {
    const data: HistoryData = { oldValue: old ? old.value : defaultValue(column), newValue: value, cause: why.cause };
    if (why.causeRef !== undefined) data.causeRef = why.causeRef;
    await ctx.appendHistory([{ cell: ref, data }]);
  }
  ctx.bump();
  const doc = await ctx.docs.get(rid);
  return buildCell(ctx, doc, ctx.entryOf(doc, params.key), column, language);
}

/** ファイル内の列（出所 file）の値をすぐリソースに書く。 */
async function writeFileCells(
  ctx: WsContext,
  rid: string,
  keys: string[],
  column: ColumnDef,
  language: LanguageId | undefined,
  value: unknown,
  why: WriteCause,
): Promise<number> {
  const resource = await ctx.docs.resource(rid);
  return ctx.locks.run(rid, async () => {
    const project = ctx.project;
    for (let attempt = 0; ; attempt++) {
    let fresh;
    try {
      fresh = await project.readDocument(resource);
    } catch (err) {
      throw new ApiError("failed", errorText(err));
    }
    const byKey = new Map(fresh.document.entries.map((e) => [e.key, e]));
    const changes: Change[] = [];
    const history: { cell: ReturnType<WsContext["cellRef"]>; data: HistoryData }[] = [];
    for (const key of keys) {
      const e = byKey.get(key);
      if (!e) continue;
      const old = language === undefined ? e.meta?.[column.id] : e.languageMeta?.[language]?.[column.id];
      if (old === value) continue;
      changes.push({ type: "set", key, field: language === undefined ? { kind: "meta", column: column.id } : { kind: "meta", column: column.id, language }, value });
      const data: HistoryData = { oldValue: old ?? defaultValue(column), newValue: value, cause: why.cause };
      if (why.causeRef !== undefined) data.causeRef = why.causeRef;
      history.push({ cell: ctx.cellRef(rid, key, column, language), data });
    }
    const fctx: FormatContext = { resource, languages: project.languages, options: fresh.options };
    let parsed = fresh.document;
    let after: { revision?: string; ok: boolean } = fresh.revision !== undefined ? { revision: fresh.revision, ok: true } : { ok: true };
    if (changes.length > 0) {
      let out: Uint8Array;
      try {
        out = fresh.format.apply(fresh.bytes, changes, fctx);
      } catch (err) {
        throw new ApiError("failed", `リソース ${resource.path} の列 "${column.id}" に変更を当てられませんでした: ${errorText(err)}`);
      }
      if ((await writeResource(ctx, resource, out, fresh.revision, attempt)) === "retry") continue;
      parsed = fresh.format.parse(out, fctx);
      after = await revisionAfterWrite(ctx, resource);
    }
    ctx.docs.setParsed(resource, parsed, fresh.format, fresh.options, after.revision);
    if (!after.ok) ctx.docs.invalidate(rid);
    if (ctx.recordsHistory(column)) await ctx.appendHistory(history);
    if (changes.length > 0) ctx.bump();
    return changes.length;
    }
  });
}

export async function setCells(
  ctx: WsContext,
  params: { resourceId: string; keys: string[]; cellId: string; value: unknown },
  why: WriteCause = { cause: "bulk" },
): Promise<{ updated: number; blocked: string[] }> {
  if (!Array.isArray(params?.keys)) throw new ApiError("invalid", "keys は配列で指定してください。");
  const { column, language } = ctx.parseCellId(params.cellId);
  writableColumn(ctx, column);
  // 1 つの cellId（1 つの言語）なので、言語の制限に合わなければ全体を断る。
  assertCan("edit", column.scope === "language" ? language?.id : undefined);
  const value = params.value === undefined ? null : params.value;
  checkValue(column, value);
  const doc = await ctx.docs.get(params.resourceId);
  const rid = doc.resource.id;
  const entries = [...new Set(params.keys)].map((k) => ctx.entryOf(doc, k));
  const blockedMap = await blockingIssues(ctx, doc, entries, column, language, value);
  const targets = entries.filter((e) => !blockedMap.has(e.key));
  const blocked = [...blockedMap.keys()];
  if (targets.length === 0) return { updated: 0, blocked };

  if (isFileColumn(column)) {
    const updated = await writeFileCells(ctx, rid, targets.map((e) => e.key), column, language?.id, value, why);
    return { updated, blocked };
  }

  const resolved = ctx.columnSource(column)!;
  const keys = targets.map((e) => e.key);
  const before = await loadSourceValues(ctx, rid, keys, [{ column, languages: [language?.id] }]);
  let hashes: string[] = [];
  if (column.basis === "text" && language) {
    hashes = await ctx.rememberTexts(targets.map((e) => ctx.effectiveText(rid, e, language.id) ?? ""));
  }
  const writes: CellWrite[] = targets.map((e, i) => {
    const w: CellWrite = { ...ctx.cellRef(rid, e.key, column, language?.id), value };
    if (hashes[i] !== undefined) w.basisHash = hashes[i];
    return w;
  });
  try {
    await resolved.source.save(writes, ctx.project.sourceContext(resolved));
  } catch (err) {
    if (isConflict(err)) throw conflictError(ctx, err);
    throw new ApiError("failed", `列 "${column.id}" の値を保存できませんでした: ${errorText(err)}`);
  }
  if (ctx.recordsHistory(column)) {
    await ctx.appendHistory(
      targets.map((e) => {
        const old: CellValue | undefined = before.get(rowCellKey(e.key, ctx.cellId(column, language?.id)));
        const data: HistoryData = { oldValue: old ? old.value : defaultValue(column), newValue: value, cause: why.cause };
        if (why.causeRef !== undefined) data.causeRef = why.causeRef;
        return { cell: ctx.cellRef(rid, e.key, column, language?.id), data };
      }),
    );
  }
  ctx.bump();
  return { updated: targets.length, blocked };
}

/**
 * アクションが返した変更点を、setText / setCell と同じ規則で反映する。
 * 本文はドラフトに積む（保存は利用者の操作）。
 */
export async function applyPatches(ctx: WsContext, patches: CellPatch[], why: WriteCause): Promise<{ patched: number; errors: string[] }> {
  let patched = 0;
  const errors: string[] = [];
  for (const p of patches) {
    try {
      const column = ctx.column(p.columnId);
      if (!column) throw new ApiError("not-found", `列 "${p.columnId}" はありません。`);
      if (column.kind === "text") {
        if (p.language === undefined) throw new ApiError("invalid", "本文の変更点には language が必要です。");
        await setText(ctx, { resourceId: p.resourceId, key: p.entryKey, language: p.language, value: String(p.value ?? "") }, why);
      } else {
        await setCell(ctx, { resourceId: p.resourceId, key: p.entryKey, cellId: ctx.cellId(column, p.language), value: p.value }, why);
      }
      patched++;
    } catch (err) {
      errors.push(`${p.resourceId} / ${p.entryKey} / ${p.columnId}${p.language ? `@${p.language}` : ""}: ${errorText(err)}`);
    }
  }
  return { patched, errors };
}
