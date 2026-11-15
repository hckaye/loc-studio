# バリデータを書く

バリデータは、セルの値（ふつうは本文）を検査して、問題の一覧を返します。結果は表の問題の印、編集モーダルの下線、CLI の `validate` に出ます。ファイルには何も書きません。

置き場所、設定での選び方、読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

## 実装する項目（Validator）

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `id` | 必須 | `string` | 登録 ID。設定の `use` に書く |
| `label` | 必須 | `string` | 表示名 |
| `version` | 必須 | `string` | 検証の結果が変わる修正をしたら上げる。結果のキャッシュの鍵に入る |
| `validate` | 必須 | `(ctx) => ValidationIssue[]`（`Promise` でもよい） | 検査して、問題の配列を返す。問題がなければ空の配列 |
| `severity` | 任意 | `"error" \| "warning" \| "info"` | 既定の重さ。省略すると `"error"` |
| `columns` | 任意 | `string[]` | 対象を、この ID の本文の列に絞る。省略すると、本文の列（`kind: "text"`）すべてが対象 |
| `languages` | 任意 | `string[]` | 対象の言語の ID。省略すると全言語 |

検証されるのは、本文の列（`kind: "text"`）のセルだけです。`columns` は、その中から列の ID で対象を絞るための項目なので、本文以外の列の ID を書くと、そのバリデータはどのセルにも当たりません。`columns` に書くのは、設定の `columns[].id` に書いた列の ID です（列の登録 ID ではありません）。

## validate が受け取る値（ValidateContext）

| 項目 | 型 | 内容 |
| --- | --- | --- |
| `value` | `string` | 検査する値（本文） |
| `tokens` | `TextToken[]` | 記法が `value` を分けたトークン（変数、タグ、制御コード、本文） |
| `base` | `{ language, value, tokens }` または `undefined` | 基になる言語（設定の `basedOn`）の本文。原文の言語や、基の本文がない場合は `undefined` |
| `language` | `LanguageDef` または `undefined` | 言語の定義（`id`、`basedOn` など）。型の上では `undefined` がありうるが、本文の列のセルでは常に入る |
| `entry` | `Entry` | 行の情報（`key`、`resource`、`meta`） |
| `column` | `ColumnDef` | 検査している列の定義 |
| `row` | `RowReader` | 同じ行のほかの値を読む。`row.text(言語 ID)` で本文、`row.get(列 ID, 言語 ID?)` でファイルの中の列の値（CSV の `MaxLen` など）。共有 DB や外部の列ソースにある値（ステータスなど）は読めない |
| `options` | `Record<string, unknown>` | 設定の `options` に書いた値。書かなければ空のオブジェクト |

## validate が返す値（ValidationIssue）

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `code` | 必須 | `string` | 問題の種類を表す短い名前。絞り込みと集計に使う |
| `message` | 必須 | `string` | 利用者に見せる説明 |
| `severity` | 任意 | `"error" \| "warning" \| "info"` | この問題だけの重さ |
| `range` | 任意 | `{ start: number, end: number }` | 本文中の位置。UTF-16 の添字で、`end` の位置の文字は含まない。編集モーダルの「該当箇所」に使われる |
| `fix` | 任意 | `{ label: string, value: string }` | ワンクリックで直せる場合の修正案。`value` は、本文全体を置き換える値 |

## 例

英語の本文に `...` があれば警告し、`…` への置き換えを修正案として出します。

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

## 設定

`loc-studio.project.json` の `validators` の配列に足します。文字列（`id` だけ）か、次の形のオブジェクトです。

```json
"validators": [
  "builtin.placeholders",
  { "use": "mystudio.asciiEllipsis", "languages": ["JaEnglish"] }
]
```

| キー | 意味 |
| --- | --- |
| `use` | バリデータの `id` |
| `options` | `ctx.options` として渡す値 |
| `severity` | 重さの上書き |
| `languages` | 対象の言語。書くと、バリデータ自身の `languages` の代わりに使われる |
| `columns` | 対象を絞る本文の列の ID。書くと、バリデータ自身の `columns` の代わりに使われる |

同じバリデータを、`options` や `languages` を変えて複数回書けます。サンプルプロジェクトは、`mystudio.lineWidth` を言語ごとに違う `maxWidth` で 2 回書いています。

## 確かめ方

```sh
node apps/cli/dist/index.js validate --project <プロジェクト> --resources "**/chapter01.csv"
```

サンプルプロジェクトのコピーに上の例を置いて設定を足すと、出力に次の 2 行が加わります。

```
  warning CH01_INTRO_002  JaEnglish  mystudio.asciiEllipsis  ascii-ellipsis  「...」の代わりに「…」を使ってください
  warning CH01_CHOICE_001B  JaEnglish  mystudio.asciiEllipsis  ascii-ellipsis  「...」の代わりに「…」を使ってください
```

各行は、重さ、行のキー、言語、バリデータの `id`、`code`、`message` の順です。`--json` を付けると、`range` を含む機械可読の出力になります。`--languages <ID>` で、検証する言語を絞れます。

## 動きの決まり

- 重さは、設定の `severity`、指摘の `severity`、バリデータの `severity`、`"error"` の順で、最初に見つかったものになります。上の例は、設定にも指摘にも `severity` がないので、バリデータの `warning` です。
- `validate` が例外を投げると、その例外は `validator-failed`（error）の指摘になり、ほかのバリデータは動き続けます。
- 設定で選んでいないバリデータは、登録されていても呼ばれません。
- 検証の結果はキャッシュされます。キャッシュの鍵には `version` が入っているので、`validate` の中身を変えたら `version` を上げます。
- バリデータには `ctx.host` が渡されません。DB や外部の API は使えません。

## 参考になる実装

- `examples/sample-project/loc-studio-plugins/line-width.ts`: `options` を使い、行ごとの `range` を返す
- `examples/sample-project/loc-studio-plugins/studio-pack/index.mjs`: 素の JavaScript で書いたフォルダ形式のプラグイン
- `packages/builtin/src/validators.ts`: 同梱のバリデータ。`tokens` と `base` を使う `builtin.placeholders` など
