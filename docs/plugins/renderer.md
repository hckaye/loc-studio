# 独自描画を書く

独自描画は、セルの見せ方を、プラグインが持つブラウザ用の ES モジュールで差し替えます。モジュールはアプリのビルドに含めず、画面が実行時に読み込むので、置くだけで使えます。

コードを書かずに済む見せ方（リンク、進み具合の棒、色見本、札）は、列の `display` で選べます（[CONFIG.md の同梱の見せ方](../CONFIG.md#同梱の見せ方display)）。それで足りないときに独自描画を使います。

置き場所と読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

## ほかの種類との違い

- モジュールはブラウザで動きます。Node の機能（`node:fs` など）は使えません。
- モジュールは JavaScript（`.js` / `.mjs`）で書きます。TypeScript は読み込めません。
- 配られるのは、モジュールのファイル 1 つだけです。モジュールの中で、ほかのファイルを import しません。
- プラグインは、フォルダ形式にします。理由は[フォルダ形式にする理由](#フォルダ形式にする理由)にあります。

## 登録する項目（CellRenderer）

プラグインの `renderers` に、次の形のオブジェクトを並べます。

| 項目 | 必須 | 意味 |
| --- | --- | --- |
| `id` | 必須 | 登録 ID。列の `renderer` に書く |
| `module` | 必須 | ブラウザ用のモジュールのファイル。プラグインのフォルダからの相対パス（単一ファイルのプラグインでは、そのファイルのあるフォルダからの相対パス） |

`module` の誤りは、次のように扱われます。

| `module` の値 | 結果 |
| --- | --- |
| 絶対パス、URL、プラグインのフォルダの外を指すパス | 読み込みエラー。そのプラグインは登録されない |
| 拡張子が `.js` / `.mjs` でないファイル、読めないファイル | プラグインは登録されるが、その独自描画は配られず、警告が出る |

## 効く列

列は、`renderer` に独自描画の `id` を書いて選びます。列の定義（`ColumnDef.renderer`）にも、設定の `columns` の要素にも書けます。`renderer` は `display` より優先します。

独自描画が効くのは、`meta` 列（`type` が `string` / `number` / `{ enum }`）、計算列、生成列です。本文、キー、レビュー列、チェックボックス（`type: "boolean"`）、アクション列には効きません。

## モジュールの形（CellRendererModule）

モジュールは、既定のエクスポートに、`render` を持つオブジェクトを書きます。

```js
export default {
  render(element, ctx) {
    // element に中身を描く
    return () => { /* 後片付け（任意） */ };
  },
};
```

- `render(element, ctx)` は、セルの要素 `element` に中身を描きます。値が変わるたびに呼ばれます。
- 後片付けが要るなら、関数を返します。返した関数は、次の描画の前と、セルが消えるときに呼ばれます。
- 表は行を仮想化していて、スクロールするとセルの要素が作り直されます。イベントの登録などは、後片付けで外します。外さないと、スクロールのたびに登録が増えます。

`ctx`（`CellRenderContext`）が持つものは次のとおりです。

| 項目 | 内容 |
| --- | --- |
| `value` | セルの値 |
| `error` | 計算列などのエラーの説明（あれば） |
| `column` | `{ id, label?, type?, options? }`。`options` は列の `options` |
| `language` | `{ id, label }`。言語ごとの列のときだけ |
| `entryKey`、`resourceId` | 行のキーとリソースの ID |
| `theme` | `"light"` か `"dark"` |
| `readOnly` | 値を変えられないとき `true` |
| `setValue(value)` | 値を保存する関数。計算列、生成列、権限のない列、読み取り専用の列では `undefined` |

モジュールの読み込みや `render` が失敗すると、そのセルだけが既定の見せ方に戻り、失敗の印（`!`）が付きます。表とほかのセルはそのままです。

## 例

優先度（0〜5）を星で見せて、星をクリックすると値を変えられる列です。値は共有 DB（`builtin.db`）に置き、見せ方だけを差し替えます。

```
loc-studio-plugins/
  stars/
    index.ts
    web/
      stars.mjs
```

`loc-studio-plugins/stars/index.ts`:

```ts
import { definePlugin } from "@loc-studio/sdk";

// 優先度（0〜5）を星で見せて、クリックで変えられる列。
// 値は共有 DB に置き（builtin.db）、見せ方だけをブラウザ用のモジュール（web/stars.mjs）で差し替える。
export default definePlugin({
  name: "mystudio-stars",
  version: "1.0.0",
  renderers: [{ id: "mystudio.stars", module: "web/stars.mjs" }],
  columns: [
    {
      id: "mystudio.priority",
      kind: "meta",
      scope: "entry",
      label: "優先度",
      type: "number",
      source: "builtin.db",
      renderer: "mystudio.stars",
      options: { max: 5 },
    },
  ],
});
```

`loc-studio-plugins/stars/web/stars.mjs`:

```js
// ブラウザで動くモジュール。Node の機能は使えない。import もしない（このファイルだけが配られる）。
export default {
  render(el, ctx) {
    const max = Number(ctx.column.options?.max ?? 5);
    const value = Math.max(0, Math.min(max, Number(ctx.value) || 0));
    const stars = [];
    for (let i = 1; i <= max; i++) {
      const star = document.createElement("span");
      star.textContent = i <= value ? "★" : "☆";
      star.style.color = ctx.theme === "dark" ? "#f5c451" : "#8a5300";
      if (ctx.setValue) {
        star.style.cursor = "pointer";
        star.title = `${i} にする`;
        star.dataset.value = String(i);
      }
      stars.push(star);
    }
    el.replaceChildren(...stars);
    if (!ctx.setValue) return;
    // 同じ星をもう一度押すと 0 に戻す。
    const onClick = (e) => {
      const v = Number(e.target?.dataset?.value);
      if (!v) return;
      e.stopPropagation();
      void ctx.setValue(v === value ? 0 : v);
    };
    el.addEventListener("click", onClick);
    // 次の描画の前と、セルが消えるときに呼ばれる。
    return () => el.removeEventListener("click", onClick);
  },
};
```

設定（`columns` に足す）:

```json
{ "use": "mystudio.priority", "id": "priority" }
```

## 確かめ方

CLI では、登録されたことを `plugins` で確かめます。表示は画面で確かめます。

```sh
node apps/cli/dist/index.js plugins --project <プロジェクト>
```

```
  renderer:
    mystudio.stars  <- mystudio-stars [project]
```

画面のローカルモードでは、プラグインを信頼したあとに、独自描画が読み込まれます。モジュールを書き換えたら、もう一度信頼して、「プラグイン」のダイアログの「プラグインを再読み込み」を押します。

確かめた結果は次のとおりです。

- サンプルプロジェクトのコピーに上の `stars` フォルダを置き、設定に列を足して、画面の本番ビルドのサーバー（ローカルモード）を起動しました。信頼する前の `info().renderers` は空で、`trustPlugins` のあとに `mystudio.stars` とハッシュが出ました。
- `GET /api/renderer/mystudio.stars?project=…&h=…` は、200、`text/javascript; charset=utf-8`、`Cache-Control: private, max-age=31536000, immutable` でした。
- 返ったモジュールを jsdom で import して `render` を呼ぶと、値のないセルは `☆☆☆☆☆` になり、3 つ目の星のクリックで `setValue(3)` が呼ばれました。`readOnly: true`（`setValue` なし）では `★★★☆☆` と描かれ、クリックできませんでした。
- サービス層の `setCell` で `priority` に `3` を保存し、`rows` を読み直すと、値は `3` でした。
- 本番ビルドを headless の Chrome で開き、`priority` が 2 の行に `★★☆☆☆`、値のない行に `☆☆☆☆☆` が表示されることを確かめました。ブラウザでのクリックは確かめていません。

## フォルダ形式にする理由

モジュールをフォルダ形式のプラグインの中に置くのには、2 つの理由があります。

- プラグインフォルダの直下に置いた `.js` / `.mjs` は、それ自体がプラグインとして読み込まれます。
- 画面のローカルモードの信頼のハッシュは、フォルダ形式ならフォルダの中の全ファイルから作るので、モジュールを書き換えると確認し直しになります。単一ファイルのプラグインでは、ハッシュに入るのは、プラグインのファイルと、そこから相対 import でたどれるファイルだけです。独自描画のモジュールはプラグインのファイルが import しないので、書き換えても確認が出ません。

## モジュールが配られる仕組み

画面は、信頼された（Web モードでは読み込んだ）プラグインの独自描画の一覧を、`info().renderers`（`id`、`pluginName`、モジュールの SHA-256 の `hash`）で受け取り、`GET /api/renderer/<id>?project=…&h=<hash>` を `import()` します。

- サーバーは、登録されたモジュールのファイルだけを返します。シンボリックリンクでプラグインのフォルダの外を指すものは返しません。
- `h` がいまのハッシュと同じなら、ブラウザに長くキャッシュさせます。モジュールを書き換えるとハッシュが変わるので、画面がプロジェクトの情報を読み直したとき（開き直したとき、プラグインを再読み込みしたとき）に、新しいモジュールを読み込みます。

## ブラウザの制限（CSP）

モジュールは画面と同じページで動くので、画面の CSP（[WEB-MODE.md の 10.1](../WEB-MODE.md#101-http-の口appswebappapi)）の制限を受けます。headless の Chrome で、別のオリジン（ポートの違う `127.0.0.1`）のサーバーに向けて試すモジュールを動かしたところ、次のようになりました。

| モジュールがしたこと | 結果 |
| --- | --- |
| 別のオリジンへの `fetch`、`WebSocket` | CSP の `connect-src 'self'` で断られた |
| 同じオリジンへの `fetch`（`/api/session`） | 通った |
| 別のオリジンの画像（`<img>`） | CSP の `img-src` で断られた |
| `data:` の画像 | 表示された |
| `eval`、`new Function` | 断られた |
| 要素の `style` の変更、`<style>` 要素の追加 | 効いた |
| 別のオリジンのモジュールの `import()`、`<script src>` の追加 | 読み込まれて実行された |
| 中身を書いた `<script>` 要素の追加 | 実行された |

最後の 2 行は、CSP の `'strict-dynamic'` が、信頼されたスクリプト（画面と、画面が読み込んだ独自描画のモジュール）が足したスクリプトを許すためです。CSP は、独自描画のモジュールが別のスクリプトを読み込むことを止めません。独自描画のモジュールは、信頼したプラグインのコードとして扱ってください。フォントは、CSP で同じオリジンと `data:` だけが許されています（試していません）。

リンクを出すときは、`ctx.value` などをそのまま `href` に入れないでください。画面自身は、プラグインから来たリンク（`display: "link"`、レビューのリンク、アクションの結果）を、`http` と `https` の URL のときだけクリックできるようにしています。
