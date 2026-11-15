# remote-project（外部 API をリソースの置き場にする例）

この例が示すことは 3 つあります。

1. CSV は、同梱プラグインのフォーマットの 1 つです。このプロジェクトは、API の JSON 文書を独自のフォーマット（`example.remoteJson`）で扱います。
2. ステータス列（`builtin.textStatus`）は、設定の `source: "tracker"` だけで、値の置き場をホストの DB から外部のタスク管理 API（`example.trackerStatus`）に替えています。`reviewStatus` は何も変えず、同梱の DB のままです。
3. ローカルにリソースのファイルは 1 つもありません。一覧、読み込み、書き込みは、`example.remoteTree` が API 経由で行います。

`example.remoteTree` は、読み込みでは 1 回の `GET` で中身と ETag を取ります（`readWithRevision`）。版の確認だけは `HEAD` で行います（`revision`）。サービス層は版の確認を既定で 3 秒に 1 回までにするので、表を見ているだけで API を呼び続けることはありません。

保存では、読んだ ETag を `If-Match` に付けます。HTTP 412 のときだけ `RevisionConflictError` を投げ、ツールが読み直して当て直します。401 や 5xx などは普通のエラーにするので、やり直さずにそのまま利用者に伝わります（未保存の変更は残ります）。

## 使い方

```sh
# 1. モック API を起動する（既定のトークンは dev-token、MOCK_API_TOKEN で変更可）
node examples/remote-project/mock-api/server.mjs --port 4010

# 2. 別のターミナルでプロジェクトを開く（CLI の例）
EXAMPLE_API_URL=http://127.0.0.1:4010 \
LOC_STUDIO_SECRET_EXAMPLE_APITOKEN=dev-token \
node apps/cli/dist/index.js tree --project examples/remote-project
```

`tree` の出力は次のとおりです。

```
RemoteExample/
  quests/
    メインクエスト  3 件  [example.remoteJson]
  ui/
    共通 UI  2 件  [example.remoteJson]
```

API の場所は環境変数 `EXAMPLE_API_URL` から、トークンは秘密情報 `example.apiToken`（環境変数 `LOC_STUDIO_SECRET_EXAMPLE_APITOKEN`、またはローカル設定）から読みます。トークンを設定ファイルに書かないでください。トークンがないと、「API のトークンがありません。」のエラーで終了コード 2 です。

`status`、`set`、`save` と画面は、プロジェクトのフォルダに `.loc-studio/`（共有 DB。レビューなどを置く）を作ります。元のフォルダを汚さないよう、試すときはフォルダのコピーを使ってください。プロジェクトのフォルダにできるのは、設定、プラグイン、`.loc-studio/` だけです。

プラグインは `loc-studio-plugins/` にあり、コピーして自社の API 向けに書き換えられます。書き方の説明は [docs/plugins/tree.md](../../docs/plugins/tree.md) と [docs/plugins/source.md の「外部の API に置く列ソース」](../../docs/plugins/source.md#外部の-api-に置く列ソース)にあります。

上の `tree` と、コピーに対する `status` は、実行して確かめました。Windows 11 の PowerShell でも確かめました。PowerShell では、環境変数を `$env:EXAMPLE_API_URL = "http://127.0.0.1:4010"` と `$env:LOC_STUDIO_SECRET_EXAMPLE_APITOKEN = "dev-token"` で設定してから、`node apps/cli/dist/index.js tree --project examples/remote-project` を実行します。
