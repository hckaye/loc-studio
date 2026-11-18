# @loc-studio/builtin の使い方

`@loc-studio/builtin` は、プロジェクトのフォルダにある CSV / TSV を読み書きし、本文の中の変数とタグを見分け、本文を検証し、進捗ステータスとレビューを共有 DB に記録するための実装をまとめた、同梱のプラグインです。設定に書ける値の一覧は [settings.md](settings.md) にあります。

コマンドは、loc-studio のリポジトリのルートで実行します（前もって `npm install` と `npm run build` を済ませます）。`<プロジェクト>` は、`loc-studio.project.json` のあるフォルダのパスです。

## 登録される実装

| 種類 | ID | すること |
| --- | --- | --- |
| ツリー | `builtin.globTree` | プロジェクトのフォルダを走査して、リソース（ファイル）の階層を作る。リソースの読み書きと作成もする |
| フォーマット | `builtin.csv`、`builtin.tsv` | CSV（`.csv`）と TSV（`.tsv`）を行に分け、変更したフィールドだけを書き戻す |
| 記法 | `builtin.braces`、`builtin.printf`、`builtin.tags` | 本文の中の `{name}`、`%s`、`<b>` などを、変数やタグとして見分ける |
| バリデータ | `builtin.placeholders`、`builtin.tagBalance`、`builtin.maxLength`、`builtin.whitespace`、`builtin.untranslated` | 変数とタグの過不足、タグの対応、文字数の上限、空白、未翻訳を指摘する |
| 列ソース | `builtin.db`、`builtin.reviews` | 列の値を共有 DB に置く。レビューの投稿を共有 DB に追記する |
| 列 | `builtin.key`、`builtin.text`、`builtin.textStatus`、`builtin.reviewStatus`、`builtin.length` | キー、本文、進捗ステータス、レビュー、文字数の列の定義 |

フック、アクション、生成器、独自描画は、このプラグインにはありません。

## 設定を書かずに使える範囲

言語だけを書いた設定ファイルでも、プロジェクトは開けます。ツリー、フォーマット、記法は、設定に書かなければ同梱の実装が使われるためです。

`<プロジェクト>/loc-studio.project.json`:

```json
{
  "languages": [
    { "id": "ja", "label": "日本語" },
    { "id": "en", "label": "English", "basedOn": "ja" }
  ]
}
```

`<プロジェクト>/text/main.csv`:

```csv
key,ja,en
HELLO,こんにちは、{name}さん,"Hello, {name}"
BYE,さようなら,
BOLD,<b>重要</b>,<b>Important
SPACE,保存しますか？, Save?
```

この状態で、次のことが決まっています。

- リソースは、プロジェクトのフォルダ以下の、拡張子が `.csv` と `.tsv`（小文字）のファイルです（`node_modules`、`.git`、`.loc-studio`、`loc-studio-plugins` の中は除きます）。
- CSV の先頭の列がキーで、見出しが言語の ID と同じ列が、その言語の本文です。
- 表の列は「キー」と「本文」の 2 つです。
- 検証は、何も選んでいないので、何も指摘しません。

```
$ node apps/cli/dist/index.js tree --project <プロジェクト>
minimal/
  text/
    main.csv  4 件  [builtin.csv]
$ node apps/cli/dist/index.js validate --project <プロジェクト>
検証したセル: 8（問題のあるセル: 0）、リソース: 1
error 0 / warning 0 / info 0
```

（`minimal` は、この例のプロジェクトのフォルダ名です。）

## 検証を選ぶ

バリデータは、設定の `validators` に ID を書いたものだけが動きます。次の設定は、5 つすべてを選び、英語の本文にだけ 8 文字の上限を付けます。

```json
"validators": [
  "builtin.placeholders",
  "builtin.tagBalance",
  { "use": "builtin.maxLength", "options": { "max": 8 }, "languages": ["en"] },
  "builtin.whitespace",
  "builtin.untranslated"
]
```

```
$ node apps/cli/dist/index.js validate --project <プロジェクト>
text/main.csv
  warning BYE  en  builtin.untranslated  empty  訳文が空です。
  error   BOLD  en  builtin.placeholders  placeholder-missing  原文にある </b> が足りません（原文 1 個、訳文 0 個）。
  error   BOLD  en  builtin.tagBalance  tag-unclosed  <b> が閉じられていません。
  error   BOLD  en  builtin.maxLength  too-long  文字数が上限を超えています（9 文字、上限 8 文字）。
  warning SPACE  en  builtin.whitespace  leading-space  先頭に空白があります。

検証したセル: 8（問題のあるセル: 3）、リソース: 1
error 3 / warning 2 / info 0
```

それぞれのバリデータが見るものは次のとおりです。

| バリデータ | 見るもの | 上の例で指摘した理由 |
| --- | --- | --- |
| `builtin.placeholders` | 基にする言語（`basedOn`）の本文と比べて、変数とタグの数が合っているか | `BOLD` の英語に `</b>` がない |
| `builtin.tagBalance` | 開始タグと終了タグが対応し、入れ子の順が正しいか | `BOLD` の英語の `<b>` が閉じていない |
| `builtin.maxLength` | 文字数が上限を超えていないか。既定では、変数とタグを除いた部分を数える | `<b>Important` の本文の部分は `Important` の 9 文字 |
| `builtin.whitespace` | 先頭と末尾の空白、連続した半角スペース | `SPACE` の英語が空白で始まっている |
| `builtin.untranslated` | 訳文が空、または原文と同じ | `BYE` の英語が空 |

`builtin.placeholders` と `builtin.untranslated` は、基にする言語と比べる検証なので、`basedOn` のない言語（原文の言語）には何も指摘しません。変数とタグの見分け方は、設定の `syntaxes` で選んだ記法が決めます（書かなければ、同梱の 3 つすべて）。本文に出てくる `%s` の形を変数として扱いたくないプロジェクトは、`"syntaxes": ["builtin.braces", "builtin.tags"]` のように、使う記法だけを書きます。

行ごとに違う上限を使うときは、CSV に上限の列を作り、フォーマットの `columns` で対応づけます（[CSV の見出しを言語と列に対応させる](#csv-の見出しを言語と列に対応させる)）。空白の指摘には修正案が付いていて、画面の編集のモーダルでは、検証結果の横に「先頭の空白を削除」などのボタンが出ます。

## 進捗ステータス、レビュー、文字数の列を出す

列は、設定の `columns` に並べたものが表に出ます。同梱の列は `use` で選び、短い `id` を付けます。

```json
"columns": [
  { "use": "builtin.key", "id": "key" },
  { "use": "builtin.text", "id": "text" },
  { "use": "builtin.length", "id": "length" },
  { "use": "builtin.textStatus", "id": "textStatus" },
  { "use": "builtin.reviewStatus", "id": "reviewStatus", "of": "text" }
]
```

`columns` を書くと、書いた列だけが出ます。キーと本文の列も、書かないと出ません。

| 列 | 表示名 | 値 | 値の置き場所 |
| --- | --- | --- | --- |
| `builtin.textStatus` | テキスト | 未着手（`todo`）、作業中（`wip`）、確定（`done`）。値のないセルは未着手 | 共有 DB（`builtin.db`） |
| `builtin.reviewStatus` | レビュー | 未レビュー（`none`）、レビュー中（`doing`）、差し戻し（`back`）、承認（`ok`）。値のないセルは未レビュー | 共有 DB（`builtin.reviews`）。投稿の記録 |
| `builtin.length` | 文字数 | 本文の文字数（未保存の編集を含む） | 保存しない（表示のたびに計算する） |

進捗ステータスは、画面ではセルのドロップダウンで選びます。変えた時点で共有 DB（既定では `<プロジェクト>/.loc-studio/meta.db`）に保存され、CSV は変わりません。コマンドラインでは `set` で変えられます。

```
$ node apps/cli/dist/index.js set textStatus@en done --resource text/main.csv --keys HELLO,BYE --project <プロジェクト> --user alice
text/main.csv textStatus@en = done: 更新 2 / ブロック 0
$ node apps/cli/dist/index.js status --project <プロジェクト>
text/main.csv
  エントリ 4 / 未保存 0 / 問題 error 3 warning 2 info 0
  textStatus: ja 0/4 (0%)  en 2/4 (50%)
  reviewStatus: ja 0/4 (0%)  en 0/4 (0%)
```

進捗の分子になるのは、「確定」と「承認」です（選択肢の `complete`）。選択肢にない値は「列 "textStatus" に "nope" は選べません（選択肢: todo, wip, done）。」で断られます。

進捗ステータスには、値を付けた時点の本文の版が一緒に残ります。あとで本文が変わると、その値に「変更あり」の印が付き、進捗には数えなくなります。

レビューは、値を書き換える列ではなく、判定とコメントの投稿を積み重ねる列です。画面では、レビュー列のセルから投稿のパネルを開いて投稿します（[GETTING-STARTED.md のレビューの投稿](../../GETTING-STARTED.md#レビューの投稿)）。セルには、最新の投稿の判定、投稿者、コメントが出ます。「差し戻し」はコメントが必須です。コマンドラインの `set` では投稿できず、「列 "reviewStatus" はレビュー列です。判定は postReview で投稿してください。」で断られます。

選択肢の名前、色、数は、スタジオの進め方に合わせて変えられます。`use` の横に `type` を書くと、選択肢を丸ごと置き換えます（[CONFIG.md の列挙の選択肢](../../CONFIG.md#列挙enumの選択肢)）。本文の列に `text` 以外の `id` を付けたときは、レビュー列の `of` もその `id` にします。

## 自分の列の値を共有 DB に置く

`builtin.db` は、同梱のステータス列だけのものではありません。列の `source` に `builtin.db` を書くと、どの列の値も共有 DB に置けます。次は、行に 1 つのメモの列です。

```json
{ "id": "memo", "kind": "meta", "scope": "entry", "label": "メモ", "type": "string", "source": "builtin.db" }
```

```
$ node apps/cli/dist/index.js set memo "店の看板" --resource text/main.csv --keys BOLD --project <プロジェクト> --user alice
text/main.csv memo = 店の看板: 更新 1 / ブロック 0
$ node apps/cli/dist/index.js query --project <プロジェクト> --where "memo is not empty" --limit 5 --columns memo,length@ja
条件に合う行: 1 / 4 行（原文 9 文字 / 1 語）
  text/main.csv: 1 / 4

行:
  text/main.csv  BOLD
    memo: 店の看板
    length@ja: 9
```

値は、リソースの ID、行のキー、列の ID、言語の組で記録されます。行のキーを画面や `entry rename` で変えると、値は新しいキーに引き継がれます。行を消しても値は消えず、同じキーの行を足し直すと戻ります。

## CSV の見出しを言語と列に対応させる

見出しが言語の ID と違うファイルは、設定の `formats` で対応づけます。次は、`examples/sample-project` の設定です。

```json
"formats": [
  {
    "use": "builtin.csv",
    "match": "**/*.csv",
    "options": {
      "key": "ID",
      "text": { "ja": "JP", "JaEnglish": "EN", "zh-Hans": "CN", "ko": "KR" },
      "columns": { "maxLength": "MaxLen" }
    }
  }
]
```

- `key` は、キーの列の見出しです。
- `text` は、言語の ID から、その言語の本文の列の見出しへの対応です。
- `columns` は、本文以外の、ファイルの中の列です。ここでは、見出し `MaxLen` の列を、行の `maxLength` という値として読みます。`builtin.maxLength` は、`max` を指定しなければ、この値を行ごとの上限として使います。

```
$ node apps/cli/dist/index.js validate --project <プロジェクト> --resources "**/ui.csv"
Assets/Text/system/ui.csv
  error   UI_SAVE_CONFIRM  JaEnglish  builtin.maxLength  too-long  文字数が上限を超えています（19 文字、上限 12 文字）。
```

ファイルの中の列を表にも出すときは、`columns` に `{ "id": "maxLength", "kind": "meta", "scope": "entry", "type": "string", "source": "file" }` のように、同じ ID の列を足します。言語ごとの列は、`"note@ja": "NoteJA"` のように `列 ID@言語 ID` で対応づけます。

設定にある見出しがファイルにないときは、読み込みでは警告になり、その列は空として読みます。その列に値を書くと、既定では、見出しの末尾に列を足します（`addColumns`。[settings.md](settings.md#builtincsv-と-builtintsv)）。

設定の画面の「CSV / TSV の列の対応」でも、キー、本文、文字コードの対応を編集できます。

## 行とリソースを足す

行の追加、削除、キーの変更は、すぐファイルに書かれます。書き換わるのは変更した行だけで、ほかの行のバイトは変わりません。

```
$ node apps/cli/dist/index.js entry add RETRY --resource text/main.csv --after BYE --text ja=もう一度 --text "en=Try again, {name}" --project <プロジェクト>
text/main.csv: 行 RETRY を追加（5 行）
```

実行の前後のファイルを `diff` で比べると、増えたのは次の 1 行だけでした。区切り文字を含む値には、引用符が付きます。

```
3a4
> RETRY,もう一度,"Try again, {name}"
```

新しいリソースは、場所を拡張子まで書いて作ります。見出しは、設定（言語と、フォーマットの対応）から作られます。

```
$ node apps/cli/dist/index.js resource create text/menu.tsv --project <プロジェクト>
リソースを作りました: text/menu.tsv
```

できたファイルの中身は、タブ区切りの `key`、`ja`、`en` の 1 行です。`.csv` と `.tsv` 以外の拡張子は、扱えるフォーマットがないので作れません（「リソース text/notes.txt を扱えるフォーマットがありません（登録されているフォーマット: "builtin.csv", "builtin.tsv"）。拡張子と、設定の formats を確かめてください。」）。

## 対象のフォルダ、文字コード、区切り文字を変える

リソースを探す範囲は、`tree` の `include` と `exclude` で変えます。

```json
"tree": { "use": "builtin.globTree", "options": { "include": ["Assets/Text/**/*.csv"] } }
```

文字コードは、既定では UTF-8 です。先頭に BOM のある UTF-16 は、設定なしで読めます。Shift_JIS のファイルは、フォーマットの `encoding` に `"shift_jis"` を書きます（自動では見分けません）。フォルダごとに文字コードが違うときは、`formats` に `match` の違う項目を並べます。

```json
"formats": [
  { "use": "builtin.csv", "match": "legacy/**/*.csv", "options": { "encoding": "shift_jis" } },
  { "use": "builtin.csv", "match": "**/*.csv" }
]
```

`formats` は並べた順に評価され、最初に一致した項目が使われます。区切り文字がカンマでもタブでもないファイルは、`delimiter` で指定します。

## うまく動かないとき

| 症状 | 原因 | 直し方 |
| --- | --- | --- |
| ツリーにファイルが出ない | 拡張子が `.csv` / `.tsv` でない（既定の `include` は大文字と小文字を区別するので、`.CSV` も出ない）。`include` に入らない、または `exclude` に入る場所にある。シンボリックリンクである | `tree` の `include` を確かめる。リンクではなく実体のファイルを置く |
| 「リソース … を扱えるフォーマットがありません」 | `formats` を書いたプロジェクトで、どの項目の `match` にも一致しない。または、`formats` がなく、登録されたどのフォーマットも、その拡張子に一致しない（`include` を広げた場合など） | `formats` に、そのパスに一致する項目を足す |
| 「キーの列「ID」が見出しにありません」 | フォーマットの `key` と、ファイルの見出しが違う | `key` を見出しに合わせる。省略すると先頭の列がキーになる |
| 「設定にある列「FR」が見出しにありません。」（警告） | `text` / `columns` / `stableId` の見出しが、ファイルにない | 見出しを合わせる。その言語をこれから足すなら、そのままでよい（値を書いたときに列が足される） |
| 「キー「X」が重複しています（最初は N 行目）。この行は読み飛ばしました。」（警告） | 同じキーの行が 2 つある | ファイルを直す。後ろの行は表に出ず、編集もできない |
| 「UTF-8 として読めないファイルです」 | UTF-8 でも、BOM つきの UTF-16 でもない | Shift_JIS なら `encoding` を書く。ほかの文字コードは UTF-8 に変換する |
| 「… は、Shift_JIS として読んで書き戻すと、元のバイト列に戻りません」 | 同じ文字に 2 通りのバイト列がある文字（機種依存文字の一部）を含む | UTF-8 か UTF-16 に変換する |
| 「文字「확」（U+D655）は Shift_JIS で表せません。」 | Shift_JIS のファイルに、表せない文字を保存しようとした | そのリソースを UTF-8 か UTF-16 に変換する |
| 列のセルが読み書きできない。警告「…の出所 "x" は、設定の sources にも登録された列ソースにもありません。」 | 列の `source` の書き間違い | `builtin.db` か `builtin.reviews`、または `sources` のキーにする |
| レビュー列が表に出ない（警告） | `of` がない、自分自身を指している、または設定にある列の `id` を指していない | `of` を、対象の列（ふつうは本文の列）の `id` にする |
| 変数が色分けされず、`builtin.placeholders` が何も指摘しない | `syntaxes` に、その書き方の記法が入っていない | `syntaxes` に `builtin.braces` などを足す |

## 確かめた範囲

2026-11-18 に、Windows 11（Node.js 26.5.1）で、上の例のプロジェクトを作り、コマンドラインで実行しました。出力は、実行したときのものです（`--user-data-dir` で、その PC の設定フォルダを一時の場所にしています）。

- 言語だけの設定での `tree` と `validate`。
- 5 つのバリデータを選んだ `validate`。
- 列を足したあとの `set`（進捗ステータス、メモ、選択肢にない値、レビュー列への `set` の拒否）、`status`、`query`。
- `entry add` の前後のファイルの差、`resource create`（TSV と、扱えない拡張子）。
- `examples/sample-project` の写しでの、`MaxLen` の列を使った `builtin.maxLength`。

次のことは、この文書のためには動かしていません。

- 画面での操作（ドロップダウン、レビューの投稿、修正案、「CSV / TSV の列の対応」）。説明は、コードと [GETTING-STARTED.md](../../GETTING-STARTED.md) に基づきます。画面の操作のうち `npm run check:browser` で確かめているものは、[README の「状況」](../../../README.md#状況)にあります。
- Shift_JIS と UTF-16 のファイル、`delimiter`、`addColumns` の切り替え。フォーマットのテスト（`packages/builtin/src/csv.test.ts`、`encoding.test.ts`）で確かめています。列の追加は、[CONFIG.md の formats](../../CONFIG.md#formats) に、サービス層で確かめた結果があります。
- 「うまく動かないとき」の表の文言は、ソースのメッセージから書きました。
