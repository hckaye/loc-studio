# フックを書く

フックは、書き込みの前後に呼ばれる処理です。スタジオごとの決まりを、アプリを変えずに足すために使います。たとえば、凍結した行のステータスを変えさせない、本文を保存したらステータスを作業中に戻す、差し戻しのレビューで状態を戻す、リソースを書く前にバージョン管理でチェックアウトする、といった処理です。

置き場所と読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

「どの値からどの値に変えられるか」「その値を誰が選べるか」だけなら、フックを書かずに設定で決められます（[CONFIG.md の列挙の選択肢](../CONFIG.md#列挙enumの選択肢)の `from` と `roles`）。フックは、設定で書けない条件や、書き込みに続けて何かをしたいときに使います。

## 実装する項目（WorkflowHook）

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `id` | 必須 | `string` | 登録 ID。設定の `hooks` に書く |
| `events` | 任意 | できごとの種類の配列 | 受け取るできごとを絞る。省略するとすべて受け取る |
| `before` | どちらか必須 | `(event, ctx) => string \| void`（`Promise` でもよい） | 書き込みの前に呼ばれる。文字列を返すと、書き込みをやめる |
| `after` | どちらか必須 | `(event, ctx) => { patches? } \| void`（`Promise` でもよい） | 書き込みのあとに呼ばれる。続けて反映するセルの変更を返せる |

`ctx` には `options`（設定の `options`）と `host`（[host.md](host.md)）が入ります。いまの利用者は `ctx.host.user`（`name` と、Web モードでの役割の ID の `role`）で分かります。ほかの行やリソースの値は `ctx.host.project` で読めます。

## できごとの種類と、受け取る値

| `event.type` | 起きるとき | おもな値 |
| --- | --- | --- |
| `cells.set` | 本文以外の列の値を変えるとき（ステータスなど） | `resource`、`column`、`language`（言語ごとの列のとき）、`changes`（`{ cell, oldValue, newValue }` の配列）、`cause` |
| `text.save` | 未保存の本文をリソースに保存するとき | `resource`、`column`（本文の列）、`changes`（保存するセルごとの `{ cell, oldValue, newValue }`） |
| `review.post` | レビューを投稿するとき | `resource`、`column`、`language`、`cell`、`verdict`、`comment`、`previous`（直前の判定）。`after` では `review`（保存された投稿）も入る |
| `entries.change` | 行を足す、消す、キーを変えるとき | `resource`、`changes`（フォーマットの `apply` に渡すものと同じ） |
| `resource.write` | リソースを書くとき | `resource` |

`cells.set` の `changes` は、同じ列・同じ言語のセルです。複数行をまとめて変えたときは 1 回のできごとにまとまり、`cause` が `"bulk"` になります。利用者が 1 つのセルを変えたときは `"manual"`、アクションが返した変更は `"action"` です。`oldValue` は変える前の値で、値のないセルでは列の既定値（`type.default`）です。

`resource.write` は、本文の保存、リソースの中の列（`source: "file"`）の変更、行の追加・削除、リソースの作成のどれでも起きます。リソースを書く前に共通して行うこと（チェックアウトなど）は、ここに書きます。

本文を編集して確定しただけ（未保存の変更）では、フックは呼ばれません。保存したときに `text.save` が呼ばれます。

本文の保存では、`text.save` の `before`、`resource.write` の `before`、リソースへの書き込み、`resource.write` の `after`、`text.save` の `after` の順に呼ばれます。

## before と after の決まり

`before` の決まりは次のとおりです。

- 空でない文字列を返すと、その書き込みをやめます。文字列は理由として利用者に見せます（エラーの `code` は `blocked`、`data.hook` にフックの ID）。値、リソース、変更履歴は変わりません。
- 例外を投げたときも、書き込みをやめます（`code` は `failed`）。決まりを確かめられないまま書き込まないためです。
- フックは、設定の `hooks` に書いた順に呼ばれます。前のフックが書き込みを止めたら、後ろのフックも `after` も呼ばれません。
- 複数行をまとめて変える操作は、1 行でも止められたら全体をやめます。

`after` の決まりは次のとおりです。

- `{ patches: [...] }` を返すと、そのセルの変更を続けて反映します。各要素は `{ resourceId, entryKey, columnId, language?, value }` です。
- この変更は、利用者の役割の絞り込みや、選択肢の `from` / `roles` にかかわらず反映します。変更履歴には、きっかけがフックであること（`cause: "hook"`）とフックの ID、きっかけになった利用者の名前が残ります。
- フックが返した変更では、フックは呼ばれません（フックどうしが呼び合って止まらなくなるのを防ぐためです）。
- 例外を投げても、済んだ書き込みは取り消しません。警告になります。
- `resource.write` の `after` では `patches` を返せません。返しても反映されず、警告になります。

## 例

本文を保存したらその言語のステータスを作業中に戻すフックと、凍結した行のステータスを変えさせないフックです。

`loc-studio-plugins/workflow.ts`:

```ts
import { definePlugin } from "@loc-studio/sdk";

export default definePlugin({
  name: "mystudio-workflow",
  hooks: [
    {
      id: "mystudio.resetOnSave",
      events: ["text.save"],
      after(event) {
        if (event.type !== "text.save") return;
        return {
          patches: event.changes.map((c) => ({
            resourceId: c.cell.resourceId,
            entryKey: c.cell.entryKey,
            columnId: "textStatus",
            language: c.cell.language!,
            value: "wip",
          })),
        };
      },
    },
    {
      id: "mystudio.freeze",
      events: ["cells.set"],
      before(event, ctx) {
        if (event.type !== "cells.set") return;
        const frozen = (ctx.options.keys as string[] | undefined) ?? [];
        const hit = event.changes.find((c) => frozen.includes(c.cell.entryKey));
        return hit ? `${hit.cell.entryKey} は凍結されています` : undefined;
      },
    },
  ],
});
```

`columnId` には、設定の `columns` に書いた列の ID を書きます（この例では、ステータスの列の ID が `textStatus` のプロジェクトを前提にしています）。

リソースを書く前に外部のコマンドを呼ぶ場合は、`resource.write` の `before` に書きます。失敗したら理由の文字列を返すと、リソースには何も書かれず、未保存の編集はそのまま残ります。

## 設定

```json
"hooks": [
  "mystudio.resetOnSave",
  { "use": "mystudio.freeze", "options": { "keys": ["UI_OK"] } }
]
```

- 設定の `hooks` に書いていないフックは、登録されていても呼ばれません。
- 登録されていない ID を書くと、プロジェクトは開き、警告が出ます。
- `hooks` は、コードを動かす設定なので、画面のローカルモードでは信頼の確認の対象です。Web モードでは、サーバーの管理者だけが変えられます。

## 確かめた範囲

上の決まりは、サービス層のテスト（`packages/server/src/workflow.test.ts`）で、一時フォルダのサンプルプロジェクトに実際のフックを登録して確かめています。呼ばれる順、`before` で止めたあとに値と履歴が変わらないこと、`after` の変更が役割の絞り込みにかかわらず入ること、その変更でフックが呼ばれないことを含みます。行の追加・削除での呼び出しは `structure.test.ts` にあります。

画面での操作（止められたときの通知の出方）は、ブラウザでは確かめていません。
