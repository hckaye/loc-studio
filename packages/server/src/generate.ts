/**
 * 生成列の生成。結果は kv("core.generated") に鍵（生成器 id + version + cacheParams + 入力）で置き、
 * セルごとに最後に使った鍵と入力の版を cells("core.generated-cells") に置く。
 */
import type { CellRef, CellWrite, ColumnDef, EntryData, GeneratorInput, GeneratorOutput, LanguageId } from "@loc-studio/sdk";
import { stableStringify } from "@loc-studio/core";
import { ApiError } from "./api-types.js";
import type { GenerateParams, GenerateResult } from "./api-types.js";
import { batchSizeOf } from "./batch-size.js";
import { loadSourceValues, pageRowReader } from "./cells.js";
import type { GeneratedCellRecord, GeneratedValue } from "./cells.js";
import type { WsContext } from "./context.js";
import { errorText, GENERATED_CELLS_NS, GENERATED_NS } from "./context.js";
import type { DocState } from "./documents.js";
import { generatorCacheKey, textHash } from "./hash.js";
import type { JobHandle } from "./jobs.js";
import { assertCanRun } from "./permissions.js";
import { matchEntries, prepareFilter, requireLanguages } from "./rows.js";
import type { PreparedFilter } from "./rows.js";

const DEFAULT_BATCH_SIZE = 10;

interface Item {
  ref: CellRef;
  input: GeneratorInput;
  cacheKey: string;
  inputHash: string;
}

/** 同じ入力をまとめた、生成器に渡す 1 件。 */
interface Unique {
  input: GeneratorInput;
  cacheKey: string;
  inputHash: string;
  refs: CellRef[];
}

async function targetDocs(ctx: WsContext, params: GenerateParams): Promise<{ doc: DocState; entries: EntryData[] }[]> {
  // filter: 条件に合う行だけを対象にする（表の絞り込みと同じ RowFilter。行を選ぶのは、ここ）。
  let filter: PreparedFilter | undefined;
  if (params.filter !== undefined) {
    if (typeof params.filter !== "object" || params.filter === null) throw new ApiError("invalid", "filter はオブジェクトで指定してください。");
    if (params.scope === "cell" || params.scope === "selection") {
      throw new ApiError("invalid", `filter（条件に合う行）は、scope が resource か project のときに指定できます（"${params.scope}" では、行を keys で名指しします）。`);
    }
    filter = prepareFilter(ctx, params.filter, requireLanguages(ctx, params.filter.languages));
  }
  const entriesOf = async (doc: DocState): Promise<EntryData[]> => (filter ? matchEntries(ctx, doc, filter) : doc.entries);
  switch (params.scope) {
    case "cell":
    case "selection": {
      if (!Array.isArray(params.keys) || params.keys.length === 0) throw new ApiError("invalid", "keys を指定してください。");
      if (params.scope === "cell" && params.keys.length !== 1) throw new ApiError("invalid", "scope が cell のときは keys を 1 つにしてください。");
      const doc = await ctx.docs.get(params.resourceId ?? "");
      return [{ doc, entries: [...new Set(params.keys)].map((k) => ctx.entryOf(doc, k)) }];
    }
    case "resource": {
      const doc = await ctx.docs.get(params.resourceId ?? "");
      return [{ doc, entries: await entriesOf(doc) }];
    }
    case "project": {
      const out: { doc: DocState; entries: EntryData[] }[] = [];
      for (const r of await ctx.docs.allResources()) {
        const doc = await ctx.docs.get(r.id);
        out.push({ doc, entries: await entriesOf(doc) });
      }
      return out;
    }
    default:
      throw new ApiError("invalid", `scope は cell / selection / resource / project のどれかにしてください（"${String(params.scope)}"）。`);
  }
}

export async function generate(ctx: WsContext, params: GenerateParams): Promise<GenerateResult> {
  const column = ctx.column(params?.columnId);
  if (!column) throw new ApiError("not-found", `列 "${String(params?.columnId)}" はありません。`);
  if (column.kind !== "generated") throw new ApiError("invalid", `列 "${column.id}" は生成列ではありません。`);
  assertCanRun("generator", column.id);
  const spec = ctx.generatorFor(column);
  if (!spec) {
    throw new ApiError("invalid", `生成列 "${column.id}" の生成器 "${column.generator ?? ""}" が見つかりません（設定の generators と登録された生成器を確かめてください）。`);
  }
  const { generator, options } = spec;
  // 生成器に 1 回で渡す入力の数。指定がなければ、生成器の既定。
  const batchSize = batchSizeOf(params.batchSize) ?? Math.max(1, Math.floor(generator.batchSize ?? DEFAULT_BATCH_SIZE));
  let languages: (LanguageId | undefined)[];
  if (column.scope === "entry") languages = [undefined];
  else {
    if (params.languages !== undefined && !Array.isArray(params.languages)) throw new ApiError("invalid", "languages は配列で指定してください。");
    const ids = [...new Set((params.languages ?? ctx.project.languages.map((l) => l.id)).map(String))].map((id) => ctx.requireLanguage(id).id);
    languages = ids.filter((l) => ctx.applies(column, l));
  }
  const cacheParams = generator.cacheParams(options);

  const items: Item[] = [];
  for (const { doc, entries } of await targetDocs(ctx, params)) {
    const values = await preloadValues(ctx, doc, entries);
    for (const data of entries) {
      const row = pageRowReader(ctx, doc, data, values);
      const entry = ctx.toEntry(doc, data);
      for (const lang of languages) {
        const language = lang !== undefined ? ctx.language(lang) : undefined;
        let input: GeneratorInput | null;
        try {
          input = generator.input({ entry, column, ...(language ? { language } : {}), row, options });
        } catch (err) {
          throw new ApiError("failed", `生成器 "${generator.id}" の input が失敗しました（${doc.resource.id} / ${data.key}）: ${errorText(err)}`);
        }
        if (!input) continue;
        items.push({
          ref: ctx.cellRef(doc.resource.id, data.key, column, lang),
          input,
          cacheKey: generatorCacheKey(generator.id, generator.version, cacheParams, input),
          inputHash: textHash(stableStringify(input)),
        });
      }
    }
  }

  const kv = ctx.shared.kv(GENERATED_NS);
  const existing = items.length > 0 ? await kv.getMany([...new Set(items.map((i) => i.cacheKey))]) : {};
  const cachedItems = items.filter((i) => i.cacheKey in existing);
  const runItems = items.filter((i) => !(i.cacheKey in existing));
  const result = { total: items.length, cached: cachedItems.length, toRun: runItems.length, batchSize };
  if (params.dryRun) return result;

  // キャッシュにある分は、セルの記録だけを最新の鍵に合わせる。
  await syncRecords(ctx, cachedItems);
  if (runItems.length === 0) return result;

  const uniques = new Map<string, Unique>();
  for (const i of runItems) {
    const u = uniques.get(i.cacheKey);
    if (u) u.refs.push(i.ref);
    else uniques.set(i.cacheKey, { input: i.input, cacheKey: i.cacheKey, inputHash: i.inputHash, refs: [i.ref] });
  }
  const label = `生成: ${column.label ?? column.id}（${runItems.length} 件）`;
  const job = ctx.jobs.start("generate", label, runItems.length, (handle) =>
    runGeneration(ctx, column, [...uniques.values()], handle, batchSize),
  );
  return { ...result, jobId: job.id };
}

/** 生成器の input が row.get で読めるよう、列ソースの値を先に読む。 */
async function preloadValues(ctx: WsContext, doc: DocState, entries: EntryData[]) {
  const langs = ctx.project.languages.map((l) => l.id);
  const specs = ctx
    .columns()
    .filter((c) => ctx.columnSource(c) && c.kind !== "review")
    .map((c) => ({ column: c, languages: c.scope === "entry" ? [undefined] : langs.filter((l) => ctx.applies(c, l)) }));
  if (specs.length === 0 || entries.length === 0) return new Map();
  return loadSourceValues(ctx, doc.resource.id, entries.map((e) => e.key), specs);
}

async function syncRecords(ctx: WsContext, items: Item[]): Promise<void> {
  if (items.length === 0) return;
  const cells = ctx.shared.cells(GENERATED_CELLS_NS);
  const current = await cells.get(items.map((i) => i.ref));
  const have = new Map(current.map((c) => [`${c.resourceId}\u0000${c.entryKey}\u0000${c.language ?? ""}`, c.value as GeneratedCellRecord | null]));
  const writes: CellWrite[] = [];
  for (const i of items) {
    const rec = have.get(`${i.ref.resourceId}\u0000${i.ref.entryKey}\u0000${i.ref.language ?? ""}`);
    if (rec?.key === i.cacheKey) continue;
    const value: GeneratedCellRecord = { key: i.cacheKey, inputHash: i.inputHash };
    writes.push({ ...i.ref, value });
  }
  if (writes.length > 0) {
    await cells.set(writes);
    ctx.bump();
  }
}

async function runGeneration(ctx: WsContext, column: ColumnDef, uniques: Unique[], job: JobHandle, batchSize: number): Promise<void> {
  const spec = ctx.generatorFor(column);
  if (!spec) throw new Error(`生成列 "${column.id}" の生成器が見つかりません。`);
  const { generator, options } = spec;
  const concurrency = Math.max(1, Math.floor(generator.concurrency ?? 1));
  const retries = Math.max(0, Math.floor(generator.retries ?? 0));
  const kv = ctx.shared.kv(GENERATED_NS);
  const cells = ctx.shared.cells(GENERATED_CELLS_NS);

  const batches: Unique[][] = [];
  for (let i = 0; i < uniques.length; i += batchSize) batches.push(uniques.slice(i, i + batchSize));

  const runBatch = async (batch: Unique[]): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      job.signal.throwIfAborted();
      let outputs: GeneratorOutput[];
      try {
        outputs = await generator.run(
          batch.map((u) => u.input),
          { options, secrets: ctx.secrets, host: ctx.project.host, signal: job.signal },
        );
        if (!Array.isArray(outputs) || outputs.length !== batch.length) {
          throw new Error(`結果の数が入力と合いません（入力 ${batch.length} 件、結果 ${Array.isArray(outputs) ? outputs.length : "配列ではない"}）。`);
        }
      } catch (err) {
        lastError = err;
        continue;
      }
      // 1 件ずつ書く。途中で止まっても済んだ分は残る。
      for (let k = 0; k < batch.length; k++) {
        const u = batch[k]!;
        const out = outputs[k];
        if (!out || typeof out.value !== "string") {
          job.info.failed += u.refs.length;
          job.info.error = `生成器 "${generator.id}" の結果に value（文字列）がありません。`;
          continue;
        }
        const value: GeneratedValue = { value: out.value, generatorId: generator.id, at: new Date().toISOString() };
        if (typeof out.comment === "string" && out.comment !== "") value.comment = out.comment;
        if (out.meta !== undefined) value.meta = out.meta;
        await kv.set(u.cacheKey, value);
        const rec: GeneratedCellRecord = { key: u.cacheKey, inputHash: u.inputHash };
        await cells.set(u.refs.map((ref) => ({ ...ref, value: rec })));
        job.info.done += u.refs.length;
      }
      ctx.bump();
      return;
    }
    job.info.failed += batch.reduce((n, u) => n + u.refs.length, 0);
    job.info.error = `生成器 "${generator.id}" が失敗しました（${retries + 1} 回試行）: ${errorText(lastError)}`;
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    // 取り消しはバッチの合間に確かめる。
    while (!job.cancelled()) {
      const batch = batches[next++];
      if (!batch) return;
      await runBatch(batch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
}
