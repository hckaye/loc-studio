# @loc-studio/builtin の設定項目

`@loc-studio/builtin` の実装に渡せる値を、実装ごとにまとめたリファレンスです。値はすべて、プロジェクト設定（`loc-studio.project.json`）の `use` に添える `options` と、列の上書きで決めます。このプラグインは、プラグインの設定（`Plugin.settings`）を宣言していないので、設定の画面の「プラグインの設定」のタブには欄が出ません。

`use` と `options` の書き方は [CONFIG.md の use と options](../../CONFIG.md#use-と-options) にあります。使い方の流れは [guide.md](guide.md) にあります。

## 設定のどこに書くか

| 実装 | 設定のキー | Web モードで変えられる人 |
| --- | --- | --- |
| `builtin.globTree` | `tree` | サーバーの管理者 |
| `builtin.csv`、`builtin.tsv` | `formats` | サーバーの管理者 |
| `builtin.braces`、`builtin.printf`、`builtin.tags` | `syntaxes` | サーバーの管理者 |
| `builtin.db`、`builtin.reviews` | 列の `source`、`sources` | 列の `source` は `manage` の権限がある役割。`sources` はサーバーの管理者 |
| バリデータ 5 つ | `validators` | `manage` の権限がある役割 |
| 列 5 つ | `columns` | `manage` の権限がある役割 |

`tree`、`formats`、`syntaxes`、`sources` は、ファイルや DB の場所とコードの動きを決める基盤の項目です。画面のローカルモードでは、これらを書いた設定ファイルは、最初に開いたときに信頼の確認が出ます（[CONFIG.md の設定ファイルの確認](../../CONFIG.md#設定ファイルの確認画面のローカルモード)）。

設定の画面に入力欄があるのは、列の並びと表示名、検証の選択と重さ、「CSV / TSV の列の対応」（キー、本文、文字コード）です。それ以外の値は、設定の画面の「詳細」の JSON か、設定ファイルで書きます。「CSV / TSV の列の対応」は、`formats` にある `builtin.csv` と `builtin.tsv` の項目をまとめて編集するので、項目ごとに対応が違う設定（フォルダごとに文字コードを変えている場合など）では欄が出ず、設定ファイルで編集するよう案内が出ます。

## builtin.globTree

```json
"tree": { "use": "builtin.globTree", "options": { "include": ["Assets/Text/**/*.csv"] } }
```

| options | 型 | 既定 | 意味 |
| --- | --- | --- | --- |
| `include` | `string[]` | `["**/*.csv", "**/*.tsv"]` | リソースにするファイルのパス（glob。プロジェクトのフォルダからの相対で、区切りは `/`） |
| `exclude` | `string[]` | `["**/node_modules/**", "**/.git/**", "**/.loc-studio/**", "loc-studio-plugins/**"]` | 除くパス（glob）。書くと既定を置き換えるので、既定の除外も要るなら書き直す。空の配列は「何も除かない」 |

- glob は picomatch で照合します。`.` で始まる名前にも一致します。
- フォルダは、中に対象のファイルが 1 つもなければツリーに出ません。並びは、フォルダが先、名前の順（数字は数として比べる）です。
- シンボリックリンク（フォルダへのリンクも、ファイルへのリンクも）は、辿らず、リソースにもしません。
- 文字列の配列でない値を書くと、ツリーを読めません（「globTree のオプション include は文字列の配列で指定してください。」）。
- 新しいリソースを作れるのは、`include` に入り `exclude` に入らない場所だけです（「… は、ツリーの対象（include: …）に入らない場所です。」）。

## builtin.csv と builtin.tsv

2 つは、区切り文字の既定と、一致する拡張子だけが違います。

| ID | 区切り文字の既定 | `match` を省略したときに一致する拡張子 |
| --- | --- | --- |
| `builtin.csv` | `,` | `.csv`（大文字と小文字を区別しない） |
| `builtin.tsv` | タブ | `.tsv`（同じ） |

大文字と小文字を区別しないのは、フォーマットの判定だけです。ツリーの `include` の既定（`**/*.csv`、`**/*.tsv`）は区別するので、拡張子が `.CSV` のファイルをリソースにするには、`tree` の `include` に `**/*.CSV` を書き足します。

```json
"formats": [
  {
    "use": "builtin.csv",
    "match": "**/*.csv",
    "options": {
      "key": "ID",
      "text": { "ja": "JP", "en": "EN" },
      "columns": { "maxLength": "MaxLen", "note@ja": "NoteJA" },
      "stableId": "GUID",
      "encoding": "auto",
      "addColumns": "all-rows"
    }
  }
]
```

| options | 型 | 既定 | 意味 |
| --- | --- | --- | --- |
| `key` | `string` | 先頭の列 | キーの列の見出し |
| `text` | `Record<言語 ID, 見出し>` | 言語 ID と同じ見出し | 言語の本文の列の見出し。ここに書いていない言語は、言語 ID と同じ見出しの列を本文として読む（その見出しが、ほかの言語の対応に使われているときは読まない） |
| `columns` | `Record<string, 見出し>` | なし | 本文以外の、ファイルの中の列。キーは `列 ID`（行に 1 つ）か `列 ID@言語 ID`（言語ごと）。値は文字列として読む |
| `stableId` | `string` | なし | 安定 ID（キーが変わっても変わらない ID）の列の見出し。あると、アプリの外でキーが書き換えられたときも、ステータスなどを新しいキーに引き継げる |
| `delimiter` | `string` | CSV は `,`、TSV はタブ | 区切り文字。2 文字以上でもよい。空の文字列と、引用符か改行を含む文字列は使えない |
| `encoding` | `string` | `"auto"` | 文字コード（下の表） |
| `addColumns` | `"all-rows"` / `"header-only"` / `"never"` | `"all-rows"` | 値を書く列が見出しにないときの扱い（下の表） |

型の合わない値や知らない値を書くと、そのフォーマットのリソースは読めず、理由にリソースのパスが添えられます（「設定の text はオブジェクトで指定してください（…）。」、「区切り文字が不正です（空、引用符、改行は使えません）: …」）。

### encoding

| 値 | 読み方 | 新しいリソース |
| --- | --- | --- |
| `"auto"` | 先頭に UTF-16 の BOM があればその UTF-16、なければ UTF-8 | BOM なしの UTF-8 |
| `"utf-8"`（`"utf8"`） | UTF-8 | BOM なしの UTF-8 |
| `"utf-16le"`（`"utf-16"`、`"utf16"`、`"utf16le"`） | UTF-16（リトルエンディアン） | BOM つき |
| `"utf-16be"`（`"utf16be"`） | UTF-16（ビッグエンディアン） | BOM つき |
| `"shift_jis"`（`"shift-jis"`、`"sjis"`、`"cp932"`、`"windows-31j"`） | Shift_JIS（Windows-31J） | Shift_JIS |

- 名前は、大文字と小文字を区別しません。
- 書き戻しは、読んだときの文字コードと BOM の有無のままです。
- その文字コードとして読めないバイト列のファイルは、読む時点でエラーになります。
- Shift_JIS のファイルは、読んで書き戻したときに元のバイト列に戻らないもの（同じ文字に 2 通りのバイト列がある機種依存文字を含むもの）を、読む時点でエラーにします。
- Shift_JIS で表せない文字を含む値は保存できず、ファイルは変わりません。

### addColumns

設定にある見出し（`text`、`columns`、`stableId`）がファイルにないとき、読み込みは警告を出して、その列を空として読みます。その列に空でない値を書いたときの動きを、`addColumns` で選びます。

| 値 | 動き |
| --- | --- |
| `"all-rows"` | 見出しの末尾に列を足し、各行の末尾にも空のフィールドを足す（表を長方形に保つ）。空の行と、元から見出しより短くて手を入れていない行は、変えない |
| `"header-only"` | 見出しと、値を書く行にだけフィールドを足す |
| `"never"` | 列を足さず、保存を失敗にする |

- 足す列の見出しは、設定に書いた見出しです。`text` に対応のない言語は、言語 ID が見出しになります。
- 空の値を書くだけでは、列を足しません。
- `columns` に対応のない列（`列 ID`）の値の変更は、どの値でも失敗します（「列「…」に対応する見出しが設定（columns）にありません」）。行を足すときは、空の値は無視され、空でない値があると同じ理由で失敗します。

### ファイルの読み方の決まり

options では変えられない決まりです。

- 見出しは、空でない最初の行です。同じ見出しが 2 つあれば、先のものを使います。
- キーが空の行と、キーが重複した 2 つ目以降の行は、警告を出して読み飛ばします。
- 空の行は読み飛ばし、書き戻しでもそのまま残します。
- フィールドの足りない行は、足りない分を空として読みます。
- 引用符は `"` で、フィールドの中の `"` は `""` と書きます。引用符の中の改行と区切り文字は、値の一部です。
- 値を書くときは、区切り文字、引用符、改行を含む値と、前後に空白のある値に引用符を付けます。元から引用符の付いていたフィールドは、引用符を保ちます。
- 行を足すときの改行は、そのファイルでいちばん多い改行（LF、CRLF、CR）に合わせます。新しいリソースの改行は LF です。

## 記法

記法には options がありません。使う記法を、設定の `syntaxes` に、適用する順に並べます。書かなければ、登録されたすべての記法を使います。

```json
"syntaxes": ["builtin.braces", "builtin.tags"]
```

| ID | 見つけるもの | トークンの種類 | 決まり |
| --- | --- | --- | --- |
| `builtin.braces` | `{name}`、`{0}`、`{player.name}` | `variable` | `{` と `}` の間が、半角の英数字、`_`、`.`、`:`、`-` の 1 文字以上。空の `{}` や、空白を含むものは本文 |
| `builtin.printf` | `%s`、`%d`、`%1$s`、`%05.2f` | `variable` | `%` のあとに、位置（`1$`）、フラグ（`-` `+` `#` `0`）、幅、精度（`.2`）、変換文字（`s d i f u x X e E g G c`）。位置から精度までは省ける。`%%` は本文 |
| `builtin.tags` | `<b>`、`</b>`、`<color=#ff0000>`、`<br/>` | `tag` | `<`（終了タグは `</`）のあとが半角の英字で始まり、`>` で閉じる。`<` のあとが空白や数字のもの、閉じていないものは本文 |

## バリデータ

```json
"validators": [
  "builtin.placeholders",
  { "use": "builtin.maxLength", "options": { "max": 20 }, "severity": "warning", "languages": ["en"] }
]
```

`severity`、`languages`、`columns` は、どのバリデータにも書ける共通の項目です（[CONFIG.md の validators](../../CONFIG.md#validators)）。

| ID | 既定の重さ | options | 既定 | 意味 |
| --- | --- | --- | --- | --- |
| `builtin.placeholders` | error | `ignoreTags` | `false` | `true` にすると、タグを比べない（変数と制御コードだけを比べる） |
| `builtin.tagBalance` | error | `voidTags` | `["br"]` | 閉じなくてよいタグの名前の配列（大文字と小文字を区別しない）。書くと既定を置き換える |
| `builtin.maxLength` | error | `max` | なし | 上限の文字数。書くと、行ごとの上限より優先する |
| | | `metaKey` | `"maxLength"` | 行ごとの上限を読む、行の値の名前（フォーマットの `columns` で対応づけた `列 ID`） |
| | | `count` | 本文だけ | `"all"` にすると、変数とタグも数える |
| `builtin.whitespace` | warning | なし | | |
| `builtin.untranslated` | warning | なし | | |

指摘の種類（`code`）は次のとおりです。条件式の `issueCode` や、コマンドラインの集計に出ます。

| バリデータ | `code` | 指摘する条件 | 位置 | 修正案 |
| --- | --- | --- | --- | --- |
| `builtin.placeholders` | `placeholder-missing` | 基の言語にある変数やタグが、訳文に足りない（同じ文字列ごとに数を比べる。順番は問わない） | なし | なし |
| | `placeholder-extra` | 基の言語にない変数やタグ、または基の言語より多い変数やタグがある | 余分な最初の 1 つ | なし |
| `builtin.tagBalance` | `tag-unclosed` | 開始タグが閉じられていない | そのタグ | なし |
| | `tag-unexpected-close` | 終了タグに対応する開始タグがない、または入れ子の順が違う | そのタグ | なし |
| `builtin.maxLength` | `too-long` | 文字数が上限を超えている | `count` が `"all"` のときだけ、上限を超えた位置から末尾まで | なし |
| `builtin.whitespace` | `leading-space` | 先頭に空白（全角の空白や改行を含む）がある | その空白 | 先頭の空白を削除 |
| | `trailing-space` | 末尾に空白がある | その空白 | 末尾の空白を削除 |
| | `double-space` | 半角スペースが 2 つ以上続いている（前後の空白を除いた内側） | 最初の 1 か所 | 連続スペースを 1 つにする |
| `builtin.untranslated` | `empty` | 訳文が空か空白だけで、基の言語の本文は空でも空白だけでもない | なし | なし |
| | `same-as-base` | 訳文が基の言語の本文と同じで、基の言語の本文（変数とタグを除いた部分）に文字がある | なし | なし |

- `builtin.placeholders` は、基の言語のない言語と、空の本文には何も指摘しません。`builtin.untranslated` は、基の言語のない言語には何も指摘しません。
- `builtin.tagBalance` は、タグの名前（`<` の直後の英数字）だけで対応を見ます。属性は比べません。`<br/>` のように `/>` で終わるタグと、`voidTags` のタグは、閉じなくてよい扱いです。
- `builtin.maxLength` は、Unicode のコードポイントの数で数えます（`😀` のように、コードポイント 1 つの絵文字は 1 文字です。複数のコードポイントを結合した絵文字は、コードポイントの数だけ数えます）。上限は、`max`、行の値（`metaKey`）の順に探し、どちらもなければ何も指摘しません。行の値が数として読めないときも、何も指摘しません。
- `builtin.untranslated` の `same-as-base` は、数字だけ、記号だけ、変数だけの本文には出ません。

## 列ソース

```json
"sources": {
  "statusB": { "use": "builtin.db", "options": { "namespace": "status.team-b" } },
  "reviewsB": { "use": "builtin.reviews", "options": { "namespace": "reviews.team-b" } }
}
```

| ID | options | 既定 | 意味 |
| --- | --- | --- | --- |
| `builtin.db` | `namespace` | `"builtin.db"` | 共有 DB の中の置き場所（名前空間）。値は、変えた時点で保存する |
| `builtin.reviews` | `namespace` | `"builtin.reviews"` | 投稿を置く名前空間。投稿に付けたリンクは、`<名前空間>.links` に置く |

- `namespace` を書かないときは、列の `source` に列ソースの ID（`"builtin.db"`）をそのまま書けば足ります。`sources` に名前を付けるのは、置き場所を分けたいときです。
- `namespace` は、空でない文字列にします。違う値を書くと、その列の値を読み書きするときにエラーになります（「列ソース "builtin.db" のオプション namespace は空でない文字列で指定してください。」）。
- 同じ名前空間を使う列どうしでも、値は列の ID ごとに分かれます。
- `namespace` を変えると、前の名前空間の値は見えなくなります（DB には残ります）。
- `builtin.reviews` は、レビュー列（`kind: "review"`）の出所として使います。値を直接は保存できない列ソースなので、ほかの種類の列の出所にしても、その列の値は変えられません。

共有 DB の場所は、設定の `storage` で決まります（[CONFIG.md の storage](../../CONFIG.md#storage)）。

## 列

列は、`columns` に `{ "use": "<登録 ID>", "id": "<列の ID>" }` と書いて選びます。`id` を省くと、列の ID が登録 ID（`builtin.textStatus` など）になるので、短い ID を付けます。

| 登録 ID | `kind` | `scope` | 表示名 | 出所 | 型と既定 |
| --- | --- | --- | --- | --- | --- |
| `builtin.key` | `key` | `entry` | なし | フォーマット | |
| `builtin.text` | `text` | `language` | なし | フォーマット | |
| `builtin.textStatus` | `meta` | `language` | テキスト | `builtin.db` | 選択式。既定の値は `todo`。`basis: "text"` |
| `builtin.reviewStatus` | `review` | `language` | レビュー | `builtin.reviews` | 選択式。既定の値は `none`。`of: "text"` |
| `builtin.length` | `computed` | `language` | 文字数 | 計算 | `number` |

選択肢の既定は次のとおりです。

| 列 | 値 | 表示名 | 色 | そのほか |
| --- | --- | --- | --- | --- |
| `builtin.textStatus` | `todo` | 未着手 | `gray` | |
| | `wip` | 作業中 | `amber` | |
| | `done` | 確定 | `ink` | `complete`（進捗の分子になる） |
| `builtin.reviewStatus` | `none` | 未レビュー | `gray` | |
| | `doing` | レビュー中 | `blue` | |
| | `back` | 差し戻し | `red` | `requireComment`（コメントが必須） |
| | `ok` | 承認 | `green` | `complete` |

`use` の横に書く上書きとして、型（`ColumnUse`）が定めているキーは、`id`、`label`、`languages`、`type`、`source`、`of`、`actions`、`generator`、`options`、`display`、`renderer` です。上書きはキーごとの置き換えで、`type` を書くと選択肢も丸ごと置き換わります。実行時は、`use` 以外のキーを、そのまま定義に写します。そのため、`basis` や `history` を JSON に書いても効きますが、型の上では対象外です。

```json
{
  "use": "builtin.textStatus",
  "id": "textStatus",
  "label": "翻訳",
  "languages": ["en", "ko"],
  "type": {
    "enum": [
      { "value": "todo", "label": "未着手", "color": "gray" },
      { "value": "translated", "label": "翻訳済み", "color": "blue" },
      { "value": "approved", "label": "承認", "color": "green", "complete": true, "from": ["translated"] }
    ],
    "default": "todo"
  }
}
```

- `builtin.textStatus` の `basis: "text"` は、値を付けた時点の本文の版を記録する指定です。本文が変わると、値に「変更あり」の印が付きます。
- `builtin.reviewStatus` の `of` は、レビューの対象の列の ID です。既定は `text` なので、本文の列に別の ID を付けたプロジェクトは `of` も書きます。
- `builtin.length` は、本文（未保存の編集を含む）のコードポイントの数です。読み取り専用で、保存されません。絞り込みと条件式に使えます。
- 選択肢の `from`、`roles`、`complete`、`requireComment` の意味は、[CONFIG.md の列挙の選択肢](../../CONFIG.md#列挙enumの選択肢)にあります。

設定に `columns` を書かないプロジェクトの「キー」と「本文」の 2 列は、コアが持つ既定の列です（ID は `key` と `text`）。`builtin.key` と `builtin.text` と同じ種類の列ですが、`use` を通さずに使われます。
