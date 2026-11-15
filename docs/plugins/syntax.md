# 本文の記法を書く

記法は、本文の中の変数、タグ、制御コードを見分けて、本文をトークンに分けます。トークンの種類は、検証（`builtin.placeholders` が基の言語との過不足を調べ、`builtin.maxLength` が本文だけを数える）と、画面の色分けに使われます。

置き場所と読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

## 実装する項目（TextSyntax）

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `id` | 必須 | `string` | 登録 ID。設定の `syntaxes` に書く |
| `tokenize` | 必須 | `(text: string) => TextToken[]` | 文字列をトークンに分ける |

`tokenize` が返すトークン（`TextToken`）の形は次のとおりです。

| 項目 | 型 | 意味 |
| --- | --- | --- |
| `kind` | `"text" \| "variable" \| "tag" \| "control"` | 本文、変数、タグ、制御コード |
| `value` | `string` | トークンの文字列 |
| `range` | `{ start: number, end: number }` | 引数の `text` の中の位置。UTF-16 の添字で、`end` の位置の文字は含まない |

## tokenize の決まり

- `range` は重ならないようにし、前から順に並べます。範囲が正しくないトークン（前のトークンと重なる、`end` が `start` より小さい、`text` の長さを超える、整数でない）があると、「記法 "..." の結果の範囲が正しくありません」のエラーになります。
- トークンの間の隙間は、ホストが `"text"` のトークンで埋めます。変数やタグだけを返してもかまいません。
- `range` は、引数に渡された `text` の先頭を 0 とした位置で書きます。設定に複数の記法を書いた場合、2 つ目以降の記法の `tokenize` には、前の記法が `"text"` と判断した部分だけが 1 つずつ渡されます。本文全体の中の位置への換算は、ホストが行います。
- 空の本文に対しては、`tokenize` は呼ばれません。

## 例

`$[PLAYER]` の形の変数を `"variable"` として見つけます。

`loc-studio-plugins/dollar-syntax.ts`:

```ts
import { definePlugin } from "@loc-studio/sdk";
import type { TextToken } from "@loc-studio/sdk";

// $[PLAYER] 形式の変数を "variable" として見つける。
export default definePlugin({
  name: "mystudio-syntax",
  syntaxes: [
    {
      id: "mystudio.dollar",
      tokenize(text) {
        const tokens: TextToken[] = [];
        let pos = 0;
        for (const m of text.matchAll(/\$\[[A-Z0-9_]+\]/g)) {
          const start = m.index;
          if (start > pos) tokens.push({ kind: "text", value: text.slice(pos, start), range: { start: pos, end: start } });
          tokens.push({ kind: "variable", value: m[0], range: { start, end: start + m[0].length } });
          pos = start + m[0].length;
        }
        if (pos < text.length) tokens.push({ kind: "text", value: text.slice(pos), range: { start: pos, end: text.length } });
        return tokens;
      },
    },
  ],
});
```

## 設定

`loc-studio.project.json` の `syntaxes` の配列に、`id` を足します。前から順に適用されます。

```json
"syntaxes": ["builtin.braces", "builtin.tags", "mystudio.dollar"]
```

設定に `syntaxes` を書いていないプロジェクトでは、登録されたすべての記法が使われます。その場合は、ファイルを置くだけでこの記法も適用されます。

フォーマットごとに記法を決めたいときは、フォーマットの `syntax` に記法の `id` を書きます（[format.md](format.md)）。その記法が登録されていなければ警告が出て、プロジェクトの既定の記法が使われます。

## 確かめ方

基の言語にある変数が訳文にないと、`builtin.placeholders` が指摘します。これを使って、記法が変数を見つけていることを確かめます。

サンプルプロジェクトのコピーの `Assets/Text/system/ui.csv` の末尾に、中国語の訳文にだけ変数がない行を足します。

```csv
UI_VAR,$[PLAYER]のターン,$[PLAYER]'s turn,轮到你了,$[PLAYER]の차례,
```

```sh
node apps/cli/dist/index.js validate --project <プロジェクト> --resources "**/ui.csv"
```

出力に次の行が出ます。

```
  error   UI_VAR  zh-Hans  builtin.placeholders  placeholder-missing  原文にある $[PLAYER] が足りません（原文 1 個、訳文 0 個）。
```

`syntaxes` から `mystudio.dollar` を外すと、この行は出なくなります。

## 参考になる実装

- `packages/builtin/src/syntax.ts`: 同梱の `builtin.braces`（`{name}`）、`builtin.printf`（`%s`）、`builtin.tags`（`<b>`）
