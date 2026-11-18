# 列の定義と計算列を書く

プラグインは、列の定義（`ColumnDef`）を `id` を付けて登録できます。登録した列は、設定の `columns` が `use` で選びます。プラグインで列を登録するのは、次の場合です。

- 計算列を作る。計算の関数（`compute`）は設定の JSON に書けないので、プラグインが列として登録します。
- 列の定義（選択肢、列ソース、独自描画の指定など）を、複数のプロジェクトで使い回す。

関数を持たない列は、プラグインなしで、設定の `columns` に直接書けます（[CONFIG.md の columns](../CONFIG.md#columns)）。

置き場所と読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

## 実装する項目（ColumnDef）

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `id` | 必須 | `string` | 登録 ID。設定の `columns[].use` に書く |
| `kind` | 必須 | `"key" \| "text" \| "meta" \| "computed" \| "actions" \| "generated" \| "review"` | 列の種類（下の表） |
| `scope` | 必須 | `"entry" \| "language"` | `entry`: 行に 1 つ。`language`: 言語ごとに 1 つ |
| `label` | 任意 | `string` | 表示名 |
| `languages` | 任意 | `string[]` | 特定の言語だけに出す。省略すると全言語 |
| `type` | 任意 | `"string" \| "number" \| "boolean" \| { enum, default? }` | 値の型 |
| `source` | 任意 | `string` | 値の出所。設定の `sources` のキー、列ソースの登録 ID、または `"file"` |
| `of` | 任意 | `string` | `kind: "review"` の対象の列の ID |
| `actions` | 任意 | `string[]` | `kind: "actions"` に並べるアクションの ID |
| `generator` | 任意 | `string` | `kind: "generated"` の生成器の名前 |
| `basis` | 任意 | `"text"` | 値を付けた時点の本文の版を記録する |
| `history` | 任意 | `boolean` | `false` で変更履歴の対象から外す |
| `options` | 任意 | `object` | 列に渡す値。`compute`、`display`、独自描画が読む |
| `display` | 任意 | `"link" \| "progress" \| "color" \| "tags"` | 同梱の見せ方 |
| `renderer` | 任意 | `string` | 独自描画の `id`（[renderer.md](renderer.md)） |
| `compute` | `kind: "computed"` のとき必須 | `(ctx) => { value, error? }` | 値を作る関数 |

| `kind` | 値の出所 | 書く場所 |
| --- | --- | --- |
| `key` | フォーマット（行のキー） | 同梱の `builtin.key` を選ぶ |
| `text` | フォーマット（本文） | 同梱の `builtin.text` を選ぶ |
| `meta` | `source` が省略か `"file"` ならファイルの中の列。それ以外は列ソース | このページ、[source.md](source.md) |
| `computed` | `compute` の戻り値。保存しない | このページ |
| `review` | `postReview` と `listReviews` を実装した列ソース | [source.md](source.md#レビューに対応した列ソース) |
| `generated` | 生成器の結果（キャッシュされる） | [generator.md](generator.md) |
| `actions` | なし（アクションのボタンを並べる） | [action.md](action.md) |

各項目の詳しい意味と、種類ごとの画面での動きは、[CONFIG.md の ColumnDef](../CONFIG.md#columndef) にあります。

## 計算列

`kind: "computed"` の列は、`compute(ctx)` で値を作ります。値は保存されず、読み取り専用です。

`compute` が受け取る `ctx`（`ComputeContext`）は次のとおりです。計算列には `ctx.host` が渡されません。

| 項目 | 型 | 内容 |
| --- | --- | --- |
| `entry` | `Entry` | 行の情報（`key`、`resource`、`meta`） |
| `language` | `LanguageDef` または `undefined` | 言語ごとの列（`scope: "language"`）では、その言語の定義 |
| `text` | `string` または `undefined` | 言語ごとの列では、その言語の本文（未保存の編集を含む） |
| `row` | `RowReader` | 同じ行のほかの値を読む。`row.text(言語 ID)`、`row.get(列 ID, 言語 ID?)` |
| `options` | `object` | 列の `options`。設定で上書きした場合は、設定の値 |

戻り値は `{ value, error? }` です。`error` に説明を入れると、セルにエラーの印が付きます。

- `compute` は、表示する行の分だけ呼ばれます。軽い処理にしてください。
- `compute` が投げた例外は、そのセルのエラーの印になります。表全体が読めなくなることはありません。
- 同期の関数です。`Promise` を返す処理（外部の API の呼び出しなど）は書けません。

## 例

本文の行数を数え、上限を超えるとエラーの印を付ける列です。

`loc-studio-plugins/lines-column.ts`:

```ts
import type { Plugin } from "@loc-studio/sdk";

export default {
  name: "mystudio-columns",
  columns: [
    {
      id: "mystudio.lines",
      kind: "computed",
      scope: "language",
      label: "行数",
      options: { max: 3 },
      compute: ({ text, options }) => {
        const n = (text ?? "").split("\n").length;
        return n > Number(options.max) ? { value: n, error: `${options.max} 行を超えています` } : { value: n };
      },
    },
  ],
} satisfies Plugin;
```

## 設定

`loc-studio.project.json` の `columns` の配列に、`use` で登録 ID を、`id` で列の ID を書きます。

```json
"columns": [
  { "use": "builtin.key", "id": "key" },
  { "use": "builtin.text", "id": "text" },
  { "use": "mystudio.lines", "id": "lines", "options": { "max": 4 } }
]
```

- `id` を書かないと、列の ID は登録 ID（`mystudio.lines`）になります。列の ID はセル ID や DB の記録に残るので、短い ID を付けます。
- `use` と一緒に書いたキーは、登録された定義の同じキーを置き換えます。型（`ColumnUse`）が定めるキーは `id`、`label`、`languages`、`type`、`source`、`of`、`actions`、`generator`、`options`、`display`、`renderer` です。
- 置き換えはキーごとで、中身は混ぜません。設定に `options` を書くと、列の定義の `options` は丸ごと置き換わります。上の設定では、`compute` が受け取る `options` は `{ "max": 4 }` です。
- `use` と `kind` を両方書いた要素は、登録された列を選ぶ指定ではなく、列の定義そのものとして扱われます（`use` は無視されます）。登録された列を選ぶときは、`kind` を書きません。
- 設定に `columns` を書いていないプロジェクトは、キーと本文の 2 列だけです。列を足すときは、キーと本文の列も `columns` に書きます。

## 確かめ方

計算列の値は、CLI のコマンドには出ません。CLI では、登録されたことを `plugins` で確かめます。

```sh
node apps/cli/dist/index.js plugins --project <プロジェクト>
```

```
  column:
    ...
    mystudio.lines  <- mystudio-columns [project]
```

「警告」に「設定の columns[2] の列 "mystudio.lines" は登録されていません」が出ていなければ、設定の `use` は合っています。値は画面の表で確かめます。

サービス層の `rows()` を呼んで確かめた結果は次のとおりです。サンプルプロジェクトのコピーで、設定を `{ "use": "mystudio.lines", "id": "lines", "options": { "max": 0 } }` と `{ "use": "builtin.length", "id": "len" }` にすると、行 `UI_OK` のセル `lines@ja` は `{"value":1,"error":"0 行を超えています"}`、セル `len@ja` は `{"value":2}` でした。画面でのセルの表示は確かめていません。

## 列ソースや独自描画と組み合わせる

列の定義に `source` や `renderer` を書いておくと、設定は `use` と `id` だけで、その列を使えます。

- 列ソースと組にした列: [source.md の「ホストの DB に置く列ソース」](source.md#ホストの-db-に置く列ソース)
- 独自描画と組にした列: [renderer.md](renderer.md)

## 参考になる実装

- `packages/builtin/src/default-columns.ts`: 同梱の列（`builtin.key`、`builtin.text`、`builtin.textStatus`、`builtin.reviewStatus`、計算列の `builtin.length`）
- 同梱の実装が守っている決まりと、処理の流れの説明: [bundled-plugins/builtin/design.md](../bundled-plugins/builtin/design.md)、[bundled-plugins/builtin/implementation.md](../bundled-plugins/builtin/implementation.md)
