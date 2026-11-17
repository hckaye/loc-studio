# プラグインガイド

スタジオごとに違う部分（検証規則、ファイル形式、本文の記法、ステータスやレビューの置き場所、セルの見せ方、外部サービスとの連携）は、プラグインで差し替えます。プラグインは、拡張ポイントの実装に `id` を付けて登録するファイルです。登録された実装のうちどれを使うかは、プロジェクト設定（`loc-studio.project.json`）が `use` で決めます。同梱の機能（`@loc-studio/builtin`）も同じ interface の実装です。

型の定義は `packages/sdk/src/types.ts` が正です。この文書と食い違うときは、型の定義に従ってください。

## 文書の構成

プラグインを書くときは、このページを読んでから、作る種類のページを 1 つ読みます。ほかのページは、必要になったときに開けば足ります。

| 文書 | 内容 |
| --- | --- |
| このページ | 種類の選び方、作る手順、守る決まり、ID と名前、うまく動かないときの直し方 |
| [plugins/validator.md](plugins/validator.md) | バリデータ（本文、列の値、リソース全体の検証） |
| [plugins/syntax.md](plugins/syntax.md) | 本文の記法（変数、タグ、制御コードの見つけ方） |
| [plugins/format.md](plugins/format.md) | フォーマット（ファイル形式の読み書き） |
| [plugins/tree.md](plugins/tree.md) | ツリープロバイダー（リソースの一覧と読み書き。外部 API など） |
| [plugins/column.md](plugins/column.md) | 列の定義と計算列 |
| [plugins/source.md](plugins/source.md) | 列ソース（ホストの DB、外部 API、レビュー） |
| [plugins/generator.md](plugins/generator.md) | 生成器（生成列の値） |
| [plugins/action.md](plugins/action.md) | アクション（ボタンやコマンドで実行する操作） |
| [plugins/hook.md](plugins/hook.md) | フック（書き込みの前後に呼ばれる処理） |
| [plugins/renderer.md](plugins/renderer.md) | 独自描画（セルの見せ方を差し替えるブラウザ用のモジュール） |
| [plugins/host.md](plugins/host.md) | ホストの機能（`ctx.host`。DB、秘密情報、`fetch` など） |
| [plugins/settings.md](plugins/settings.md) | プラグインの設定（項目の宣言、プラグインごとの設定ファイル、設定の画面での編集） |
| [plugins/loading.md](plugins/loading.md) | 読み込みの決まり（プラグインフォルダと層、`plugin.json`、TypeScript、SDK の import） |
| [plugins/trust.md](plugins/trust.md) | 画面での信頼の確認、import の条件、個人のプラグインの制限 |

## 拡張ポイントの種類

拡張ポイントは 10 種類です。独自描画のモジュールだけはブラウザで動き、ほかはサーバー側（Node）で動きます。

| やりたいこと | 種類 | 書き方 |
| --- | --- | --- |
| 本文や列の値を検査して、問題を指摘する。ほかの行と比べて検査する | validator | [validator.md](plugins/validator.md) |
| 本文の中の変数、タグ、制御コードを見分ける | syntax | [syntax.md](plugins/syntax.md) |
| CSV / TSV 以外のファイル形式を読み書きする | format | [format.md](plugins/format.md) |
| リソースをフォルダ以外（外部の API など）から読み書きする | tree | [tree.md](plugins/tree.md) |
| 列を足す。ほかの値から計算した値を列に出す | column | [column.md](plugins/column.md) |
| 列の値を、ファイル以外（共有 DB、外部の API）に置く。レビューの投稿を受ける | source | [source.md](plugins/source.md) |
| 生成列の値を作る（逆翻訳など） | generator | [generator.md](plugins/generator.md) |
| ボタンやコマンドで、セルの値を変える。外部のチケットへのリンクを作る | action | [action.md](plugins/action.md) |
| 書き込みの前後に、スタジオの決まりを足す（書き込みを止める、状態を戻す、書く前にチェックアウトする） | hook | [hook.md](plugins/hook.md) |
| セルの見せ方を、自分で描いて差し替える | renderer | [renderer.md](plugins/renderer.md) |

1 つのプラグインに、複数の種類の実装を並べられます。種類ごとの `Plugin` の欄と、設定で選ぶ場所は次のとおりです。

| 種類 | `Plugin` の欄 | interface | 設定（`loc-studio.project.json`）で選ぶ場所 |
| --- | --- | --- | --- |
| validator | `validators` | `Validator` | `validators: ["<id>"]`、または `validators: [{ "use": "<id>", "options": {}, "severity", "languages", "columns" }]` |
| syntax | `syntaxes` | `TextSyntax` | `syntaxes: ["<id>"]` |
| format | `formats` | `Format` | `formats: [{ "use": "<id>", "match": "<glob>", "options": {} }]` |
| tree | `trees` | `TreeProvider` | `tree: { "use": "<id>", "options": {} }` |
| column | `columns` | `ColumnDef` | `columns: [{ "use": "<id>", "id": "<列 ID>", ...上書き }]` |
| source | `sources` | `ColumnSource` | 列の `source: "<id>"`。`sources: { "<名前>": { "use": "<id>", "options": {} } }` で名前と `options` を付けて、列の `source` にその名前を書いてもよい |
| generator | `generators` | `Generator` | `generators: { "<名前>": { "use": "<id>", "options": {} } }` と、生成列の `generator: "<名前>"` |
| action | `actions` | `Action` | `actions: ["<id>"]`。レビューの転載先は `review.targets: ["<id>"]` |
| hook | `hooks` | `WorkflowHook` | `hooks: ["<id>"]`、または `hooks: [{ "use": "<id>", "options": {} }]` |
| renderer | `renderers` | `CellRenderer` | 列の `renderer: "<id>"` |

設定の `options` は、実装の関数が呼ばれるたびに `ctx.options` として渡されます。設定の書き方の詳細は [CONFIG.md](CONFIG.md#use-と-options) にあります。

次のことは、プラグインを書かずに設定だけでできます。

| やりたいこと | 設定 |
| --- | --- |
| ステータスやレビューの選択肢、表示名、色を変える | 列の `type.enum` を上書きする（[CONFIG.md の列挙の選択肢](CONFIG.md#列挙enumの選択肢)） |
| どの状態からどの状態に変えられるか、その値を誰が選べるかを決める | 選択肢の `from` と `roles`（同じ節） |
| 役割を足す。役割ごとに、触れる列、見えるリソース、実行できるアクションを絞る | `roles`（[CONFIG.md の roles](CONFIG.md#roles)） |
| 編集画面で参照する言語と列、本文の長さの数え方を変える | `editor`（[CONFIG.md の editor](CONFIG.md#editor)） |
| 値をリンク、進み具合の棒、色見本、札で見せる | 列の `display`（[CONFIG.md の同梱の見せ方](CONFIG.md#同梱の見せ方display)） |
| CSV / TSV の見出しと言語を対応づける | `formats[].options`（[CONFIG.md の formats](CONFIG.md#formats)） |
| 共有 DB に置く列を足す | `{ "id": "...", "kind": "meta", "scope": "entry", "type": "string", "source": "builtin.db" }`（[CONFIG.md の columns](CONFIG.md#columns)） |
| 文字数の列を出す | `{ "use": "builtin.length", "id": "length" }` |
| LLM で翻訳した値を生成列に出す（機械翻訳、逆翻訳） | `llm.translation` の列と `llm.translate`（[CONFIG.md の generators](CONFIG.md#llm-で機械翻訳と翻訳の評価をする)） |
| LLM に、訳文を原文と比べて OK / WARNING / NG で判定させる | `llm.evaluation` の列と `llm.evaluate`（同じ節） |
| LLM に渡すプロンプトを変える | 設定の画面の「プラグインの設定」（[CONFIG.md](CONFIG.md#プロンプトなどの設定プラグインの設定)） |

## 作る手順

英語の本文に `...` があれば警告するバリデータを例に、置いてから動作を確かめるまでを示します。ほかの種類でも、手順 2 のコードと手順 3 の設定の場所が変わるだけで、流れは同じです。

コマンドは、loc-studio のリポジトリのルートで実行します。前もって `npm install` と `npm run build` を済ませてください（Node.js 22.13 以上）。`<プロジェクト>` は、`loc-studio.project.json` のあるフォルダのパスです。

試すときは、`examples/sample-project` のコピーを使います。元のフォルダに対して `status` などを実行すると、データベースのフォルダ `.loc-studio/` ができるためです。

```sh
# bash
cp -r examples/sample-project /tmp/sample-project
```

```powershell
# PowerShell
Copy-Item -Recurse examples/sample-project $env:TEMP/sample-project
```

### 1. 種類を決める

[拡張ポイントの種類](#拡張ポイントの種類)の表から選びます。本文の検査なので、ここでは validator です。

### 2. プラグインのファイルを置く

`<プロジェクト>/loc-studio-plugins/` の直下に、ファイルを 1 つ作ります。下の階層に置いたファイルは読み込まれません。ファイル名は自由です（`_` か `.` で始まる名前、`.d.ts`、`*.test.*` は無視されます）。

`loc-studio-plugins/ascii-ellipsis.ts`:

```ts
import { definePlugin } from "@loc-studio/sdk";
import type { ValidationIssue } from "@loc-studio/sdk";

export default definePlugin({
  name: "mystudio-ellipsis",
  version: "1.0.0",
  validators: [
    {
      id: "mystudio.asciiEllipsis",
      label: "「...」の使用",
      version: "1", // 検証の結果が変わる修正をしたら上げる（キャッシュの鍵に入る）
      severity: "warning",
      validate({ value, options }) {
        const replacement = typeof options.replacement === "string" ? options.replacement : "…";
        const issues: ValidationIssue[] = [];
        for (const m of value.matchAll(/\.{3,}/g)) {
          const start = m.index;
          issues.push({
            code: "ascii-ellipsis",
            message: `「${m[0]}」の代わりに「${replacement}」を使ってください`,
            range: { start, end: start + m[0].length },
            fix: { label: `「${replacement}」に置き換える`, value: value.replace(/\.{3,}/g, replacement) },
          });
        }
        return issues;
      },
    },
  ],
});
```

このファイルの要点は 3 つです。

- 既定のエクスポート（`export default`）で、プラグインのオブジェクトを書き出します。
- `validators` の欄に、バリデータの実装を並べます。欄の名前は種類ごとに決まっています（上の表）。
- 実装に `id` を付けます。設定はこの `id` で実装を選びます。

TypeScript のファイルは、そのまま読み込まれます。ビルドは要りません。

### 3. 設定で選ぶ

`<プロジェクト>/loc-studio.project.json` の `validators` の配列に、手順 2 の `id` を足します。

```json
"validators": [
  "builtin.placeholders",
  { "use": "mystudio.asciiEllipsis", "languages": ["JaEnglish"] }
]
```

ファイルを置いただけでは、実装は使われません。手順 2 だけを済ませた状態では、プラグインは読み込まれて `plugins` の一覧に出ますが、`validate` はこのバリデータの指摘を 1 件も出しません。

記法とフォーマットだけは扱いが違います。設定に `syntaxes` を書いていないプロジェクトでは登録されたすべての記法が、`formats` を書いていないプロジェクトでは登録されたすべてのフォーマットが使われます。サンプルプロジェクトのように `syntaxes` と `formats` を書いているプロジェクトでは、ほかの種類と同じく、設定に足す必要があります。

### 4. コマンドラインで確かめる

読み込まれたことを `plugins` で確かめます。

```sh
node apps/cli/dist/index.js plugins --project <プロジェクト>
```

出力の「プラグイン」に手順 2 の `name` が、「登録された実装」の `validator` に手順 2 の `id` が出ていれば、読み込まれています。

```
プラグイン:
  ...
  mystudio-ellipsis  1.0.0  [project]  <プロジェクト>/loc-studio-plugins/ascii-ellipsis.ts

登録された実装:
  ...
  validator:
    ...
    mystudio.asciiEllipsis  <- mystudio-ellipsis [project]
```

読み込めなかったプラグインは「読み込みエラー」に、設定の誤りは「警告」に出ます。読み込みエラーがあると、`plugins` の終了コードは 1 です。

続けて、動作を確かめます。確かめ方は種類ごとに違い、各ページの「確かめ方」にあります。バリデータは `validate` で確かめます。

```sh
node apps/cli/dist/index.js validate --project <プロジェクト> --resources "**/chapter01.csv"
```

サンプルプロジェクトでは、次の 2 行が出力に加わります。

```
  warning CH01_INTRO_002  JaEnglish  mystudio.asciiEllipsis  ascii-ellipsis  「...」の代わりに「…」を使ってください
  warning CH01_CHOICE_001B  JaEnglish  mystudio.asciiEllipsis  ascii-ellipsis  「...」の代わりに「…」を使ってください
```

`validate` は、重さが error の指摘が 1 件でもあると終了コード 1 で終わります。サンプルプロジェクトには同梱のバリデータが見つける error が元からあるので、この例でも終了コードは 1 です。

### 5. 画面で信頼する

ローカルモードの画面は、プロジェクトのフォルダと個人のフォルダにあるプラグインを、利用者が信頼するまで読み込みません。プロジェクトを開くと確認のダイアログが出るので、ファイルの一覧を確かめて信頼します。あとから信頼するときは、上のバーの「プラグイン」のダイアログにある「信頼していないため読み込んでいないプラグイン」の「信頼する」を押します。

プラグインのファイルを書き換えると、もう一度確認が要ります。コマンドラインと Web モードは、確認なしで読み込みます。信頼の確認には import の書き方の条件があり、[plugins/trust.md](plugins/trust.md) にまとめています。

## 守る決まり

1. 入口のファイルは、`export default` でプラグインを書き出します。書き出せるのは、`Plugin` のオブジェクト、`Plugin` を返す関数（`async` でもよい）、`Plugin` の配列のどれかです。
2. プラグインの `name` を書きます。省略すると、ファイル名（拡張子なし）かフォルダ名になります。
3. 実装の `id` は、`mystudio.lineWidth` のように「スタジオの名前 + `.` + 実装の名前」にします。`builtin.` と `llm.` で始まる `id` は、同梱のプラグインが使っています。同じ種類で同じ `id` を登録すると、後から読み込まれた層の実装が前の実装を上書きし、警告が出ます。
4. 種類ごとの必須の項目（下の表）をすべて書きます。1 つでも足りないと、そのファイルのプラグイン全体が登録されません。
5. 実装を使うには、設定の `use` で選びます（[作る手順の 3](#3-設定で選ぶ)）。
6. 本文中の位置（`range`）は、UTF-16 の添字で書きます。`end` の位置の文字は範囲に含みません。JavaScript の文字列の添字（`String.prototype.slice` の引数）と同じです。
7. バリデータと生成器の `version` は、結果が変わる修正をしたら上げます。`version` は結果のキャッシュの鍵に入っているので、上げないと古い結果が残ります。
8. 接続キーなどの秘密情報は、設定ファイルやコードに書かず、`ctx.host.secrets.get("<名前>")` で読みます。ログやエラーメッセージにも出しません（[host.md](plugins/host.md)）。
9. 1 つのプラグインを複数のファイルに分けるときは、フォルダ形式（`loc-studio-plugins/<名前>/index.ts`）にするか、補助のファイルの名前を `_` で始めます（`_shared.ts` など）。プラグインフォルダの直下にあるコードのファイルは、名前が `_` か `.` で始まるものを除いて、1 つずつがプラグインとして読み込まれるためです。補助のファイルをそのまま置くと、「既定のエクスポート（export default）がありません。」の読み込みエラーになります。
10. import できるのは、プラグインのフォルダの中のファイル（相対 import）、Node の組み込み、`@loc-studio/sdk`、プラグイン自身の `node_modules` にあるパッケージです。画面のローカルモードは、これ以外の import を含むプラグインを読み込みません（[trust.md](plugins/trust.md)）。
11. 独自描画のブラウザ用のモジュールは、JavaScript（`.js` / `.mjs`）で書き、フォルダ形式のプラグインの中に置きます（[renderer.md](plugins/renderer.md)）。

種類ごとの必須の項目は次のとおりです。どの種類も、このほかに `id`（空でない文字列）が要ります。

| 種類 | 必須の関数 | 必須の文字列 |
| --- | --- | --- |
| validator | `validate` か `validateResource` のどちらか | `label` `version` |
| syntax | `tokenize` | |
| format | `match` `parse` `apply` | |
| tree | `list` `read` `write` | |
| column | | `kind` `scope` |
| source | `load` `save` | `saveMode` |
| generator | `cacheParams` `input` `run` | `version` |
| action | `run` | `label` `target` |
| hook | `before` か `after` のどちらか | |
| renderer | | `module`（プラグインのフォルダからの相対パス） |

## ID と名前

設定とコードには、似た役割の名前がいくつか出てきます。取り違えると「登録されていません」の警告や、値が読めない状態になります。

| 名前 | 決める場所 | 使う場所 | 例 |
| --- | --- | --- | --- |
| プラグインの `name` | プラグインのコード | `plugins` の一覧と警告の表示 | `mystudio-ellipsis` |
| 実装の `id`（登録 ID） | プラグインのコードの各実装 | 設定の `use` | `mystudio.asciiEllipsis` |
| 列の ID | 設定の `columns[].id`。省略すると列の登録 ID | セル ID、レビュー列の `of`、バリデータとアクションの `columns`、CLI の `generate <列 ID>`、DB の記録 | `text`、`textStatus` |
| セル ID | 列の ID と言語の ID から決まる。言語ごとの列は `<列 ID>@<言語 ID>`、行に 1 つの列は `<列 ID>` | CLI の `set`、サービス層の `setCell` など | `textStatus@ko`、`priority` |
| 列ソースの名前 | 設定の `sources` のキー | 列の `source`。この名前が `sources` になければ、列ソースの登録 ID として探す | `tracker` |
| 生成器の名前 | 設定の `generators` のキー | 生成列の `generator`。この名前が `generators` になければ、生成器の登録 ID として探す | `rev` |
| 名前空間 | プラグインのコード | `ctx.host.db.cells("<名前空間>")` などの引数。共有 DB の中の置き場所を分ける | `mystudio.memo` |
| 言語の ID | 設定の `languages[].id` | `languages` の指定、セル ID | `ja`、`JaEnglish` |

列の ID は、登録 ID とは別の名前です。設定で `{ "use": "builtin.text", "id": "text" }` と書いた列の ID は `text` で、バリデータやアクションの `columns: ["text"]` が指すのはこの ID です。

## うまく動かないとき

まず `plugins` を実行して、「読み込みエラー」と「警告」を読みます。`--json` を付けると、機械可読の出力になります。

```sh
node apps/cli/dist/index.js plugins --project <プロジェクト>
```

| 症状 | 原因 | 直し方 |
| --- | --- | --- |
| `plugins` の「プラグイン」に出ず、エラーもない | 置き場所が対象外。プラグインフォルダの下の階層にある、名前が `_` か `.` で始まる、`*.test.*` や `.d.ts` である、フォルダに `plugin.json` も `index.*` もない、のどれか | `<プロジェクト>/loc-studio-plugins/` の直下に置く。フォルダ形式なら `index.ts` を作る。「探したプラグインフォルダ」に出るパスが、置いた場所と同じか確かめる |
| 読み込みエラー「既定のエクスポート（export default）がありません。」 | `export const plugin = ...` のように、名前付きで書き出している | `export default` で書き出す |
| 読み込みエラー「validators[0]（"x"） に関数 validate がありません。」「validators[0]（"x"） の version は文字列にしてください。」 | 必須の項目が足りない | [守る決まり](#守る決まり)の表の項目を足す |
| 読み込みエラー「validators は配列にしてください。」 | 欄に、配列でない値を書いている | `validators: [ ... ]` のように配列にする |
| 読み込みエラー「Cannot find module '...'」 | import したパッケージかファイルが見つからない | 相対パスを確かめる。パッケージはプラグイン自身の `node_modules` に置く |
| 読み込みエラー「プラグイン API の版 2 には対応していません（このアプリの版は 1）。」 | `apiVersion` がアプリの版と違う | `apiVersion` を `1` にするか、書かない |
| `plugins` の「登録された実装」には出るが、検証や表に反映されない | 設定で選んでいない | 設定の `use` に `id` を書く（[拡張ポイントの種類](#拡張ポイントの種類)の表） |
| 警告「設定の validators[5] にある validator "x" は登録されていません（使える validator: ...）。」 | 設定の `id` の書き間違い。または、そのプラグインが読み込みエラーになっている | 警告の「使える validator」の一覧にある `id` と見比べる。読み込みエラーがあれば先に直す |
| 警告「設定の columns[4] の列 "x" は登録されていません（使える列: ...）。この列は表示しません。」 | `columns` の `use` が、列の登録 ID と違う | プラグインの `columns` の `id` と同じ文字列にする |
| 警告「設定の columns[7]（"m1"） の出所 "x" は、設定の sources にも登録された列ソースにもありません。」 | 列の `source` が、`sources` のキーにも列ソースの登録 ID にもない | `source` を、`sources` のキーか列ソースの `id` に合わせる |
| `run` が「アクション "x" は設定の actions にありません（使えるアクション: ...）。」で終わる（終了コード 2） | 登録はされているが、設定の `actions` に書いていない | 設定の `actions` に `id` を足す |
| `generate` が「生成列 "x" の生成器 "y" が見つかりません（設定の generators と登録された生成器を確かめてください）。」で終わる（終了コード 2） | 生成列の `generator` が、`generators` のキーにも生成器の登録 ID にもない | 生成列の `generator` を `generators` のキーに合わせる |
| 警告「validator "x" をプラグイン "A" が上書きしました（元はプラグイン "B"）。」 | 同じ種類の同じ `id` が 2 回登録された | 意図した上書きでなければ、`id` を変える |
| コマンドラインでは動くが、画面で動かない | 画面のローカルモードで、プラグインを信頼していない | 「プラグイン」のダイアログで「信頼する」を押す |
| 読み込みエラー「信頼の確認の条件を満たさないため読み込みません: ...」（画面だけ） | import の書き方が、信頼の確認の条件に合わない | エラーにある行を、[trust.md](plugins/trust.md) の条件に合わせて直す |
| ファイルを書き換えたのに、画面に反映されない | 画面は、開いたときに読み込んだプラグインを使い続ける | 「プラグイン」のダイアログの「プラグインを再読み込み」を押す（Web モードでは manager だけが使えます）。コマンドラインは毎回読み込み直します |

CLI の `plugins` の「警告」に出るのは、`tree`、`formats`、`syntaxes`、`validators`、`sources`、`columns` の `use`、列の `source` と `renderer` の誤りです。`actions`、`review.targets`、生成列の `generator` の誤りは、`plugins` には出ません。CLI では `run` や `generate` を実行したときにエラーになり、画面では「警告とエラー」に「設定の actions にあるアクション "x" は登録されていません。」のように出ます。

壊れたプラグインがあっても、ほかのプラグインは読み込まれます。実行時の失敗は、次のように出ます。

- バリデータが例外を投げると、`validator-failed`（error）の指摘になります。ほかのバリデータは動き続けます。
- アクションや生成器の例外は、アクションの名前や行のキーを含むメッセージとして、画面の通知と CLI の標準エラー出力に出ます。`LOC_STUDIO_DEBUG=1` を付けると、CLI はスタックトレースも出します。
- 計算列の `compute` が投げた例外は、そのセルのエラーの印になります。
- 独自描画の失敗は、そのセルだけが既定の見せ方に戻り、`!` の印が付きます。印にマウスを置くと理由が出ます。後片付けの失敗は、ブラウザのコンソールに出ます。
- `ctx.host.log(message)` は、標準エラー出力に書きます。

画面では、上のバーの「プラグイン」で、`plugins` と同じ内容（読み込んだプラグイン、探したフォルダ、エラーと警告）を見られます。下のステータスバーの「警告とエラー」にも、プラグインのエラーと設定の警告が出ます。

## 例を確かめた範囲

この文書群のコードの例は、`examples/sample-project` の一時コピーに置き、設定を足して、動かして確かめたものです。2026-11-15 に、Windows 11（Node.js 26.5.1）で、文書からコードを取り出して置き直し、下の表の「Windows」の列の内容をもう一度実行しました。結果は、各ページの「確かめ方」に書いた出力と同じでした。

| 例 | ページ | 確かめ方 | Windows でのやり直し |
| --- | --- | --- | --- |
| バリデータ | [validator.md](plugins/validator.md) | CLI: `plugins`、`validate` | 同じ |
| 記法 | [syntax.md](plugins/syntax.md) | CLI: `plugins`、`validate` | 同じ |
| フォーマット | [format.md](plugins/format.md) | CLI: `tree`、`validate`、`run`、`save` | 同じ |
| ツリー（フォルダ 1 つを並べる例） | [tree.md](plugins/tree.md) | CLI: `tree`。サービス層: `setText`、`save`（外で書き換えたあとの保存を含む） | Windows で初めて確かめた |
| ツリー、外部 API の列ソース | [tree.md](plugins/tree.md)、[source.md](plugins/source.md) | モック API と CLI: `tree`、`status`。保存と競合は `packages/server/src/remote-example.test.ts` | CLI の `tree` と `status`、トークンがないときのエラー |
| 計算列 | [column.md](plugins/column.md) | サービス層: `rows`。CLI: `plugins` | 同じ（`max` が 0 の場合） |
| 列と列ソース | [source.md](plugins/source.md) | CLI: `set`。サービス層: `rows` | 同じ |
| レビューの列ソース | [source.md](plugins/source.md) | サービス層: `postReview`、`reviews`、`rows` | 同じ |
| 生成器 | [generator.md](plugins/generator.md) | CLI: `generate`（`--dry-run`、本実行、再実行） | 同じ |
| アクション（セル） | [action.md](plugins/action.md) | CLI: `run`、`save` | 同じ |
| アクション（レビューの転載先） | [action.md](plugins/action.md) | サービス層: `postReview`（`forward: true`） | 同じ |
| 独自描画 | [renderer.md](plugins/renderer.md) | 本番ビルドのサーバー: `trustPlugins`、`info`、`GET /api/renderer/<id>`。jsdom で `render`。headless の Chrome で表示 | 信頼のあとに `info().renderers` に出ることと、列の値の保存だけ |
| フォルダ形式での npm パッケージの import | [loading.md](plugins/loading.md) | CLI: `plugins`、`validate`。サービス層: 信頼の確認つきの読み込み | Windows で初めて確かめた |

サービス層を `pluginTrust: "prompt"`（画面のローカルモードと同じ）で開き、設定ファイルとプラグインを信頼したあとに、この文書群のすべての例と、`examples/sample-project`、`examples/remote-project` のプラグインが、読み込みエラーなしで読み込まれることも確かめました。TypeScript の例は、`strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax` を有効にした `tsc` で、SDK の型に対して型検査が通ることを確かめています。どちらも、Windows でやり直して同じ結果でした。

次のことは、動かして確かめていません。

- 画面（ブラウザ）での、これらのプラグインの動作と、信頼のダイアログの操作。説明はコードに基づきます。独自描画は、headless の Chrome で表示だけを確かめました。
- 自作のツリープロバイダーと、外部 API の列ソースの、実際の外部サービスに対する動作。確かめたのはモック API だけです。
- ES モジュールだけを配る npm パッケージの import。確かめたのは、プラグインの `node_modules` に置いた CommonJS のパッケージです。
- 別のコピーの SDK が読み込まれる環境（バンドルした画面のビルドなど）での、エラークラスの照合（[loading.md](plugins/loading.md#sdk-の-import)）。
