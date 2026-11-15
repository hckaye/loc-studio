# loc-studio

ゲーム向けのローカライゼーションテキスト管理ツールです。画面の左にリソース（CSV などのテキストファイル）のツリー、右に多言語の表を出し、本文の編集、検証、進捗ステータス、レビューを 1 つの画面で扱います。

画面は Web アプリ（Next.js）で、使い方は 2 つあります。ローカルモードは、1 人が自分の PC で動かす使い方で、認証はありません。Web モードは、サーバーに置いた 1 つの画面を複数人がブラウザで使う使い方で、ログインとプロジェクトごとの役割があります。画面は Electron の殻に入れてデスクトップアプリとしても動かせますが、Electron での起動は確かめていません（下の「状況」）。画面なしのコマンドライン（`loc-studio`）もあり、検証や一括操作を CI やスクリプトから実行できます。

スタジオごとに違う部分（ファイル形式、本文の記法、検証規則、ステータスの選択肢、レビューの流れ、セルの見せ方、外部サービスとの連携）は、プラグインで差し替えます。同梱の機能も同じ拡張ポイントの実装です。

## 設計の要点

リソースが正で、DB は補助です。テキスト本体はリソース（既定ではプロジェクト内のファイル）にあります。DB（SQLite か Postgres）には、進捗ステータス、レビュー、変更履歴、生成結果のキャッシュ、未保存の編集を置きます。CSV に保存すると、変更したフィールド以外のバイトは変わりません（見出しにない列を足すときは、見出しと、設定によっては各レコードの末尾も変わります）。

スタジオ固有の部分はプラグインです。既定の CSV / TSV も、フォルダを走査するツリーも、「テキスト」のステータス列と「レビュー」列も、同梱プラグイン（`@loc-studio/builtin`）が登録した実装です。アプリのコードに言語 ID（`"ja"` など）やステータス名は書かれていません。

プラグインは、フォルダに置けば使えます。`.ts` / `.js` / `.mjs` などの単一ファイルか、`plugin.json` か `index.ts` のあるフォルダを、プラグインフォルダに置き、プロジェクト設定の `use` で選びます。再ビルドは要りません（TypeScript はそのまま読み込まれます）。セルの見せ方を変えるブラウザ用のモジュールも、プラグインに入れて置くだけで画面が読み込みます。プラグインとコードの設定（`loc-studio.config.ts`）は利用者の権限で動くコードで、設定ファイル（`loc-studio.project.json`）は保存先や外部の接続先を決めます。そのためローカルモードの画面では、プロジェクトを初めて開くときに設定ファイルの内容を確認し、続けてプロジェクトと個人のフォルダのプラグインとコードの設定を確認します。確認のダイアログで信頼するまで、設定は使わず、コードは読み込みません（CLI は確認なしですべて使います。Web モードはサーバーに置かれた設定とプラグインだけを確認なしで使います）。

リソースは API の向こうにも置けます。コアはリソースを `TreeProvider` 経由でしか読み書きしないので、ローカルにファイルを持たず、ネットワークの API から読み書きする実装に差し替えられます。ステータスなどの列の値も、列ソースを差し替えれば外部サービスに置けます。例は [`examples/remote-project`](examples/remote-project/README.md) です。

設定にはプロジェクトの層とローカルの層があります。チームで共有する `loc-studio.project.json`（と `loc-studio.config.ts`）と、その PC だけの `settings.json`（ユーザー名、テーマなど）です。プロジェクト側から、ローカル設定の既定値を決めたり、一部を固定したりできます。

## 必要なもの

- Node.js 22.13 以上（SQLite に `node:sqlite` を使うため。`package.json` の `engines` も同じ値です）。Node 22 では、`node:sqlite` の実験的機能の警告が標準エラー出力に出ます（コマンドラインは、この警告を出しません）。Node 26.5.1 では、この警告は出ませんでした。Node 26.5.1 で出たのは、TypeScript のプラグインやコードの設定の中身を信頼の確認のために調べるときの、`stripTypeScriptTypes` の実験的機能の警告です。
- 依存パッケージの導入に `npm`（npm workspaces）。
- Postgres を使う場合は PostgreSQL のサーバー（確かめたのは 16 だけです）。

## クイックスタート

```sh
npm install
npm run build        # tsc -b（packages と apps/cli）
npm test             # vitest run
```

### 画面を、サンプルプロジェクトのコピーで動かす

プロジェクトのフォルダには、データベースの `.loc-studio/` フォルダが作られ、編集すると CSV も書き換わります。元の `examples/` を汚さないよう、コピーを使います。

```sh
cp -r examples/sample-project /tmp/sample-project
LOC_STUDIO_PROJECT=/tmp/sample-project \
LOC_STUDIO_USER_DATA_DIR=/tmp/loc-studio-user \
npm run dev:web
```

起動すると、ターミナルに `loc-studio: http://127.0.0.1:3000/?token=…` の形で URL が表示されます。この URL をブラウザで開きます。合言葉（`?token=…`）なしで開くと、開き方を案内するページが出るだけです。本番ビルドで動かす場合は次のとおりです。

```sh
npm run build:web
LOC_STUDIO_PROJECT=/tmp/sample-project \
LOC_STUDIO_USER_DATA_DIR=/tmp/loc-studio-user \
PORT=3000 \
npm run start:web
```

サーバーは `127.0.0.1` で待ち受けます（`LOC_STUDIO_HOST` で変えられます）。

操作の説明は [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) にあります。複数人で使うサーバーの用意は [docs/WEB-MODE.md](docs/WEB-MODE.md) にあります。

### コマンドラインで動かす

```sh
node apps/cli/dist/index.js plugins  --project /tmp/sample-project   # 読み込まれたプラグインと実装
node apps/cli/dist/index.js tree     --project /tmp/sample-project   # リソースのツリーとエントリ数
node apps/cli/dist/index.js validate --project /tmp/sample-project   # 検証（error があれば終了コード 1）
node apps/cli/dist/index.js status   --project /tmp/sample-project   # 件数、問題、進捗
```

`npm run cli -- <コマンド> ...` でも同じです。コマンドの一覧は [docs/CLI.md](docs/CLI.md) にあります。

## リポジトリの構成

| パス | 内容 |
| --- | --- |
| `packages/sdk` | 拡張ポイント（9 種類）、ホスト機能、設定の型。プラグインが import する契約 |
| `packages/core` | プロジェクトを開く処理、設定の読み込み、プラグインローダー、レジストリ、列の解決、検証の実行、ロック、ローカル設定の層 |
| `packages/builtin` | 同梱プラグイン。グロブのツリー、CSV / TSV、記法、バリデータ、DB とレビューの列ソース、既定の列 |
| `packages/store` | ホストの DB の実装。SQLite（`node:sqlite`。共有モードのロックを含む）と Postgres |
| `packages/plugin-llm` | LLM で翻訳する生成器 `llm.translate`（OpenAI 互換の API） |
| `packages/server` | 画面とコマンドラインが使うサービス層（行の取得、編集、保存、レビュー、履歴、検証、設定、アクション、生成）。Web モードの認証と権限 |
| `apps/web` | Next.js の画面。API は `packages/server` を呼ぶ薄い層 |
| `apps/desktop` | Electron の殻。Web アプリの standalone ビルドを子プロセスで起動して表示する |
| `apps/cli` | コマンドライン `loc-studio`。Web モードのアカウントの管理も含む |
| `examples/sample-project` | 動作確認用のサンプル。CSV 2 ファイルと、プラグイン 2 つ（TypeScript の単一ファイルと、素の JavaScript のフォルダ形式） |
| `examples/remote-project` | リソースとステータスを外部 API に置く例（モック API つき） |
| `docs` | 文書 |

## 状況

| 区分 | 内容 |
| --- | --- |
| 実装済みでテストあり | SDK、コア（設定、プラグインローダー、レジストリ、列、検証、ロック）、同梱プラグイン（CSV / TSV の書き戻しと見出しにない列の追加、記法、バリデータ、DB とレビューの列ソース）、SQLite と Postgres のストア、サービス層（設定ファイルとプラグインとコードの設定の信頼の確認、import の書き方の検査、信頼するまでの制限された状態、Web モードの認証、セッション、ログインの総当たり対策、権限、言語の制限、管理者だけが変えられる設定の項目、環境変数の許可、管理者でない人へのパスの伏せ字、要求の量の上限、ドラフトの同時編集の検出を含む）、コマンドライン（`user` / `member` / `server check` を含む）、LLM 生成器（テストはモックの `fetch`）、画面のコンポーネントと Web の層の守り。2026-11-15（UTC）に `npx vitest run` を実行し、933 件が通り、1 件は飛ばした（74 ファイル）。同じ日に Windows 11（Node.js 26.5.1、PostgreSQL なし）で実行した結果は、893 件が通り、4 件が失敗し、37 件を飛ばした。失敗の 2 件は、シンボリックリンクの作成が権限の不足（`EPERM`）で失敗し、残りの 2 件は、SQLite のファイル（`server.db` など）の削除が `EBUSY` で失敗した（2 回実行して同じ結果）。飛ばした 37 件は、Postgres のサーバーが要るテスト（36 件）と、画面の standalone ビルドが要るテスト（1 件） |
| 実装済みで動かして確かめた | 画面の本番ビルドのサーバー（ローカルモードと Web モード）。起動の合言葉、ホスト名の許可リスト、オリジンの確かめ、本文の上限、守りのヘッダー、Web モードのクッキーを `curl` で確かめ、headless の Chrome で表と独自描画の表示を確かめた。`npm run smoke:web`（本番ビルドを一時コピーに対して起動し、設定とプラグインの信頼、API、ログイン、権限、独自描画のモジュールの配信、起動の断り方を確かめる。99 項目）は、2026-11-15 に実行し、99 項目すべてが通った。本番ビルドを headless の Chromium で操作し、設定の確認、続けてのプラグインの確認、作業の途中で設定が変わったときの確認と復帰（編集欄の入力が残ること）を確かめた。Web モードの配置の手順、`proxy` モード、CSV の列の追加、独自描画の例も実行して確かめた。Postgres（PostgreSQL 16）の共有 DB とサーバーの DB を CLI から使えることも確かめた。2026-11-15 に Windows 11（Node.js 26.5.1）で、ビルド、コマンドライン（`plugins`、`tree`、`validate`、`status`、`set`、`save`、`generate`、`run`）、サービス層、プラグインの文書の例（[docs/PLUGINS.md の「例を確かめた範囲」](docs/PLUGINS.md#例を確かめた範囲)）を実行して確かめた |
| 実装済みで、ブラウザでは操作を確かめていない | 画面の操作（ツリー、仮想化した表、言語の切り替え、編集モーダルと問題の下線、レビュー、詳細パネル、設定、プラグイン一覧と信頼の確認、保存の競合と同時編集のダイアログ、プロジェクト全体の検索、ジョブ、列幅のキーボード操作、ログイン、プロジェクト一覧、利用者のメニュー、管理の画面、権限で無効になる操作、独自描画と同梱の見せ方）。説明はコードに基づく |
| 安全性の点検 | 実装から独立した点検を 4 回行った。指摘は 1 回目が 10 件、2 回目が 4 件、3 回目が 3 件、4 回目が 2 件で、すべて直した。3 回目までの修正は、4 回目の点検で確かめられている。4 回目の 2 件（動的な import や再エクスポートで `node:module` に届く書き方の見逃しと、Postgres の URL のクエリが接続先を上書きするときの確認の画面の表示）の修正は、テスト（と、テスト全体と smoke の実行）で確かめただけで、5 回目の点検はしていない。残る弱点（分散したログインの大量送信など）は、[docs/plugins/trust.md](docs/plugins/trust.md#信頼の確認で分かること分からないこと)、[docs/WEB-MODE.md](docs/WEB-MODE.md) の 9 章、[docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) の「ローカルモードの注意」に書いた |
| 実装していない | バックアップの読み戻し（Postgres の `backup` は書き出しだけで、コマンドラインや画面からは呼べない） |
| 未確認 | Electron の殻の起動と配布物の作成（Electron の実行ファイルを取得できる環境で試していない）。Windows での画面の起動（Windows で確かめたのは、ビルド、テスト、コマンドライン、サービス層まで）と、macOS での実行。ネットワーク共有上の共有 SQLite（同じ PC の複数プロセスでの確認だけ）。PostgreSQL 16 以外の版。実際の LLM への接続。実際のリバースプロキシの後ろでの Web モード。`npm run dev:web` での起動 |

詳細は、各文書の、確かめたことと確かめていないことを書いた節にあります。

## 文書

- [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md): 導入から編集まで、画面の見方、デスクトップ版、新しいプロジェクトの作り方
- [docs/WEB-MODE.md](docs/WEB-MODE.md): Web モードの配置の手順、サーバーの設定、認証、権限、管理（後半は実装者向けの API）
- [docs/CONFIG.md](docs/CONFIG.md): プロジェクト設定、ローカル設定、環境変数のリファレンス
- [docs/PLUGINS.md](docs/PLUGINS.md): プラグインの作り方（種類の選び方、作る手順、守る決まり、うまく動かないときの直し方）。種類ごとの書き方と動く例は [docs/plugins/](docs/plugins/) の各ページ
- [docs/CLI.md](docs/CLI.md): コマンドライン
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): 設計の要約
- [docs/SERVER-API.md](docs/SERVER-API.md): サービス層（画面とコマンドラインが使う API）の仕様
- [packages/store/README.md](packages/store/README.md): ホストの DB（SQLite と Postgres）の実装
- [apps/desktop/README.md](apps/desktop/README.md): デスクトップ版の開発と配布物の作成
- [examples/remote-project/README.md](examples/remote-project/README.md): 外部 API を使う例
