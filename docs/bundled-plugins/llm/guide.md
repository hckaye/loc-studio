# @loc-studio/plugin-llm の使い方

`@loc-studio/plugin-llm` は、LLM に本文を送って、機械翻訳と、訳文の評価（OK / WARNING / NG の判定と理由）を、表の列に出す同梱のプラグインです。接続先は、OpenAI 互換の API（`chat/completions`）です。設定に書ける値の一覧は [settings.md](settings.md) にあります。

| 生成器 | 作る値 | 設定の `columns` に `use` で足せる列 |
| --- | --- | --- |
| `llm.translate` | そのセルの言語の本文を、別の言語（既定は日本語）に翻訳した文章 | `llm.translation`（表示名「機械翻訳」） |
| `llm.evaluate` | そのセルの言語の本文（訳文）を、原文と比べた判定。`OK`、`WARNING`、`NG` のどれかと、理由 | `llm.evaluation`（表示名「翻訳の評価」） |

どちらも生成列です。値は、利用者が生成を実行したときに作られ、共有 DB に残ります。本文を開くたびに LLM を呼ぶことはありません。

## 用意するもの

- OpenAI 互換の API の URL と、モデル名。`<URL>/chat/completions` に POST できるものなら、LiteLLM などの中継サーバーでも構いません。
- API キー（要る接続先だけ）。

生成の結果は、プロジェクトの共有 DB（既定では `<プロジェクト>/.loc-studio/meta.db`）に置かれます。DB は、プロジェクトを、画面か、サービス層を通すコマンド（`generate`、`status` など）で最初に開いたときに作られます。

## 設定する

設定は 3 か所です。

### 1. 接続先に名前を付ける（generators）

プロジェクト設定の `generators` に、生成器に付ける名前と、接続先を書きます。

```json
"generators": {
  "mt": { "use": "llm.translate", "options": { "endpoint": "https://llm.example.internal/v1", "model": "my-model" } },
  "check": { "use": "llm.evaluate", "options": { "endpoint": "https://llm.example.internal/v1", "model": "my-model" } }
}
```

`endpoint` と `model` は必須です。`mt` と `check` は、プロジェクトで決める名前です。

### 2. 列を足す（columns）

`columns` に、同梱の列を `use` で足し、`generator` に、上で付けた名前を書きます。`languages` には、列を出す言語（訳文の言語）を書きます。

```json
"columns": [
  { "use": "builtin.key", "id": "key" },
  { "use": "builtin.text", "id": "text" },
  { "use": "llm.translation", "id": "mt", "generator": "mt", "languages": ["en"] },
  { "use": "llm.evaluation", "id": "mtCheck", "generator": "check", "languages": ["en"] }
]
```

この設定では、英語の本文の横に、2 つの列が出ます。

- 「機械翻訳」の列（`mt`）には、英語の本文を日本語に翻訳した文章が入ります。訳文を原文の言語に訳し戻して、意味がずれていないかを読んで確かめる使い方（逆翻訳）です。
- 「翻訳の評価」の列（`mtCheck`）には、英語の本文を、英語の基にする言語（`basedOn`。ここでは日本語）の本文と比べた判定が入ります。

`languages` を省くと、すべての言語に列が出ます。評価は、基にする言語のない言語（原文の言語）のセルには何も作りません。

### 3. API キーを渡す（秘密情報）

API キーは、設定ファイルには書きません。秘密情報 `llm.apiKey` として、次のどちらかで渡します。

| 使い方 | 渡し方 |
| --- | --- |
| 画面のローカルモード、コマンドライン | ローカル設定（`settings.json`）の `"secrets.llm.apiKey": "sk-..."`、または環境変数 `LOC_STUDIO_SECRET_LLM_APIKEY` |
| Web モード | サーバーの環境変数 `LOC_STUDIO_SECRET_LLM_APIKEY` |

秘密情報がないときは、`Authorization` ヘッダーを付けずに送ります。

画面のローカルモードでは、`generators` を書いた設定ファイルは、最初に開いたときに設定の確認のダイアログが出ます。ダイアログに出る接続先が、意図したものかを確かめてから信頼してください。信頼するまで、プロジェクトは外部に接続しません。

## 生成する

### 画面から生成する

- 生成列のセルには、「最新」「変更あり」「未生成」の印と、生成のボタン（「⟳」）が出ます。ボタンを押すと、範囲（このセル、選択した行、このリソース全体、プロジェクト全体）を選ぶ窓が出て、全体、キャッシュ済み、実行する件数を確かめてから実行できます。
- ツールバーの「一括アクション ▾」からは、いまの絞り込みに合う行だけを生成できます（[QUERY.md の一括アクション](../../QUERY.md#一括アクション)）。
- 実行中の生成は、上のバーの「ジョブ」で進み具合を見て、取り消せます。

### コマンドラインから生成する

`generate` の引数は、列の ID です（`generators` の名前ではありません）。`--dry-run` を付けると、件数だけを出して、LLM には送りません。

```
$ node apps/cli/dist/index.js generate mt --project <プロジェクト> --dry-run
mt（ドライラン）: 全体 3 / キャッシュ済み 0 / 実行する分 3
$ node apps/cli/dist/index.js generate mt --project <プロジェクト>
mt: 全体 3 / キャッシュ済み 0 / 生成 3 / 失敗 0
$ node apps/cli/dist/index.js generate mt --project <プロジェクト>
mt: 全体 3 / キャッシュ済み 3 / 生成 0 / 失敗 0
```

この例のプロジェクトは 4 行で、英語の本文が空の行が 1 つあります。空の本文は生成しないので、全体は 3 件です。2 回目の実行は、3 件ともキャッシュにあるので、何も送りません。

条件に合う行だけを生成する `--where`、キーを指定する `--keys`、言語を絞る `--languages` もあります（[CLI.md の generate](../../CLI.md#generate)）。

## 結果を読む

機械翻訳の列には、翻訳した文章がそのまま出ます。評価の列には、判定が色つきの札（既定の色は、OK が緑、WARNING が黄、NG が赤）で出て、理由が横に出ます。

評価の判定は、絞り込みと集計に使えます。大小は `OK`、`WARNING`、`NG` の順なので、`mtCheck@en >= WARNING` で、WARNING と NG の行を選べます。

```
$ node apps/cli/dist/index.js query --project <プロジェクト> --languages en --group-by mtCheck@en
条件に合う行: 4 / 4 行（原文 49 文字 / 5 語）
  text/main.csv: 4 / 4

集計（mtCheck@en）:
  OK: 1 行（14 文字 / 1 語）
  WARNING: 1 行（18 文字 / 1 語）
  NG: 1 行（12 文字 / 2 語）
  （空）: 1 行（5 文字 / 1 語）
$ node apps/cli/dist/index.js query --project <プロジェクト> --languages en --where "mtCheck@en >= WARNING" --limit 5 --columns text@ja,text@en,mt@en,mtCheck@en
条件に合う行: 2 / 4 行（原文 30 文字 / 3 語）
  text/main.csv: 2 / 4

行:
  text/main.csv  SHOP
    text@ja: いらっしゃいませ。何をお探しですか？
    text@en: Hi
    mt@en: [MT] Hi
    mtCheck@en: WARNING
  text/main.csv  GOLD
    text@ja: 所持金：{gold} G
    text@en: Gold: G
    mt@en: [MT] Gold: G
    mtCheck@en: NG
```

「（空）」の 1 行は、英語の本文が空で、評価していない行です。この出力は、決まった返事を返す確認用のサーバーを接続先にしたときのものです。`[MT] Hi` という翻訳と、判定は、そのサーバーが機械的に作ったもので、実際のモデルの結果ではありません。

### 「変更あり」になるとき

結果は、作ったときの入力と設定を覚えています。次のどれかが変わると、セルに「変更あり」の印が出ます。前の結果は消えずに残り、生成し直すと「最新」に戻ります。

- そのセルの本文。評価では、原文の本文も含みます。
- 接続先（`endpoint`）、モデル（`model`）、`temperature`。
- プロンプト、訳し先の言語、`instructions`。
- 評価では、比べる原文の言語（プラグインの設定、`options` の `source`、言語の `basedOn`）。

「変更あり」の行は、絞り込みの「要確認」と、条件式の `stale` で探せます。値を元に戻すと、前の結果がまた「最新」として出ます（結果は、入力と設定の組ごとに残っているためです）。

## プロンプトと訳し先を変える

プロンプト、訳し先の言語、評価で比べる原文の言語は、設定の画面の「プラグインの設定」のタブで変えます。`@loc-studio/plugin-llm` の欄に、4 つの項目が出ます。

| 項目 | 既定 |
| --- | --- |
| 機械翻訳: 訳し先の言語 | `日本語` |
| 機械翻訳: プロンプト | 「ユーザーが送る文章を{to}に翻訳してください。」で始まる 3 行 |
| 翻訳の評価: 比べる原文の言語 | 空（その言語の `basedOn`） |
| 翻訳の評価: プロンプト | 判定の基準を書いた 8 行 |

- プロンプトの欄で「既定の文章を入力欄に入れる」を押すと、既定の文章から書き換えられます。欄を空にして保存すると、既定に戻ります。
- 機械翻訳のプロンプトの `{to}` は、訳し先の言語の名前に置き換わります。
- 評価のプロンプトには、判定の基準だけを書きます。返事の形（判定と理由の JSON）の指示は、アプリが後ろに足します。
- 値は、プロジェクトの `loc-studio-plugin-settings/%40loc-studio%2Fplugin-llm.json` に保存され、チームで共有されます。

次は、訳し先を「フランス語」に、評価のプロンプトを別の文章に変えたときの出力です。生成済みの 3 件が、どちらの列でも、もう一度実行する対象になっています。

```
$ node apps/cli/dist/index.js generate mt --project <プロジェクト> --dry-run
mt（ドライラン）: 全体 3 / キャッシュ済み 0 / 実行する分 3
$ node apps/cli/dist/index.js generate mtCheck --project <プロジェクト> --dry-run
mtCheck（ドライラン）: 全体 3 / キャッシュ済み 0 / 実行する分 3
$ node apps/cli/dist/index.js query --project <プロジェクト> --languages en --where "stale"
条件に合う行: 3 / 4 行（原文 44 文字 / 4 語）
  text/main.csv: 3 / 4
```

生成し直すと、`stale` に合う行は 0 になりました。設定ファイルを消して値を既定に戻すと、最初に作った結果がキャッシュ済みとして数えられ、何も送らずに「最新」に戻りました。

同じ生成器を、列ごとに別の値で使いたいときは、`generators` に名前を 2 つ作り、`options` に `to`、`prompt`、`source`、`instructions` を書きます。`options` の値が、プラグインの設定より優先されます。

```json
"generators": {
  "toJa": { "use": "llm.translate", "options": { "endpoint": "https://llm.example.internal/v1", "model": "my-model", "to": "日本語" } },
  "toEn": { "use": "llm.translate", "options": { "endpoint": "https://llm.example.internal/v1", "model": "my-model", "to": "英語", "instructions": "ゲームの UI の文言です。短く訳してください。" } }
}
```

## まとめて送る件数を変える

既定では、1 回の要求に 1 つの本文を入れて送ります。生成のときに、まとめて送る件数（バッチサイズ）を選べます。画面では、生成の窓の「まとめて送る件数」と、一括アクションの「まとめて送る行数」です。コマンドラインでは `--batch-size` です。

```
$ node apps/cli/dist/index.js generate mtCheck --project <プロジェクト> --batch-size 2
mtCheck: 全体 3 / キャッシュ済み 0 / 生成 3 / 失敗 0
```

この実行は、3 件を、2 件と 1 件の 2 回の要求で送りました。

- 2 件以上をまとめると、本文に番号を付けた JSON の配列で送り、モデルに、番号ごとの結果の配列を返させます。
- 返事に足りない番号があるなど、形の合わない返事は、そのまとまり全体を失敗にして、やり直します（やり直しは 2 回まで）。
- 件数を増やすと、要求の回数は減りますが、モデルが返事の形を崩しやすくなります。失敗が増えたら、件数を減らしてください。
- 同時に送る要求は 2 つまでです。

## うまく動かないとき

生成の失敗は、画面ではジョブのエラーとして、コマンドラインでは標準エラー出力に出ます。3 回（最初の 1 回と、やり直しの 2 回）試しても失敗したときに、最後の理由が出ます。

| 文言 | 原因 | 直し方 |
| --- | --- | --- |
| `llm.translate: オプション "endpoint" が設定されていません。…` | `generators` の `options` に `endpoint`（または `model`）がない。生成列の `generator` が、`generators` の名前を指していない | 文言にある形で、`generators` に書く。列の `generator` を、その名前にする |
| `… への接続に失敗しました: fetch failed` | 接続先に届かない（URL の誤り、サーバーが止まっている、ネットワーク） | `endpoint` を確かめる。URL は、`/chat/completions` の手前まで（`…/v1` など）を書く |
| `… がエラーを返しました (HTTP 401): …` | API キーがない、または誤っている | 秘密情報 `llm.apiKey` を設定する |
| `… がエラーを返しました (HTTP 404): …` | `endpoint` のパスか、モデル名が違う | 接続先の文書で、URL とモデル名を確かめる |
| `… が 60000ms 以内に応答しませんでした。` | 応答が遅い | `options` の `timeoutMs` を延ばす。まとめて送る件数を減らす |
| `… の応答に結果 (choices[0].message.content) がありません。` | 接続先の応答が、OpenAI 互換の形でない | 接続先が `chat/completions` の形で返すかを確かめる |
| `モデルの返事を JSON として読めませんでした: …` | 評価、またはまとめて送ったときに、モデルが JSON 以外を返した | まとめて送る件数を減らす。プロンプトに、返事の形を崩す指示がないか確かめる |
| `モデルの返事に id 3 の結果がありません（5 件をまとめて送りました）。…` | まとめて送った返事に、足りない番号がある | まとめて送る件数を減らす |
| `…判定（verdict）が OK / WARNING / NG のどれでもありません: …` | 評価のプロンプトを書き換えて、判定の値が変わった | 判定の値は 3 つのままにする。意味は、プロンプトで説明する |
| 列は出るが、どのセルも「未生成」のままで、件数が 0 | 評価の列を、基にする言語のない言語に出している。本文が空 | `languages` に訳文の言語を書く。比べる原文の言語を設定する |
| `生成列 "mt" の生成器 "x" が見つかりません（設定の generators と登録された生成器を確かめてください）。` | 列の `generator` が、`generators` の名前にも、生成器の ID にもない | `generator` を `generators` の名前に合わせる |

Web モードでは、管理者でない利用者に見せる失敗の文言から、接続先の URL が `<接続先>` に置き換えられます。

## 確かめた範囲

2026-11-18 に、Windows 11（Node.js 26.5.1）で、上の設定のプロジェクト（4 行の CSV、日本語と英語）を作り、コマンドラインで実行しました。接続先は、手元に立てた確認用のサーバー（`chat/completions` に、決まった返事を返すもの）です。出力は、実行したときのものです。

- `endpoint` のない設定での失敗の文言。接続先を止めたあとの、接続の失敗の文言。
- `generate` の `--dry-run`、実行、2 回目の実行（キャッシュ）。
- 環境変数 `LOC_STUDIO_SECRET_LLM_APIKEY` を渡したときに、`Authorization: Bearer …` が付くこと。渡さないときに、付かないこと。
- `--batch-size 2` で、3 件が 2 回の要求になること。
- `query` での、評価の判定の集計と絞り込み。
- プラグインの設定ファイルを書き換えたあとの、件数、`stale`、送られるプロンプトの 1 行目。設定ファイルを消したあとに、前の結果がキャッシュ済みになること。

次のことは、この文書のためには動かしていません。

- 実際の LLM の API と、実際の LiteLLM への接続。既定のプロンプトで、実際のモデルがどう判定するか、まとめて送ったときに返事の形を守るかも、確かめていません。
- 画面での操作。説明は、コードと [GETTING-STARTED.md の生成列とアクション](../../GETTING-STARTED.md#生成列とアクション)に基づきます。画面の生成、評価の札と理由、プロンプトの書き換えは、`npm run check:browser` が、確認用のサーバーを相手に確かめています（[README の「状況」](../../../README.md#状況)）。
- 「うまく動かないとき」の表のうち、上に挙げた 2 つ以外の文言は、ソースのメッセージから書きました。HTTP のステータスごとの原因は、接続先によって違うことがあります。
