# プラグインの読み込みの決まり

プラグインをどのフォルダから探し、どのファイルを入口として読み、どんな形なら登録するかをまとめます。作る手順は [PLUGINS.md](../PLUGINS.md#作る手順) にあります。

## プラグインフォルダと層

プラグインは、次のフォルダから探します。表の下の行ほど優先し、同じ種類の同じ `id` は、下の行の層の実装が上書きします（上書きは警告に出ます）。

| 順 | 層（`layer`） | 場所 |
| --- | --- | --- |
| 0 | `builtin` | 同梱（`@loc-studio/builtin` と `@loc-studio/plugin-llm`。CLI も含め、すべての入口で登録されます） |
| 1 | `app` | アプリのフォルダの `plugins/`（CLI は `--app-dir` または `LOC_STUDIO_APP_DIR`、Web は `LOC_STUDIO_APP_DIR`、デスクトップ版は配布物の隣の `plugins`） |
| 2 | `app` | 環境変数 `LOC_STUDIO_PLUGIN_DIRS` のフォルダ（OS のパス区切りで複数。層の名前は `app`） |
| 3 | `project` | プロジェクトの `loc-studio-plugins/`（設定の `pluginDirs` で変えられる。複数可） |
| 4 | `local` | 個人の設定フォルダ（user data）の `plugins/`。Web モードでは読まない |

- スタジオのプラグインは、ふつう project 層（`<プロジェクト>/loc-studio-plugins/`）に置きます。プロジェクトを共有するチームの全員が使えます。
- local 層のプラグインは、その人の PC だけで使われます。プロジェクト設定で、種類ごとに禁止できます（[trust.md の「個人のプラグインを制限する」](trust.md#個人のプラグインを制限する)）。
- フォルダがなくてもエラーではありません（`plugins` コマンドに「フォルダなし」と出るだけです）。
- デスクトップ版の配布物でも、アプリを作り直さずにプラグインを足せます。ファイルを置いて、画面の「プラグイン」の一覧で「再読み込み」を押します。TypeScript のままで構いません。app 層（アプリの隣の `plugins`）は、信頼の確認なしで読み込みます。
- 同じフォルダの中では、名前の順（ロケールに依存しない比較）に読み込みます。
- 画面のローカルモードでは、project 層と local 層のプラグインは、利用者が信頼するまで読み込みません（[trust.md](trust.md)）。CLI と Web モードは常に読み込みます。

## 単一ファイルとフォルダ形式

対象になるのは、プラグインフォルダの直下にあるものだけです。下の階層は探しません。プラグインの形は 2 つあります。

単一ファイルのプラグインは、`.ts` / `.mts` / `.js` / `.mjs` / `.cjs` のファイルです。`_` か `.` で始まる名前、`.d.ts`、`*.test.*` は無視します。

フォルダ形式のプラグインは、中に `plugin.json` か、`index.ts` / `index.mts` / `index.js` / `index.mjs` / `index.cjs` があるフォルダです。`plugin.json` も `index.*` もないフォルダは、プラグインではない（データ置き場など）とみなして無視します。`node_modules` と、`_` / `.` で始まるフォルダも無視します。

```
<プロジェクト>/
  loc-studio.project.json
  loc-studio-plugins/
    line-width.ts          単一ファイルのプラグイン
    _shared.ts             無視される（名前が _ で始まる）。ほかのプラグインから import できる
    studio-pack/           フォルダ形式のプラグイン
      plugin.json
      index.mjs
    notes/                 無視される（plugin.json も index.* もない）
      memo.txt
```

フォルダ形式を選ぶのは、次の場合です。

- プラグインを複数のファイルに分ける。
- npm パッケージを使う（プラグインのフォルダの `node_modules` に置く）。
- 独自描画のブラウザ用のモジュールを持つ（[renderer.md](renderer.md)）。
- `eval` や `child_process` のように、単一ファイルでは信頼の確認を通らない書き方を使う（[trust.md](trust.md#単一ファイルのプラグインとコードの設定だけで断る書き方)）。

## plugin.json

フォルダ形式のプラグインに置ける設定のファイルです。キーはすべて省略できます。

```json
{
  "name": "studio-pack",
  "version": "1.2.0",
  "apiVersion": 1,
  "main": "index.mjs"
}
```

| キー | 意味 |
| --- | --- |
| `name` | プラグインが `name` を書かなかったときの名前。どちらもなければ、ファイル名（拡張子なし）かフォルダ名 |
| `version` | プラグインが `version` を書かなかったときの版 |
| `apiVersion` | 対応するプラグイン API の版。いまの版は `1`。違う値だと、そのプラグインは読み込まれずエラーになる。省略すると現在の版とみなす |
| `main` | 入口のファイル（フォルダからの相対）。省略すると `index.*` を探す。プラグインのフォルダの中を指す必要がある |
| `enabled` | `false` で、そのフォルダを読み込まない |

`plugin.json` が JSON として読めない、`main` のファイルがない、入口のファイルがない、といった場合は、読み込みエラーになります。ほかのプラグインは読み込まれます。

## 入口のファイルが書き出すもの

入口のファイルは、既定のエクスポート（`export default`）で、次のどれかを書き出します。

- `Plugin` のオブジェクト
- `Plugin` を返す関数（`async` でもよい）
- `Plugin` の配列（1 つのファイルから複数のプラグイン。名前がなければ `<名前>#1`、`<名前>#2` の順に付きます）

```ts
import { definePlugin } from "@loc-studio/sdk";

export default definePlugin({
  name: "mystudio-example",
  version: "1.0.0",
  validators: [ /* ... */ ],
});
```

`definePlugin` は型の補完のためだけの関数で、値をそのまま返します。同じ形のオブジェクトをそのまま書き出してもかまいません（`examples/sample-project/loc-studio-plugins/studio-pack/index.mjs` は、`import` なしの素の JavaScript です）。

## 読み込むときの形の確認

読み込むときに、次のことを確かめます。1 つでも問題があれば、そのファイルのプラグイン全体を登録しません（一部だけが登録された状態を作らないためです）。

- `name` が空でない文字列であること（省略したときは、`plugin.json` の `name`、ファイル名、フォルダ名の順で補われます）
- `version` が文字列、`apiVersion` が数値であること（書いた場合）
- 各欄（`validators` など）が配列であること
- 各実装の `id` が空でない文字列であること
- 種類ごとの必須の関数と文字列があること

| 種類 | 必須の関数 | 必須の文字列 |
| --- | --- | --- |
| tree | `list` `read` `write` | |
| format | `match` `parse` `apply` | |
| syntax | `tokenize` | |
| source | `load` `save` | `saveMode` |
| column | | `kind` `scope` |
| generator | `cacheParams` `input` `run` | `version` |
| action | `run` | `label` `target` |
| validator | `validate` | `label` `version` |
| renderer | | `module`（プラグインのフォルダからの相対パス） |

読み込みエラーのメッセージは、どの実装の何が足りないかを含みます。実際に出たものは次のとおりです。

```
読み込みエラー:
  [project] <プロジェクト>/loc-studio-plugins/nodefault.ts: プラグイン <プロジェクト>/loc-studio-plugins/nodefault.ts を読み込めませんでした: 既定のエクスポート（export default）がありません。
  [project] <プロジェクト>/loc-studio-plugins/missing.ts: プラグイン <プロジェクト>/loc-studio-plugins/missing.ts を読み込めませんでした: generators[0]（"t.gen"） に関数 cacheParams がありません。 generators[0]（"t.gen"） に関数 input がありません。 generators[0]（"t.gen"） の version は文字列にしてください。 validators[0]（"t.missing"） の label は文字列にしてください。 validators[0]（"t.missing"） の version は文字列にしてください。
  [project] <プロジェクト>/loc-studio-plugins/folder-no-entry: <プロジェクト>/loc-studio-plugins/folder-no-entry に入口のファイル（plugin.json の main、または index.ts / index.mts / index.js / index.mjs / index.cjs）がありません。
```

## TypeScript とビルド

プラグインは、実行時にフォルダから読み込まれます（`jiti`）。アプリの再ビルドも、プラグイン自身のビルドも要りません。TypeScript は、そのまま置けば読み込まれます。

- 読み込みでは型の検査をしません。エディタで検査したいときは、プラグインのフォルダに別途 `tsconfig` を用意してください。
- 毎回キャッシュなしで読み込みます。CLI は実行のたびに読み込み直します。画面は、「プラグイン」のダイアログの「プラグインを再読み込み」を押すと読み込み直します。
- 独自描画のブラウザ用のモジュールだけは、ブラウザがそのまま読むので、JavaScript（`.js` / `.mjs`）で書きます。

## 複数のファイルと npm パッケージ

フォルダ形式のプラグインは、フォルダの中の相対 import（別の `.ts` ファイル、`.json`）と、フォルダの `node_modules` に置いた npm パッケージを使えます。

```
loc-studio-plugins/
  withdep/
    index.ts
    helper.ts
    words.json
    node_modules/
      tiny-dep/
        package.json
        index.js
```

```ts
// loc-studio-plugins/withdep/index.ts
import { definePlugin } from "@loc-studio/sdk";
import dep from "tiny-dep";
import words from "./words.json";
import { helper } from "./helper";
```

上の構成（`tiny-dep` は CommonJS のパッケージ）を、CLI と、サービス層の信頼の確認つきの読み込みの両方で確かめました。信頼の確認の対象のファイルには、`helper.ts`、`index.ts`、`words.json` と、`node_modules/tiny-dep` の中のファイルが入りました。ES モジュールだけを配るパッケージは確かめていません。

単一ファイルのプラグインは、同じフォルダにある補助のファイルを相対 import できます。補助のファイルは、プラグインとして読み込まれないよう、名前を `_` で始めます（`import { shout } from "./_shared"`）。

見つからないパッケージを import すると、CLI では「Cannot find module '...'」の読み込みエラーになります。画面のローカルモードでは、信頼の確認の段階で「import "..." はプラグインのフォルダの中（node_modules）にありません。」のエラーになります。import の条件は [trust.md](trust.md) にあります。

## SDK の import

プラグインは `@loc-studio/sdk` を import できます。プラグインのフォルダは `node_modules` の外にあるため、ローダーが `@loc-studio/sdk` をアプリ自身の SDK の入口に向けます。プラグインの側で SDK を導入する必要はありません。

```ts
import { definePlugin, RevisionConflictError, StoreConflictError } from "@loc-studio/sdk";
import type { Validator, ValidationIssue } from "@loc-studio/sdk";
```

型だけの import には `import type` を使ってください（`verbatimModuleSyntax` の規則と同じです）。実行時に使える値は、次のものです。

| 値 | 用途 |
| --- | --- |
| `definePlugin`、`defineConfig`、`defineTreeProvider`、`defineFormat`、`defineTextSyntax`、`defineColumnSource`、`defineGenerator`、`defineAction`、`defineValidator` | 型の補完のための関数。値をそのまま返す |
| `PLUGIN_API_VERSION` | プラグイン API の版（`1`） |
| `RevisionConflictError` | ツリープロバイダーの `write` が、版の競合を知らせるために投げる（[tree.md](tree.md)） |
| `StoreConflictError` | 列ソースの `save` が、セルの版の競合を知らせるために投げる（[source.md](source.md)） |

エラークラスは、名前でも照合されます。プラグインがアプリとは別に読み込まれた SDK のコピーを使うと、プラグインが投げた `RevisionConflictError` は、アプリ側のクラスの `instanceof` に一致しません。そのためサービス層（`packages/server` の `editing.ts` と `rpc.ts`）は、`instanceof` に加えて、エラーの `name`（`"RevisionConflictError"`、`"StoreConflictError"`、`"LockTimeoutError"`）も見て判定します。

- プラグインは、SDK のエラークラスをそのまま投げます。自分でエラーを作るなら、`name` を上の文字列にします。
- プラグインの中でこれらのエラーを捕まえるときは、`instanceof` ではなく `name` で判定します。

ローダーで読み込んだプラグインの `RevisionConflictError` をアプリ側のクラスと比べたところ、`instanceof` も真でした。別のコピーになるかどうかは、アプリの読み込み方（バンドルなど）で変わります。別のコピーになる環境での照合は、動かして確かめていません。
