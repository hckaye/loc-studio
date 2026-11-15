# ツリープロバイダーを書く

ツリープロバイダーは、リソースの一覧を返し、リソースのバイト列を読み書きします。コアはリソースをこの interface 経由でしか扱わないので、ローカルにファイルを置かず、ネットワークの API から読み書きする実装にも差し替えられます。同梱の `builtin.globTree` は、プロジェクトのフォルダのファイルを glob で集めます。フォルダと glob で足りるなら、設定の `tree.options` だけで済みます（[CONFIG.md の tree](../CONFIG.md#tree)）。

置き場所と読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

## 実装する項目（TreeProvider）

| 項目 | 必須 | 意味 |
| --- | --- | --- |
| `id` | 必須 | 登録 ID。設定の `tree.use` に書く |
| `list(ctx)` | 必須 | リソースの一覧を、ツリーの形（`TreeNode[]`）で返す |
| `read(resource, ctx)` | 必須 | リソースのバイト列（`Uint8Array`）を返す |
| `write(resource, data, ctx, opts?)` | 必須 | リソースのバイト列を書く。`opts.expectedRevision` は、読んだときの版 |
| `revision(resource, ctx)` | 任意 | 本文を読まずに、いまの版を表す文字列を返す（更新時刻、ハッシュ、ETag など）。外部で書き換えられたことの検出に使われる |
| `readWithRevision(resource, ctx)` | 任意 | 中身と版を一度に返す（`{ data, revision? }`）。あれば、コアは `read` と `revision` を別々に呼ばずにこれを使う |
| `watch(ctx, onChange)` | 任意 | 変更の監視。リソースが外部で変わったら `onChange(resource)` を呼ぶ。戻り値は、監視をやめる関数。実装があれば、アプリはプロジェクトを開いている間これを呼び、知らされたリソースを読み直す |
| `create(path, data, ctx)` | 任意 | 新しいリソースを作って、その `ResourceRef` を返す。同じ場所にすでにあれば、上書きせずに例外にする。実装がなければ、画面からリソースを作れない |

どの関数も `Promise` を返します（`watch` を除く）。

`watch` は、版を出せない（`revision` のない）置き場で、外部の変更をアプリに伝える手段になります。プロジェクトの設定を読み直すと、アプリは監視をやめてから始め直し、プロジェクトを閉じるとやめます。`watch` が例外を投げても、プロジェクトは開き、警告になります。同梱の `builtin.globTree` は `watch` を実装しておらず、版（更新時刻と大きさ）の確認で変更に気づきます。

`create` の `path` は、置き場所の指定です。アプリは、区切りが `/` の相対的な書き方だけを渡します（`..` や絶対パスは、ツリーに渡す前に断ります）。同梱のツリーは、`include` に合わない場所には作りません（作っても一覧に出ないためです）。`ctx`（`TreeContext`）は次のとおりです。

| 項目 | 内容 |
| --- | --- |
| `projectRoot` | プロジェクトのフォルダの絶対パス。設定ファイルの置き場所で、リソースがここにあるとは限らない |
| `options` | 設定の `tree.options` に書いた値 |
| `host` | ホストの機能。外部の API を呼ぶ実装は、`host.fetch` と `host.secrets` を使う（[host.md](host.md)） |

## list が返す値

`list` は `TreeNode` の配列を返します。階層は、ファイルシステムと関係なく決められます。

| 項目 | 必須 | 意味 |
| --- | --- | --- |
| `id` | 必須 | ノードの ID |
| `name` | 必須 | 表示名 |
| `kind` | 必須 | `"folder"` か `"resource"` |
| `children` | 任意 | 下の階層のノード（フォルダのとき） |
| `resource` | `kind` が `"resource"` のとき必須 | リソース（`ResourceRef`） |

`ResourceRef` は `{ id, path, name }` です。`id` と `path` は、区切りを `/` にして、プロジェクトの中で一意にします。`path` は、設定の `formats[].match` の glob と照合されます。`id` は、共有 DB の記録（ステータス、レビュー、履歴）の鍵に入るので、あとから変えると、それまでの記録がリソースに結び付かなくなります。

## 版と競合の決まり

- `write` に `opts.expectedRevision` が渡され、それがいまの版と違うときは、書かずに `RevisionConflictError` を投げます。
- それ以外の失敗（認証、通信、5xx など）は、普通の `Error` にします。
- 保存のときに、サービス層がリソースを読み直して変更を当て直すのは、`RevisionConflictError` のときだけです。最初の試行を含めて 3 回まで試します。ほかの失敗は、やり直さずに、メッセージをそのまま付けて画面に伝えます（未保存の変更は消えません）。
- `readWithRevision` を実装すると、読み込みと版の確認の間に書き換えられる隙がなくなります。API から読む実装では、通信も 1 回で済みます。
- サービス層は、表示中のリソースの版の確認（`revision`）を、既定で 3 秒に 1 回までにします（表を見ているだけで API を呼び続けないためです）。
- `revision` も `readWithRevision` もない実装では、外部で書き換えられたことを検出できません。

## 例（フォルダ 1 つを並べるツリー）

設定の `options.dir` のフォルダの直下にある `.csv` を、フォルダ分けせずに並べます。4 つの関数（`list`、`read`、`revision`、`write`）と、版の競合の扱いを確かめるための最小の例です。

`loc-studio-plugins/flat-tree.ts`:

```ts
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { definePlugin, RevisionConflictError } from "@loc-studio/sdk";
import type { ResourceRef, TreeContext, TreeNode } from "@loc-studio/sdk";

// options.dir（プロジェクトからの相対パス）の直下にある .csv を、フォルダ分けせずに並べるツリー。
const dirOption = (ctx: TreeContext): string => String(ctx.options.dir ?? ".");
const fileOf = (resource: ResourceRef, ctx: TreeContext): string => path.resolve(ctx.projectRoot, dirOption(ctx), resource.name);

// 版は更新時刻とサイズから作る。読んだあとに外で書き換えられたことを見つけるために使う。
async function revisionOf(file: string): Promise<string> {
  const st = await stat(file);
  return `${st.mtimeMs}-${st.size}`;
}

export default definePlugin({
  name: "mystudio-flat-tree",
  trees: [
    {
      id: "mystudio.flatTree",
      async list(ctx) {
        const dir = dirOption(ctx);
        const names = (await readdir(path.resolve(ctx.projectRoot, dir))).filter((n) => n.endsWith(".csv")).sort();
        return names.map((name): TreeNode => {
          const id = `${dir}/${name}`; // id と path は "/" 区切りで、プロジェクトの中で一意にする
          return { id, name, kind: "resource", resource: { id, path: id, name } };
        });
      },
      async read(resource, ctx) {
        return new Uint8Array(await readFile(fileOf(resource, ctx)));
      },
      async revision(resource, ctx) {
        return revisionOf(fileOf(resource, ctx));
      },
      async write(resource, data, ctx, opts) {
        const file = fileOf(resource, ctx);
        // 読んだときの版と違えば、書かずに RevisionConflictError を投げる
        if (opts?.expectedRevision !== undefined && (await revisionOf(file)) !== opts.expectedRevision) {
          throw new RevisionConflictError(resource.id);
        }
        await writeFile(file, data);
      },
    },
  ],
});
```

設定（`tree` を置き換える）:

```json
"tree": { "use": "mystudio.flatTree", "options": { "dir": "Assets/Text/system" } }
```

確かめ方:

```sh
node apps/cli/dist/index.js tree --project <プロジェクト>
```

サンプルプロジェクトのコピーでは、次の出力になります。

```
SampleGame/
  ui.csv  4 件  [builtin.csv]
```

書き込みは、サービス層の `setText` と `save` で確かめました。本文を変えて保存すると、`ui.csv` のその行だけが変わりました。未保存の変更がある状態で、外から `ui.csv` に行を足してから保存すると、足された行は残り、変更も反映されました。

## 例（外部の API をリソースの置き場にする）

完全な動く例は `examples/remote-project/loc-studio-plugins/remote-tree.ts`（と、モック API の `mock-api/server.mjs`）です。自社の API 向けに書くときは、このファイルをコピーして書き換えます。動かす手順は [examples/remote-project/README.md](../../examples/remote-project/README.md) にあります。

次のコードは、そのファイルの、版に関わる部分の抜粋です（`call`、`failed`、`resourcePath` はファイルの中の補助の関数で、ここには載せていません）。

```ts
import { RevisionConflictError } from "@loc-studio/sdk";

// 中身と版（ETag）を 1 回の GET で取る。別々に取ると、その間の更新で中身と版が食い違うため。
async function readWithEtag(resource, ctx) {
  const res = await call(ctx, "GET", resourcePath(resource));
  if (!res.ok) throw failed(`リソース ${resource.id} の読み込み`, "GET", res);
  const etag = res.headers.get("etag") ?? undefined;
  const data = new Uint8Array(await res.arrayBuffer());
  return etag !== undefined ? { data, revision: etag } : { data };
}

const remoteTree = {
  id: "example.remoteTree",
  async list(ctx) { /* API の一覧から TreeNode[] を作る */ },
  async read(resource, ctx) { return (await readWithEtag(resource, ctx)).data; },
  readWithRevision: readWithEtag,
  async write(resource, data, ctx, opts) {
    const headers = { "content-type": "application/json; charset=utf-8" };
    // 読んだ ETag を If-Match にして、読んでから書くまでの間の他者の更新を上書きしない
    if (opts?.expectedRevision !== undefined) headers["if-match"] = opts.expectedRevision;
    const res = await call(ctx, "PUT", resourcePath(resource), { body: data, headers });
    if (res.status === 412) throw new RevisionConflictError(resource.id, `リソース ${resource.id} は読み込んだあとにほかの人が更新しました`);
    if (!res.ok) throw failed(`リソース ${resource.id} の書き込み`, "PUT", res); // 認証や通信の失敗は普通の Error
  },
  async revision(resource, ctx) {
    const res = await call(ctx, "HEAD", resourcePath(resource)); // 本文を読まずに版だけ
    if (res.status === 404) return undefined;
    if (!res.ok) throw failed(`リソース ${resource.id} の版の確認`, "HEAD", res);
    return res.headers.get("etag") ?? undefined;
  },
};
```

外部の API を使うツリープロバイダーでは、次のようにします。

- API の場所は、設定の `options` に直接書くか、環境変数の名前（例の `baseUrlEnv`）で渡して `ctx.host.env` から読みます。チームで共有する設定に、個人の環境の値を書かずに済みます。
- トークンは `ctx.host.secrets.get("example.apiToken")` で読み、ヘッダーに載せるだけにします。ログやエラーメッセージには出しません。
- API の呼び出しには `ctx.host.fetch` を使います。
- リソースの ID に拡張子がない場合、フォーマットは拡張子で判定できません。設定の `formats[].match` の glob で割り当てるか、フォーマットの `match(resource, head)` で先頭のバイトを調べます（remote-project の `example.remoteJson` は後者です）。
- `list` と `read` は、CLI の `tree` と `validate` からも呼ばれます。この 2 つのコマンドでは、秘密情報は環境変数 `LOC_STUDIO_SECRET_<名前>` からだけ読まれます（[host.md](host.md#cli-の-plugins--tree--validate--whoami-での違い)）。

確かめ方（モック API を起動した状態で）:

```sh
# bash
EXAMPLE_API_URL=http://127.0.0.1:4010 LOC_STUDIO_SECRET_EXAMPLE_APITOKEN=dev-token \
  node apps/cli/dist/index.js tree --project <remote-project のコピー>
```

```powershell
# PowerShell
$env:EXAMPLE_API_URL = "http://127.0.0.1:4010"
$env:LOC_STUDIO_SECRET_EXAMPLE_APITOKEN = "dev-token"
node apps/cli/dist/index.js tree --project <remote-project のコピー>
```

```
RemoteExample/
  quests/
    メインクエスト  3 件  [example.remoteJson]
  ui/
    共通 UI  2 件  [example.remoteJson]
```

`status` も API のリソースを読めました。ローカルにはリソースのファイルがなく、プロジェクトのフォルダには `.loc-studio/` だけが作られます。トークンがないときは、「API のトークンがありません。」を含むエラーで、終了コード 2 になります。保存、競合、認証の失敗の扱いは、`packages/server/src/remote-example.test.ts` のテストが確かめています。実際の外部サービスに対する動作は、確かめていません。

## 参考になる実装

- `packages/builtin/src/glob-tree.ts`: 同梱の `builtin.globTree`。一時ファイルを作ってから置き換える書き込みと、更新時刻とサイズによる版
- `examples/remote-project/loc-studio-plugins/remote-tree.ts`: 外部の API を使う完全な例
