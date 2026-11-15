# ホストの機能（PluginHost）

プラグインの実装は、関数の引数 `ctx` の `ctx.host`（型は `PluginHost`）から、アプリ本体の機能を使えます。共有 DB、いまのユーザー名、秘密情報、環境変数、`fetch` があります。

## どの種類が使えるか

| 種類 | `ctx.host` | 補足 |
| --- | --- | --- |
| tree | あり | `TreeContext.host` |
| source | あり | `ColumnSourceContext.host` |
| generator | `run` にあり | `run` の `ctx` は `secrets` も直接持つ。`input` の `ctx` には `host` がない |
| action | あり | `ActionContext` は `secrets` と `env` も直接持つ |
| validator、format、syntax | なし | 渡されるのは本文や `options` だけ |
| column（計算列の `compute`） | なし | 渡されるのは行の値と `options` だけ |
| renderer | なし | ブラウザで動くため。受け取るのは `CellRenderContext`（[renderer.md](renderer.md)） |

## メンバー

| メンバー | 内容 |
| --- | --- |
| `db.cells(名前空間)` | セルごとの値を置く場所。版番号つき。`get(cells)`、`set(values)`、`query({ resourceId?, columnId?, language? })`、`renameEntry(resourceId, 旧キー, 新キー)` |
| `db.log(名前空間)` | 追記だけの記録。`append(entries)`、`list({ cell?, resourceId?, columnId?, limit? })`（新しい順）、`latest(cells)`（セルごとの最新 1 件。なければ `undefined`。引数と同じ順）、`renameEntry`。各記録に `id`、`at`（日時）、`by`（その時点のユーザー名）が付く |
| `db.kv(名前空間)` | キーと値。`get`、`getMany`、`set`、`setMany`、`delete`。キャッシュなどに使う |
| `user.name` | いまのユーザー名。読むたびに最新の値になる（ローカル設定の変更がすぐ反映される） |
| `secrets.get(名前)` | 接続キーなどの秘密情報。ローカル設定の `secrets.<名前>`、なければ環境変数 `LOC_STUDIO_SECRET_<名前>`。どちらもなければ `undefined` |
| `env` | プロセスの環境変数。Web モードでは、サーバーの設定の `projects[].env` に並べた名前だけが入る |
| `projectRoot` | プロジェクトのフォルダの絶対パス |
| `fetch` | 外部の API を呼ぶときに使う（`globalThis.fetch`） |
| `log(message)` | メッセージを標準エラー出力に書く |

`db.cells(名前空間).set(values)` は、`expectedVersion` が今の版と合わないセルが 1 つでもあると、`StoreConflictError` を投げて何も書きません。

## 共有 DB の名前空間

`db` は共有 DB（設定の `storage`）です。チームで共有する値を置く場所なので、名前空間にはプラグインの名前を付けて、ほかと重ならないようにします（`mystudio.memo` など）。`core.` で始まる名前空間はコアが、`builtin.` で始まる名前空間は同梱プラグインが使っています。

共有 DB が SQLite でも Postgres でも、プラグインからは同じ形で使えます。共有モードの書き込みロックは、ホスト側が扱います。

`status` / `set` / `save` / `generate` / `run` と画面は、本物の共有 DB を使います。

## 秘密情報と環境変数

秘密情報は、設定ファイルにもコードにも書かず、`secrets.get` で読みます。ログやエラーメッセージにも出しません。

```ts
const token = ctx.host.secrets.get("example.apiToken");
if (!token) throw new Error("API のトークンがありません。秘密情報「example.apiToken」を設定してください");
```

環境変数で渡すときの名前は、秘密情報の名前を大文字にして、英数字以外を `_` に置き換え、前に `LOC_STUDIO_SECRET_` を付けたものです。`example.apiToken` なら `LOC_STUDIO_SECRET_EXAMPLE_APITOKEN` です。Web モードでは、秘密情報はサーバーの環境変数から読みます。

`env` には、次の名前は入りません（ローカルモードでも Web モードでも同じです）。秘密情報を `env` 経由で読めないようにするためです。

- `LOC_STUDIO_SECRET_` で始まる名前
- アプリ自身が使う `LOC_STUDIO_LOCAL_TOKEN`、`LOC_STUDIO_INTERNAL_SECRET`、`LOC_STUDIO_ADMIN_USER`、`LOC_STUDIO_ADMIN_PASSWORD`

API の場所のような、秘密ではないが環境ごとに違う値は、`ctx.options` か `ctx.host.env` から取ります。チームで共有する設定ファイルに、個人の環境の値を書かずに済みます。

## CLI の plugins / tree / validate / whoami での違い

CLI のコマンドのうち、`plugins` / `tree` / `validate` / `whoami` は、サービス層を通さずにプロジェクトを開きます。この 4 つでは、ホストの機能が次のように変わります。ツリープロバイダーの `list` と `read` は `tree` と `validate` からも呼ばれるので、どちらの状態でも動くように書きます。

| メンバー | この 4 つのコマンドでの動き |
| --- | --- |
| `db` | メモリ上の DB。コマンドが終わると中身は消える |
| `user.name` | 常に `"unknown"` |
| `secrets.get(名前)` | 環境変数 `LOC_STUDIO_SECRET_<名前>` だけを読む。ローカル設定の `secrets.<名前>` は読まない |
| `env` | プロセスの環境変数がそのまま入る。上の節の除外は働かず、`LOC_STUDIO_SECRET_` で始まる名前も入る |

## 使用例

- 共有 DB にセルの値を置く列ソース: [source.md の「ホストの DB に置く列ソース」](source.md#ホストの-db-に置く列ソース)
- 追記だけの記録にレビューの投稿を置く列ソース: [source.md の「レビューに対応した列ソース」](source.md#レビューに対応した列ソース)
- `fetch` と `secrets` で外部の API を呼ぶツリープロバイダー: [tree.md](tree.md)
