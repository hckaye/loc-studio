# @loc-studio/builtin の実装

`packages/builtin` のコードを直す人に向けて、ファイルの構成、それぞれの処理の流れ、テスト、変えるときに揃えるものをまとめます。守っている決まりは [design.md](design.md) にあります。

## パッケージ

| 項目 | 内容 |
| --- | --- |
| 場所 | `packages/builtin` |
| パッケージ名 | `@loc-studio/builtin` |
| 依存 | `@loc-studio/sdk`（型と、`RevisionConflictError`）、`picomatch`（glob の照合） |
| 書き出すもの | `builtinPlugin`（`Plugin` のオブジェクト）と、各ファイルの実装と補助の関数 |
| ビルド | ルートの `npm run build`（`tsc -b`）。出力は `packages/builtin/dist` |

`builtinPlugin` は、設定を読まないので、関数ではなくオブジェクトのまま書き出しています（プラグインの設定を使う同梱のプラグインは、`Plugin` を返す関数にします。`packages/plugin-llm` がその形です）。

```ts
export const builtinPlugin: Plugin = {
  name: "@loc-studio/builtin",
  version: "0.1.0",
  trees: [globTree],
  formats: [csvFormat, tsvFormat],
  syntaxes: builtinSyntaxes,
  validators: builtinValidators,
  sources: [dbSource, reviewSource],
  columns: builtinColumns,
};
```

登録するのは、サービス層（`packages/server/src/workspace.ts`）とコマンドライン（`apps/cli/src/commands.ts`）です。どちらも、`openProject` の `builtins` の先頭に `builtinPlugin` を渡します。

## ファイルの構成

| ファイル | 中身 | テスト |
| --- | --- | --- |
| `src/index.ts` | `builtinPlugin` の組み立てと、各ファイルの書き出し | |
| `src/glob-tree.ts` | ツリー `builtin.globTree`。`listGlobTree`、`readGlobTreeFile` | `glob-tree.test.ts` |
| `src/csv.ts` | フォーマット `builtin.csv` / `builtin.tsv`。`createDelimitedFormat`、`readDelimitedHeader` | `csv.test.ts`、`csv.perf.test.ts` |
| `src/encoding.ts` | 文字コードの読み書き（`decodeText`、`encodeText`、`parseEncodingOption`）。`index.ts` からは書き出していない | `encoding.test.ts` |
| `src/syntax.ts` | 記法 3 つ | `syntax.test.ts` |
| `src/validators.ts` | バリデータ 5 つ | `validators.test.ts` |
| `src/db-source.ts` | 列ソース `builtin.db`。`namespaceOption` | `db-source.test.ts` |
| `src/review-source.ts` | 列ソース `builtin.reviews` | `review-source.test.ts` |
| `src/default-columns.ts` | 列 5 つ | `default-columns.test.ts` |

パッケージの外から使われている関数は、`listGlobTree`、`readGlobTreeFile`、`readDelimitedHeader` の 3 つです。新しいプロジェクトを作る処理（`packages/server/src/new-project.ts`）が、作る前に、フォルダにすでにあるファイルと、その見出しを確かめるために呼びます。この 3 つの引数や動きを変えるときは、そちらも確かめます。

## glob-tree.ts

- `listGlobTree(projectRoot, options)` が、`include` と `exclude` から picomatch の照合の関数を作り（`dot: true`）、`walk` でフォルダを再帰的にたどります。`walk` は、`readdir` の `withFileTypes` の結果で、フォルダとファイルを見分けます。シンボリックリンクは、どちらにも当たらないので、何もしません。除外に一致したフォルダには入りません。子のないフォルダは結果に入れません。並べ替えは `byName`（フォルダが先。名前は `localeCompare` の `numeric`）です。
- リソースの `id` と `path` は、どちらもプロジェクトからの相対パス（`/` 区切り）です。
- `resolveInside(root, relPath)` が、相対パスを絶対パスにして、ルートの外に出ていないかを確かめます。`read`、`readWithRevision`、`revision`、`create`、`write` のすべてが、これを通ります。
- 版は、`stat` の `mtimeNs` と `size` を 36 進数にして `-` でつないだ文字列です。`fileRevision` は、ファイルがなければ `undefined` を返します。`readFileWithRevision` は、1 つのファイルハンドルで `stat` と `readFile` を呼びます。
- `write` は、同じフォルダに `.<ファイル名>.<乱数>.tmp` を書き、`expectedRevision` があれば `fileRevision` と比べてから、`rename` します。失敗したら一時ファイルを消します。`RevisionConflictError` は、そのまま投げ直します。ほかの失敗は、ファイルのパスを添えた `Error` にします。
- `create` は、パスの形（空でない、`\` を含まない、`.` や `..` や空の部分がない）と、ツリーの対象に入ることを確かめてから、`writeFile` の `flag: "wx"` で書きます。`EEXIST` は「… はすでにあります。」にします。

## csv.ts

1 つのファイルに、字句解析、設定の読み取り、見出しと列の対応、解析、書き戻し、新規作成が、この順で入っています。CSV と TSV の違いは、`createDelimitedFormat` に渡す `DelimitedFormatSpec`（`id`、区切り文字の既定、拡張子）だけです。

### 字句解析（scan）

`scan(text, delim)` が、文字列を `RawRecord` の配列にします。

- `RawCell` は、フィールドの生のテキストの範囲（`start`、`end`。引用符を含む）、引用符つきかどうか、値を持ちます。
- `RawRecord` は、行の中身の範囲（`start`、`end`）、改行の後ろの位置（`termEnd`）、始まりの行番号、フィールドの配列、空の行かどうか、引用符が閉じていないかどうかを持ちます。
- 改行は LF、CRLF、CR を見分け、数を数えます。いちばん多い改行を `eol` として返します（1 つもなければ LF）。
- 引用符が閉じていない、閉じ引用符の後ろに文字がある、の 2 つを、診断（警告）として返します。
- 区切り文字は、2 文字以上でも扱えます（`isDelimAt`）。

書き戻しは、この範囲を使って、元の文字列から生のテキストを切り出します。値からテキストを作り直さないので、触っていないフィールドは 1 文字も変わりません。

### 設定の読み取りと、列の対応

- `resolveOptions(ctx, defaultDelimiter)` が、`ctx.options` の形を確かめて、`ResolvedOptions` にします。型の合わない値は、リソースのパスを添えた例外です。`encoding` は `parseEncodingOption` に渡します。
- `buildLayout(headers, opts, ctx)` が、見出しと設定から `Layout` を作ります。`Layout` は、キーの列の位置、言語ごとの本文の列（`text`）、ファイルの中の列（`meta`。キーは `列 ID` か `列 ID@言語 ID`）、安定 ID の列を持ちます。見出しにない列は、位置が `-1` です。`text` に対応のない言語は、言語 ID と同じ見出しを探します。

### 解析（parseDocument）

`loadDocument` が、文字コードを戻し、`scan` を呼び、空でない最初の行を見出しにして `Layout` を作ります。`parseDocument` は、見出しのあとの行を順に `EntryData` にします。キーの列がなければ、エラーの診断を 1 件返して終わります。キーが空の行と重複した行は、警告にして飛ばします。エントリには、`location.line` に行番号を入れます。

### 書き戻し（Editor）

`applyChanges` は、変更がなければ `original.slice()` を返します。変更があれば、`loadDocument` で読み、`Editor` に変更を順に当て、`output()` の文字列を `encodeText` でバイト列にします。

`Editor` は、行を双方向リスト（`Item`）で持ちます。行の順番の入れ替え（追加と削除）を、行の数によらない手間で行うためです。

- `Item` は、元の `RawRecord`（追加した行にはない）、改行（`term`）、編集したフィールドの配列（`cells`。手を入れた行だけが持つ）を持ちます。`cells` のない行は、`output()` で、元の文字列をそのまま出します。
- `byKey` は、キーからその行（重複があれば、文書の順の配列）への索引です。先頭の行が、有効なエントリです。消すと、重複していた次の行が有効になります。
- `set` は、`columnMap` で変更先の列を決め、`ensureIndex` で列の位置を決め（見出しになければ `createColumn`）、`setCell` でフィールドの生のテキストを差し替えます。引用符は `toRaw` が決めます（元が引用符つきなら保つ。要るときは付ける）。
- `rename` は、キーのフィールドだけを差し替え、索引を付け替えます。`remove` は、行をリストから外します。`add` は、見出しと同じ数の空のフィールドを持つ行を作り、値を入れて、`after` の行（なければ、最後の空でない行）の後ろに入れます。
- `createColumn` は、`addColumns` が `never` なら例外、見出しにすでにある名前なら例外です。足す位置は `baseWidth`（見出しの幅と、いちばん長い行の幅の大きいほう）から順に取ります。足した列は `created` に覚え、同じ見出しを 2 度足しません。
- `output()` は、`all-rows` で列を足したとき、各行を `padTo`（`baseWidth` と足した列の数の和）まで区切り文字で埋めます。手を入れていない行は、元の見出しの幅以上のものだけを埋めます。空の行と、引用符が閉じていない行は埋めません。
- 引用符が閉じていない行にフィールドを足そうとすると、例外にします。閉じていない引用符の後ろに区切りを足すと、区切りが値の一部になるためです。

変更は、渡された順に当てます。キーを変えたあとの `set` は新しいキーで行を探し、追加した行への `set` も当てられます。

### 新規作成（createDocument）

見出しと、渡されたエントリの行を作り、各行の末尾に LF を付けて、`encodeText` でバイト列にします。`encoding` が `auto` なら UTF-8、UTF-16 なら BOM を付けます。キーが空のエントリと、重複したキーは例外です。

### readDelimitedHeader

バイト列から、見出しの行の値だけを読みます。プロジェクトの設定がまだない段階で呼ばれるので、`FormatContext` を取りません。

## encoding.ts

- `parseEncodingOption(value, where)` が、設定の名前を `TextEncoding`（`utf-8`、`utf-16le`、`utf-16be`、`shift_jis`）か `auto` にします。別名の表（`ALIASES`）にない名前は例外です。
- `decodeText(input, encoding, what)` は、`TextDecoder` を `fatal: true`（読めないバイト列は例外）、`ignoreBOM: true`（BOM を文字として残す）で使います。BOM は自分で判定して外し、あったかどうかを返します。Shift_JIS のときは、`encodeText` で書き戻して、元のバイト列と同じかを確かめます。
- `encodeText(text, bom, encoding)` は、UTF-8 を `TextEncoder`、UTF-16 を自前のループで書きます。Shift_JIS は、`shiftJisTable()` の表を引きます。
- `shiftJisTable()` は、文字から Shift_JIS のバイト列への表です。実行環境の `TextDecoder("shift_jis")` で、ありうるバイト列（1 バイトと 2 バイト）をすべて読んで作ります。同じ文字に複数のバイト列があるときは、先に見つかったほう（小さいほう）を使います。最初に使うときに 1 回だけ作り、モジュールの変数に覚えます。

変換の表は、パッケージの中には持っていません。読むときに使うのと同じ、実行環境のデコーダから作ります。

## syntax.ts

`tokenizeWith(text, pattern, kind, accept)` が、3 つの記法に共通の処理です。正規表現に一致した部分を `kind` のトークンにし、間を `text` のトークンで埋めます。`accept` が `false` を返した一致は、トークンにせず本文に含めます（`builtin.printf` が `%%` に使います）。空の文字列には、空の配列を返します。

## validators.ts

- `builtin.placeholders` は、`groupTokens` で、本文でないトークンを値ごとにまとめ、基の言語と数を比べます。足りない値ごとに `placeholder-missing` を 1 件、余分な値ごとに `placeholder-extra` を 1 件（位置は、余分な最初の出現）返します。
- `builtin.tagBalance` は、タグのトークンを順に見て、開始タグをスタックに積み、終了タグでスタックの先頭と名前を比べます。合わなければ `tag-unexpected-close`、最後にスタックに残ったものが `tag-unclosed` です。
- `builtin.maxLength` は、`resolveLimit` で上限を決めます（`options.max`、行の `meta[metaKey]` の順）。`count` が `"all"` のときは、上限を超えた最初のコードポイントの位置を UTF-16 の添字で求めて、`range` にします。
- `builtin.whitespace` は、先頭と末尾の空白を先に見つけ、連続スペースは、その内側だけを探します（前後の空白は、別の指摘になるためです）。空白だけの値は、先頭の空白としてだけ指摘します。
- `builtin.untranslated` は、空の判定に `trim()` を使い、「原文と同じ」は、基の言語の `text` のトークンに Unicode の Letter があるときだけ返します。

どのバリデータも `version` は `"1"` です。指摘の結果が変わる修正をしたら、`version` を上げます（結果のキャッシュの鍵に入っています）。

## db-source.ts と review-source.ts

- `namespaceOption(ctx, fallback, sourceId)` が、`options.namespace` を確かめます。2 つの列ソースが使います。
- `dbSource` は、`ctx.host.db.cells(名前空間)` の `get` と `set` を呼ぶだけです。空の配列を渡されたら、DB を呼ばずに返します。`onEntriesChanged` は、`rename` のときだけ `renameEntry` を呼びます。
- `reviewSource` は、2 つの記録を使います。投稿は `log(名前空間)` に `ReviewRecordData`（`verdict`、`comment`、`basisHash`）として、リンクは `log(名前空間 + ".links")` に `ReviewLinkData`（`reviewId`、`links`）として足します。
- `load` は、`posts.latest(cells)` で、セルごとの最新の投稿を引きます。返す値には、判定のほかに、投稿の時刻と投稿者（`updatedAt`、`updatedBy`）、`basisHash`、空でないコメント（`comment`）を入れます。
- `listReviews` は、セルの投稿（新しい順）と、同じセルのリンクを引き、リンクを投稿の ID ごとにまとめて、投稿に添えます。リンクは、足した順に並ぶよう、新しい順の一覧を逆からたどります。
- `addReviewLinks` は、投稿を ID で探し、リンクを、投稿と同じセルに結び付けて足します。投稿が見つからなければ例外です。
- `postReview` は、判定が空なら例外です。投稿の記録に 1 件を足し、返ってきた記録（ID、投稿者、時刻を含む）を `ReviewPost` の形にして返します。
- `onEntriesChanged` は、`rename` のときだけ、投稿とリンクの両方の記録で `renameEntry` を呼びます。
- `save` は、空でない値を渡されると例外です。

## default-columns.ts

列の定義のオブジェクトが 5 つあるだけです。`builtin.length` の `compute` は、`Array.from(text ?? "").length` で、コードポイントの数を返します。定義は、設定で `use` されるたびにコアが複製するので、プロジェクトの上書きが、ここのオブジェクトを書き換えることはありません。

## テスト

```sh
npx vitest run packages/builtin          # このパッケージのテスト
npm run test:perf                        # 時間の予算を見るテスト（csv.perf.test.ts を含む）
```

- `vi.mock` でのモジュールの差し替えはしていません。ツリーは一時フォルダの本物のファイルに対して動かします。列ソースは、コアのメモリ上の DB（`createMemoryDb`）と、本物のホスト（`createPluginHost`）に対して動かします。SQLite と Postgres のストアを通した確認は、サービス層のテストにあります。
- `csv.test.ts` には、決めた入力の確認のほかに、乱数で作った変更を当てて、結果を参照の実装とバイト単位で比べるテストと、5 万行のファイルでのテストがあります。
- ファイルへのシンボリックリンクのテストは、リンクを作れない環境（権限のない Windows など）では、`it.skipIf` で飛ばします。フォルダへのリンクのテストは、ジャンクションで作るので、飛ばしません。
- `csv.perf.test.ts` は、時間の予算（5 秒）を見るテストで、ふつうの `npm test` には入りません。

このパッケージを対象にした、壊し方の確認（`npm run test:mutation`）の一覧は、次のファイルにあります。

| 一覧 | このパッケージの対象 |
| --- | --- |
| `scripts/mutations/more.mjs` | 文字コード（`encoding.ts`、`csv.ts`） |
| `scripts/mutations/structure.mjs` | リソースの作成（`glob-tree.ts`）、キーの変更への追従（`db-source.ts`） |
| `scripts/mutations/review-cell.mjs` | 最新の投稿のコメント（`review-source.ts`） |
| `scripts/mutations/new-project.mjs` | 見出しの読み取り（`csv.ts`） |

2026-11-18 に、Windows 11（Node.js 26.5.1）で `npx vitest run packages/builtin` を実行し、8 ファイルの 203 件が通り、1 件を飛ばしました（飛ばしたのは、シンボリックリンクを作る権限が要るテストです）。

## 変えるときに揃えるもの

- **options を足す、既定を変える。** [settings.md](settings.md) の表と、[CONFIG.md](../../CONFIG.md) の同じ実装の表を直します。フォーマットの options のうち、設定の画面の「CSV / TSV の列の対応」が編集するもの（`key`、`text`、`encoding`）を変えるときは、`apps/web/lib/client/config-edit.ts` と、そのテストも直します。
- **実装を足す。** `index.ts` の `builtinPlugin` に足し、[README.md](../README.md) と [guide.md](guide.md) の一覧、[CONFIG.md](../../CONFIG.md) の同梱の表を直します。`id` は `builtin.` で始めます。
- **列の定義や選択肢の既定を変える。** 期待する値を書き下したテスト（`default-columns.test.ts`、`packages/server/src/new-project.test.ts`）を直します。選択肢の値（`todo`、`ok` など）は、この既定を使っているプロジェクトの共有 DB に、セルの値や投稿の判定として記録されています。値を変えるときは、記録済みの値がどうなるかを先に確かめます。
- **バリデータの指摘が変わる修正をする。** `version` を上げます。`code` は、条件式の `issueCode`（[QUERY.md](../../QUERY.md#組み込みの欄)）と、コマンドラインの `validate` の集計に、そのまま出る値です。変えると、利用者が書いた条件式が合わなくなります。
- **フォーマットの書き戻しを変える。** 「変更したフィールドのほかは変えない」が保たれていることを、`csv.test.ts` の、バイト単位で比べるテストで確かめます。
- **新しいプロジェクトの雛形が使う関数を変える。** `packages/server/src/new-project.ts` と、そのテストを確かめます。
- **振る舞いを足したら、壊し方も足す。** その振る舞いを決めている条件の壊し方を、`scripts/mutations/` の一覧に足します（[AGENTS.md のテストの決まり](../../../AGENTS.md#テストの決まり)）。

アプリのコード（コア、サービス層、画面）に、同梱の実装のための分岐を足さないでください。同梱の機能も、拡張ポイントと設定の実装として書きます。

## この文書を書いたときに確かめたこと

ファイルの構成、関数の名前、処理の流れは、2026-11-18 の時点のソースを読んで書きました。コードを動かして確かめたのは、[guide.md の「確かめた範囲」](guide.md#確かめた範囲)と、上のテストの実行です。壊し方の確認（`npm run test:mutation`）は、この文書のためには実行していません。
