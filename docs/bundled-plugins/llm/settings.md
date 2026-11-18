# @loc-studio/plugin-llm の設定項目

`@loc-studio/plugin-llm` の値は、種類によって置き場所が 4 つに分かれています。使い方の流れは [guide.md](guide.md)、分けている理由は [design.md](design.md#値の置き場所を-4-つに分けている) にあります。

| 値 | 置き場所 | チームで共有 | Web モードで変えられる人 |
| --- | --- | --- | --- |
| 接続先（URL、モデル名など） | プロジェクト設定の `generators` の `options` | する | サーバーの管理者 |
| プロンプト、訳し先、比べる原文の言語 | プラグインの設定（`loc-studio-plugin-settings/%40loc-studio%2Fplugin-llm.json`） | する | `manage` の権限がある役割 |
| API キー | 秘密情報 `llm.apiKey`（ローカル設定か環境変数） | しない | サーバーの環境変数だけ |
| まとめて送る件数 | 生成を実行するときに選ぶ | しない（実行ごと） | 生成を実行できる人 |

## 生成器の options（プロジェクト設定の generators）

```json
"generators": {
  "mt": {
    "use": "llm.translate",
    "options": {
      "endpoint": "https://llm.example.internal/v1",
      "model": "my-model",
      "temperature": 0,
      "timeoutMs": 60000,
      "to": "日本語",
      "instructions": "ゲームの UI の文言です。短く訳してください。"
    }
  }
}
```

| options | 型 | 既定 | 使う生成器 | 意味 |
| --- | --- | --- | --- | --- |
| `endpoint` | `string` | なし（必須） | 両方 | OpenAI 互換の API の基底 URL。`<endpoint>/chat/completions` に POST する。末尾の `/` は、あってもなくてもよい |
| `model` | `string` | なし（必須） | 両方 | 要求の `model` に入れる、モデル名 |
| `apiKeySecret` | `string` | `"llm.apiKey"` | 両方 | API キーを読む秘密情報の名前。接続先ごとにキーが違うときに変える |
| `temperature` | `number` | `0` | 両方 | 要求の `temperature` |
| `timeoutMs` | `number` | `60000` | 両方 | 1 回の要求の制限時間（ミリ秒） |
| `instructions` | `string` | なし | 両方 | プロンプトの後ろに足す文章。使う場所ごとの補足に使う |
| `prompt` | `string` | プラグインの設定の値 | 両方 | プロンプト。プラグインの設定より優先する |
| `to` | `string` | プラグインの設定の値 | `llm.translate` | 訳し先の言語の名前。プラグインの設定より優先する |
| `source` | `string` | プラグインの設定の値 | `llm.evaluate` | 比べる原文の言語の ID。プラグインの設定より優先する |

- `endpoint` か `model` がない（空の文字列、空白だけを含む）と、生成は失敗し、何を設定に書けばよいかを添えて知らせます。
- `temperature` と `timeoutMs` は、数でない値を書くと、既定の値を使います。
- 文字列の値（`apiKeySecret`、`instructions`、`prompt`、`to`、`source`）は、送る内容を決めるときに、空の文字列と空白だけの文字列を、書いていないものとして扱います。
- キャッシュの鍵には、`endpoint`、`model`、`instructions`、`temperature` を、設定に書いた値のまま入れます。空の `instructions` を書く、既定と同じ `"temperature": 0` を書き足す、`endpoint` の末尾の `/` を付け外しする、のどれでも、送る内容は同じですが、鍵は変わり、生成済みの結果は「変更あり」になります。
- `generators` は基盤の項目です。画面のローカルモードでは、信頼の確認のダイアログに、`options` の値と、`endpoint` の実際の接続先（ホストとポート）が出ます。Web モードでは、管理者でない利用者には値を返しません。

生成列の `generator` に、`generators` の名前ではなく生成器の ID（`"llm.translate"`）を直接書くと、`options` が空の生成器として扱われます。`endpoint` と `model` が必須なので、この書き方では生成できません。

## プラグインの設定（プロンプト、訳し先、比べる原文の言語）

設定の画面の「プラグインの設定」のタブに、`@loc-studio/plugin-llm` の欄として出ます。値は、プロジェクトのフォルダの次のファイルに保存されます。

`loc-studio-plugin-settings/%40loc-studio%2Fplugin-llm.json`:

```json
{
  "translateTo": "英語",
  "evaluateSource": "ja"
}
```

| キー | 画面の名前 | 型 | 既定 | 意味 |
| --- | --- | --- | --- | --- |
| `translateTo` | 機械翻訳: 訳し先の言語 | 文字列 | `日本語` | プロンプトの `{to}` に入る、言語の名前（言語の ID ではなく、モデルに読ませる名前） |
| `translatePrompt` | 機械翻訳: プロンプト | 文字列（複数行） | 下の文章 | モデルに渡す指示。`{to}` は、訳し先の言語の名前に、すべて置き換わる |
| `evaluateSource` | 翻訳の評価: 比べる原文の言語 | 文字列 | なし | 原文として比べる言語の ID。空なら、評価する言語の `basedOn` の言語 |
| `evaluatePrompt` | 翻訳の評価: プロンプト | 文字列（複数行） | 下の文章 | モデルに渡す、判定の基準の指示 |

- ファイルがなくても動きます（既定の値を使います）。値がすべてなくなると、設定の画面はファイルを消します。
- 画面で欄を空にして保存すると、ファイルからその値を消して、既定に戻します。
- 画面のローカルモードでは、このファイルの中身も、設定ファイルの確認の対象です。アプリの外で書き換えると、次に開いたときに確認のダイアログが出ます（[plugins/settings.md の信頼の確認](../../plugins/settings.md#信頼の確認)）。
- コマンドラインには、この設定を変えるコマンドはありません。ファイルを直接書きます。

### 値が決まる順

同じ値を複数の場所に書いたときは、次の順で、最初に見つかった値を使います。

| 値 | 1 | 2 | 3 |
| --- | --- | --- | --- |
| 訳し先 | 生成器の `options.to` | プラグインの設定 `translateTo` | `日本語` |
| 機械翻訳のプロンプト | 生成器の `options.prompt` | プラグインの設定 `translatePrompt` | 既定の文章 |
| 評価のプロンプト | 生成器の `options.prompt` | プラグインの設定 `evaluatePrompt` | 既定の文章 |
| 比べる原文の言語 | 生成器の `options.source` | プラグインの設定 `evaluateSource` | 評価する言語の `basedOn` |

比べる原文の言語が決まらないセル（`basedOn` のない言語で、ほかの指定もない）と、比べる原文の言語そのもののセルは、評価しません。

### 既定のプロンプト

機械翻訳（`translatePrompt` の既定）:

```
ユーザーが送る文章を{to}に翻訳してください。
{name} のようなプレースホルダーや <b> のようなタグは、一切変更せずそのまま残してください。
翻訳結果だけを出力し、説明や引用符、前置きは付けないでください。
```

翻訳の評価（`evaluatePrompt` の既定）:

```
あなたは、ゲームのローカライズの品質を確かめるレビュアーです。
ユーザーが送る原文（source）と訳文（translation）を比べ、訳文が原文の意味を正しく伝えているかを判定してください。
判定は、次の 3 つのどれかです。
- OK: 意味が正しく伝わっている。
- WARNING: 合っているか怪しい（意味がずれているかもしれない、あいまい、抜けや余分があるかもしれない）。
- NG: 意味が違う、大事な内容が抜けている、訳されていない。
{name} のようなプレースホルダーや <b> のようなタグが、原文と同じだけ訳文に残っているかも確かめてください。
判定の理由は、日本語で、1 文で書いてください。
```

### モデルに送る指示の組み立て

モデルに送る指示（system のメッセージ）は、次の順に、改行でつないだものです。

| 順 | 機械翻訳 | 翻訳の評価 |
| --- | --- | --- |
| 1 | プロンプト（`{to}` を置き換えたもの） | プロンプト |
| 2 | `instructions`（あれば） | `instructions`（あれば） |
| 3 | まとめて送るときだけ、入出力の形の指示 | 入出力の形の指示（1 件のときと、まとめて送るときで違う） |

3 の指示は、アプリが足す決まった文章で、設定では変えられません。評価では、判定を `OK`、`WARNING`、`NG` のどれかにし、理由を添えた JSON で返すよう指示します。プロンプトを書き換えるときも、判定の値はこの 3 つのままにしてください（ほかの値の返事は、失敗として扱います）。

本文（user のメッセージ）は、機械翻訳の 1 件のときは、本文そのままです。評価の 1 件のときは、`{"source": "原文", "translation": "訳文"}` の JSON です。まとめて送るときは、どちらも、`id` を付けた JSON の配列です。

## API キー（秘密情報）

| 渡し方 | 書き方 | 使えるモード |
| --- | --- | --- |
| ローカル設定 | `settings.json` の `"secrets.llm.apiKey": "sk-..."` | 画面のローカルモード、コマンドライン |
| 環境変数 | `LOC_STUDIO_SECRET_LLM_APIKEY=sk-...` | すべて。Web モードは、サーバーの環境変数 |

- 両方にあるときは、ローカル設定が優先です。
- 秘密情報があると、要求に `Authorization: Bearer <キー>` を付けます。なければ、付けずに送ります。
- `apiKeySecret` を変えたときの環境変数の名前は、秘密情報の名前を大文字にして、英数字以外を `_` に置き換えたものです（`llm.team-b` なら `LOC_STUDIO_SECRET_LLM_TEAM_B`）。
- API キーは、設定ファイル、プラグインの設定、エラーの文言、キャッシュの鍵には入りません。

## 生成を実行するときに選ぶ値

| 値 | 既定 | 選ぶ場所 |
| --- | --- | --- |
| まとめて送る件数（バッチサイズ） | 1 件ずつ | 画面の生成の窓の「まとめて送る件数」、一括アクションの「まとめて送る行数」、コマンドラインの `generate --batch-size`、サービス層の `generate` の `batchSize` |

1 以上 1000 以下の整数です。同時に送る要求の数（2）と、失敗したときのやり直しの回数（2）は、生成器が持つ値で、設定では変えられません。

## 列

| 登録 ID | 表示名 | `kind` / `scope` | 生成器の既定 | 型 |
| --- | --- | --- | --- | --- |
| `llm.translation` | 機械翻訳 | `generated` / `language` | `llm.translate` | 文字列 |
| `llm.evaluation` | 翻訳の評価 | `generated` / `language` | `llm.evaluate` | 選択式（下の表） |

| 値 | 表示名 | 色 |
| --- | --- | --- |
| `OK` | OK | `green` |
| `WARNING` | WARNING | `amber` |
| `NG` | NG | `red` |

```json
{ "use": "llm.evaluation", "id": "mtCheck", "generator": "check", "label": "AI チェック", "languages": ["en", "ko"] }
```

- `generator` には、`generators` に付けた名前を書きます。列の定義にある既定（生成器の ID）のままでは、`options` が空になり、生成できません。
- `languages` で、列を出す言語を絞れます。
- 表示名と色は、`use` の横に `label` や `type` を書いて変えられます。`type` を書くときは、値（`OK`、`WARNING`、`NG`）と並びを変えないでください。値は生成器が返すもので、並びは、条件式の大小（`mtCheck@en >= WARNING`）の順になります。
- 同梱の列を使わずに、`{ "id": "back", "kind": "generated", "scope": "language", "label": "逆翻訳", "generator": "mt" }` のように、列の定義を直接書いても構いません。

## キャッシュの鍵に入る値

生成の結果は、次の値の組ごとに、共有 DB に残ります。どれかが変わると、前の結果は「変更あり」になり、生成し直せます。元の値に戻すと、前の結果がまた「最新」として出ます。

| | `llm.translate` | `llm.evaluate` |
| --- | --- | --- |
| 入力 | そのセルの言語の本文、言語の ID | 訳文、言語の ID、原文、原文の言語の ID |
| 設定 | `endpoint`、`model`、訳し先、`instructions`、`temperature`、既定から変えたときのプロンプト | `endpoint`、`model`、プロンプト、`instructions`、`temperature` |
| 生成器 | ID と `version` | ID と `version` |

`apiKeySecret`、`timeoutMs`、まとめて送る件数は、鍵に入りません。変えても、生成済みの結果はそのまま使われます。
