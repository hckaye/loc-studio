# アクションを書く

アクションは、ボタンやコマンドで実行する操作です。セルの値の変更、メッセージ、開く場所を返します。レビューの投稿を外部のチケットに転載する先（レビュー先）も、アクションとして書きます。

置き場所と読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

## 実装する項目（Action）

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `id` | 必須 | `string` | 登録 ID。設定の `actions`、または `review.targets` に書く |
| `label` | 必須 | `string` | ボタンやメニューに出る表示名 |
| `target` | 必須 | `"cell" \| "column" \| "row" \| "selection" \| "file" \| "review"` | 対象（下の表） |
| `run` | 必須 | `(ctx) => Promise<ActionResult>` | 実行する。結果を返す |
| `when` | 任意 | `(ctx) => boolean` | `false` を返すと、その対象では実行されない |
| `columns` | 任意 | `string[]` | 使える列の ID。設定の `columns[].id` に書いた ID（登録 ID ではない） |
| `languages` | 任意 | `string[]` | 使える言語の ID |
| `icon` | 任意 | `string` | アイコン |

## target と、run が受け取る値

`target` によって、`run` と `when` が呼ばれる回数と、`ctx`（`ActionContext`）に入る値が変わります。

| `target` | 呼ばれ方 | `ctx` に入る値 | 画面での置き場所 |
| --- | --- | --- | --- |
| `cell` | 行ごとに 1 回 | `entry`、`row`、`column`、`value`（そのセルのいまの値。本文は未保存の編集を含む）、`language`（言語ごとの列のとき） | アクション列のボタン、複数行を選んだときのバー |
| `row` | 行ごとに 1 回 | `entry`、`row`、`language`（指定されたとき） | アクション列のボタン、複数行を選んだときのバー |
| `column` | 1 回だけ | `entries`（リソースの全行）、`rows`、`column`、`language`（言語ごとの列のとき） | 列見出しの「⋮」メニュー |
| `selection` | 1 回だけ | `entries`（選んだ行。行の指定がなければ全行）、`rows` | 複数行を選んだときのバー |
| `file` | 1 回だけ | `entries`（リソースの全行）、`rows` | ツールバーの「アクション ▾」 |
| `review` | 投稿の転載ごとに 1 回 | `entry`、`row`、`review`（投稿）、`column`（レビュー列）、`value`（投稿の判定）、`language` | レビューの投稿パネル |

どの `target` でも、`options`（設定の `options`）、`secrets`、`env`、`host`（[host.md](host.md)）が入ります。表にない項目は `undefined` です。たとえば `file` 対象のアクションでは `ctx.entry` は `undefined` なので、行は `ctx.entries` から読みます。

`rows` は、`entries` と同じ順に並んだ `row` の配列です（`ctx.rows[i]` が `ctx.entries[i]` の行）。リソースを書き出す、外部のサービスに送るといったアクションは、ここから各行の本文と列の値を読みます。ほかのリソースの行は `ctx.host.project.rows(リソースの ID)` で読めます（[host.md](host.md#プロジェクトを読むhostproject)）。

`entry` は `{ key, resource, meta?, stableId? }` です。`row` は、同じ行のほかの値を読む窓口で、`row.text(言語 ID)` で本文を、`row.get(列 ID, 言語 ID?)` で列の値を返します。

## run が返す値（ActionResult）

| 項目 | 意味 |
| --- | --- |
| `patches` | セルの変更の配列。各要素は `{ resourceId, entryKey, columnId, language?, value }`。`language` は、言語ごとの列のときに書く |
| `message` | 利用者に見せるメッセージ |
| `open` | 開く場所。`{ url }` か `{ file, line? }` |
| `links` | 外部に作ったもの（チケットなど）へのリンク（`{ label, url }` の配列）。`target: "review"` のとき、投稿に紐づけて保存される |

変更がないときは、空のオブジェクト `{}` を返します。

`patches` の反映には、次の決まりがあります。

- 本文の列への変更は、画面の編集と同じく、未保存の変更（ドラフト）になります。リソースに書くには、保存（CLI では `save`）が要ります。
- ステータスなどの列ソースの列への変更は、すぐに保存されます。
- 反映できない変更（読み取り専用の言語、存在しない列など）は、理由つきのエラーとして返ります。ほかの変更は反映されます。
- 変更履歴には、原因がアクションであること（`cause: "action"`）と、アクションの `id` が残ります。
- `cell` 対象と `row` 対象は、対象が 20 行を超えると、ジョブとして実行されます。

## 例

セルを対象にして変更を返すアクション（`mystudio.trim`）と、レビュー先としてリンクを返すアクション（`mystudio.openTicket`）です。

`loc-studio-plugins/trim-action.ts`:

```ts
import { definePlugin } from "@loc-studio/sdk";

export default definePlugin({
  name: "mystudio-trim",
  actions: [
    {
      id: "mystudio.trim",
      label: "前後の空白を削除",
      target: "cell",
      columns: ["text"],
      // 変わらないセルでは実行しない
      when: ({ value }) => typeof value === "string" && value !== value.trim(),
      async run({ entry, column, language, value }) {
        if (!entry || !column || !language || typeof value !== "string") return {};
        return {
          patches: [
            { resourceId: entry.resource.id, entryKey: entry.key, columnId: column.id, language: language.id, value: value.trim() },
          ],
        };
      },
    },
    {
      id: "mystudio.openTicket",
      label: "チケットを作る",
      target: "review", // レビューの投稿を転載する先
      async run({ entry, review, options }) {
        if (!entry || !review) return {};
        const base = String(options.baseUrl ?? "https://tracker.example.com");
        const url = `${base}/new?key=${encodeURIComponent(entry.key)}&verdict=${encodeURIComponent(review.verdict)}`;
        return { links: [{ label: "チケット", url }], message: "チケットの作成画面を用意しました" };
      },
    },
  ],
});
```

`mystudio.trim` の `columns: ["text"]` は、ID が `text` の列にだけ使えるという指定です。本文の列に別の ID を付けたプロジェクトでは、その ID に書き換えます。

## 設定

`target` が `review` 以外のアクションは `actions` に、`review` のアクションは `review.targets` に書きます。

```json
"actions": ["mystudio.trim"],
"review": { "targets": [{ "use": "mystudio.openTicket", "options": { "baseUrl": "https://tracker.example.com" } }] }
```

- 設定の `actions` に書いていないアクションは、登録されていても実行できません。
- 表にボタンを出すには、`kind: "actions"` の列を `columns` に足して、その `actions` にアクションの `id` を並べます（`{ "id": "ops", "kind": "actions", "scope": "language", "actions": ["mystudio.trim"] }`）。
- `review.targets` に置けるのは、`target: "review"` のアクションだけです。
- 転載するかどうかは、ローカル設定の `review.forwardOnPost` で決まります（[CONFIG.md の actions と review.targets](../CONFIG.md#actions-と-reviewtargets)）。

## 確かめ方

`cell` 対象のアクションは、CLI の `run` で実行できます。サンプルプロジェクトのコピーの `Assets/Text/system/ui.csv` の末尾に、日本語の本文の前後に空白がある行を足します。

```csv
UI_PAD, 戻る ,Back...,返回,뒤로,
```

```sh
node apps/cli/dist/index.js run mystudio.trim --project <プロジェクト> --resources "**/ui.csv" --column text --languages ja --keys UI_PAD
node apps/cli/dist/index.js save --project <プロジェクト>
```

`--column` は列の ID、`--keys` は行のキーです。出力は、順に次のとおりです。

```
Assets/Text/system/ui.csv text@ja: 反映 1
前後の空白を削除（mystudio.trim）: リソース 1 / 反映 1 / 失敗 0
本文の変更は未保存です。save で書き込んでください。
```

```
保存: リソース 1 / セル 1 / 競合 0
```

保存のあと、`UI_PAD, 戻る ,Back...` の行は `UI_PAD,戻る,Back...` に変わり、行のほかの部分は変わりませんでした。前後に空白のないセル（`--keys UI_OK`）に対しては、`when` が `false` を返し、`反映 0` で終わります。`run` と `save` は、プロジェクトのフォルダに `.loc-studio/`（共有 DB）を作ります。

`review` 対象のアクションは、CLI の `run` では実行できません。サービス層の `postReview` を `forward: true` で呼んで確かめました（ローカル設定の `review.forwardOnPost` は既定の `ask`）。同梱のレビュー列 `reviewStatus@ko` に判定 `back` を投稿すると、戻り値の `links` は `[{"label":"チケット","url":"https://tracker.example.com/new?key=UI_OK&verdict=back"}]` で、投稿の一覧にも同じリンクが保存されていました。画面では、投稿のパネルに「レビュー先に転載する」のチェックボックスが出ます。転載に失敗しても、投稿は失敗にならず、警告になります。

## 参考になる実装

- 対象ごとの呼ばれ方の実装は `packages/server/src/actions.ts`、レビューの転載は `packages/server/src/reviews.ts` にあります。
