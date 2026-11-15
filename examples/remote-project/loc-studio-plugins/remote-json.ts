// API が返す JSON ドキュメント（{ entries: [{ key, texts }] }）のフォーマット。
// 注意: CSV と違い、API のペイロードは「元のバイト列をそのまま残す」ことに意味がない。
// 空白や並びはサーバーが正規化するので、ここでは parse → 変更 → 整形して再出力する（ロスレス書き戻しは行わない）。
import type { Change, EntryData, Format, FormatContext, ParsedDocument } from "@loc-studio/sdk";

interface ApiEntry {
  key: string;
  texts: Record<string, string>;
}
interface ApiDoc {
  entries: ApiEntry[];
}

const dec = new TextDecoder();
const enc = new TextEncoder();

function load(input: Uint8Array, where: string): ApiDoc {
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(input));
  } catch (err) {
    throw new Error(`${where} の JSON を読めません: ${err instanceof Error ? err.message : String(err)}`);
  }
  const doc = json as Partial<ApiDoc> | null;
  if (!doc || !Array.isArray(doc.entries)) throw new Error(`${where} に entries の配列がありません`);
  return { entries: doc.entries };
}

const remoteJson: Format = {
  id: "example.remoteJson",

  // リソース ID は拡張子を持たないので、先頭が {"entries" の JSON かどうかで判定する。
  match(_resource, head) {
    return /^\s*\{\s*"entries"\s*:/.test(dec.decode(head));
  },

  parse(input, ctx: FormatContext): ParsedDocument {
    const doc = load(input, ctx.resource.id);
    const entries: EntryData[] = doc.entries.map((e, i) => ({
      key: e.key,
      text: { ...e.texts },
      // エディタで開く用ではないが、並び順の手がかりとして行番号代わりに入れる。
      location: { line: i + 1 },
    }));
    return { entries };
  },

  apply(original, changes: Change[], ctx: FormatContext) {
    const doc = load(original, ctx.resource.id);
    const find = (key: string): ApiEntry => {
      const e = doc.entries.find((x) => x.key === key);
      if (!e) throw new Error(`${ctx.resource.id} にキー「${key}」がありません`);
      return e;
    };
    for (const c of changes) {
      switch (c.type) {
        case "set":
          if (c.field.kind !== "text") throw new Error(`${ctx.resource.id}: このフォーマットは本文以外の列を持てません（${c.field.column}）`);
          find(c.key).texts[c.field.language] = String(c.value);
          break;
        case "rename":
          find(c.key).key = c.newKey;
          break;
        case "add": {
          const entry: ApiEntry = { key: c.entry.key, texts: Object.fromEntries(Object.entries(c.entry.text).map(([k, v]) => [k, v ?? ""])) };
          const at = c.after === undefined ? -1 : doc.entries.findIndex((x) => x.key === c.after);
          doc.entries.splice(at + 1, 0, entry);
          break;
        }
        case "remove":
          doc.entries.splice(doc.entries.indexOf(find(c.key)), 1);
          break;
      }
    }
    return enc.encode(JSON.stringify(doc, null, 2) + "\n");
  },

  create(entries) {
    const doc: ApiDoc = { entries: entries.map((e) => ({ key: e.key, texts: Object.fromEntries(Object.entries(e.text).map(([k, v]) => [k, v ?? ""])) })) };
    return enc.encode(JSON.stringify(doc, null, 2) + "\n");
  },
};

export default { name: "example-remote-json", version: "1.0.0", formats: [remoteJson] };
