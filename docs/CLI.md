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
| [`init`](#init) | 新しいプロジェクトを作る（設定ファイルを書く） | 作るだけ（最初のファイルを作るときは通す） |
| [`plugins`](#plugins) | 読み込まれたプラグインと登録された実装を表示 | 通さない |
| [`tree`](#tree) | リソースのツリーをエントリ数とフォーマットつきで表示 | 通さない |
| [`validate`](#validate) | プロジェクトを検証 | 通さない |
| [`whoami`](#whoami) | 解決されたユーザー名と出所 | 通さない |
| [`status`](#status) | リソースごとの件数、未保存、問題、進捗 | 通す |
| [`query`](#query) | 条件に合う行を数え、集計し、CSV / TSV に書き出す | 通す |
| [`generate <columnId>`](#generate) | 生成列を一括で実行 | 通す |
| [`run <actionId>`](#run) | アクションを実行 | 通す |
| [`save`](#save) | 未保存の本文をすべて書き込む | 通す |
| [`set <cellId> <値>`](#set) | セルの値を複数行へ一括で設定 | 通す |
| [`entry add` / `remove` / `rename`](#entry) | 行を足す、消す、キーを変える | 通す |
| [`resource create <path>`](#resource-create) | 行のない新しいリソースを作る | 通す |
| [`user ...`](#サーバー管理) | サーバー（Web モード）のアカウントを管理 | サーバーの DB を直接開く |
| [`member ...`](#サーバー管理) | プロジェクトごとの役割を管理 | 同上 |
| [`server check`](#サーバー管理) | サーバーの設定、DB、プロジェクトを確かめる | 同上 |
| `help` | 使い方を表示 | |

「通す」のコマンドは、画面と同じサービス層（`packages/server`）を通るので、変更履歴、生成結果のキャッシュ、未保存の変更（ドラフト）を画面のローカルモードと共有します。共有 DB（既定は `.loc-studio/meta.db`。設定 `storage` で Postgres にもできる）とその PC の DB を開くので、画面を同時に開いていても同じ DB を使います。「通さない」のコマンドは DB を作らず、ホストの DB はメモリ上のものになります。

どのコマンドも、同梱プラグイン（`@loc-studio/builtin`、`@loc-studio/plugin-llm`）とプロジェクトのプラグインを読みます。コマンドラインは利用者が自分で実行するものなので、プロジェクトと個人のフォルダのプラグインも、プロジェクトのコードの設定（`loc-studio.config.*`）も、確認なしで読み込みます（`pluginTrust: "always"`）。設定ファイル（`loc-studio.project.json`）も確認なしで使うので、そこに書かれた保存先や接続先に、そのまま接続します。画面のローカルモードと違い、信頼の確認も import の条件の確認もしません。知らないプロジェクトに CLI を使うときは、先に設定ファイル、プラグインフォルダ、コードの設定の中身を確かめてください。

### init

新しいプロジェクトを作ります。`--project` のフォルダ（なければ作ります）に、設定ファイル `loc-studio.project.json` を書きます。画面の「新しいプロジェクトを作る」と同じ処理です。すでにプロジェクトのあるフォルダ（`loc-studio.project.json` か `loc-studio.config.*` がある）には作らず、設定ファイルも変えません。

| オプション | 意味 |
| --- | --- |
| `--languages <a=名前,b=名前>` | 言語の ID と表示名（必須）。表示名を省くと ID が表示名になります。最初の言語を原文にして表の固定側に置き、ほかの言語はそこから翻訳する設定（`basedOn`）にします。ID に使えるのは、半角の英数字と `-` `_`（40 文字まで）です。`any` と `all` は、条件式の語なので使えません |
| `--name <text>` | プロジェクトの名前。省略時はフォルダの名前 |
| `--resource <path>` | 最初のファイルも作ります（`.csv` か `.tsv`）。キーの列と、言語ごとの本文の列だけがある、行のないファイルです |
| `--key-column <見出し>` | すでにある CSV / TSV の、キーの列。省略時は先頭の列 |
| `--text-columns <a=見出し,b=見出し>` | すでにある CSV / TSV の、言語ごとの本文の列。書かなかった言語は、言語 ID と同じ見出しの列を使います |
| `--encoding <名前>` | すでにある CSV / TSV の文字コード（`auto` / `utf-8` / `utf-16le` / `utf-16be` / `shift_jis`）。省略時は `auto` |
| `--no-status` / `--no-review` / `--no-validators` | 進捗の列、レビューの列、同梱の検証（空白、未翻訳）を付けません |

```
$ node apps/cli/dist/index.js init --project /tmp/my-game --name "My Game" --languages "ja=日本語,en=English,ko=한국어" --resource text/main.csv --user-data-dir /tmp/ud
プロジェクトを作りました: /tmp/my-game
  設定ファイル: /tmp/my-game/loc-studio.project.json
  最初のファイル: text/main.csv
画面で開くか、loc-studio tree --project "/tmp/my-game" で中身を確かめられます。
$ cat /tmp/my-game/text/main.csv
key,ja,en,ko
$ node apps/cli/dist/index.js tree --project /tmp/my-game --user-data-dir /tmp/ud
My Game/
  text/
    main.csv  0 件  [builtin.csv]
$ node apps/cli/dist/index.js entry add TITLE --resource text/main.csv --text "ja=はじめる" --project /tmp/my-game --user-data-dir /tmp/ud
text/main.csv: 行 TITLE を追加（1 行）
```

できる設定ファイルは次の形です（上の例。`--no-*` を付けると、`columns` や `validators` を書きません）。

```json
{
  "name": "My Game",
  "languages": [
    { "id": "ja", "label": "日本語", "pinned": true },
    { "id": "en", "label": "English", "basedOn": "ja" },
    { "id": "ko", "label": "한국어", "basedOn": "ja" }
  ],
  "columns": [
    { "use": "builtin.key", "id": "key" },
    { "use": "builtin.text", "id": "text" },
    { "use": "builtin.textStatus", "id": "textStatus" },
    { "use": "builtin.reviewStatus", "id": "reviewStatus", "of": "text" }
  ],
  "validators": ["builtin.whitespace", "builtin.untranslated"]
}
```

すでに CSV のあるフォルダでは、列の対応を指定します。次は、見出しが `Note,ID,JP,EN` のファイルがあるフォルダの例です。設定ファイルに `formats`（CSV と TSV の `key` と `text`）が入ります。すでにあるファイルは書き換えません。

```
$ node apps/cli/dist/index.js init --project /tmp/existing --languages "ja=日本語,en=English" --key-column ID --text-columns "ja=JP,en=EN" --user-data-dir /tmp/ud
プロジェクトを作りました: /tmp/existing
  設定ファイル: /tmp/existing/loc-studio.project.json
画面で開くか、loc-studio tree --project "/tmp/existing" で中身を確かめられます。
$ node apps/cli/dist/index.js query --project /tmp/existing --where "text@en = Yes" --user-data-dir /tmp/ud
条件に合う行: 1 / 1 行（原文 2 文字 / 1 語）
  Text/ui.csv: 1 / 1
```

`formats` は、画面で開くときに確認の対象になる項目です。`init` は、いま書いた中身を確認済みとしてローカル設定（`--user-data-dir` の `settings.json`。省略時は既定のローカル設定）に記録するので、同じ設定フォルダを使う画面では、開くときに確認が出ません。あとでその項目を書き換えると、確認が出ます。

すでにプロジェクトのあるフォルダでは終了コード 1、入力の誤りは終了コード 2 で、どちらも何も作りません。

```
$ node apps/cli/dist/index.js init --project /tmp/my-game --languages ja
/tmp/my-game には、すでにプロジェクトの設定ファイル（loc-studio.project.json）があります。新しく作らずに、既存のプロジェクトとして開いてください。
$ node apps/cli/dist/index.js init --project /tmp/bad --languages "ja jp"
言語の ID "ja jp" は使えません。半角の英数字で始め、英数字と - _ だけの 40 文字までにしてください（例: ja、en、zh-Hans）。
$ node apps/cli/dist/index.js init --project /tmp/bad
init には --languages が必要です（例: --languages ja=日本語,en=English。最初の言語が原文）。
詳しくは loc-studio --help を参照してください。
```

`--json` を付けると、`{ "project", "configFile", "config", "resource"? }` を返します。

### plugins

読み込まれたプラグイン、登録された実装、探したフォルダ、読み込みエラー、警告を表示します。オプションはありません（共通のオプションのみ）。読み込みエラーがあると終了コード 1 です。

```
$ node apps/cli/dist/index.js plugins --project /tmp/sample --user-data-dir /tmp/ud
プラグイン:
  @loc-studio/builtin  0.1.0  [builtin]  (同梱)
  @loc-studio/plugin-llm  0.2.0  [builtin]  (同梱)
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
    llm.evaluate  <- @loc-studio/plugin-llm [builtin]
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

進捗の分子は、`complete` の選択肢（既定では「確定」「承認」）の数です。設定の `grid.progressUnit` が `characters` か `words` のときは、行数ではなく原文の文字数（語数）で数え、先頭に「進捗は、原文の文字数で数えています。」と出ます（`--json` では、全体の `progressUnit` に単位が入ります）。言語 ID の位置の `-` は、行に 1 つの列（言語がない）を表します（`--json` では、言語 ID の位置が `"*"` になります）。`--resources` に一致するリソースがないときは、「対象のリソースがありません。」と出て、終了コードは 0 です。`--json` は `{ "resources": [{ "path", "entries", "unsaved", "issues", "progress": { 列 ID: { 言語 ID: { "complete", "total", "percent" } } } }] }` です。問題があっても終了コードは 0 です。読めないリソース（UTF-8 でない CSV など）は `パス  (読めません: 理由)` と出て（`--json` では該当リソースに `error`、全体に `unreadable`）、ほかのリソースは数え、終了コードは 1 です。

### query

条件に合う行を、リソースをまたいで数え、欄の値ごとに集計し、CSV / TSV に書き出します。条件は、画面の「条件」と同じ式です（書き方は [QUERY.md](QUERY.md#条件式の書き方)）。

| オプション | 意味 |
| --- | --- |
| `--where <式>` | 条件式。省略時は、すべての行 |
| `--resources <glob>` | 対象のリソース |
| `--languages <a,b>` | 対象の言語 ID。式の `@any` / `@all`（と、言語を省いた欄）が見る言語で、出力する列の言語でもある。省略時は、すべての言語 |
| `--group-by <欄,欄>` | 集計の区切り。値ごとの行数と、原文の文字数・語数を出す（4 つまで） |
| `--limit <n>` | 表示する行の数（既定は 0 で、数と集計だけを出す。2000 まで） |
| `--format <csv\|tsv>` | 条件に合う行を、CSV / TSV で出力する。`--group-by` があれば、行ではなく集計を出力する |
| `--columns <a,b>` | 出力するセルの ID（`text@ja,textStatus@ko` など）。省略時は、対象の言語のすべての列 |
| `--out <file>` | `--format` の出力先のファイル（省略時は標準出力） |
| `--bom` | `--format` の出力の先頭に BOM を付ける（表計算ソフトで開くとき） |

```
$ node apps/cli/dist/index.js query --project /tmp/sample --user-data-dir /tmp/ud --where "issues >= error"
条件に合う行: 5 / 12 行（原文 43 文字 / 6 語）
  Assets/Text/system/ui.csv: 1 / 4
  Assets/Text/chapter01.csv: 4 / 8
```

1 行目は、条件に合う行の数、対象の行の数、合う行の原文の量です。続けて、合う行のあるリソースを、合う行の数と全体の行数で並べます。原文の量は、最初の原文の言語（`basedOn` のない最初の言語）の本文で量ります。

`--group-by` を付けると、その欄の値ごとの集計が加わります。選択式の列は、選択肢の並び順に、表示名で出ます。

```
$ node apps/cli/dist/index.js query --project /tmp/sample --user-data-dir /tmp/ud --group-by textStatus@ko
条件に合う行: 12 / 12 行（原文 129 文字 / 15 語）
  Assets/Text/system/ui.csv: 4 / 4
  Assets/Text/chapter01.csv: 8 / 8

集計（textStatus@ko）:
  未着手: 10 行（122 文字 / 13 語）
  確定: 2 行（7 文字 / 2 語）
```

`--limit` を付けると、合う行を、リソースの並び順、その中の行の順に出します。値のないセルは出しません。

```
$ node apps/cli/dist/index.js query --project /tmp/sample --user-data-dir /tmp/ud --where "text@ko is empty or issues@ko >= error" --limit 2 --columns text@ja,text@ko
条件に合う行: 2 / 12 行（原文 18 文字 / 2 語）
  Assets/Text/chapter01.csv: 2 / 8

行:
  Assets/Text/chapter01.csv  CH01_CHOICE_001A
    text@ja: <b>信じる</b>
    text@ko: <b>믿는다
  Assets/Text/chapter01.csv  CH01_CHOICE_001B
    text@ja: ……信じられるか
```

`--format` を付けると、数の表示の代わりに、合う行（`--group-by` があれば集計）を CSV / TSV で出力します。見出しと値の書き方は [QUERY.md の書き出しの形](QUERY.md#書き出しの形) にあります。

```
$ node apps/cli/dist/index.js query --project /tmp/sample --user-data-dir /tmp/ud --where 'key ~ "UI_" and textStatus@ko = done' --format csv --columns text@ja,text@ko,textStatus@ko
resource,key,text@ja,text@ko,textStatus@ko
Assets/Text/system/ui.csv,UI_OK,決定,확인,done
Assets/Text/system/ui.csv,UI_CANCEL,キャンセル,취소,done

$ node apps/cli/dist/index.js query --project /tmp/sample --user-data-dir /tmp/ud --where "text@ko is empty" --format csv --columns text@ja,text@ko --out /tmp/untranslated.csv --bom
1 行を書き出しました: /tmp/untranslated.csv

$ node apps/cli/dist/index.js query --project /tmp/sample --user-data-dir /tmp/ud --format csv --group-by resource,issues@ko
resource,issues@ko,rows,characters,words
Assets/Text/chapter01.csv,none,5,50,6
Assets/Text/chapter01.csv,warning,2,42,3
Assets/Text/chapter01.csv,error,1,10,1
Assets/Text/system/ui.csv,none,4,27,5
```

`--json` は、サービス層の `query` の結果（`{ "matched": { "rows", "characters", "words" }, "totalRows", "resources": [{ "resourceId", "path", "matched", "total" }], "unreadable", "groups", "rows" }`）をそのまま出します。`--format` と `--json` は、同時には指定できません。

式や引数の誤りは、何が違うかを出して、終了コード 2 で終わります。読めないリソースがあると、`パス  (読めません: 理由)` と出て（`--json` では `unreadable`）、ほかのリソースは数え、終了コードは 1 です。

```
$ node apps/cli/dist/index.js query --project /tmp/sample --user-data-dir /tmp/ud --where "textStatus@ko = finished"
条件式の "textStatus@ko = finished": 列 "textStatus" に選択肢 "finished" はありません（選べる値: todo, wip, done）。
```

### generate

生成列（`kind: "generated"`、逆翻訳など）を、プロジェクト全体または一部に対して実行します。引数は列の ID で、`generators` の名前ではありません。

| オプション | 意味 |
| --- | --- |
| `--resources <glob>` | 対象のリソース。指定すると 1 リソースにつき 1 ジョブ。省略するとプロジェクト全体で 1 ジョブ。一致するリソースがなければ終了コード 2 |
| `--languages <a,b>` | 対象の言語 ID |
| `--keys <k1,k2>` | 対象のキー。そのキーの行だけを、その行のあるリソースで生成する。どのリソースにもなければ終了コード 2。`--where` とは併用できない |
| `--where <式>` | 条件に合う行だけを生成する。式は `query` と同じ（[QUERY.md](QUERY.md#条件式の書き方)）。`--resources` を省くと、プロジェクトのすべてのリソースから、条件に合う行を探す |
| `--batch-size <n>` | 生成器に 1 回で渡す件数（1 以上 1000 以下の整数）。省略すると、生成器の既定（同梱の `llm.translate` と `llm.evaluate` は 1 件ずつ） |
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

`--where` は、条件に合う行だけを生成します。式の中で言語を書かない欄は、`--languages` の言語だけを見ます（省くと、すべての言語）。まだ生成していない行だけを生成する、検証の問題のある行だけを評価し直す、といった使い方ができます。`--batch-size` は、外部の API に、何件分を 1 回で送るかを決めます。

次は、同梱の LLM の生成器（[CONFIG.md の generators](CONFIG.md#llm-で機械翻訳と翻訳の評価をする)）で、機械翻訳の列 `mt` と、翻訳の評価の列 `mtCheck` を、サンプルのプロジェクトの韓国語に足したときの出力です。接続先は、手元に立てた OpenAI 互換のサーバー（決まった返事を返すもの）です。

```
$ node apps/cli/dist/index.js generate mt --project /tmp/sample --user-data-dir /tmp/ud --dry-run --languages ko
mt（ドライラン）: 全体 11 / キャッシュ済み 0 / 実行する分 11
$ node apps/cli/dist/index.js generate mt --project /tmp/sample --user-data-dir /tmp/ud --languages ko --resources "**/ui.csv"
mt: 全体 4 / キャッシュ済み 0 / 生成 4 / 失敗 0
$ node apps/cli/dist/index.js generate mt --project /tmp/sample --user-data-dir /tmp/ud --languages ko --where "mt@ko is empty" --batch-size 4
mt: 全体 7 / キャッシュ済み 0 / 生成 7 / 失敗 0
$ node apps/cli/dist/index.js generate mtCheck --project /tmp/sample --user-data-dir /tmp/ud --languages ko --batch-size 5
mtCheck: 全体 11 / キャッシュ済み 0 / 生成 11 / 失敗 0
```

2 つ目の実行は、`ui.csv` の 4 行を 1 件ずつ送りました（要求 4 回）。3 つ目は、まだ機械翻訳のない 7 行を、4 件ずつにまとめて送りました（4 件と 3 件の、要求 2 回）。4 つ目は、11 行の評価を、5 件ずつにまとめて送りました（5 件、5 件、1 件の、要求 3 回）。評価の結果は、`query` で数えたり、絞り込んだりできます。

```
$ node apps/cli/dist/index.js query --project /tmp/sample --user-data-dir /tmp/ud --languages ko --group-by mtCheck@ko
条件に合う行: 12 / 12 行（原文 129 文字 / 15 語）
  Assets/Text/system/ui.csv: 4 / 4
  Assets/Text/chapter01.csv: 8 / 8

集計（mtCheck@ko）:
  OK: 8 行（99 文字 / 11 語）
  WARNING: 2 行（17 文字 / 2 語）
  NG: 1 行（5 文字 / 1 語）
  （空）: 1 行（8 文字 / 1 語）
$ node apps/cli/dist/index.js query --project /tmp/sample --user-data-dir /tmp/ud --languages ko --where "mtCheck@ko >= WARNING" --limit 5 --columns text@ja,text@ko,mtCheck@ko
条件に合う行: 3 / 12 行（原文 22 文字 / 3 語）
  Assets/Text/system/ui.csv: 2 / 4
  Assets/Text/chapter01.csv: 1 / 8

行:
  Assets/Text/system/ui.csv  UI_CANCEL
    text@ja: キャンセル
    text@ko: 취소
    mtCheck@ko: NG
  Assets/Text/system/ui.csv  UI_SAVE_CONFIRM
    text@ja: セーブしますか？
    text@ko: 저장하시겠습니까?
    mtCheck@ko: WARNING
  Assets/Text/chapter01.csv  CH01_INTRO_002
    text@ja: ここは……どこだ？
    text@ko: 여기는…… 어디지?
    mtCheck@ko: WARNING
```

「（空）」の 1 行は、韓国語の本文が空で、評価していない行です。判定は、この確認用のサーバーが訳文の文字から機械的に決めたもので、実際のモデルの判定ではありません。

### run

アクションを、リソースに対して実行します。引数は、設定の `actions` にあるアクションの ID です。`target: "review"` のアクション（レビューの転載先）は、`run` では使えません。

| オプション | 意味 |
| --- | --- |
| `--resources <glob>` | 対象のリソース。一致するリソースがなければ終了コード 2 |
| `--languages <a,b>` | 対象の言語 ID（`cell` / `column` 対象は、列 × 言語のセルごとに実行。`row` 対象は、指定すると言語ごとに実行）。`cell` / `column` 対象で省略すると、アクションの `languages`、それもなければ全言語 |
| `--keys <k1,k2>` | 対象のキー（`cell` / `row` / `selection` 対象）。省略すると全行 |
| `--where <式>` | 条件に合う行だけを対象にする（`cell` / `row` / `selection` 対象）。式は `query` と同じ（[QUERY.md](QUERY.md#条件式の書き方)）。`--keys` とは併用できない |
| `--column <id>` | `cell` / `column` 対象のアクションで使う列。省略するとアクションの `columns` |
| `--batch-size <n>` | 1 回の呼び出しにまとめる行の数（1 以上 1000 以下の整数。既定は 1 行ずつ）。2 以上は、複数の行をまとめて受け取れるアクション（`runBatch` を実装した `cell` / `row` 対象のアクション。[plugins/action.md](plugins/action.md#行をまとめて受け取るrunbatch)）だけで使える。ほかのアクションに付けると終了コード 2 |

```
$ node apps/cli/dist/index.js run mystudio.trim --project /tmp/sample --user-data-dir /tmp/ud --user alice --resources "**/ui.csv" --column text --languages ja --keys UI_PAD
Assets/Text/system/ui.csv text@ja: 反映 1
前後の空白を削除（mystudio.trim）: リソース 1 / 反映 1 / 失敗 0
本文の変更は未保存です。save で書き込んでください。
```

（`mystudio.trim` は [plugins/action.md](plugins/action.md) の例です。）

`--where` を付けると、条件に合う行だけに実行します。`--resources` を省くと、プロジェクトのすべてのリソースから、条件に合う行を探します（合う行のないリソースは、結果に出ません）。先に `query --where` で同じ式を試すと、対象になる行を、実行する前に確かめられます。

```
$ node apps/cli/dist/index.js run mystudio.trim --project /tmp/sample --user-data-dir /tmp/ud --user alice --column text --languages ja --where "key ~ PAD"
Assets/Text/system/ui.csv text@ja: 条件に合う行 1 / 反映 1
Assets/Text/chapter01.csv text@ja: 条件に合う行 1 / 反映 1
前後の空白を削除（mystudio.trim）: リソース 2 / 条件に合う行 2 / 反映 2 / 失敗 0
本文の変更は未保存です。save で書き込んでください。
```

- 式の中で言語を書かない欄（`text ~ 王都` のような、どれかの言語を見る書き方）は、`--languages` の言語だけを見ます。`--languages` を省くと、すべての言語です。
- 条件に合う行が 1 つもないときは、`条件に合う行がありません。` と出して、終了コード 0 で終わります。
- `file` / `column` 対象のアクションは、ファイルや列の全体が対象なので、`--where` は使えません（終了コード 2）。対象のファイルは `--resources` で絞ります。
- `--where` と `--keys` を両方付けたとき、式に誤りがあるときも、終了コード 2 です（何も実行しません）。

- 本文への変更は、画面と同じく未保存の変更（ドラフト）になります。リソースに書くには、`save` が要ります（ドラフトはその PC の DB に残るので、別のコマンドで `save` できます）。ステータスなどの列への変更は、すぐ共有 DB に保存されます。
- 失敗（反映できない変更、アクションの例外）があれば終了コード 1 です。アクションが見つからない、列がない、などは終了コード 2 です（`アクション "x" は設定の actions にありません（使えるアクション: ...）`）。
- 対象が 20 行を超える `cell` / `row` のアクションは、ジョブとして実行され、進み具合が標準エラー出力に出ます。
- `--json` は `{ "actionId", "matched"?, "patched", "failed", "results": [{ "resource", "cellId"?, "matched"?, "message"?, "patched", "jobDone"?, "jobFailed"?, "errors" }] }` です。`matched`（条件に合った行の数）は、`--where` を付けたときだけ入ります。

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

### entry

行を足す、消す、キーを変えるコマンドです。どれも、すぐリソースに書きます。`--resource`（パスまたは ID）は必須です。

| 書き方 | 内容 |
| --- | --- |
| `entry add <key> --resource <path> [--after <key>] [--text <言語 ID>=<本文> ...]` | 行を足す。`--after` を省くと末尾に足す。`--text` は言語ごとに繰り返せる（本文に `=` があってもよい） |
| `entry rename <key> <newKey> --resource <path>` | キーを変える。ステータス、レビュー、履歴、未保存の編集は、新しいキーに引き継ぐ |
| `entry remove --resource <path> --keys <k1,k2>` | 行を消す。ステータスなどの記録は残り、同じキーの行を足し直すと戻る |

```
$ node apps/cli/dist/index.js entry add UI_RETRY --resource Assets/Text/system/ui.csv --after UI_OK --text ja=もう一度 --text JaEnglish=Retry --project /tmp/sample --user-data-dir /tmp/ud
Assets/Text/system/ui.csv: 行 UI_RETRY を追加（5 行）
$ node apps/cli/dist/index.js entry rename UI_RETRY UI_AGAIN --resource Assets/Text/system/ui.csv --project /tmp/sample --user-data-dir /tmp/ud
Assets/Text/system/ui.csv: キー UI_RETRY を UI_AGAIN に変更（5 行）
$ node apps/cli/dist/index.js entry remove --resource Assets/Text/system/ui.csv --keys UI_AGAIN,UI_GOLD --project /tmp/sample --user-data-dir /tmp/ud
Assets/Text/system/ui.csv: 2 行を削除（UI_AGAIN, UI_GOLD）（3 行）
```

当てられない変更（すでにあるキー、ない行）は、理由を標準エラー出力に出して、終了コード 1 です。リソースは変わりません。複数の変更を 1 回で渡したとき（`remove` の `--keys`）は、1 つでも当てられなければ、どれも当てません。

```
$ node apps/cli/dist/index.js entry add UI_OK --resource Assets/Text/system/ui.csv --project /tmp/sample --user-data-dir /tmp/ud
リソース Assets/Text/system/ui.csv の行を変えられませんでした（フォーマット "builtin.csv"）: add: キー「UI_OK」は既にあります（Assets/Text/system/ui.csv）。
```

行の変更に対応していないフォーマットのリソースでも、終了コード 1 で、リソースは変わりません。`--json` を付けると、当てた変更と、変更後の行数を返します。

### resource create

行のない新しいリソースを作ります。場所は、拡張子まで書きます。フォーマットは場所から決まり（設定の `formats` の `match`、またはフォーマットの `match`）、見出しなどの中身はフォーマットが作ります。

```
$ node apps/cli/dist/index.js resource create Assets/Text/dlc/new.csv --project /tmp/sample --user-data-dir /tmp/ud
リソースを作りました: Assets/Text/dlc/new.csv
$ cat /tmp/sample/Assets/Text/dlc/new.csv
ID,JP,EN,CN,KR,MaxLen
```

すでにあるリソースは上書きせず、終了コード 1 です（`リソース Assets/Text/dlc/new.csv はすでにあります。`）。上の階層に出る書き方（`..`）、ツリーの対象に入らない場所、フォーマットの決まらない拡張子、作成に対応していないツリーやフォーマットでは、何も作らずに終わります（使い方の誤りは終了コード 2）。

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
| `member set <project> <user> --role <役割の ID> [--languages a,b]` | 役割を割り当てる（すでにあれば置き換える。`--languages` を省くと言語の制限はなくなる）。役割は、そのプロジェクトの役割（同梱の `viewer` / `translator` / `reviewer` / `manager` と、プロジェクト設定の `roles`）のどれか。ほかの値は終了コード 2 |
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
- `entry add` / `rename` / `remove` と `resource create` の出力は、2026-11-15 に Windows 11（Node.js 26.5.1）で、サンプルプロジェクトの一時コピーに対して実行して得たものです。
- `query` の出力は、2026-11-16 に Windows 11（Node.js 26.5.1）で、サンプルプロジェクトの一時コピーに対して実行して得たものです（`--where`、`--group-by`、`--limit`、`--columns`、`--format csv`、`--out`、`--bom`、誤った式）。集計の例は、先に `set textStatus@ko done --keys UI_OK,UI_CANCEL` を実行したあとの出力です。書き出し先のパスは、例に合わせて書き換えています。読めないリソースがある場合と、`--format tsv` は、テストで確かめただけです。
- `init` の出力は、2026-11-16 に Windows 11（Node.js 26.5.1）で、リポジトリの中の一時フォルダに対して実行して得たものです（新しいフォルダ、すでに CSV のあるフォルダ、すでにプロジェクトのあるフォルダ、誤った言語 ID、`--languages` の欠落）。パスは、例に合わせて書き換えています。`--encoding`、`--no-*`、`--json` は、テストで確かめただけです。
- `run --where` の出力は、2026-11-16 に Windows 11（Node.js 26.5.1）で、サンプルプロジェクトの一時コピー（[plugins/action.md](plugins/action.md) の `mystudio.trim` を置き、前後に空白のある行を `entry add` で 2 つのリソースに足したもの）に対して実行して得たものです。条件に合う行がない場合、`--keys` との併用、誤った式、`--json` も実行しました。`file` 対象のアクションに `--where` を付けた場合は、テストで確かめただけです。
- `generate` の `--where`、`--batch-size` と、同梱の LLM の生成器（`llm.translate`、`llm.evaluate`）の出力は、2026-11-18 に Windows 11 で、サンプルプロジェクトの一時コピーに、機械翻訳の列と翻訳の評価の列を足し、手元に立てた OpenAI 互換のサーバー（決まった返事を返すもの）を接続先にして実行して得たものです。要求の回数と、まとめた件数は、そのサーバーが受けた要求から数えました。`generate --keys` も同じ構成で実行しました。実際の LLM の API には、接続していません。
- `run --batch-size` は、テストで確かめただけです（`apps/cli/src/batch.test.ts`。行をまとめて受け取れるアクションを、3 行ずつにまとめて呼ぶこと、まとめて受け取れないアクションでは終了コード 2 になること）。
- `save` の競合（終了コード 1）と、20 行を超えるアクションのジョブは、実行していません。説明はコードに基づきます。
