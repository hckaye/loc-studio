# 同梱のプラグイン

loc-studio には、最初から登録されているプラグインが 2 つあります。どちらも、スタジオが書くプラグインと同じ `Plugin` の形をしていて、同じ拡張ポイントに実装を登録します。プラグインフォルダに置く必要はなく、画面、サービス層、コマンドラインのどれでプロジェクトを開いても、`builtin` の層に登録されます。

| プラグイン | パッケージ | 登録する実装 |
| --- | --- | --- |
| `@loc-studio/builtin` | `packages/builtin` | フォルダを走査するツリー、CSV / TSV のフォーマット、本文の記法 3 つ、バリデータ 5 つ、列ソース 2 つ（共有 DB、レビュー）、列 5 つ（キー、本文、進捗ステータス、レビュー、文字数） |
| `@loc-studio/plugin-llm` | `packages/plugin-llm` | LLM（OpenAI 互換の API）を使う生成器 2 つ（機械翻訳、翻訳の評価）、それを使う列 2 つ、プロンプトなどの設定 4 つ |

登録された実装は、プロジェクト設定の `use` で選んだものだけが使われます。設定を書かなくても使われるのは、次の 3 つです。

- 設定に `tree` がないプロジェクトは、`builtin.globTree` でリソースを探します。
- 設定に `formats` がないプロジェクトは、登録されたすべてのフォーマット（同梱では `builtin.csv` と `builtin.tsv`）を、拡張子で使い分けます。
- 設定に `syntaxes` がないプロジェクトは、登録されたすべての記法（同梱では `builtin.braces`、`builtin.printf`、`builtin.tags`）を使います。

バリデータ、進捗ステータスとレビューの列、LLM の生成器は、設定で選ぶまで何もしません。

## プラグインごとの文書

文書は、プラグインごとに 4 つに分けています。

| 文書 | 読む人 | `@loc-studio/builtin` | `@loc-studio/plugin-llm` |
| --- | --- | --- | --- |
| ユーザーガイド | プロジェクトを設定して使う人 | [builtin/guide.md](builtin/guide.md) | [llm/guide.md](llm/guide.md) |
| 設定項目 | 設定に書ける値と既定を調べる人 | [builtin/settings.md](builtin/settings.md) | [llm/settings.md](llm/settings.md) |
| 設計 | なぜその動きにしているかを知りたい人、同じ種類のプラグインを書く人 | [builtin/design.md](builtin/design.md) | [llm/design.md](llm/design.md) |
| 実装 | このプラグインのコードを直す人 | [builtin/implementation.md](builtin/implementation.md) | [llm/implementation.md](llm/implementation.md) |

プロジェクト設定の全体は [CONFIG.md](../CONFIG.md)、画面の操作は [GETTING-STARTED.md](../GETTING-STARTED.md) にあります。この文書群は、同梱のプラグインに関わる部分を、プラグインごとにまとめ直したものです。食い違いがあれば、型の定義（`packages/sdk/src/types.ts`）と各プラグインのソースに従ってください。

## 登録された実装を確かめる

コマンドラインの `plugins` で、読み込まれたプラグインと、登録された実装の一覧を見られます。次は、`examples/sample-project` の写しで実行した出力のうち、同梱のプラグインの部分です（2026-11-18、Windows 11、Node.js 26.5.1）。

```
$ node apps/cli/dist/index.js plugins --project <プロジェクト>
プラグイン:
  @loc-studio/builtin  0.1.0  [builtin]  (同梱)
  @loc-studio/plugin-llm  0.2.0  [builtin]  (同梱)
  ...

登録された実装:
  tree:
    builtin.globTree  <- @loc-studio/builtin [builtin]
  format:
    builtin.csv  <- @loc-studio/builtin [builtin]
    builtin.tsv  <- @loc-studio/builtin [builtin]
  syntax:
    builtin.braces  <- @loc-studio/builtin [builtin]
    builtin.printf  <- @loc-studio/builtin [builtin]
    builtin.tags  <- @loc-studio/builtin [builtin]
  source:
    builtin.db  <- @loc-studio/builtin [builtin]
    builtin.reviews  <- @loc-studio/builtin [builtin]
  column:
    builtin.key  <- @loc-studio/builtin [builtin]
    builtin.text  <- @loc-studio/builtin [builtin]
    builtin.textStatus  <- @loc-studio/builtin [builtin]
    builtin.reviewStatus  <- @loc-studio/builtin [builtin]
    builtin.length  <- @loc-studio/builtin [builtin]
    llm.translation  <- @loc-studio/plugin-llm [builtin]
    llm.evaluation  <- @loc-studio/plugin-llm [builtin]
  generator:
    llm.translate  <- @loc-studio/plugin-llm [builtin]
    llm.evaluate  <- @loc-studio/plugin-llm [builtin]
  validator:
    builtin.placeholders  <- @loc-studio/builtin [builtin]
    builtin.tagBalance  <- @loc-studio/builtin [builtin]
    builtin.maxLength  <- @loc-studio/builtin [builtin]
    builtin.whitespace  <- @loc-studio/builtin [builtin]
    builtin.untranslated  <- @loc-studio/builtin [builtin]
    ...
```

画面では、上のバーの「プラグイン」のダイアログに同じ一覧が出ます。

## 同梱の実装を置き換える

`builtin.` と `llm.` で始まる `id` は、同梱のプラグインが使っています。プロジェクトやアプリのプラグインが同じ種類の同じ `id` を登録すると、後から読み込まれた層の実装が同梱の実装を上書きし、警告が出ます（[plugins/loading.md](../plugins/loading.md#プラグインフォルダと層)）。動きを変えたいときは、別の `id` で実装を登録して、設定の `use` をその `id` に変えるほうが、どちらを使っているかが設定から読み取れます。

## この文書群を確かめた範囲

- ユーザーガイドの手順と出力は、2026-11-18 に、Windows 11（Node.js 26.5.1）で、一時のプロジェクトを作ってコマンドラインで実行したものです。何を実行したかは、それぞれのガイドの「確かめた範囲」にあります。画面での操作は、この文書群のためには確かめ直していません。
- 設定項目、設計、実装の文書は、同じ日のソースを読んで書きました。書いたあとで、文書の記述をソースと 1 つずつ突き合わせる点検を、書いたのとは別の読み手で 1 回行い、見つかった誤りと言い過ぎ（22 件）と、裏づけのない理由の記述（7 件）を直しました。直したあとの文書は、もう一度は点検していません。
- LLM のプラグインは、実際の LLM の API には接続していません。確認用のサーバー（決まった返事を返すもの）を相手にしています。

## 自分でプラグインを書くとき

自分でプラグインを書くときは、[PLUGINS.md](../PLUGINS.md) と、種類ごとのページ（[plugins/](../plugins/)）を読んでください。同梱のプラグインのソースは、各種類の実装の例としても読めます（設計と実装の文書に、ファイルごとの案内があります）。
