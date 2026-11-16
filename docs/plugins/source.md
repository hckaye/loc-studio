# 列ソースを書く

列ソースは、ファイル以外の場所にある列の値を読み書きします。進捗ステータスやレビューのように、リソースのファイルには入れない値の置き場所です。同梱の列ソースは、ホストの DB（共有 DB）を使います。値を外部の API に置きたいとき、レビューの投稿を外部のサービスに置きたいときに書きます。

共有 DB に値を置くだけなら、プラグインを書かずに、列の `source` に同梱の `builtin.db` を指定すれば済みます（[CONFIG.md の sources](../CONFIG.md#sources)）。

置き場所と読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

## 実装する項目（ColumnSource）

| 項目 | 必須 | 意味 |
| --- | --- | --- |
| `id` | 必須 | 登録 ID。列の `source`、または設定の `sources.<名前>.use` に書く |
| `saveMode` | 必須 | `"immediate"` と書く。型には `"buffered"` もあるが、いまのアプリは `saveMode` の値を読まず、列の値は常に変更した時点で `save` に渡される |
| `load(cells, ctx)` | 必須 | 指定されたセルの値（`CellValue[]`）を返す。値のないセルは返さなくてよい（列の `type.default` とみなされる） |
| `save(values, ctx)` | 必須 | 値（`CellWrite[]`）を保存して、保存後の値（`CellValue[]`）を返す |
| `postReview(post, ctx)` | レビュー列の出所にするとき必須 | レビューの投稿を保存して、`ReviewPost` を返す |
| `listReviews(cell, ctx)` | レビュー列の出所にするとき必須 | そのセルの投稿を、新しい順に返す |
| `addReviewLinks(reviewId, links, ctx)` | 任意 | 投稿に、外部へのリンク（チケットなど）を紐づける。レビューの転載先のアクションがリンクを返す場合に要る |
| `onEntriesChanged(changes, resource, ctx)` | 任意 | 行の追加・削除・キーの変更に追従する。画面や API から行を変えたあとと、安定 ID でキーの変更に気づいたときに、当てた変更（`Change[]`）を受け取る。キーの変更（`rename`）では、値を新しいキーに移す |
| `subscribe(ctx, onChange)` | 任意 | 値が外部で変わったら `onChange(cells)` を呼ぶ。戻り値は、通知をやめる関数。実装があれば、アプリはプロジェクトを開いている間これを呼び、知らせを受けると、覚えていた統計を捨てて画面に変更を伝える |

`ctx`（`ColumnSourceContext`）は `{ projectRoot, options, host }` です。`options` は、設定の `sources.<名前>.options` に書いた値です。列の `source` に列ソースの登録 ID を直接書いた場合、`options` は空のオブジェクトです。

セルを指す値（`CellRef`）と、読み書きする値の形は次のとおりです。

| 型 | 項目 |
| --- | --- |
| `CellRef` | `resourceId`、`entryKey`（行のキー）、`columnId`（列の ID）、`language?`（言語ごとの列のとき） |
| `CellValue` | `CellRef` の項目に加えて、`value`、`version?`（値の版番号）、`updatedAt?`、`updatedBy?`、`basisHash?`（値を付けた時点の、対象の版）、`comment?`（値に添えたコメント。レビュー列では、表のセルの判定の横に `updatedBy` と並べて出る） |
| `CellWrite` | `CellRef` の項目に加えて、`value`、`expectedVersion?`（書き手が読んだときの版番号）、`basisHash?` |

## 競合の決まり

`save` は、`expectedVersion` がいまの版と違うセルがあれば、上書きせずに `StoreConflictError` を投げます。画面は、自分の値とほかの人の値を両方見せて、利用者に選ばせます。`StoreConflictError` には、競合したセルと、いまの値（`current`）を渡します。

```ts
throw new StoreConflictError([{ cell, current }]);
```

ホストの DB の `cells(名前空間).set(values)` は、この判定をして `StoreConflictError` を投げるので、ホストの DB を使う列ソースは、そのまま呼ぶだけで済みます。

## ホストの DB に置く列ソース

共有 DB にメモを置く列ソースと、それを使う列の定義を、1 つのプラグインで登録します。

`loc-studio-plugins/memo-column.ts`:

```ts
import { definePlugin } from "@loc-studio/sdk";
import type { ColumnSource } from "@loc-studio/sdk";

// ホストの DB（共有 DB）にメモを置く列ソース。
const memoSource: ColumnSource = {
  id: "mystudio.memoStore",
  saveMode: "immediate",
  async load(cells, ctx) {
    return ctx.host.db.cells("mystudio.memo").get(cells);
  },
  async save(values, ctx) {
    // expectedVersion が合わなければ StoreConflictError が投げられ、何も書かれない
    return ctx.host.db.cells("mystudio.memo").set(values);
  },
};

export default definePlugin({
  name: "mystudio-memo",
  sources: [memoSource],
  columns: [
    { id: "mystudio.memo", kind: "meta", scope: "language", label: "メモ", type: "string", source: "mystudio.memoStore" },
  ],
});
```

設定（`columns` に足す）:

```json
{ "use": "mystudio.memo", "id": "memo" }
```

列の定義が `source: "mystudio.memoStore"` を持っているので、設定に `sources` を書く必要はありません。`type: "string"` の列は、表のセルの中で編集できます。`type` を `{ "enum": [...] }` にすれば、ドロップダウンになります（[CONFIG.md の列挙の選択肢](../CONFIG.md#列挙enumの選択肢)）。

確かめ方:

```sh
node apps/cli/dist/index.js set memo@ja "要確認" --project <プロジェクト> --resource Assets/Text/system/ui.csv --keys UI_OK
```

```
Assets/Text/system/ui.csv memo@ja = 要確認: 更新 1 / ブロック 0
```

`set` の最初の引数はセル ID（`<列 ID>@<言語 ID>`）です。`set` は、プロジェクトのフォルダに `.loc-studio/`（共有 DB）を作ります。保存のあと、サービス層の `rows` は、行 `UI_OK` のセル `memo@ja` として `{"value":"要確認","version":1,...}` を返しました。

## 外部の API に置く列ソース

列の定義はそのままで、設定の `source` だけで値の置き場所を替えられます。`examples/remote-project/loc-studio-plugins/tracker-status.ts` は、ステータス列（`builtin.textStatus`）の値を、ホストの DB ではなく外部のタスク管理 API に置く列ソース `example.trackerStatus` です。自社の API 向けに書くときは、このファイルをコピーして書き換えます。

設定では、`sources` で列ソースに名前と `options` を付け、列の `source` にその名前を書きます。

```json
"sources": {
  "tracker": { "use": "example.trackerStatus", "options": { "baseUrl": "http://127.0.0.1:4010", "baseUrlEnv": "EXAMPLE_API_URL" } }
},
"columns": [
  { "use": "builtin.textStatus", "id": "textStatus", "source": "tracker" }
]
```

外部の API の列ソースでは、次のようにします。

- API の呼び出しは `ctx.host.fetch`、トークンは `ctx.host.secrets.get(...)`、API の場所は `ctx.host.env` か `ctx.options` から取ります。`ctx.host.db` は使いません。
- API が採番する版を、`CellValue.version` にそのまま対応させます。画面は、読んだときの版を `expectedVersion` として `save` に渡します。
- 版が合わず API が 409 を返したら、いまの値（`current`）を添えて `StoreConflictError` を投げます。
- `load` は、リソースごとに 1 回だけ API を呼んで、必要なセルを選びます。セルごとに API を呼ぶと、表を開くたびに行数ぶんの通信になります。

確かめ方: モック API を起動した状態（[tree.md](tree.md#例外部の-api-をリソースの置き場にする) と同じ環境変数）で `status` を実行すると、`textStatus` の進捗が API の値から計算されました。保存と競合は、`packages/server/src/remote-example.test.ts` のテストが確かめています。実際の外部サービスに対する動作は、確かめていません。

## レビューに対応した列ソース

レビュー列（`kind: "review"`）の出所になる列ソースは、`load` と `save` に加えて、`postReview` と `listReviews` を実装します。レビューは「列に対する投稿」で、追記だけです。書き換えも削除もしません。

| 関数 | すること |
| --- | --- |
| `load(cells, ctx)` | セルごとに、最新の投稿の判定を値として返す |
| `save(values, ctx)` | 例外を投げる。判定は投稿で変えるもので、直接は保存させない |
| `postReview(post, ctx)` | `post.cell`、`post.verdict`、`post.comment`、`post.basisHash`（投稿した時点の、対象の値の版）を保存して、`ReviewPost` を返す |
| `listReviews(cell, ctx)` | そのセルの投稿を、新しい順に返す |
| `addReviewLinks(reviewId, links, ctx)` | 投稿にリンクを足す（任意） |

`postReview` が返す `ReviewPost` は、`{ id, cell, columnId, verdict, comment, userName, createdAt, basisHash?, links? }` です。`columnId` は `cell.columnId` と同じ値、`userName` は投稿した人の名前、`createdAt` は ISO 8601 の日時です。

サービス層が受け持つこと（列ソースの側では実装しません）:

- 判定が、列の `type.enum` の選択肢にあるかの確認。
- `requireComment` の判定で、コメントが空の投稿を断ること（「判定「NG」にはコメントが必要です。」）。
- `basisHash` の計算。対象の値があとで変わったかの判定（画面の「変更あり」）は、サービス層が `basisHash` と対象のいまの版を比べて行います。
- 変更履歴への記録と、レビューの転載。

次の例は、投稿をホストの DB のログ（追記だけの記録）に置く、最小の実装です。外部のサービスに置くなら、`ctx.host.db.log(...)` の呼び出しを、`ctx.host.fetch` で API を呼ぶ処理に替えます。

`loc-studio-plugins/qa-reviews.ts`:

```ts
import { definePlugin } from "@loc-studio/sdk";
import type { CellRef, CellValue, ColumnSource, LogRecord, ReviewPost } from "@loc-studio/sdk";

// レビューの投稿を、ホストの DB のログ（追記だけ）に置く列ソース。
// 外部のレビュー用サービスに置く場合は、ctx.host.fetch で呼ぶ処理に置き換える。
interface Post { verdict: string; comment: string; basisHash?: string }
const NS = "mystudio.qa";

const toPost = (rec: LogRecord<Post>): ReviewPost => ({
  id: rec.id,
  cell: rec.cell!,
  columnId: rec.cell!.columnId,
  verdict: rec.data.verdict,
  comment: rec.data.comment,
  userName: rec.by, // 投稿した時点のユーザー名（ホストが付ける）
  createdAt: rec.at,
  ...(rec.data.basisHash !== undefined ? { basisHash: rec.data.basisHash } : {}),
});

const qaSource: ColumnSource = {
  id: "mystudio.qaStore",
  saveMode: "immediate",
  // セルの値は、最新の投稿の判定
  async load(cells: CellRef[], ctx) {
    const latest = await ctx.host.db.log<Post>(NS).latest(cells);
    const out: CellValue[] = [];
    cells.forEach((cell, i) => {
      const rec = latest[i];
      if (rec) out.push({ ...cell, value: rec.data.verdict, updatedAt: rec.at, updatedBy: rec.by, ...(rec.data.basisHash ? { basisHash: rec.data.basisHash } : {}) });
    });
    return out;
  },
  async save() {
    throw new Error("レビューの判定は、投稿（postReview）で変えてください");
  },
  async postReview(post, ctx) {
    const data: Post = { verdict: post.verdict, comment: post.comment, ...(post.basisHash ? { basisHash: post.basisHash } : {}) };
    const [rec] = await ctx.host.db.log<Post>(NS).append([{ cell: post.cell, data }]);
    return toPost(rec!);
  },
  async listReviews(cell, ctx) {
    return (await ctx.host.db.log<Post>(NS).list({ cell })).map(toPost); // 新しい順
  },
};

export default definePlugin({
  name: "mystudio-qa",
  sources: [qaSource],
  columns: [
    {
      id: "mystudio.qa",
      kind: "review",
      of: "text",
      scope: "language",
      label: "QA",
      source: "mystudio.qaStore",
      type: {
        enum: [
          { value: "none", label: "未確認", color: "gray" },
          { value: "ng", label: "NG", color: "red", requireComment: true },
          { value: "ok", label: "OK", color: "green", complete: true },
        ],
        default: "none",
      },
    },
  ],
});
```

設定（`columns` に足す）:

```json
{ "use": "mystudio.qa", "id": "qa" }
```

レビュー列の `of` は、レビューの対象の列の ID です。上の列の定義は `of: "text"` なので、設定に ID が `text` の列が要ります。本文の列に別の ID を付けたプロジェクトでは、設定で `of` も上書きします。`of` が設定にある別の列を指していないレビュー列は、表示されません（警告が出ます）。

確かめ方: レビューの投稿は、CLI のコマンドではできません。画面のレビューのパネルか、サービス層の `postReview` で確かめます。サービス層を呼んで確かめた結果は次のとおりです。

- 判定 `ng`（`requireComment`）をコメントなしで投稿すると、「判定「NG」にはコメントが必要です。」で断られました。
- コメントつきの投稿は成功し、`rows` が、セル `qa@ko` の値として `ng`（`updatedBy` と `basisHash` つき）を返しました。
- 投稿の前は、セル `qa@ko` の値は `type.default` の `none` でした。

この例の `load` は `comment` を返さないので、表のセルには判定だけが出ます。同梱の `builtin.reviews` は、最新の投稿のコメントを `comment` に入れて返すので、セルに投稿者とコメントが出ます（`comment` を返す形にしたこの例は、動かして確かめていません）。

この例は `addReviewLinks` を実装していません。レビューの転載先のアクションがリンクを返すと、転載は「リンクの保存（addReviewLinks）に対応していません。」の警告になります（投稿そのものは成功します）。リンクを保存するレビュー列ソースの実装は、同梱の `builtin.reviews` にあります。

## 参考になる実装

- `packages/builtin/src/db-source.ts`: 同梱の `builtin.db`。`options.namespace` で置き場所を分ける
- `packages/builtin/src/review-source.ts`: 同梱の `builtin.reviews`。リンクの追記（`addReviewLinks`）も実装している
- `examples/remote-project/loc-studio-plugins/tracker-status.ts`: 外部の API を使う完全な例
