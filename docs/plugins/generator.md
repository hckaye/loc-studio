# 生成器を書く

生成器は、生成列（`kind: "generated"`）の値を作ります。逆翻訳や機械翻訳のように、ほかの値から作る、時間のかかる値に使います。結果は共有 DB にキャッシュされ、入力が変わったセルは「古い」と表示されます。

LLM で翻訳するだけなら、同梱の `llm.translate` が使えます（[CONFIG.md の generators](../CONFIG.md#generators)）。値を保存せずに毎回計算する軽い処理は、計算列に向いています（[column.md](column.md#計算列)）。

置き場所と読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

## 実装する項目（Generator）

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `id` | 必須 | `string` | 登録 ID。設定の `generators.<名前>` に書く |
| `version` | 必須 | `string` | 結果が変わる修正をしたら上げる。キャッシュの鍵に入る |
| `cacheParams` | 必須 | `(options) => object` | 設定の `options` のうち、結果に影響する値（モデル、訳し先、指示文など）を返す。キャッシュの鍵に入る。接続キーは含めない。なければ `() => ({})` |
| `input` | 必須 | `(ctx) => GeneratorInput \| null` | そのセルの入力を返す。生成しないセルは `null` |
| `run` | 必須 | `(inputs, ctx) => Promise<GeneratorOutput[]>` | 入力の配列に対する結果の配列を返す |
| `batchSize` | 任意 | `number` | `run` に 1 回で渡す入力の数。既定 10 |
| `concurrency` | 任意 | `number` | 同時に走らせる `run` の数。既定 1 |
| `retries` | 任意 | `number` | `run` が失敗したときに、やり直す回数。既定 0 |

## input

`input(ctx)` は、セルごとに呼ばれます。`ctx`（`GeneratorCellContext`）は次のとおりです。`input` には `ctx.host` が渡されません。

| 項目 | 内容 |
| --- | --- |
| `entry` | 行の情報（`key`、`resource`、`meta`） |
| `column` | 生成列の定義 |
| `language` | 言語ごとの列では、その言語の定義 |
| `row` | 同じ行のほかの値を読む。`row.text(言語 ID)` で本文、`row.get(列 ID, 言語 ID?)` で列の値 |
| `options` | 設定の `generators.<名前>.options` に書いた値 |

戻り値（`GeneratorInput`）は `{ text, language?, extra? }` です。入力の全体がキャッシュの鍵に入るので、結果に影響する値は、すべてここに入れます。

`input` は、生成を実行するときだけでなく、表を表示するときにも呼ばれます（セルの結果が新しいか古いかを、いまの入力から判定するためです）。次のようにします。

- 同期の関数にして、軽い処理にとどめる。
- 同じ行の値に対して、いつも同じ入力を返す。現在時刻や乱数を入れると、キャッシュの鍵が呼ぶたびに変わり、生成済みの結果が新しいと判定されなくなります。

## run

`run(inputs, ctx)` の `ctx`（`GeneratorRunContext`）は、`options`、`secrets`、`host`、`signal`（中断の合図）です。

- 結果（`{ value, meta? }`）の配列を、入力と同じ順、同じ数で返します。数が合わないと、そのバッチは失敗になります。
- `value` は文字列にします。
- 入力が同じセルは、1 つにまとめて 1 回だけ渡されます。
- 例外を投げると、そのバッチが失敗になります（`retries` の回数までやり直します）。
- 外部の API を呼ぶときは `ctx.host.fetch` を使い、`ctx.signal` を渡して中断できるようにします。接続キーは `ctx.secrets.get(...)` で読みます。

## 例

逆翻訳の代わりに、本文を逆順にするだけの生成器です。外部の API を使わずに、生成器の形を確かめられます。

`loc-studio-plugins/reverse-generator.ts`:

```ts
import { definePlugin } from "@loc-studio/sdk";

// 逆翻訳の代わりに、本文を逆順にするだけの生成器（形を確かめるための例）。
export default definePlugin({
  name: "mystudio-reverse",
  generators: [
    {
      id: "mystudio.reverse",
      version: "1", // 結果が変わる修正をしたら上げる
      cacheParams: () => ({}), // 結果に影響する options があればここで返す（接続キーは入れない）
      input({ language, row }) {
        if (!language) return null;
        const text = row.text(language.id);
        return text ? { text, language: language.id } : null;
      },
      async run(inputs) {
        return inputs.map((i) => ({ value: Array.from(i.text).reverse().join("") }));
      },
    },
  ],
});
```

## 設定

設定は 2 か所です。`generators` で生成器に名前を付け、`columns` に生成列を足して、その名前を `generator` に書きます。

```json
"generators": { "rev": "mystudio.reverse" },
"columns": [
  { "use": "builtin.key", "id": "key" },
  { "use": "builtin.text", "id": "text" },
  { "id": "reverse", "kind": "generated", "scope": "language", "label": "逆順", "languages": ["ko"], "generator": "rev" }
]
```

ここには 3 つの名前があります。

| 名前 | 例 | 使う場所 |
| --- | --- | --- |
| 生成器の登録 ID | `mystudio.reverse` | `generators` の値（`use`） |
| 生成器の名前 | `rev` | 生成列の `generator` |
| 生成列の ID | `reverse` | CLI の `generate <列 ID>`、セル ID（`reverse@ko`） |

`options` を渡すときは、`"generators": { "rev": { "use": "mystudio.reverse", "options": { ... } } }` と書きます。

## 確かめ方

`generate` の引数は、生成列の ID（`reverse`）です。生成器の名前（`rev`）でも、登録 ID でもありません。`--dry-run` は、生成器を呼ばずに件数だけを出します。

```sh
node apps/cli/dist/index.js generate reverse --project <プロジェクト> --dry-run
node apps/cli/dist/index.js generate reverse --project <プロジェクト> --resources "**/ui.csv"
node apps/cli/dist/index.js generate reverse --project <プロジェクト> --resources "**/ui.csv" --json
```

サンプルプロジェクトのコピー（`ui.csv` に 2 行を足した状態）では、順に次の出力になりました。3 回目は、2 回目の結果がキャッシュにあるので、生成は 0 件です。

```
reverse（ドライラン）: 全体 13 / キャッシュ済み 0 / 実行する分 13
reverse: 全体 6 / キャッシュ済み 0 / 生成 6 / 失敗 0
{
  "columnId": "reverse",
  "total": 6,
  "cached": 6,
  "generated": 0,
  "failed": 0,
  "errors": []
}
```

生成のあと、サービス層の `rows` は、セル `reverse@ko` を `generated: "fresh"` で返し、`UI_OK` の韓国語 `확인` に対する値は、逆順の `인확` でした。`generate` は、プロジェクトのフォルダに `.loc-studio/`（共有 DB）を作ります。

## 参考になる実装

- `packages/plugin-llm`: 同梱の `llm.translate`。OpenAI 互換の API を呼び、`cacheParams` にモデルや指示文を入れる
