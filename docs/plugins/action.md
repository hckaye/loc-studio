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
| `runBatch` | 任意 | `(items) => Promise<ActionResult>` | 複数の行をまとめて処理する（`cell` / `row` 対象のアクション。下の「行をまとめて受け取る」） |
| `columns` | 任意 | `string[]` | 使える列の ID。設定の `columns[].id` に書いた ID（登録 ID ではない） |
| `languages` | 任意 | `string[]` | 使える言語の ID |
| `icon` | 任意 | `string` | アイコン |

## target と、run が受け取る値

`target` によって、`run` と `when` が呼ばれる回数と、`ctx`（`ActionContext`）に入る値が変わります。

| `target` | 呼ばれ方 | `ctx` に入る値 | 画面での置き場所 |
| --- | --- | --- | --- |
| `cell` | 行ごとに 1 回 | `entry`、`row`、`column`、`value`（そのセルのいまの値。本文は未保存の編集を含む）、`language`（言語ごとの列のとき） | アクション列のボタン、セルの右クリックのメニュー、複数行を選んだときのバー、「一括アクション ▾」 |
| `row` | 行ごとに 1 回 | `entry`、`row`、`language`（指定されたとき） | アクション列のボタン、セルの右クリックのメニュー、複数行を選んだときのバー、「一括アクション ▾」 |
| `column` | 1 回だけ | `entries`（リソースの全行）、`rows`、`column`、`language`（言語ごとの列のとき） | 列見出しの「⋮」メニュー |
| `selection` | 1 回だけ | `entries`（選んだ行。行の指定がなければ全行。「一括アクション」と `run --where` では、そのリソースの条件に合う行）、`rows` | セルの右クリックのメニュー、複数行を選んだときのバー、「一括アクション ▾」 |
| `file` | 1 回だけ | `entries`（リソースの全行）、`rows` | ツールバーの「アクション ▾」 |
| `review` | 投稿の転載ごとに 1 回 | `entry`、`row`、`review`（投稿）、`column`（レビュー列）、`value`（投稿の判定）、`language` | レビューの投稿パネル |

### セルの右クリックのメニューに項目を足す

表のセルの右クリックのメニューには、`target` が `cell` / `row` / `selection` のアクションが「アクション」のまとまりに並びます。メニューに項目を足すには、アクションを書いて、プロジェクト設定の `actions` に置きます。専用の拡張ポイントはありません。

- どの列のセルに出すかは、アクションの `columns`（列の ID）で絞れます。`languages` を書くと、その言語の列のセルにだけ出ます。
- 列を足すプラグインは、列の定義の `actions` にアクションの ID を並べると、その列のセルのメニューを、並べたアクションだけにできます。
- 実行すると、選んでいる行すべてが対象になります（`cell` と `row` は行ごとに 1 回、`selection` は 1 回）。`target: "cell"` のアクションには、右クリックしたセルの列が `ctx.column` に入ります。
- 役割の `actions` で実行できないアクションは、理由つきで押せません。

この並び方は、画面のテスト（`apps/web/components/cell-menu.test.tsx`）と、本番ビルドをブラウザで操作する確認（`npm run check:browser`。行が対象のアクションを、選んだ 3 行に実行）で確かめています。

どの `target` でも、`options`（設定の `options`）、`secrets`、`env`、`host`（[host.md](host.md)）が入ります。表にない項目は `undefined` です。たとえば `file` 対象のアクションでは `ctx.entry` は `undefined` なので、行は `ctx.entries` から読みます。

`rows` は、`entries` と同じ順に並んだ `row` の配列です（`ctx.rows[i]` が `ctx.entries[i]` の行）。リソースを書き出す、外部のサービスに送るといったアクションは、ここから各行の本文と列の値を読みます。ほかのリソースの行は `ctx.host.project.rows(リソースの ID)` で読めます（[host.md](host.md#プロジェクトを読むhostproject)）。

`entry` は `{ key, resource, meta?, stableId? }` です。`row` は、同じ行のほかの値を読む窓口で、`row.text(言語 ID)` で本文を、`row.get(列 ID, 言語 ID?)` で列の値を返します。

### 行をまとめて受け取る（runBatch）

`cell` / `row` 対象のアクションは、ふつうは行ごとに 1 回呼ばれます。外部の API に、複数の行を 1 回の要求で送りたいときは、`runBatch(items)` も実装します。

- 実行する人が、1 回にまとめる行の数（バッチサイズ）を選びます。画面の「一括アクション」の確かめる窓の「まとめて送る行数」、コマンドラインの `run --batch-size`、サービス層の `runAction` の `batchSize` です。既定は 1 行ずつです。
- バッチサイズが 2 以上のとき、対象の行をその数ずつに分け、まとまりごとに `runBatch` を 1 回呼びます（`run` は呼びません）。バッチサイズが 1 のときは、これまでどおり `run` を行ごとに呼びます。そのため、`run` も実装しておきます。
- `items` は、`run` が行ごとに受け取る `ctx` と同じ値の配列です（行の順）。`when` が `false` を返した行は入りません。最後のまとまりは、バッチサイズより少ないことがあります。
- 戻り値は `run` と同じ `ActionResult` です。まとまりの中のすべての行の変更を、`patches` にまとめて返します。
- `runBatch` が例外を投げると、そのまとまりの行はすべて失敗になります。20 行を超えてジョブになっているときは、失敗として数えて次のまとまりに進みます。ジョブでないときは、どの行のまとまりかを添えたエラーで止まります（先に済んだまとまりの変更は残ります）。
- `runBatch` のないアクションと、`selection` / `file` / `column` 対象のアクション（もともと対象を 1 回で受け取ります）には、2 以上のバッチサイズを指定できません。画面は入力欄を出さず、コマンドラインとサービス層は断ります。

```js
export default {
  name: "mystudio-send",
  actions: [
    {
      id: "mystudio.send",
      label: "外部に送る",
      target: "row",
      // 1 行ずつのとき
      async run(ctx) {
        return send([ctx]);
      },
      // 何行かまとめるとき
      async runBatch(items) {
        return send(items);
      },
    },
  ],
};

/** 行をまとめて 1 回で送る（ここでは、送った行数を知らせるだけ）。 */
async function send(items) {
  return { message: items.map((item) => item.entry.key).join(", ") + " を送りました（" + items.length + " 行）" };
}
```

この例と同じ形のアクション（行をまとめて受け取り、行ごとの変更を返すもの）で、まとまりの分け方、`when` の扱い、失敗の数え方を、サービス層のテスト（`packages/server/src/action-batch.test.ts`）とコマンドラインのテストで確かめています。上のコードそのものは、動かしていません。

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

絞り込みに合う行すべてに実行する「一括アクション ▾」（表のツールバーと検索結果の表示）と、コマンドラインの `run --where` は、`cell` / `row` / `selection` のアクションを、条件に合う行を対象にして呼びます（[QUERY.md の一括アクション](../QUERY.md#一括アクション)）。リソースをまたぐときは、リソースごとに呼ばれます（`selection` は、リソースごとに 1 回）。アクションの側で、対象の決まり方に合わせて書き分けることはありません。

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
