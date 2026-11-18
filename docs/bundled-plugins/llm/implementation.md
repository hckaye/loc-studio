# @loc-studio/plugin-llm の実装

`packages/plugin-llm` のコードを直す人に向けて、ファイルの構成、処理の流れ、テスト、変えるときに揃えるものをまとめます。守っている決まりは [design.md](design.md) にあります。生成器の拡張ポイントそのものの説明は [plugins/generator.md](../../plugins/generator.md) にあります。

## パッケージ

| 項目 | 内容 |
| --- | --- |
| 場所 | `packages/plugin-llm` |
| パッケージ名 | `@loc-studio/plugin-llm` |
| 依存 | `@loc-studio/sdk`（型だけ） |
| 書き出すもの | `llmPlugin`（`Plugin` を返す関数。既定のエクスポートも同じ）、`LLM_PLUGIN_NAME`、各ファイルの関数と定数 |
| ビルド | ルートの `npm run build`（`tsc -b`）。出力は `packages/plugin-llm/dist` |

HTTP のクライアントのパッケージは使っていません。要求は、ホストの `fetch`（`ctx.host.fetch`）で送ります。

## ファイルの構成

| ファイル | 中身 | テスト |
| --- | --- | --- |
| `src/index.ts` | `llmPlugin`。プラグインの設定の宣言、生成器 2 つ、列 2 つ | `translate.test.ts` の「plugin」 |
| `src/chat.ts` | `chat/completions` の呼び出しと、返事の読み取り。2 つの生成器が共通に使う | `translate.test.ts`、`evaluate.test.ts` |
| `src/translate.ts` | 生成器 `llm.translate`（`createTranslateGenerator`）と、既定のプロンプト | `translate.test.ts` |
| `src/evaluate.ts` | 生成器 `llm.evaluate`（`createEvaluateGenerator`）と、既定のプロンプト、判定の値 | `evaluate.test.ts` |
| `src/testing.ts` | テスト用の補助。`index.ts` からは書き出さず、ビルドの対象からも外している（`tsconfig.json` の `exclude`） | |

## プラグインの組み立て（index.ts）

`llmPlugin` は、`Plugin` のオブジェクトではなく、`Plugin` を返す関数です。プラグインの設定の値を読む窓口（`setup.settings`）を受け取るためです。関数は、プロジェクトを開く（読み直す）たびに呼ばれます。

```ts
export function llmPlugin(setup: PluginSetupContext): Plugin {
  return {
    name: LLM_PLUGIN_NAME, // "@loc-studio/plugin-llm"
    version: "0.2.0",
    settings: [ /* translateTo, translatePrompt, evaluateSource, evaluatePrompt */ ],
    generators: [createTranslateGenerator(setup.settings), createEvaluateGenerator(setup.settings)],
    columns: [ /* llm.translation, llm.evaluation */ ],
  };
}
```

`setup.settings.get(key)` は、関数の中（プラグインを組み立てている間）では呼べません。生成器は、窓口を受け取って覚えておき、`cacheParams`、`input`、`run` が呼ばれたときに値を読みます。そのため、設定の画面で値を保存すると、次の呼び出しから新しい値になります。

登録するのは、サービス層（`packages/server/src/workspace.ts`）とコマンドライン（`apps/cli/src/commands.ts`）です。どちらも、`openProject` の `builtins` に、`builtinPlugin` に続けて `llmPlugin` を渡します。画面の本番ビルドでは、`apps/web/next.config.mjs` の、サーバー側のパッケージの一覧にも、このパッケージの名前があります。

## chat.ts

| 関数 | すること |
| --- | --- |
| `textOption(value)` | 空でない文字列（空白だけでない）なら、その値。それ以外は `undefined` |
| `resolveChatOptions(id, options)` | 接続に使う options（`endpoint`、`model`、`apiKeySecret`、`temperature`、`timeoutMs`）を読む。`endpoint` と `model` がなければ、直し方を書いた例外 |
| `chat(id, opts, messages, ctx)` | 1 回の要求を送り、`choices[0].message.content`（前後の空白を除いたもの）と、結果に残す情報（応答の `model` と `usage`）を返す |
| `parseJsonReply(id, content)` | モデルの返事から JSON を読む。コードの囲みと、前後の文章を除く |
| `itemsById(id, reply, count)` | まとめて送った返事を、`id`（1 から `count`）の順の配列にする。配列でない、`id` が足りない、同じ `id` が 2 回あるときは例外 |

`chat` の流れは次のとおりです。

1. URL を作る（`endpoint` の末尾の `/` を除いて、`/chat/completions` を付ける）。
2. 中断の合図を作る。制限時間の合図（`AbortSignal.timeout`）と、呼び出し側の合図（`ctx.signal`。あれば）を、`AbortSignal.any` で 1 つにする。
3. 秘密情報（`ctx.secrets.get(opts.apiKeySecret)`）があれば、`Authorization: Bearer …` を付ける。
4. `ctx.host.fetch` で POST する。本文は `{ model, temperature, messages }`。
5. 失敗を、原因ごとの例外にする。呼び出し側が中断していれば、元の例外をそのまま投げる。制限時間なら「… が 60000ms 以内に応答しませんでした。」（数は `timeoutMs`）、それ以外は「… への接続に失敗しました: 理由」。
6. 応答が 2xx でなければ、ステータスと、本文の先頭 300 文字（`BODY_PREVIEW_LENGTH`）を入れた例外。JSON でない応答、`content` のない応答も例外。

例外の文言は、どれも生成器の ID で始めます。サービス層が、この文言を、ジョブのエラーとして利用者に見せます。

## translate.ts

`createTranslateGenerator(settings)` が返す生成器は、次の値を持ちます。

| 項目 | 値 |
| --- | --- |
| `id` | `llm.translate`（`TRANSLATE_ID`） |
| `version` | `"1"` |
| `batchSize` / `concurrency` / `retries` | `1` / `2` / `2` |

- `resolve(options)` が、訳し先とプロンプトを決めます。順は、生成器の `options`、プラグインの設定、既定の定数（`DEFAULT_TRANSLATE_TO`、`DEFAULT_TRANSLATE_PROMPT`）です。
- `systemPrompt(r, batch)` が、モデルに送る指示を組み立てます。プロンプトの `{to}` を、訳し先にすべて置き換え、`instructions` と、まとめて送るときの形の指示（`BATCH_FORMAT`）を、改行でつなぎます。
- `cacheParams(options)` は、`endpoint`、`model`、訳し先、`instructions`、`temperature` を返します。プロンプトは、既定と違うときだけ入れます。
- `input(ctx)` は、`ctx.row.text(言語 ID)` で本文を読み、空でなければ `{ text, language }` を返します。
- `run(inputs, ctx)` は、1 件なら本文をそのまま送って、返事を結果にします。2 件以上なら、`[{ id, text }]` の JSON を送り、`parseJsonReply` と `itemsById` で読んで、各要素の `translation` を結果にします。結果の `meta` には、応答の `model` と `usage` を入れ、まとめて送ったときは件数（`batch`）も入れます。

## evaluate.ts

`createEvaluateGenerator(settings)` が返す生成器の `id` は `llm.evaluate`（`EVALUATE_ID`）で、`version`、`batchSize`、`concurrency`、`retries` は `llm.translate` と同じです。

- `sourceOf(ctx)` が、比べる原文の言語を決めます。順は、生成器の `options.source`、プラグインの設定 `evaluateSource`、そのセルの言語の `basedOn` です。
- `input(ctx)` は、訳文と原文を読み、`{ text: 訳文, language, extra: { source: 原文, sourceLanguage } }` を返します。原文を `extra` に入れているので、サービス層が作るキャッシュの鍵と、入力の版に、原文も入ります。
- `cacheParams(options)` は、`endpoint`、`model`、プロンプト、`instructions`、`temperature` を返します。`llm.translate` と違い、プロンプトは常に入れます。
- `systemPrompt(r, batch)` は、プロンプト、`instructions`、返事の形の指示（1 件は `SINGLE_FORMAT`、まとめて送るときは `BATCH_FORMAT`）をつなぎます。
- `toOutput(item, meta, where)` が、返事の 1 件を結果にします。`verdict` を大文字にそろえ、`VERDICTS`（`OK`、`WARNING`、`NG`）になければ例外です。`reason` が空でなければ、結果の `comment` に入れます。
- `run(inputs, ctx)` は、1 件なら `{ source, translation }` を、2 件以上なら `[{ id, source, translation }]` を送ります。

判定の値（`VERDICTS`）と、`index.ts` の列 `llm.evaluation` の選択肢の値は、同じ 3 つを、別々に書いています。片方を変えるときは、もう片方も変えます。

## サービス層とのつながり

生成器を呼ぶのは、サービス層の `packages/server/src/generate.ts` です。このプラグインを直すときに、前提にしている動きは次のとおりです。

- キャッシュの鍵は、生成器の `id`、`version`、`cacheParams(options)` の戻り値、`input` の戻り値から作ります。セルごとに、最後に使った鍵と、入力のハッシュを記録します。「変更あり」の判定には、鍵を使います。いまの鍵の結果がキャッシュになく、記録した鍵の結果が残っているセルが「変更あり」です（入力のハッシュは記録するだけで、判定には読みません）。
- 同じ入力のセルは 1 つにまとめられ、`run` には 1 回だけ渡ります。
- `run` に 1 回で渡る件数は、実行のときに指定されたバッチサイズで、なければ生成器の `batchSize` です。
- `run` が例外を投げるか、入力と数の合わない配列を返すと、そのまとまりを、`retries` の回数までやり直します。それでも失敗すると、「生成器 "llm.translate" が失敗しました（3 回試行）: …」として、最後の例外の文言を残します。
- 結果の `value` は文字列でなければ、失敗になります。`comment` と `meta` は、結果と一緒に残ります。

## テスト

```sh
npx vitest run packages/plugin-llm                 # 生成器の単体のテスト
npx vitest run packages/server/src/llm.test.ts     # サービス層を通したテスト
```

- 単体のテスト（`translate.test.ts`、`evaluate.test.ts`）は、外部の HTTP（`host.fetch`）だけを差し替え、生成器は本物を動かします。補助は `src/testing.ts` にあります（`makeCtx` が `fetch` の呼び出しを記録し、`settingsOf` がプラグインの設定の値を、`cellOf` が `input` に渡す値を作ります）。
- サービス層のテスト（`packages/server/src/llm.test.ts`）は、手元に立てた OpenAI 互換のサーバーを相手に、生成、キャッシュ、「変更あり」、条件に合う行だけの生成、バッチサイズ、プラグインの設定を確かめます。
- 画面の操作は、`npm run check:browser`（`apps/web/scripts/browser-check.mjs`）が、同じように手元のサーバーを相手に確かめます。
- 壊し方の一覧は `scripts/mutations/llm-and-batch.mjs` です。このパッケージの 3 つのファイルと、サービス層、コマンドライン、画面の、生成とバッチサイズに関わる条件が入っています。

2026-11-18 に、Windows 11（Node.js 26.5.1）で `npx vitest run packages/plugin-llm` を実行し、2 ファイルの 38 件が通りました。サービス層のテスト、`check:browser`、壊し方の確認は、この文書のためには実行していません。実際の LLM の API に接続するテストはありません。

## 変えるときに揃えるもの

- **プロンプトの既定や、返事の形の指示を変える。** 生成器の `version` を上げるかを決めます。`llm.evaluate` は、プロンプトが `cacheParams` に入っているので、既定を変えると、既定のまま使っているプロジェクトの結果が「変更あり」になります。`llm.translate` は、既定のプロンプトを鍵に入れていないので、既定を変えても「変更あり」にはなりません。生成し直させたいときは、`version` を上げます。返事の形の指示（`BATCH_FORMAT` など）は鍵に入らないので、結果が変わる変更なら `version` を上げます。
- **options を足す。** 結果が変わる値なら `cacheParams` に入れ、API キーのように結果を変えない値は入れません。[settings.md](settings.md) と、[CONFIG.md の接続先の表](../../CONFIG.md#接続先generators-の-options)を直します。外部の接続先を決める値は、プラグインの設定には置かず、生成器の `options` に置きます。
- **プラグインの設定の項目を足す。** `index.ts` の `settings` に宣言を足し、生成器の中で `settings.get` で読みます。[settings.md](settings.md) の表と、期待する宣言を書き下したテスト（`translate.test.ts` の「生成器 2 つ、列 2 つ、設定 4 つを公開する」）を直します。
- **判定の値を変える。** `VERDICTS` と、列 `llm.evaluation` の選択肢の両方を変えます。判定の値は、すでに生成した結果として共有 DB に残り、条件式（`mtCheck@ko = NG` など）にも書かれます。変えるときは、[ARCHITECTURE.md の 8 章](../../ARCHITECTURE.md#8-決め打ちにしているもの)の表も直します。
- **既定（バッチサイズ、同時に送る数、やり直しの回数）を変える。** 期待する値を書き下したテスト（「既定は 1 件ずつ送る（バッチサイズ 1、並列 2、やり直し 2 回）」）と、ARCHITECTURE.md の 8 章の表、コマンドラインの使い方の説明（`apps/cli/src/args.ts`）を直します。
- **依存を足す。** サービス層に入るパッケージなので、配布物に入ることを確かめます（`npm run build:web` のあと `npm run smoke:web`。[AGENTS.md](../../../AGENTS.md#新しいプロジェクトの作成と配布物に入る依存を変えるとき)）。
- **振る舞いを足したら、壊し方も足す。** `scripts/mutations/llm-and-batch.mjs` に、その振る舞いを決めている条件の壊し方を足します。実装を直して `from` の文字列が合わなくなったら、一覧のほうを直します。

## この文書を書いたときに確かめたこと

ファイルの構成、関数の名前、処理の流れは、2026-11-18 の時点のソースを読んで書きました。コードを動かして確かめたのは、[guide.md の「確かめた範囲」](guide.md#確かめた範囲)と、上のテストの実行です。
