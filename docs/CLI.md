# コマンドライン

`loc-studio` は、画面を起動せずに検証、状況の確認、一括操作をするコマンドです。CI やスクリプトから使えます。Web モードのサーバーのアカウントと権限の管理にも使います（[サーバー管理](#サーバー管理)）。

```sh
node apps/cli/dist/index.js <コマンド> [オプション]      # ビルドのあと。これを標準の呼び方とする
npm run cli -- <コマンド> [オプション]                  # 同じ
npx loc-studio <コマンド> [オプション]                  # 実行権限が付いているとき（下記）
```

### ビルドと実行権限

ルートの `npm run build`（`tsc -b`）は `dist/index.js` に実行権限を付けません。`npx loc-studio`（`node_modules/.bin/loc-studio`）を Linux / macOS で使うには、CLI のパッケージを npm 経由でビルドします。

```sh
npm run build -w @loc-studio/cli     # tsc -b のあと、postbuild が scripts/make-executable.mjs で chmod +x
```

Windows では何もしません（実行権限がない）。いちど権限が付いたファイルは、あとの `tsc -b` で書き換えられても権限が残りますが、新しく clone した直後は上のコマンドが必要です。権限が付いていなくても、`node apps/cli/dist/index.js` と `npm run cli` はそのまま動きます。

以下の出力は、`examples/sample-project` の一時コピー（`--project`）と、一時フォルダ（`--user-data-dir`）に対して実行したものです（一部を省略しています）。`status` / `set` / `save` / `generate` / `run` はプロジェクトのフォルダに `.loc-studio/`（共有 DB）を作るので、元の `examples/` に対しては実行しないでください。

`node:sqlite` の実験的機能の警告（`ExperimentalWarning: SQLite is an experimental feature ...`）は、CLI の入口で捨てています（この警告だけ。ほかの警告は出ます）。`--json` の標準出力は常に JSON だけです。

## 共通のオプション

| オプション | 意味 |
| --- | --- |
| `--project <dir>` | プロジェクトのフォルダ。既定はカレントディレクトリ |
| `--app-dir <dir>` | アプリのフォルダ。その中の `plugins/` を読む。既定は環境変数 `LOC_STUDIO_APP_DIR` |
| `--user-data-dir <dir>` | 個人の設定フォルダ。その中の `plugins/`、`settings.json`、その PC の DB を使う。既定はローカル設定ファイルのあるフォルダ |
| `--json` | 機械可読の JSON で出力する |
| `--help` | 使い方を表示する（`help` コマンドと同じ。終了コード 0） |
| `--user <name>` | 記録に残すユーザー名。`whoami` / `generate` / `run` / `status` / `save` / `set` で使える。環境変数 `LOC_STUDIO_USER` より優先 |

コマンドごとに使えるオプションが決まっていて、使えないオプションは `オプション --languages は plugins コマンドでは使えません。` のように、終了コード 2 で知らされます。値が `-` で始まる位置引数は、`--` の後ろに書きます（`--` の後ろはすべて位置引数になるので、オプションは前に書きます）。

環境変数は [CONFIG.md の環境変数](CONFIG.md#環境変数) にあります。CLI が読むのは `LOC_STUDIO_APP_DIR`、`LOC_STUDIO_PLUGIN_DIRS`、`LOC_STUDIO_SETTINGS`、`LOC_STUDIO_USER`、`LOC_STUDIO_SDK_PATH`、`LOC_STUDIO_DEBUG`（設定するとエラー時にスタックトレースも出す）、秘密情報の `LOC_STUDIO_SECRET_<名前>` と、サーバー管理のコマンドが読む `LOC_STUDIO_USER_DATA_DIR`、`LOC_STUDIO_SERVER_CONFIG` です。

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 正常 |
| 1 | 検証の問題（`--fail-on` 以上）、プラグインの読み込みエラー（`plugins`）、読めないリソースがある（`tree` / `validate` / `status`。`--fail-on never` でも 1）、生成やアクションの失敗、保存の競合、サービス層を通るコマンドとサーバー管理のコマンドのそのほかの失敗、`server check` が問題を見つけた |
| 2 | 使い方の誤り（不明なコマンド、オプション、引数の数、値）、プロジェクトを開けない、対象（列、アクション、リソース、言語、ユーザー、サーバーの設定のプロジェクト）が見つからない、入力の誤り（短いパスワードなど）、サービス層を通さないコマンド（`plugins` / `tree` / `validate` / `whoami`）のそのほかの失敗 |

## コマンドの一覧

| コマンド | 内容 | サービス層 |
| --- | --- | --- |
| [`plugins`](#plugins) | 読み込まれたプラグインと登録された実装を表示 | 通さない |
| [`tree`](#tree) | リソースのツリーをエントリ数とフォーマットつきで表示 | 通さない |
| [`validate`](#validate) | プロジェクトを検証 | 通さない |
| [`whoami`](#whoami) | 解決されたユーザー名と出所 | 通さない |
| [`status`](#status) | リソースごとの件数、未保存、問題、進捗 | 通す |
| [`generate <columnId>`](#generate) | 生成列を一括で実行 | 通す |
| [`run <actionId>`](#run) | アクションを実行 | 通す |
| [`save`](#save) | 未保存の本文をすべて書き込む | 通す |
| [`set <cellId> <値>`](#set) | セルの値を複数行へ一括で設定 | 通す |
| [`user ...`](#サーバー管理) | サーバー（Web モード）のアカウントを管理 | サーバーの DB を直接開く |
| [`member ...`](#サーバー管理) | プロジェクトごとの役割を管理 | 同上 |
| [`server check`](#サーバー管理) | サーバーの設定、DB、プロジェクトを確かめる | 同上 |
| `help` | 使い方を表示 | |

「通す」のコマンドは、画面と同じサービス層（`packages/server`）を通るので、変更履歴、生成結果のキャッシュ、未保存の変更（ドラフト）を画面のローカルモードと共有します。共有 DB（既定は `.loc-studio/meta.db`。設定 `storage` で Postgres にもできる）とその PC の DB を開くので、画面を同時に開いていても同じ DB を使います。「通さない」のコマンドは DB を作らず、ホストの DB はメモリ上のものになります。

どのコマンドも、同梱プラグイン（`@loc-studio/builtin`、`@loc-studio/plugin-llm`）とプロジェクトのプラグインを読みます。コマンドラインは利用者が自分で実行するものなので、プロジェクトと個人のフォルダのプラグインも、プロジェクトのコードの設定（`loc-studio.config.*`）も、確認なしで読み込みます（`pluginTrust: "always"`）。設定ファイル（`loc-studio.project.json`）も確認なしで使うので、そこに書かれた保存先や接続先に、そのまま接続します。画面のローカルモードと違い、信頼の確認も import の条件の確認もしません。知らないプロジェクトに CLI を使うときは、先に設定ファイル、プラグインフォルダ、コードの設定の中身を確かめてください。

### plugins

読み込まれたプラグイン、登録された実装、探したフォルダ、読み込みエラー、警告を表示します。オプションはありません（共通のオプションのみ）。読み込みエラーがあると終了コード 1 です。

```
$ node apps/cli/dist/index.js plugins --project /tmp/sample --user-data-dir /tmp/ud
プラグイン:
  @loc-studio/builtin  0.1.0  [builtin]  (同梱)
  @loc-studio/plugin-llm  0.1.0  [builtin]  (同梱)
  mystudio-line-width  1.0.0  [project]  /tmp/sample/loc-studio-plugins/line-width.ts
  studio-pack  1.2.0  [project]  /tmp/sample/loc-studio-plugins/studio-pack

登録された実装:
  tree:
    builtin.globTree  <- @loc-studio/builtin [builtin]
  format:
    builtin.csv  <- @loc-studio/builtin [builtin]
    builtin.tsv  <- @loc-studio/builtin [builtin]
  ...
  generator:
    llm.translate  <- @loc-studio/plugin-llm [builtin]
  validator:
    builtin.placeholders  <- @loc-studio/builtin [builtin]
    ...
    mystudio.lineWidth  <- mystudio-line-width [project]
    mystudio.forbiddenChars  <- studio-pack [project]

探したプラグインフォルダ:
  [project] /tmp/sample/loc-studio-plugins
  [local] /tmp/ud/plugins  (フォルダなし)
```

独自描画を登録したプラグインがあると、`登録された実装:` に `renderer:` の節が出ます。読み込みエラーと警告は、末尾に `読み込みエラー:` と `警告:` の節で出ます（例は [PLUGINS.md の「うまく動かないとき」](PLUGINS.md#うまく動かないとき)）。`--json` の出力は、`plugins`、`extensions`、`pluginDirs`、`errors`、`warnings` のキーを持つオブジェクトです。

### tree

リソースのツリーを、エントリ数とフォーマットつきで表示します。リソースを 1 つずつ読むため、読めないリソース（UTF-8 でないファイルなど）は `(読めません: ...)` と表示され、終了コード 1 です。`validate` と `status` も同じ形で、読めないリソースを自分の行に出し、ほかのリソースは処理します。

```
$ node apps/cli/dist/index.js tree --project /tmp/sample --user-data-dir /tmp/ud
SampleGame/
  Assets/
    Text/
      system/
        ui.csv  4 件  [builtin.csv]
      chapter01.csv  8 件  [builtin.csv]
```

`--json` は `{ "tree": [...] }` です（各リソースに `name`、`kind`、`path`、`format`、`entries`、読めなければ `error`）。

### validate

設定で選んだバリデータを、本文のセルに当てて、問題を表示します。

| オプション | 意味 |
| --- | --- |
| `--languages <a,b>` | 検証する言語 ID（カンマ区切り）。プロジェクトにない言語は終了コード 2 |
| `--resources <glob>` | 検証するリソースのパス。`**`、`*`、`?` が使える（例: `"**/ui.csv"`）。`/` 区切りのパスに対して照合する |
| `--fail-on <重さ>` | `error` / `warning` / `info` / `never`（既定 `error`）。この重さ以上の問題か、この重さ以上のファイルの形式の診断があれば終了コード 1。`never` では、問題があっても 0（読めないリソースがあるときは 1） |
| `--max-issues <n>` | 表示する問題の数（既定 200）。集計は常に全件。超えた分は「ほか N 件」と表示される |

```
$ node apps/cli/dist/index.js validate --project /tmp/sample --user-data-dir /tmp/ud
Assets/Text/system/ui.csv
  error   UI_SAVE_CONFIRM  JaEnglish  builtin.maxLength  too-long  文字数が上限を超えています（19 文字、上限 12 文字）。

Assets/Text/chapter01.csv
  warning CH01_INTRO_003  ja  mystudio.lineWidth  line-too-long  2 行目が 20 文字です（上限 18 文字）
  ...
  error   CH01_CHOICE_001A  ko  builtin.placeholders  placeholder-missing  原文にある </b> が足りません（原文 1 個、訳文 0 個）。
  error   CH01_CHOICE_001A  ko  builtin.tagBalance  tag-unclosed  <b> が閉じられていません。
  warning CH01_CHOICE_001B  ko  builtin.untranslated  empty  訳文が空です。
  error   CH01_ITEM_001  zh-Hans  builtin.placeholders  placeholder-missing  原文にある {count} が足りません（原文 1 個、訳文 0 個）。
  error   CH01_SHOP_001  ja  mystudio.forbiddenChars  forbidden-char  使えない文字「①」があります
  error   CH01_SHOP_002  JaEnglish  builtin.maxLength  too-long  文字数が上限を超えています（8 文字、上限 6 文字）。

検証したセル: 48（問題のあるセル: 10）、リソース: 2
error 6 / warning 6 / info 0
コード別:
  line-too-long: 5
  placeholder-missing: 2
  too-long: 2
  empty: 1
  forbidden-char: 1
  tag-unclosed: 1
$ echo $?
1
```

行の形式は `重さ  キー  言語  バリデータの ID  コード  メッセージ` です。ファイルの形式の問題（引用符が閉じていない、設定にある列が見出しにない、など）は、`(ファイルの形式)` として行番号つきで出て、集計に `ファイルの形式の警告 N` が加わります。

条件を絞る例:

```
$ node apps/cli/dist/index.js validate --project /tmp/sample --user-data-dir /tmp/ud --resources "**/ui.csv" --languages ko --fail-on never --max-issues 2
検証したセル: 4（問題のあるセル: 0）、リソース: 1
error 0 / warning 0 / info 0
```

`--json` は `{ "resources": [{ "path", "issues": [...], "diagnostics": [...] }], "summary": { "error", "warning", "info", "byCode", "cellsChecked", "cellsWithIssues", "diagnostics", "resources" } }` です。各 `issue` は `key`、`language`、`columnId`、`validatorId`、`code`、`severity`、`message`、`range`（あれば）を持ちます。

CI では、`validate --fail-on error` を、検証の失敗として使えます。読めないリソース（UTF-8 でない CSV など）は `パス  (読めません: 理由)` と 1 行で出て、ほかのリソースは検証されます。終了コードは `--fail-on never` でも 1 です。集計に `読めないリソース N` が加わり、`--json` では該当リソースに `error`、`summary` に `unreadable` が入ります。

### whoami

ユーザー名と、その出所（`enforce` / `cli` / `local` / `defaults` / `app`）、ローカル設定ファイルのパスを表示します。`--user <name>` を付けて、指定の効果を確かめられます。

```
$ node apps/cli/dist/index.js whoami --project /tmp/sample --user alice
ユーザー名: alice
出所: cli
ローカル設定ファイル: /home/me/.config/loc-studio/settings.json
```

`--json` は `{ "userName", "source", "locked", "localSettingsPath" }` です。ユーザー名の決め方は [CONFIG.md のローカル設定](CONFIG.md#ローカル設定) にあります。`--user-data-dir` を指定すると、ほかのコマンドと同じく `<そのフォルダ>/settings.json` を読み、そのパスを表示します（なければ `LOC_STUDIO_SETTINGS` か OS の既定の場所）。

### status

リソースごとに、件数、未保存、問題、選択式の列の言語ごとの進捗を表示します。

| オプション | 意味 |
| --- | --- |
| `--resources <glob>` | 対象のリソース |
| `--languages <a,b>` | 対象の言語 ID（進捗の表示を絞る） |

```
$ node apps/cli/dist/index.js status --project /tmp/sample --user-data-dir /tmp/ud
Assets/Text/system/ui.csv
  エントリ 4 / 未保存 0 / 問題 error 1 warning 0 info 0
  textStatus: ja 0/4 (0%)  JaEnglish 0/4 (0%)  zh-Hans 0/4 (0%)  ko 0/4 (0%)
  reviewStatus: ja 0/4 (0%)  JaEnglish 0/4 (0%)  zh-Hans 0/4 (0%)  ko 0/4 (0%)

Assets/Text/chapter01.csv
  エントリ 8 / 未保存 0 / 問題 error 5 warning 6 info 0
  ...
```

進捗の分子は、`complete` の選択肢（既定では「確定」「承認」）の数です。言語 ID の位置の `-` は、行に 1 つの列（言語がない）を表します（`--json` では、言語 ID の位置が `"*"` になります）。`--resources` に一致するリソースがないときは、「対象のリソースがありません。」と出て、終了コードは 0 です。`--json` は `{ "resources": [{ "path", "entries", "unsaved", "issues", "progress": { 列 ID: { 言語 ID: { "complete", "total", "percent" } } } }] }` です。問題があっても終了コードは 0 です。読めないリソース（UTF-8 でない CSV など）は `パス  (読めません: 理由)` と出て（`--json` では該当リソースに `error`、全体に `unreadable`）、ほかのリソースは数え、終了コードは 1 です。

### generate

生成列（`kind: "generated"`、逆翻訳など）を、プロジェクト全体または一部に対して実行します。引数は列の ID で、`generators` の名前ではありません。

| オプション | 意味 |
| --- | --- |
| `--resources <glob>` | 対象のリソース。指定すると 1 リソースにつき 1 ジョブ。省略するとプロジェクト全体で 1 ジョブ。一致するリソースがなければ終了コード 2 |
| `--languages <a,b>` | 対象の言語 ID |
| `--dry-run` | 件数（全体 / キャッシュ済み / 実行する分）だけ表示して終了する。生成器は呼ばれない |

キャッシュにある分は飛ばします。ジョブは進み具合が変わるたびに、標準エラー出力へ 1 行出します。失敗があれば終了コード 1 です。

サービス層は、実行中・待機中のジョブを 1 人あたり 3 つまで、ワークスペース全体で 20 までにしています（1 つのプロセスの中で数えます）。`generate` は、リソースごとのジョブを 1 つずつ始め、終わるのを待ってから次を始めるので、一致するリソースがいくつあってもこの上限には当たりません。6 つのリソースに一致させ、生成に 0.5 秒かかる生成器で実行して、6 つのジョブが順に終わることを確かめました。それでも上限で断られた場合は、最大で約 1 分待ってやり直し、それでも始められなければエラーで終わります。

```
$ node apps/cli/dist/index.js generate reverse --project /tmp/sample --user-data-dir /tmp/ud --dry-run
reverse（ドライラン）: 全体 13 / キャッシュ済み 0 / 実行する分 13
$ node apps/cli/dist/index.js generate reverse --project /tmp/sample --user-data-dir /tmp/ud --resources "**/ui.csv"
reverse: 全体 6 / キャッシュ済み 0 / 生成 6 / 失敗 0
```

（`reverse` は [plugins/generator.md](plugins/generator.md) の列です。）失敗したときは、次のようになります（LLM の生成器で、つながらないエンドポイントを指定した例）。

```
back: 全体 4 / キャッシュ済み 0 / 生成 0 / 失敗 4
エラー: Assets/Text/system/ui.csv: 生成器 "llm.translate" が失敗しました（3 回試行）: llm.translate: http://127.0.0.1:1/v1/chat/completions への接続に失敗しました: fetch failed
```

このとき終了コードは 1 です。`--json` は `{ "columnId", "total", "cached", "generated", "failed", "errors" }`（`--dry-run` では `{ "columnId", "dryRun": true, "total", "cached", "toRun" }`）です。列がない、生成列でない、生成列の生成器が見つからない場合は、終了コード 2 です。

### run

アクションを、リソースに対して実行します。引数は、設定の `actions` にあるアクションの ID です。`target: "review"` のアクション（レビューの転載先）は、`run` では使えません。

| オプション | 意味 |
| --- | --- |
| `--resources <glob>` | 対象のリソース。一致するリソースがなければ終了コード 2 |
| `--languages <a,b>` | 対象の言語 ID（`cell` / `column` 対象は、列 × 言語のセルごとに実行。`row` 対象は、指定すると言語ごとに実行）。`cell` / `column` 対象で省略すると、アクションの `languages`、それもなければ全言語 |
| `--keys <k1,k2>` | 対象のキー（`cell` / `row` / `selection` 対象）。省略すると全行 |
| `--column <id>` | `cell` / `column` 対象のアクションで使う列。省略するとアクションの `columns` |

```
$ node apps/cli/dist/index.js run mystudio.trim --project /tmp/sample --user-data-dir /tmp/ud --user alice --resources "**/ui.csv" --column text --languages ja --keys UI_PAD
Assets/Text/system/ui.csv text@ja: 反映 1
前後の空白を削除（mystudio.trim）: リソース 1 / 反映 1 / 失敗 0
本文の変更は未保存です。save で書き込んでください。
```

（`mystudio.trim` は [plugins/action.md](plugins/action.md) の例です。）

- 本文への変更は、画面と同じく未保存の変更（ドラフト）になります。リソースに書くには、`save` が要ります（ドラフトはその PC の DB に残るので、別のコマンドで `save` できます）。ステータスなどの列への変更は、すぐ共有 DB に保存されます。
- 失敗（反映できない変更、アクションの例外）があれば終了コード 1 です。アクションが見つからない、列がない、などは終了コード 2 です（`アクション "x" は設定の actions にありません（使えるアクション: ...）`）。
- 対象が 20 行を超える `cell` / `row` のアクションは、ジョブとして実行され、進み具合が標準エラー出力に出ます。
- `--json` は `{ "actionId", "patched", "failed", "results": [{ "resource", "cellId"?, "message"?, "patched", "jobDone"?, "jobFailed"?, "errors" }] }` です。

### save

未保存の本文を、すべてのリソースに書き込みます（画面の「すべて保存」と同じ）。書き込む前にリソースの版を確かめ、外部で書き換えられていたら読み直してからドラフトを当て直し、同じセルが食い違っていた分は、書かずに残します（競合）。

```
$ node apps/cli/dist/index.js save --project /tmp/sample --user-data-dir /tmp/ud
保存: リソース 1 / セル 1 / 競合 0
```

競合があれば、標準エラー出力に `N 件の競合があり、書かずに残しました。画面で確かめてください。` と出て、続けて 1 件ずつ `リソース  キー  言語` を出し、終了コード 1 です。`--json` は `{ "resources", "saved", "conflicts", "conflictList": [{ "resourceId", "key", "language" }] }` です。

### set

セルの値を、複数行へ一括で設定します。`set <cellId> <値> --resource <path> --keys k1,k2` です。`--resource`（パスまたは ID）と `--keys` は必須です。セル ID は、行に 1 つの列は `列ID`、言語別の列は `列ID@言語ID`（例: `textStatus@ko`）です。本文の列には使えません（本文の変更は `run` のアクションか画面で行います）。レビュー列、キー、生成列、アクション列、計算列にも使えません。値は常に文字列として渡されるので、`type` が `number` / `boolean` の列に使うと、「列 "priority" の値は number で指定してください（"3"）。」のエラーで終了コード 2 になります。

```
$ node apps/cli/dist/index.js set textStatus@ko done --resource Assets/Text/chapter01.csv --keys CH01_INTRO_001,CH01_INTRO_002 --project /tmp/sample --user-data-dir /tmp/ud --user alice
Assets/Text/chapter01.csv textStatus@ko = done: 更新 2 / ブロック 0
$ node apps/cli/dist/index.js status --project /tmp/sample --user-data-dir /tmp/ud --resources "**/chapter01.csv" --languages ko
Assets/Text/chapter01.csv
  エントリ 8 / 未保存 0 / 問題 error 5 warning 6 info 0
  textStatus: ko 2/8 (25%)
  reviewStatus: ko 0/8 (0%)
```

設定の `validation.blockComplete` が有効で、`complete` の選択肢への変更の対象に問題のある行は、書かずに `ブロック` に数えられ、キーが `ブロックされた行: ...` と出ます（終了コードは 0）。履歴には、`--user` で指定した名前（なければ解決されたユーザー名）で、`cause: bulk` として残ります。`--json` は `{ "resource", "cellId", "value", "updated", "blocked" }` です。

## サーバー管理

`user`、`member`、`server check` は、Web モード（[WEB-MODE.md](WEB-MODE.md)）のアカウントと権限を、画面なしで管理するコマンドです。最初の管理者の作成や、忘れたパスワードの再設定に使います。

これらのコマンドはサーバーの DB を直接開くので、サーバーのマシンで実行します。認証はなく、管理者の権限で動きます。SQLite のサーバーの DB では、サーバーの起動中に実行できることを確かめました。

場所は `--data-dir <dir>`（サーバーのデータフォルダ。環境変数 `LOC_STUDIO_USER_DATA_DIR` と同じ意味）と `--server-config <file>`（既定は環境変数 `LOC_STUDIO_SERVER_CONFIG`、なければ `<データフォルダ>/server.json`）で指定します。どちらも指定せず、環境変数もなければ、終了コード 2 です。環境変数 `LOC_STUDIO_ADMIN_USER` / `LOC_STUDIO_ADMIN_PASSWORD`（最初の管理者の自動作成）は、これらのコマンドでは使いません。

パスワードはコマンドラインの引数では渡せません（シェルの履歴やプロセスの一覧に残るため）。標準入力（`--password-stdin`。末尾の改行は取り除く）か、環境変数（`--password-env <VAR>`）で渡します。パスワードのハッシュとセッションのトークンは、どの出力にも出しません。

ユーザー名は小文字にそろえてから扱います（`Bob` と `bob` は同じユーザー）。英小文字か数字で始まり、英小文字、数字、`. _ @ -` だけの 1〜64 文字で、日本語のユーザー名は使えません。表示名（`--display-name`）には日本語を使えます。パスワードは 8〜1024 文字です。

終了コードは、0 が正常、1 が失敗（設定を読めない、すでにいるユーザーの追加、最後の管理者を守るための拒否など）、2 が使い方と入力の誤り（引数、必須オプションの欠落、ユーザーやプロジェクトが見つからない、使えないユーザー名、パスワードの長さなど）です。

### user

| コマンド | 内容 |
| --- | --- |
| `user list [--json]` | アカウントの一覧（名前、表示名、管理者か、有効か、パスワードの有無） |
| `user add <name> [--display-name <text>] [--admin] [--password-stdin \| --password-env <VAR>]` | 追加する。パスワードの指定がなければ、乱数（24 文字）で作って 1 回だけ表示する（`--json` では `generatedPassword`） |
| `user passwd <name> (--password-stdin \| --password-env <VAR> \| --generate)` | パスワードを変える。そのユーザーのセッションはすべて無効になる。`--generate` は生成して 1 回だけ表示する |
| `user set <name> [--admin \| --no-admin] [--enable \| --disable] [--display-name <text>]` | 管理者、有効・無効、表示名を変える。1 つは指定が必要 |
| `user delete <name> --yes` | 削除する。`--yes` がなければ終了コード 2 |
| `user logout <name>` | そのユーザーのセッションをすべて無効にする |

最後の有効な管理者は、削除、無効化、管理者の解除ができません。`"alice" は最後の有効な管理者なので、無効にすることができません。先に別の管理者を追加（user add --admin）または有効化してください。` のように出て、終了コード 1 です。無効なアカウントは管理者の数に入りません。

```
$ printf 'correct-horse-1' | node apps/cli/dist/index.js user add alice --admin --password-stdin --data-dir /srv/loc/data
追加しました: alice  alice  管理者  有効  パスワードあり
$ node apps/cli/dist/index.js user add Bob --display-name "Bob B" --data-dir /srv/loc/data
追加しました: bob  Bob B  一般  有効  パスワードあり
生成したパスワード: XBf9lUBE...（24 文字）
（表示はこの 1 回だけです。控えてください）
$ node apps/cli/dist/index.js user list --data-dir /srv/loc/data
alice  alice  管理者  有効  パスワードあり
bob  Bob B  一般  有効  パスワードあり
$ printf 'correct-horse-1' | node apps/cli/dist/index.js user add 山田 --password-stdin --data-dir /srv/loc/data
ユーザー名 "山田" は使えません。英数字で始まり、英数字と . _ @ - だけの 1〜64 文字にしてください（大文字小文字は区別せず、小文字にそろえます）。
```

### member

| コマンド | 内容 |
| --- | --- |
| `member list [--project <id>] [--json]` | 割り当ての一覧。ここでの `--project` は、プロジェクトのフォルダではなく、サーバーの設定の `projects[].id` |
| `member set <project> <user> --role <viewer\|translator\|reviewer\|manager> [--languages a,b]` | 役割を割り当てる（すでにあれば置き換える。`--languages` を省くと言語の制限はなくなる） |
| `member remove <project> <user>` | 割り当てを外す |

`member set` と `member remove` には、サーバーの設定にあるプロジェクトだけを指定できます。`member set` のユーザーは存在するものだけです（なければ終了コード 2）。管理者はすべてのプロジェクトで manager として扱われるので、割り当ては要りません。

```
$ node apps/cli/dist/index.js member set mygame bob --role translator --languages JaEnglish,ko --data-dir /srv/loc/data
設定しました: mygame  bob  translator  言語: JaEnglish,ko
$ node apps/cli/dist/index.js member list --project mygame --data-dir /srv/loc/data
mygame  bob  translator  言語: JaEnglish,ko
$ node apps/cli/dist/index.js member set nope bob --role translator --data-dir /srv/loc/data
プロジェクト "nope" はサーバーの設定にありません（mygame）。
```

### server check

サーバーの設定ファイルを読み、サーバーの DB を開き（なければ作ります）、各プロジェクトを Web モードのサーバーと同じ条件（local 層のプラグインなし、`${env:}` は `projects[].env` だけ、プラグインフォルダはプロジェクトとアプリのフォルダの中だけ）で開いて、問題を並べます。確かめるのは、設定の JSON と項目、サーバーの DB を開けること、`auth.proxySecretEnv` の環境変数があること、有効な管理者がいること（`password` モード）、各プロジェクトのフォルダ、プロジェクトの設定、プラグインの読み込みエラーです。プロジェクトの警告も、プロジェクトごとに `警告:` として出します。プロジェクトを実際に開くので、各プロジェクトのフォルダに共有 DB（既定は `.loc-studio/`）が、データフォルダに `workspaces/` ができます。問題があれば終了コード 1 です。`--json` は `{ "ok", "configFile", "dataDir", "problems", "projects": [{ "id", "name", "root", "ok", "error"?, "warnings" }], "auth": {…}, "users": { "total", "admins", "enabledAdmins" } }` です。

```
$ node apps/cli/dist/index.js server check --data-dir /srv/loc/data
設定ファイル: /srv/loc/data/server.json
データフォルダ: /srv/loc/data
認証: password  サーバー DB: /srv/loc/data/server.db
セッション: 最後の利用から 168 時間 / ログインから最長 720 時間
ユーザー: 0（管理者 0、有効な管理者 0）
プロジェクト:
  mygame  MyGame  /srv/loc/mygame  OK
    (mygame の ${env:} で使える環境変数: なし)
問題:
  - 有効な管理者がいません（user add <name> --admin で作成できます）。
$ echo $?
1
```

管理者を作ったあとは、`ユーザー: 1（管理者 1、有効な管理者 1）` と `問題は見つかりませんでした。` が出て、終了コード 0 です。サーバーの DB が Postgres のときは `サーバー DB: postgres` と出ます。

## 使い方の誤りの例

```
$ node apps/cli/dist/index.js foo
不明なコマンドです: foo
詳しくは loc-studio --help を参照してください。
$ echo $?
2
$ node apps/cli/dist/index.js tree --project /nonexistent
プロジェクトを開けませんでした（/nonexistent）: /nonexistent にプロジェクトの設定ファイル（loc-studio.project.json / loc-studio.config.ts / loc-studio.config.mts / loc-studio.config.js / loc-studio.config.mjs）がありません。
$ node apps/cli/dist/index.js set textStatus@ko done --project /tmp/sample
set には --resource <path> が必要です。
```

3 つとも終了コード 2 です。

## CI での使い方の例

```sh
npm ci
npm run build
node apps/cli/dist/index.js validate --project . --fail-on error --json > validation.json
```

`.loc-studio/`（共有 DB）は、`validate` では作られません。`status` などは作るので、CI では `--user-data-dir` に一時フォルダを指定し、`.loc-studio/` を成果物に含めないようにしてください。

## 確かめたこと

このページの出力は、ビルド済みの CLI を、サンプルプロジェクトの一時コピーに対して実行して得たものです。

- プロジェクトのコマンド: `--help`、`plugins`（`--json` を含む）、`tree`（読めないファイルがある場合を含む）、`validate`（`--resources`、`--languages`、`--fail-on`、`--max-issues`、`--json`）、`whoami`（`--user`、`--json`）、`status`（`--resources`、`--languages`、`--json`）、`set`、`save`、`generate`（`--dry-run`、本実行、キャッシュが効く再実行、失敗）、`run`（`--json` を含む）を実行しました。
- 使い方の誤り: 不明なコマンド、使えないオプション、`--fail-on` の不正な値、必須オプションの欠落、プロジェクトがない、存在しない言語を試しました。
- `generate` と `run` の例の `reverse` と `mystudio.trim` は、[plugins/generator.md](plugins/generator.md) と [plugins/action.md](plugins/action.md) の例のプラグインを置いた一時コピーでの出力です。
- サーバー管理のコマンド（`server check`、`user add` / `list` / `set` / `passwd` / `delete`、`member set` / `list`、エラーになる場合を含む）は、一時フォルダの `server.json` と SQLite のサーバーの DB に対して実行しました。
- `server check` は、Postgres のサーバーの DB（PostgreSQL 16）でも実行しました。ただし、出力に「プロジェクトを開く確認」の行が加わる前の版での実行で、いまの版ではやり直していません。
- `save` の競合（終了コード 1）と、20 行を超えるアクションのジョブは、実行していません。説明はコードに基づきます。
