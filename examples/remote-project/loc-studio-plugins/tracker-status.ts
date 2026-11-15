// ステータス列の値を、ホストの DB ではなく外部のタスク管理 API に置く列ソース。
// ctx.host.db は使わない。列の定義（builtin.textStatus など）はそのままで、設定の source だけで出所が替わる。
import { StoreConflictError } from "@loc-studio/sdk";
import type { CellRef, CellValue, CellWrite, ColumnSource, ColumnSourceContext, Plugin } from "@loc-studio/sdk";

const DEFAULT_TOKEN_SECRET = "example.apiToken";

/** API 側の 1 セル。version は API が採番する。 */
interface ApiStatus extends CellRef {
  value: unknown;
  version: number;
  updatedAt?: string;
  basisHash?: string;
}

function baseUrl(ctx: ColumnSourceContext): string {
  const o = ctx.options as { baseUrl?: string; baseUrlEnv?: string };
  const url = (o.baseUrlEnv ? ctx.host.env[o.baseUrlEnv] : undefined) || o.baseUrl;
  if (!url) throw new Error("タスク管理 API の場所が未設定です。sources の options に baseUrl か baseUrlEnv を設定してください");
  return url.replace(/\/+$/, "");
}

async function call(ctx: ColumnSourceContext, method: string, path: string, body?: unknown): Promise<Response> {
  const name = String((ctx.options as { tokenSecret?: string }).tokenSecret ?? DEFAULT_TOKEN_SECRET);
  const token = ctx.host.secrets.get(name);
  if (!token) throw new Error(`タスク管理 API のトークンがありません。秘密情報「${name}」を設定してください`);
  const url = `${baseUrl(ctx)}${path}`;
  try {
    return await ctx.host.fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new Error(`タスク管理 API に接続できませんでした（${method} ${url}）: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const sameCell = (a: CellRef, b: CellRef): boolean =>
  a.resourceId === b.resourceId && a.entryKey === b.entryKey && a.columnId === b.columnId && (a.language ?? "") === (b.language ?? "");

/** API の version（API が採番）を CellValue.version にそのまま対応させる。これがコアの競合検出の土台になる。 */
const toCellValue = (s: ApiStatus): CellValue => ({
  resourceId: s.resourceId,
  entryKey: s.entryKey,
  columnId: s.columnId,
  ...(s.language !== undefined ? { language: s.language } : {}),
  value: s.value,
  version: s.version,
  ...(s.updatedAt !== undefined ? { updatedAt: s.updatedAt } : {}),
  ...(s.basisHash !== undefined ? { basisHash: s.basisHash } : {}),
});

const trackerStatus: ColumnSource = {
  id: "example.trackerStatus",
  // 外部の API は「変更した瞬間に書く」。編集バッファに積むと他者の更新との競合が増える。
  saveMode: "immediate",

  async load(cells, ctx) {
    // API は resource 単位で返すので、リソースごとに 1 回だけ呼んで、必要なセルを選ぶ。
    const out: CellValue[] = [];
    for (const rid of new Set(cells.map((c) => c.resourceId))) {
      const res = await call(ctx, "GET", `/status?resource=${encodeURIComponent(rid)}`);
      if (!res.ok) throw new Error(`ステータスの読み込みに失敗しました（GET ${res.url}、HTTP ${res.status}）`);
      const all = (await res.json()) as ApiStatus[];
      for (const c of cells.filter((x) => x.resourceId === rid)) {
        const hit = all.find((s) => sameCell(s, c));
        if (hit) out.push(toCellValue(hit));
      }
    }
    return out;
  },

  async save(values: CellWrite[], ctx) {
    if (values.length === 0) return [];
    const res = await call(ctx, "PUT", "/status", values);
    if (res.status === 409) {
      const body = (await res.json()) as { conflicts: { cell: CellRef; current?: ApiStatus }[] };
      // 版が合わない。コアが利用者に両方の値を見せられるよう、いまの値を添えて投げる。
      throw new StoreConflictError(body.conflicts.map((c) => ({ cell: c.cell, current: c.current ? toCellValue(c.current) : undefined })));
    }
    if (!res.ok) throw new Error(`ステータスの保存に失敗しました（PUT ${res.url}、HTTP ${res.status}）`);
    return ((await res.json()) as ApiStatus[]).map(toCellValue);
  },
};

const plugin: Plugin = { name: "example-tracker-status", version: "1.0.0", sources: [trackerStatus] };
export default plugin;
