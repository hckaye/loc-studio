# フォーマットを書く

フォーマットは、リソースのバイト列とエントリ（キーと言語ごとの本文）を相互に変換します。同梱の `builtin.csv` と `builtin.tsv` で読めないファイル形式を扱うときに書きます。

置き場所と読み込みの確かめ方は [PLUGINS.md の「作る手順」](../PLUGINS.md#作る手順)にあります。

## 実装する項目（Format）

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `id` | 必須 | `string` | 登録 ID。設定の `formats[].use` に書く |
| `match` | 必須 | `(resource, head) => boolean` | このフォーマットが扱うリソースかを返す。`head` はリソースの先頭のバイト列（4096 バイトまで）。拡張子や先頭のバイトで判定する |
| `parse` | 必須 | `(input, ctx) => ParsedDocument` | バイト列をエントリの配列にする。エンコーディングの判定もここで行う |
| `apply` | 必須 | `(original, changes, ctx) => Uint8Array` | 変更点を元のバイト列に当てて、新しいバイト列を返す |
| `create` | 任意 | `(entries, ctx) => Uint8Array` | 新しいリソースのバイト列を作る。型にはあるが、いまのアプリはこの関数を呼ばない |
| `syntax` | 任意 | `string` | このフォーマットの本文に使う記法の `id`。省略するとプロジェクトの既定の記法 |

`parse` と `apply` の `ctx`（`FormatContext`）は次のとおりです。フォーマットには `ctx.host` が渡されません。

| 項目 | 型 | 内容 |
| --- | --- | --- |
| `resource` | `ResourceRef` | 対象のリソース（`id`、`path`、`name`） |
| `languages` | `LanguageDef[]` | プロジェクトの言語の定義 |
| `options` | `Record<string, unknown>` | 設定の `formats[].options` に書いた値 |

## parse が返す値

`parse` は `{ entries, diagnostics? }` を返します。`entries` の要素（`EntryData`）は次のとおりです。

| 項目 | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `key` | 必須 | `string` | 行のキー。リソースの中で一意にする |
| `text` | 必須 | `{ [言語 ID]: string }` | 言語ごとの本文。ない言語は書かない |
| `stableId` | 任意 | `string` | キーが変わっても同じ行だと分かる ID |
| `meta` | 任意 | `{ [列 ID]: unknown }` | ファイルの中にある、行に 1 つの列の値（`source: "file"` の列やバリデータが読む） |
| `languageMeta` | 任意 | `{ [言語 ID]: { [列 ID]: unknown } }` | ファイルの中にある、言語ごとの列の値 |
| `location` | 任意 | `{ line: number }` | ファイルの中の行番号（1 始まり） |

壊れた行などのファイルの形式の警告は、`diagnostics`（`{ severity, message, line? }` の配列）で返します。画面の「警告とエラー」に出ます。

## apply が受け取る変更

`apply` の `changes` は、次の 4 種類の配列です。

| `type` | 形 | 意味 |
| --- | --- | --- |
| `set` | `{ type: "set", key, field, value }` | 値の変更。`field` は `{ kind: "text", language }`（本文）か `{ kind: "meta", column, language? }`（ファイルの中の列） |
| `add` | `{ type: "add", after?, entry }` | 行の追加。`after` はその後ろに足す行のキー |
| `remove` | `{ type: "remove", key }` | 行の削除 |
| `rename` | `{ type: "rename", key, newKey }` | キーの変更 |

`apply` は、変更した部分だけを元のバイト列に当てます。触っていない部分のバイトは変えません（コメント、空行、改行コード、引用符の付け方を保つためです）。

いまのアプリ（画面と CLI）が `apply` に渡すのは `set` だけです。本文の保存で `field.kind` が `"text"` の `set` が、ファイルの中の列（`source: "file"`）の変更で `field.kind` が `"meta"` の `set` が渡されます。`add`、`remove`、`rename` は型にありますが、これらを作る機能はまだありません。対応していない種類の変更を受け取ったら、黙って無視せず、原因の分かるメッセージで例外を投げます。

## 例

`KEY=本文` の行を 1 エントリにする、1 言語だけの形式です。本文の変更（`set`）だけに対応しています。

`loc-studio-plugins/keyvalue-format.ts`:

```ts
import { definePlugin } from "@loc-studio/sdk";
import type { EntryData, Format } from "@loc-studio/sdk";

// "KEY=本文" を 1 行 1 エントリにする、1 言語だけのフォーマット。
// 言語は options.language で指定する（省略時は設定の最初の言語）。
const dec = new TextDecoder("utf-8", { fatal: true });
const enc = new TextEncoder();

const keyValue: Format = {
  id: "mystudio.keyValue",
  match: (resource) => resource.path.endsWith(".kv"),
  parse(input, { languages, options }) {
    const lang = String(options.language ?? languages[0]?.id);
    const entries: EntryData[] = [];
    dec.decode(input).split(/\r?\n/).forEach((line, i) => {
      const eq = line.indexOf("=");
      if (line.trim() === "" || line.startsWith("#") || eq < 0) return;
      entries.push({ key: line.slice(0, eq), text: { [lang]: line.slice(eq + 1) }, location: { line: i + 1 } });
    });
    return { entries };
  },
  // 変更した行の「=」より後ろだけを書き換える。ほかの行は 1 バイトも変えない。
  apply(original, changes) {
    const lines = dec.decode(original).split("\n");
    for (const c of changes) {
      if (c.type !== "set" || c.field.kind !== "text") throw new Error(`mystudio.keyValue は本文の変更だけに対応しています（${c.type}）`);
      const i = lines.findIndex((l) => l.startsWith(`${c.key}=`));
      if (i < 0) throw new Error(`キー ${c.key} の行がありません`);
      const cr = lines[i]!.endsWith("\r") ? "\r" : "";
      lines[i] = `${c.key}=${String(c.value)}${cr}`;
    }
    return enc.encode(lines.join("\n"));
  },
};

export default definePlugin({ name: "mystudio-keyvalue", formats: [keyValue] });
```

## 設定

`loc-studio.project.json` の `formats` に足します。新しい拡張子のファイルをツリーに出すには、ツリーの `include` にも足します。

```json
"tree": { "use": "builtin.globTree", "options": { "include": ["Assets/Text/**/*.csv", "Assets/Notes/**/*.kv"] } },
"formats": [
  { "use": "builtin.csv", "match": "**/*.csv", "options": { "key": "ID", "text": { "ja": "JP", "JaEnglish": "EN", "zh-Hans": "CN", "ko": "KR" } } },
  { "use": "mystudio.keyValue", "match": "**/*.kv", "options": { "language": "ja" } }
]
```

リソースに使うフォーマットは、次の順で決まります。

1. 設定の `formats` を前から順に見て、最初に当てはまったものを使います。`match`（glob）を書いた要素は、リソースのパスが glob に一致するかで判定します。`match` を書いていない要素は、フォーマットの `match()` で判定します。
2. どれにも当てはまらないリソースは読めません（「扱えるフォーマットがありません」）。
3. 設定に `formats` を書いていないプロジェクトでは、登録されたすべてのフォーマットの `match()` で判定します。後から読み込まれた層のフォーマットを先に試します。

## 確かめ方

サンプルプロジェクトのコピーに、`Assets/Notes/notes.kv` を作ります（3 行目の末尾に空白が 1 つあります）。

```
# メモ
NOTE_A=最初のメモ
NOTE_B=末尾に空白 
```

`tree` で、リソースが読めていることを確かめます。

```sh
node apps/cli/dist/index.js tree --project <プロジェクト>
```

```
SampleGame/
  Assets/
    Notes/
      notes.kv  2 件  [mystudio.keyValue]
    Text/
      ...
```

`validate --resources "**/*.kv"` を実行すると、同梱の `builtin.whitespace` が、末尾に空白のある行を指摘します。

```
  info    NOTE_B  ja  builtin.whitespace  trailing-space  末尾に空白があります。
```

書き戻し（`apply`）は、本文を変えるアクションを実行してから `save` して確かめます。[action.md](action.md) の `mystudio.trim` を置いて、次の順に実行します。

```sh
node apps/cli/dist/index.js run mystudio.trim --project <プロジェクト> --resources "**/*.kv" --column text --languages ja
node apps/cli/dist/index.js save --project <プロジェクト>
```

保存のあと、`NOTE_B` の行の末尾の空白だけが消え、`# メモ` のコメント行とほかの行は変わりませんでした（`cat -A` でバイト列を確認）。

## 参考になる実装

- `packages/builtin/src/csv.ts`: 同梱の CSV / TSV。`set` / `add` / `remove` / `rename` のすべてと、見出しにない列の追加（`addColumns`）に対応する
- `examples/remote-project/loc-studio-plugins/remote-json.ts`: API の JSON 文書を扱うフォーマット。リソースの ID に拡張子がないので、`match(resource, head)` で先頭のバイトを調べる
