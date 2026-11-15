/**
 * 行の構成の変更（追加・削除・キーの変更）と、新しいリソースの作成。
 * どちらもフォーマットとツリーに任せる（Format.apply の add / remove / rename、Format.create、TreeProvider.create）。
 * 対応していないフォーマットやツリーでは、理由つきで失敗する。
 */
import type { Change, EntryData, FormatContext, ResourceRef, WorkflowEvent } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { EntryChange } from "./api-types.js";
import type { WsContext } from "./context.js";
import { errorText, GENERATED_CELLS_NS, HISTORY_NS, STABLE_KEYS_NS, TEXT_BASIS_NS } from "./context.js";
import type { DocState } from "./documents.js";
import { applyPatches, revisionAfterWrite, writeResource } from "./editing.js";
import { runAfter, runBefore } from "./hooks.js";
import { resourceVisible } from "./permissions.js";

/** 1 回の呼び出しで当てられる変更の数。 */
const MAX_CHANGES = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const requireKey = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v === "") throw new ApiError("invalid", `${what} は空でない文字列で指定してください。`);
  return v;
};

/** 呼び出しの引数を、フォーマットに渡す Change にする。 */
function toChanges(ctx: WsContext, raw: unknown): Change[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApiError("invalid", "changes は、1 つ以上の変更の配列で指定してください。");
  if (raw.length > MAX_CHANGES) throw new ApiError("invalid", `changes は ${MAX_CHANGES} 個までにしてください。`);
  return raw.map((c: EntryChange, i): Change => {
    const where = `changes[${i}]`;
    if (!isRecord(c)) throw new ApiError("invalid", `${where} はオブジェクトにしてください。`);
    switch (c.type) {
      case "add": {
        const entry: EntryData = { key: requireKey(c.key, `${where}.key`), text: {} };
        if (c.text !== undefined) {
          if (!isRecord(c.text)) throw new ApiError("invalid", `${where}.text は「言語 ID: 本文」のオブジェクトにしてください。`);
          for (const [language, value] of Object.entries(c.text)) {
            ctx.requireLanguage(language);
            if (typeof value !== "string") throw new ApiError("invalid", `${where}.text.${language} は文字列で指定してください。`);
            entry.text[language] = value;
          }
        }
        if (c.meta !== undefined) {
          if (!isRecord(c.meta)) throw new ApiError("invalid", `${where}.meta は「列 ID: 値」のオブジェクトにしてください。`);
          entry.meta = { ...c.meta };
        }
        const change: Change = { type: "add", entry };
        if (c.after !== undefined) change.after = requireKey(c.after, `${where}.after`);
        return change;
      }
      case "remove":
        return { type: "remove", key: requireKey(c.key, `${where}.key`) };
      case "rename": {
        const key = requireKey(c.key, `${where}.key`);
        const newKey = requireKey(c.newKey, `${where}.newKey`);
        if (key === newKey) throw new ApiError("invalid", `${where}: 新しいキーが、いまのキーと同じです。`);
        return { type: "rename", key, newKey };
      }
      default:
        throw new ApiError("invalid", `${where}.type は add / remove / rename のどれかにしてください（"${String((c as { type?: unknown }).type)}"）。`);
    }
  });
}

/** 変更を当てたあとにあるはずのキーの集合（フォーマットが変更を黙って無視していないかの確認に使う）。 */
function expectedKeys(before: string[], changes: Change[]): string[] {
  const keys = [...before];
  for (const c of changes) {
    if (c.type === "add") {
      const at = c.after !== undefined ? keys.indexOf(c.after) : -1;
      if (at >= 0) keys.splice(at + 1, 0, c.entry.key);
      else keys.push(c.entry.key);
    } else if (c.type === "remove") {
      const at = keys.indexOf(c.key);
      if (at >= 0) keys.splice(at, 1);
    } else if (c.type === "rename") {
      const at = keys.indexOf(c.key);
      if (at >= 0) keys[at] = c.newKey;
    }
  }
  return keys;
}

export async function editEntries(ctx: WsContext, params: { resourceId: string; changes: EntryChange[] }): Promise<{ entries: number; revision?: string }> {
  const changes = toChanges(ctx, params?.changes);
  const resource = await ctx.docs.resource(params.resourceId);
  const rid = resource.id;
  const event: WorkflowEvent = { type: "entries.change", resource, changes };

  const result = await ctx.locks.run(rid, async () => {
    const project = ctx.project;
    for (let attempt = 0; ; attempt++) {
      let fresh;
      try {
        fresh = await project.readDocument(resource);
      } catch (err) {
        throw new ApiError("failed", errorText(err));
      }
      const fctx: FormatContext = { resource, languages: project.languages, options: fresh.options };
      let out: Uint8Array;
      let parsed;
      try {
        out = fresh.format.apply(fresh.bytes, changes, fctx);
        parsed = fresh.format.parse(out, fctx);
      } catch (err) {
        throw new ApiError("failed", `リソース ${resource.path} の行を変えられませんでした（フォーマット "${fresh.format.id}"）: ${errorText(err)}`);
      }
      // フォーマットが変更を黙って無視していたら、書かずに失敗にする。
      const want = expectedKeys(fresh.document.entries.map((e) => e.key), changes);
      const got = parsed.entries.map((e) => e.key);
      if (want.length !== got.length || want.some((k, i) => k !== got[i])) {
        throw new ApiError("failed", `フォーマット "${fresh.format.id}" は、行の追加・削除・キーの変更に対応していません（変更が反映されませんでした）。リソース ${resource.path} は変えていません。`);
      }
      await runBefore(ctx, event);
      if ((await writeResource(ctx, resource, out, fresh.revision, attempt)) === "retry") continue;
      const after = await revisionAfterWrite(ctx, resource);
      const state = ctx.docs.setParsed(resource, parsed, fresh.format, fresh.options, after.revision);
      if (!after.ok) ctx.docs.invalidate(rid);

      await followEntryChanges(ctx, resource, changes);
      // 「安定 ID → キー」の覚えも、いまの中身に合わせる。
      await followStableIds(ctx, state);
      ctx.bump();
      const r: { entries: number; revision?: string } = { entries: parsed.entries.length };
      if (after.revision !== undefined) r.revision = after.revision;
      return r;
    }
  });
  // あとのフックは、リソースのロックを離してから呼ぶ。
  await runAfter(ctx, event, applyPatches);
  return result;
}

/**
 * 行の変更に、セルごとの記録を追従させる。キーの変更では、未保存の編集、履歴、要再確認の記録、生成の記録を新しいキーに移し、
 * 列ソースに知らせる（同梱の列ソースはステータスとレビューを移す）。削除では、未保存の編集だけを捨てる
 * （消したキーを戻したときに記録が戻るよう、共有 DB の記録は残す）。
 */
export async function followEntryChanges(ctx: WsContext, resource: ResourceRef, changes: Change[]): Promise<void> {
  const rid = resource.id;
  for (const c of changes) {
    if (c.type === "rename") {
      await ctx.drafts.renameKey(rid, c.key, c.newKey);
      await ctx.shared.log(HISTORY_NS).renameEntry(rid, c.key, c.newKey);
      await ctx.shared.cells(TEXT_BASIS_NS).renameEntry(rid, c.key, c.newKey);
      await ctx.shared.cells(GENERATED_CELLS_NS).renameEntry(rid, c.key, c.newKey);
    } else if (c.type === "remove") {
      await ctx.drafts.removeKey(rid, c.key);
    }
  }
  // 列ソースは、設定の名前ごとに 1 回ずつ知らせる（同じ実装を別の名前空間で使い分けていることがある）。
  const told = new Set<string>();
  for (const column of ctx.columns()) {
    const resolved = ctx.columnSource(column);
    if (!resolved || told.has(resolved.name)) continue;
    told.add(resolved.name);
    if (typeof resolved.source.onEntriesChanged !== "function") continue;
    try {
      await resolved.source.onEntriesChanged(changes, resource, ctx.project.sourceContext(resolved));
    } catch (err) {
      ctx.warn(`列ソース "${resolved.name}" が行の変更（${resource.path}）に追従できませんでした: ${errorText(err)}`);
    }
  }
}

/**
 * 安定 ID（EntryData.stableId）で、外部でのキーの変更に追従する。
 * リソースを読み込むたびに「安定 ID → キー」を前に覚えたものと比べ、キーが変わった行の記録を新しいキーに移す。
 * 安定 ID を出さないフォーマットでは何もしない。
 */
export async function followStableIds(ctx: WsContext, state: DocState): Promise<void> {
  const now: Record<string, string> = {};
  for (const e of state.entries) if (e.stableId !== undefined && e.stableId !== "" && !(e.stableId in now)) now[e.stableId] = e.key;
  if (Object.keys(now).length === 0) return;
  const kv = ctx.shared.kv(STABLE_KEYS_NS);
  const rid = state.resource.id;
  try {
    const stored = await kv.get(rid);
    const before: Record<string, string> = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, string>) : {};
    const keysNow = new Set(state.entries.map((e) => e.key));
    const renames: Change[] = [];
    for (const [stableId, key] of Object.entries(now)) {
      const old = before[stableId];
      // 古いキーの行がまだあるなら、キーの変更ではない（安定 ID の付け替えなど）ので、記録は動かさない。
      if (typeof old === "string" && old !== key && !keysNow.has(old)) renames.push({ type: "rename", key: old, newKey: key });
    }
    if (renames.length > 0) await followEntryChanges(ctx, state.resource, renames);
    const changed = Object.keys(now).length !== Object.keys(before).length || Object.entries(now).some(([id, key]) => before[id] !== key);
    if (changed) await kv.set(rid, now);
  } catch (err) {
    ctx.warn(`リソース ${state.resource.path} のキーの変更に追従できませんでした: ${errorText(err)}`);
  }
}

export async function createResource(ctx: WsContext, params: { path: string }): Promise<{ resource: ResourceRef }> {
  const resourcePath = params?.path;
  if (typeof resourcePath !== "string" || resourcePath.trim() === "") throw new ApiError("invalid", "path（リソースの場所）を指定してください。");
  // ツリーの実装にかかわらず、上の階層に出る書き方（".." など）は受け付けない。
  if (/^[\\/]|^[A-Za-z]:|\\/.test(resourcePath) || resourcePath.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new ApiError("invalid", `リソースの場所は、区切りが "/" の相対的な書き方で指定してください（".." は使えません）: ${resourcePath}`);
  }
  // 見えるリソースを絞られた利用者は、見える場所にだけ作れる。
  if (!resourceVisible(resourcePath)) throw new ApiError("forbidden", `${resourcePath} は、あなたの役割では作れない場所です。`);
  if ((await ctx.docs.allResources()).some((r) => r.id === resourcePath || r.path === resourcePath)) {
    throw new ApiError("conflict", `リソース ${resourcePath} はすでにあります。`);
  }
  let data: Uint8Array;
  try {
    data = ctx.project.newResourceBytes(resourcePath).data;
  } catch (err) {
    throw new ApiError("invalid", errorText(err));
  }
  const name = resourcePath.split("/").pop() ?? resourcePath;
  const candidate: ResourceRef = { id: resourcePath, path: resourcePath, name };
  await runBefore(ctx, { type: "resource.write", resource: candidate });
  let resource: ResourceRef;
  try {
    resource = await ctx.project.createResource(resourcePath, data);
  } catch (err) {
    throw new ApiError("failed", `リソース ${resourcePath} を作れませんでした: ${errorText(err)}`);
  }
  await ctx.docs.refreshTree();
  ctx.bump();
  await runAfter(ctx, { type: "resource.write", resource });
  return { resource };
}
