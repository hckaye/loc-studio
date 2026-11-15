// ネットワークの API をリソースの置き場にする TreeProvider。
// ローカルにリソースのファイルは一切置かない。コアは TreeProvider 経由でしか読み書きしないので、これだけで成り立つ。
import { RevisionConflictError } from "@loc-studio/sdk";
import type { Plugin, ResourceRef, TreeContext, TreeNode, TreeProvider } from "@loc-studio/sdk";

const DEFAULT_TOKEN_SECRET = "example.apiToken";

interface RemoteResource {
  id: string;
  name: string;
  folder?: string;
  etag?: string;
}

/** API の場所は設定に直接書くか、環境変数の名前（baseUrlEnv）で渡す。チームで共有する設定に個人の環境を書かないため。 */
function baseUrl(ctx: TreeContext): string {
  const o = ctx.options as { baseUrl?: string; baseUrlEnv?: string };
  const fromEnv = o.baseUrlEnv ? ctx.host.env[o.baseUrlEnv] : undefined;
  const url = fromEnv || o.baseUrl;
  if (!url) {
    throw new Error(`API の場所が未設定です。tree.options.baseUrl か、環境変数名を指す baseUrlEnv（${o.baseUrlEnv ?? "未指定"}）を設定してください`);
  }
  return url.replace(/\/+$/, "");
}

/** トークンはログやエラーに出さないよう、ヘッダーに載せるだけにする。 */
function authHeaders(ctx: TreeContext): Record<string, string> {
  const name = String((ctx.options as { tokenSecret?: string }).tokenSecret ?? DEFAULT_TOKEN_SECRET);
  const token = ctx.host.secrets.get(name);
  if (!token) throw new Error(`API のトークンがありません。秘密情報「${name}」を設定してください（環境変数なら LOC_STUDIO_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}）`);
  return { authorization: `Bearer ${token}` };
}

async function call(ctx: TreeContext, method: string, path: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
  const url = `${baseUrl(ctx)}${path}`;
  let res: Response;
  try {
    res = await ctx.host.fetch(url, {
      method,
      headers: { ...authHeaders(ctx), ...init.headers },
      ...(init.body ? { body: init.body } : {}),
    });
  } catch (err) {
    throw new Error(`API に接続できませんでした（${method} ${url}）: ${err instanceof Error ? err.message : String(err)}`);
  }
  return res;
}

const failed = (what: string, method: string, res: Response): Error =>
  new Error(`${what}に失敗しました（${method} ${res.url}、HTTP ${res.status}）`);

const resourcePath = (r: ResourceRef): string => `/resources/${r.id.split("/").map(encodeURIComponent).join("/")}`;

async function listAll(ctx: TreeContext): Promise<RemoteResource[]> {
  const res = await call(ctx, "GET", "/resources");
  if (!res.ok) throw failed("リソース一覧の取得", "GET", res);
  return (await res.json()) as RemoteResource[];
}

/** 中身と版（ETag）を 1 回の GET で取る。別々に取ると、その間の更新で中身と版が食い違うため。 */
async function readWithEtag(resource: ResourceRef, ctx: TreeContext): Promise<{ data: Uint8Array; revision?: string }> {
  const res = await call(ctx, "GET", resourcePath(resource));
  if (!res.ok) throw failed(`リソース ${resource.id} の読み込み`, "GET", res);
  const etag = res.headers.get("etag") ?? undefined;
  const data = new Uint8Array(await res.arrayBuffer());
  return etag !== undefined ? { data, revision: etag } : { data };
}

const remoteTree: TreeProvider = {
  id: "example.remoteTree",

  async list(ctx) {
    const items = await listAll(ctx);
    // API の folder をそのままツリーのフォルダにする。ファイルシステムの階層は関係ない。
    const folders = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];
    for (const it of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
      const node: TreeNode = { id: it.id, name: it.name, kind: "resource", resource: { id: it.id, path: it.id, name: it.name } };
      if (!it.folder) {
        roots.push(node);
        continue;
      }
      let folder = folders.get(it.folder);
      if (!folder) {
        folder = { id: `folder:${it.folder}`, name: it.folder, kind: "folder", children: [] };
        folders.set(it.folder, folder);
        roots.push(folder);
      }
      folder.children!.push(node);
    }
    return roots;
  },

  async read(resource, ctx) {
    return (await readWithEtag(resource, ctx)).data;
  },

  readWithRevision: readWithEtag,

  async write(resource, data, ctx, opts) {
    // expectedRevision（ETag）を If-Match にして、読んでから書くまでの間の他者の更新を上書きしない。
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
    if (opts?.expectedRevision !== undefined) headers["if-match"] = opts.expectedRevision;
    const res = await call(ctx, "PUT", resourcePath(resource), { body: data, headers });
    if (res.status === 412) {
      // コアはこのエラーのときだけ読み直して当て直す。認証や通信の失敗は普通の Error にする。
      throw new RevisionConflictError(resource.id, `リソース ${resource.id} は読み込んだあとにほかの人が更新しました（PUT ${res.url}、HTTP 412）`);
    }
    if (!res.ok) throw failed(`リソース ${resource.id} の書き込み`, "PUT", res);
  },

  async revision(resource, ctx) {
    // 本文を読まずに版だけ知る（HEAD。ETag は GET と同じ値）。
    const res = await call(ctx, "HEAD", resourcePath(resource));
    if (res.status === 404) return undefined;
    if (!res.ok) throw failed(`リソース ${resource.id} の版の確認`, "HEAD", res);
    return res.headers.get("etag") ?? undefined;
  },
};

const plugin: Plugin = { name: "example-remote-tree", version: "1.0.0", trees: [remoteTree] };
export default plugin;
