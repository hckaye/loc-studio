import type { CellStore, ColumnSource, ColumnSourceContext } from "@loc-studio/sdk";

/** options.namespace を省略したときの名前空間。 */
export const DB_SOURCE_DEFAULT_NAMESPACE = "builtin.db";

/** options.namespace を確かめて返す。列ソースを複数の名前で使い分けると、値の置き場所を分けられる。 */
export function namespaceOption(ctx: ColumnSourceContext, fallback: string, sourceId: string): string {
  const ns = ctx.options.namespace;
  if (ns === undefined) return fallback;
  if (typeof ns !== "string" || ns === "") {
    throw new Error(`列ソース "${sourceId}" のオプション namespace は空でない文字列で指定してください。`);
  }
  return ns;
}

const store = (ctx: ColumnSourceContext): CellStore =>
  ctx.host.db.cells(namespaceOption(ctx, DB_SOURCE_DEFAULT_NAMESPACE, dbSource.id));

/**
 * ホストの DB に列の値を置く列ソース（進捗ステータスなど）。
 * 変更した瞬間に保存し、版番号で競合を検出する（競合は StoreConflictError のまま呼び出し側へ）。
 */
export const dbSource: ColumnSource = {
  id: "builtin.db",
  saveMode: "immediate",
  async load(cells, ctx) {
    if (cells.length === 0) return [];
    return store(ctx).get(cells);
  },
  async save(values, ctx) {
    if (values.length === 0) return [];
    return store(ctx).set(values);
  },
  async onEntriesChanged(changes, resource, ctx) {
    const cells = store(ctx);
    // 削除や追加では何もしない。削除したキーを戻したときに値が戻るほうが安全なため。
    for (const change of changes) {
      if (change.type === "rename") await cells.renameEntry(resource.id, change.key, change.newKey);
    }
  },
};
