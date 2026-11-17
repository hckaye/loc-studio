# プラグインの設定

プラグインは、自分の設定の項目を宣言できます。宣言すると、設定の画面の「プラグインの設定」に入力欄が出て、値はプロジェクトのフォルダに、プラグインごとの設定ファイルとして保存されます。しきい値、切り替え、やり方の選択など、スタジオが画面から調整したい値に使います。

`use` に添える `options`（[CONFIG.md の use と options](../CONFIG.md#use-と-options)）との違いは次のとおりです。

| | `options` | プラグインの設定 |
| --- | --- | --- |
| 決める単位 | 使う場所ごと（同じ実装を、別の値で 2 回使える） | プラグインごとに 1 組 |
| 書く場所 | `loc-studio.project.json` の `use` のとなり | `loc-studio-plugin-settings/<プラグインの名前>.json` |
| 画面での編集 | 「詳細」の JSON | 宣言から作った入力欄 |
| 形の確認 | プラグインが自分で確かめる | 宣言した種類で、アプリが確かめる |

接続キーなどの秘密は、設定に置かず、`ctx.host.secrets.get("<名前>")` で読みます（[host.md](host.md)）。設定ファイルはプロジェクトのフォルダにあり、チームで共有されるためです。

## 宣言する

`Plugin` の `settings` に、項目を並べます。

| 項目 | 型 | 内容 |
| --- | --- | --- |
| `key` | `string` | 設定ファイルのキー。プラグインの中で重複しない、空でない文字列 |
| `label` | `string` | 設定の画面に出す名前 |
| `description` | `string`（任意） | 設定の画面に出す説明 |
| `type` | `"string"` / `"number"` / `"boolean"` / `"enum"` | 値の種類 |
| `options` | `{ value: string; label?: string }[]` | `type: "enum"` の選択肢（1 つ以上。値は重複しない）。`enum` 以外では書けない |
| `multiline` | `boolean`（任意） | `type: "string"` の値を、複数行の入力欄で編集する（プロンプトなどの長い文章）。`string` 以外では書けない |
| `default` | `string` / `number` / `boolean`（任意） | 設定ファイルに値がないときの値。`type` に合う値にする |

宣言の形が誤っているプラグインは、読み込みません。理由は、`plugins` の「読み込みエラー」と、画面の「プラグイン」のダイアログに出ます。

## 値を読む

値は、入口の関数が受け取る `setup.settings.get(key)` で読みます。入口のファイルの既定のエクスポートを、`Plugin` を返す関数にします（[loading.md](loading.md#入口のファイルが書き出すもの)）。

`loc-studio-plugins/width.mjs`:

```js
// 設定で上限と重さを変えられる検証。値は、検証のたびに setup.settings.get で読む。
export default (setup) => ({
  name: "mystudio-width",
  version: "1.0.0",
  settings: [
    { key: "maxLength", label: "文字数の上限", description: "これより長い本文を指摘します。", type: "number", default: 5 },
    { key: "severity", label: "重さ", type: "enum", options: [{ value: "warning", label: "警告" }, { value: "error", label: "エラー" }], default: "warning" },
    { key: "skipEmpty", label: "空の本文を飛ばす", type: "boolean", default: true },
    { key: "note", label: "メモ", type: "string" },
  ],
  validators: [
    {
      id: "mystudio.width",
      label: "文字数（設定つき）",
      version: "1",
      severity: "warning",
      validate(ctx) {
        const max = setup.settings.get("maxLength");
        if (ctx.value === "" && setup.settings.get("skipEmpty")) return [];
        if (ctx.value.length <= max) return [];
        return [{ code: "too-wide", message: ctx.value.length + " 文字（上限 " + max + "）", severity: setup.settings.get("severity") }];
      },
    },
  ],
});
```

設定（`validators` に足す）:

```json
"validators": ["mystudio.width"]
```

- `get` は、設定ファイルの値を返します。値がなければ `default`、`default` もなければ `undefined` です。
- `get` は、`validate` や `run` など、拡張ポイントの関数の中で呼びます。呼ぶたびに、いまの値を返します。入口の関数の中（プラグインを組み立てている間）で呼ぶと、例外になり、プラグインは読み込みエラーになります（値は、プラグインを読み込んだあとで、宣言を見てから読むためです）。
- 宣言していないキーを渡すと、例外になります（書き間違いに気づけるように）。
- 入口がプラグインの配列を返すときは、そのキーを宣言しているプラグインの値を返します。
- TypeScript では、`import type { PluginSetupContext } from "@loc-studio/sdk"` で `setup` の型を付けられます。
- 入口が関数でない（`Plugin` のオブジェクトをそのまま書き出す）プラグインは、`settings` を宣言できますが、値を読む窓口を受け取れません。設定を使うプラグインは、関数の形で書きます。

## 設定ファイル

値は、プロジェクトのフォルダの `loc-studio-plugin-settings/<プラグインの名前>.json` に、「キー: 値」の JSON として置きます。1 つのプラグインに 1 つのファイルです。

```json
{
  "maxLength": 9,
  "severity": "error"
}
```

- ファイル名は、プラグインの `name` です。英数字と `.` `_` `-` 以外の文字は `%XX` になります（`pack#1` は `pack%231.json`）。
- ファイルがなくても動きます（既定の値を使います）。最初に保存したときに作り、値がすべてなくなると消します。
- プラグインのフォルダの中には置きません。フォルダ形式のプラグインは、フォルダの中のファイルすべてが信頼の確認のハッシュに入るので、値を変えるたびにプラグインの確認をやり直すことになるためです。
- 宣言した種類に合わない値は使わず、既定の値で動かして警告にします（画面の「警告とエラー」と、「プラグインの設定」のそのプラグインの欄に出ます）。JSON として読めないファイルも同じです。
- 宣言にないキーは、プラグインには渡りません。設定の画面から保存しても、そのまま残します。
- 同じ `name` のプラグインが 2 つ設定を宣言していると、あとから読み込んだほうの設定は使わず、警告にします。

## 設定の画面

上のバーの「設定」の、「プラグインの設定」のタブに、設定を宣言しているプラグインごとの欄が出ます。

- 欄は、宣言の `type` で決まります。文字と数値は入力欄、選択式はドロップダウン、`boolean` はチェックです。
- `multiline` の文字の項目は、複数行の入力欄になります。既定の値があれば、「既定の文章を入力欄に入れる」のボタンで、既定の文章を入力欄に入れてから書き換えられます。既定の値は長いので、「既定の値を見る」を開くと読めます。
- 欄を空にして保存すると（選択式は「（既定の値を使う）」）、設定ファイルからその値を消して、既定の値に戻します。
- 「設定を保存」は、変えた項目だけを書きます。保存すると、設定とプラグインを読み直し、プラグインは次に呼ばれたときから新しい値を受け取ります（検証の結果も、新しい値でやり直します）。
- Web モードでは、値は全員が見られ、保存できるのは `manage` の権限がある役割です（[WEB-MODE.md](../WEB-MODE.md)）。設定ファイルの場所は、サーバーの管理者にだけ出ます。

サービス層では、`pluginSettings()` が一覧を返し、`setPluginSettings({ plugin, values })` が保存します（[SERVER-API.md](../SERVER-API.md)）。コマンドラインには、設定を変えるコマンドはありません（設定ファイルを直接書きます）。

## 同梱のプラグインの設定

同梱の `@loc-studio/plugin-llm` も、この仕組みで設定を宣言しています（機械翻訳と翻訳の評価のプロンプトなど。[CONFIG.md](../CONFIG.md#プロンプトなどの設定プラグインの設定)）。設定ファイルは `loc-studio-plugin-settings/%40loc-studio%2Fplugin-llm.json` です。

アプリに組み込むプラグイン（サービス層の `extraBuiltins`、コアの `openProject` の `builtins`）も、`Plugin` を返す関数の形で渡すと、同じ `setup.settings` を受け取ります。関数は、プロジェクトを開く（読み直す）たびに呼ばれます。

## 信頼の確認

画面のローカルモードでは、プラグインの設定ファイルの中身も、プロジェクトの設定ファイルの確認の対象です（[trust.md](trust.md)）。プラグインは、この値で動きを変えるためです。

- プロジェクトを開いたとき、設定ファイルの中身が、確認したときと違っていれば（アプリの外で書き換えた、リポジトリから取り込んだ、など）、設定の確認のダイアログが出ます。ダイアログには、プラグインの設定ファイルごとに、値がそのまま出ます。確認するまで、プロジェクトは制限された状態で開きます。
- 設定の画面から保存した値は、その場で確認済みとして記録します（保存する前の設定が確認済みだったときだけ）。
- コマンドラインと Web モードは、確認なしで読み込みます。

## 確かめた範囲

- 上の `width.mjs` と同じ内容のプラグインを一時のプロジェクトに置き、サービス層で、一覧、保存（値の書き込み、`null` での削除、ファイルの削除）、保存した値で検証の結果が変わること、種類の合わない値と宣言にないキーを断ること、設定ファイルの誤った値を既定の値に倒すこと、確認のモードでの信頼を確かめています（`packages/server/src/plugin-settings.test.ts`）。
- 設定の画面のタブは、本番ビルドをブラウザで操作して確かめています（`npm run check:browser`。入力欄の種類、保存したファイルの中身、保存のあとでアクションの結果が変わること、信頼の確認が出ないこと）。
- 複数行の項目は、宣言の確認（コアのテスト）、設定の画面の入力欄と「既定の文章を入力欄に入れる」（コンポーネントのテスト）、同梱の LLM のプラグインのプロンプトを画面で書き換えて保存する操作（`npm run check:browser`）で確かめています。
- 同梱のプラグインが関数の形で設定を読むことは、コアのテスト（`packages/core/src/project.test.ts`）と、同梱の LLM のプラグインを通したテスト（`packages/server/src/llm.test.ts`）で確かめています。
- TypeScript で書いた入口（`.ts`）での `PluginSetupContext` の型付けは、型の定義があるだけで、実際のプラグインを動かしては確かめていません。
