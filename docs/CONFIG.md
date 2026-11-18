# 設定リファレンス

設定は 2 種類あります。プロジェクト設定はチームで共有する設定で、プロジェクトのフォルダの `loc-studio.project.json`（と、コードで書く `loc-studio.config.ts`）に書きます。ローカル設定はその PC だけの設定で、`settings.json` に書きます（ユーザー名、テーマなど）。Web モードでは、ローカル設定の代わりに利用者ごとの設定をサーバーに置きます（[WEB-MODE.md](WEB-MODE.md)）。Web モードのサーバーの設定ファイル `server.json` も WEB-MODE.md で説明します。

この文書は、型（`packages/sdk/src/types.ts` の `ProjectConfig`）とコードを読んで書いています。例のうち実行して確かめたものには、そう書いています。

## 目次

- [プロジェクト設定のファイル](#プロジェクト設定のファイル)
- [ProjectConfig のキー](#projectconfig-のキー)
- [すべてのキーを書いた例](#すべてのキーを書いた例)
- [use と options](#use-と-options)
- [name](#name)
- [languages](#languages)
- [pluginDirs](#plugindirs)
- [tree](#tree)
- [formats と syntaxes](#formats-と-syntaxes)
- [columns](#columns)
- [sources](#sources)
- [validators](#validators)
- [generators](#generators)
- [actions と review.targets](#actions-と-reviewtargets)
- [hooks](#hooks)
- [roles](#roles)
- [editor](#editor)
- [validation](#validation)
- [storage](#storage)
- [languageSets と grid](#languagesets-と-grid)
- [localSettings](#localsettings)
- [ローカル設定](#ローカル設定)
- [環境変数](#環境変数)

## プロジェクト設定のファイル

| ファイル | 役割 |
| --- | --- |
| `loc-studio.project.json` | JSON。画面の設定ダイアログが書き換えるのはこちら（一部のキーだけ） |
| `loc-studio.config.ts`（なければ `.mts`、`.js`、`.mjs` の順） | コードで書く設定。TypeScript はそのまま読み込まれる |

どちらか一方があれば足ります。どちらもなければプロジェクトを開けず、エラーに探したファイル名が出ます。

両方ある場合は、コードの設定に値がある最上位のキーが、JSON の同じキーを丸ごと置き換えます（キーの中身は混ぜません）。値が `undefined` のキーは無視します。コードの設定から来たキーは、画面の設定ダイアログでは読み取り専用になり、`updateProjectSettings` で変えようとすると `locked` で失敗します。

コードの設定は、既定のエクスポートに、設定のオブジェクトか、それを返す関数（`async` でもよい）を書きます。

```ts
// loc-studio.config.ts
import { defineConfig } from "@loc-studio/sdk";

export default defineConfig({
  name: "FromCode",
  validators: ["builtin.untranslated"],
});
```

上のファイルを JSON の設定があるプロジェクトに置くと、`name` と `validators` がコードの値になり、ほかのキーは JSON のままになることを、CLI（`tree` と `validate`）で確かめました。関数を返す形（`export default async () => ({ name: "..." })`）も読み込まれました。`@loc-studio/sdk` は、プラグインと同じ仕組みで解決されます（[plugins/loading.md](plugins/loading.md#sdk-の-import)）。

コードの設定はプロジェクトのフォルダにあるコードなので、プラグインと同じく信頼の確認の対象です。画面のローカルモードでは、利用者が信頼するまで読み込まず、`loc-studio.project.json` だけで開きます。JSON だけでは設定として足りない（JSON がない、`languages` がないなど）場合、プロジェクトは制限された状態で開き、信頼するまで編集などはできません。コードの設定が import できるのは、プロジェクトのフォルダの中のファイル（相対 import）と、Node の組み込み、`@loc-studio/sdk`、プロジェクトの `node_modules` にあるパッケージだけです。import の書き方にも条件があります（[plugins/trust.md](plugins/trust.md#信頼の確認を通る書き方)）。コマンドラインと Web モードは、確認なしで読み込みます。

設定の形を確かめ、通らなければプロジェクトを開けません。確かめるのは、`languages` が空でない配列で、各要素がオブジェクトであること、言語の `id` が空でない文字列で重複しないこと、`label` が文字列であること、`basedOn` が文字列で、存在する言語を指し、循環しないこと、`pluginDirs` が文字列の配列であること、`formats` / `syntaxes` / `columns` / `actions` / `validators` が配列であることです。それ以外の誤り（登録されていない実装の指定など）は警告になり、プロジェクトは開きます。警告は、画面ではステータスバーの「警告とエラー」に、CLI では `plugins` の「警告」に出ます。ただし、`actions`、`review.targets`、生成列の生成器、`localSettings.enforce` についての警告は、画面にだけ出て、CLI の `plugins` には出ません。

### JSON の書き方の決まり

`loc-studio.project.json` は、次の決まりで読みます。

- 最上位は、JSON のオブジェクトです。キーの順は自由です。
- 厳密な JSON です。コメントと、末尾のカンマは書けません。先頭に BOM のあるファイルも読めません。どれも、「設定ファイル … を読めませんでした: …」のエラーで、プロジェクトを開けません。
- この文書にない最上位のキーは、無視します（警告も出ません）。キーの名前を書き間違えると、そのキーを省略したときの動きになります。
- `${env:NAME}` を環境変数に置き換えるのは、`storage.path` と `storage.url` だけです（[storage](#storage)）。ほかの場所に書いても、置き換えません。

BOM のあるファイル、コメントのあるファイル、知らないキーのあるファイルを、CLI の `tree` とサービス層で開いて確かめました（前の 2 つは開けず、知らないキーは警告なしで開けました）。

### 設定ファイルの確認（画面のローカルモード）

`loc-studio.project.json` も、画面のローカルモードでは信頼の確認の対象です。設定ファイルは、データの保存先、読み込むプラグインのフォルダ、生成器などの接続先、使う環境変数を決めます。確認なしで使うと、フォルダを開いただけで、設定に書かれた接続先へ環境変数の値を送らせたり、他人の用意した接続先を生成器に使わせたりできてしまうためです。

確認するのは基盤の項目です。`storage`、`pluginDirs`、`tree`、`formats`、`syntaxes`、`sources`、`generators`、`actions`、`hooks`、`review` の 10 のキーの中身（キーの順をそろえた形）と、ファイル全体で参照している `${env:NAME}` の名前の一覧を合わせて、ハッシュにします。信頼は、このハッシュごとに、この PC のローカル設定 `plugins.trust` に記録します。

- 基盤の項目か `${env:NAME}` の参照が 1 つでもあれば、そのプロジェクトを最初に開いたときに 1 回確認します。`tree` や `formats` を書いたプロジェクトは、どれも確認の対象です。どちらもなければ、確認しません。
- 信頼するまで、プロジェクトは制限された状態で開きます。環境変数は展開せず、共有 DB を開かず、ネットワークに接続せず、ツリーや生成器などの実装も作りません。信頼済みのコードの設定があっても、読み込みません。
- `name`、`languages`、`columns`、`validators`、`validation`、`languageSets`、`grid`、`localSettings` を変えても、ハッシュは変わりません。ほかの人が言語や列を変えても、確認は出ません。
- 画面の「新しいプロジェクトを作る」とコマンドラインの `init` で作った設定ファイルは、作ったときの内容を確認済みとして記録します（基盤の項目が入るのは、すでにある CSV / TSV の列を対応させたときの `formats` だけです）。その場で利用者が選んだ内容なので、開いた直後にもう一度確認を出しません。あとで基盤の項目を書き換えると、確認が出ます。
- 画面の設定のダイアログから設定ファイルを保存したとき（名前、言語、列、検証、CSV / TSV の列の対応、保存先、プラグインフォルダ）は、保存した内容を自動で信頼します。ただし、保存する前のファイルの内容が信頼済みだったときだけです。アプリの外で基盤の項目が変わっていた場合は、保存はしますが自動では信頼せず、プロジェクトは制限された状態に切り替わります。
- git の更新やエディタでの編集など、アプリの外で基盤の項目が変わると、次に開くか読み直したときに、もう一度確認します。
- コマンドラインと Web モードは、確認なしで使います。

確認のダイアログには、基盤の項目がすべて、options の値まで 1 行ずつ出ます。1 つの項目の options の値が 40 個を超えると、残りは個数だけが出ます（URL、パス、環境変数を含む値は省きません）。500 文字を超える値は、途中で切って残りの文字数を出します。URL として読める値には実際の接続先（ホストとポート）が添えられます。表示の詳しい決まりは [GETTING-STARTED.md の「設定とプラグインの信頼」](GETTING-STARTED.md#設定とプラグインの信頼)にあります。

この動きは、サンプルプロジェクトのコピーをサービス層に `pluginTrust: "prompt"` で開いて確かめました（最初は制限された状態で、設定ファイルを信頼するとプラグインの確認に進むこと、`name` の変更では確認が出ず `tree` の変更では出ること、設定のダイアログ相当の `updateProjectSettings` での保存は自動で信頼され、外で変わっていた場合は制限された状態に切り替わってドラフトが残ること、基盤の項目も `${env:}` もない設定ファイルでは確認が出ないこと）。

## ProjectConfig のキー

| キー | 型 | 意味 |
| --- | --- | --- |
| `name` | `string` | プロジェクト名。省略するとフォルダ名 |
| `languages` | `LanguageDef[]` | 言語の定義。必須 |
| `pluginDirs` | `string[]` | プラグインを探すフォルダ（プロジェクトからの相対）。既定 `["loc-studio-plugins"]`。Web モードでは、プロジェクトかアプリのフォルダの中にあるものだけを使う |
| `tree` | `UseRef` | リソースの一覧と読み書き（`TreeProvider`）。既定 `builtin.globTree` |
| `formats` | `FormatUse[]` | ファイル形式の割り当て。省略すると、登録されたすべてのフォーマットの `match` で判定 |
| `syntaxes` | `string[]` | 本文の記法（前から順に適用）。省略すると、登録されたすべての記法 |
| `sources` | `Record<string, UseRef>` | 列ソースに名前と options を付ける |
| `columns` | `(ColumnDef \| ColumnUse)[]` | 列の並び。省略すると「キー」「本文」の 2 列 |
| `generators` | `Record<string, UseRef>` | 生成器に名前と options を付ける |
| `actions` | `UseRef[]` | 使うアクション |
| `hooks` | `UseRef[]` | 書き込みの前後に呼ぶフック（書いた順に呼ぶ） |
| `roles` | `Record<string, RoleDef>` | 役割の定義（Web モード）。同梱の役割に足すか、同じ ID で置き換える |
| `editor` | `EditorConfig` | 本文の編集画面の設定（参照する言語と列、長さの数え方） |
| `validators` | `(string \| ValidatorUse)[]` | 使うバリデータ |
| `validation` | `{ blockComplete?: Severity \| false, recheck?: boolean }` | 検証と「要確認」の印に関する設定 |
| `review` | `{ targets?: UseRef[] }` | レビューの転載先 |
| `storage` | `StorageConfig` | 共有 DB の設定 |
| `localSettings` | `{ defaults?, enforce? }` | ローカル設定の初期値と固定 |
| `languageSets` | `Record<string, LanguageId[]>` | 言語の表示セット |
| `grid` | `{ pinCommon?, maxPinnedRatio?, progressColumn?, progressUnit? }` | 表とツリーの進捗の設定 |

必須のキーは `languages` だけです。ほかのキーを省略したときの動きと、誰がどこで変えられるかは、次のとおりです。

| キー | 省略したとき | 基盤の項目 | Web モードで変えられる人 | 設定の画面の欄 |
| --- | --- | --- | --- | --- |
| `name` | プロジェクトのフォルダ名 | | `manage` の役割 | プロジェクト名 |
| `languages` | 省略できない | | `manage` の役割 | 言語 |
| `pluginDirs` | `["loc-studio-plugins"]` | ○ | サーバーの管理者 | プラグインフォルダ |
| `tree` | `builtin.globTree`（フォルダの `.csv` と `.tsv`） | ○ | サーバーの管理者 | なし |
| `formats` | 登録されたすべてのフォーマットを、それぞれの `match()` で判定 | ○ | サーバーの管理者 | CSV / TSV の列の対応 |
| `syntaxes` | 登録されたすべての記法 | ○ | サーバーの管理者 | なし |
| `sources` | 名前を付けた列ソースなし（列の `source` には、列ソースの ID を書ける） | ○ | サーバーの管理者 | なし |
| `columns` | 「キー」と「本文」の 2 列 | | `manage` の役割 | 列 |
| `generators` | 名前を付けた生成器なし | ○ | サーバーの管理者 | なし |
| `actions` | 使えるアクションなし | ○ | サーバーの管理者 | なし |
| `hooks` | 呼ぶフックなし | ○ | サーバーの管理者 | なし |
| `roles` | 同梱の 4 つの役割 | | サーバーの管理者 | なし |
| `editor` | 参照欄は、基になる言語の本文と、その言語の生成列。長さはコードポイントの数 | | `manage` の役割 | なし |
| `validators` | 検証なし | | `manage` の役割 | 検証 |
| `validation` | `blockComplete` は無効、`recheck` は有効 | | `manage` の役割 | なし |
| `review` | 転載先なし | ○ | サーバーの管理者 | なし |
| `storage` | SQLite の `.loc-studio/meta.db` | ○ | サーバーの管理者 | 共有 DB の場所（`path` と、共有の方式だけ。`driver`、`url`、`schema` は設定ファイルで書く） |
| `localSettings` | 初期値も固定もなし | | `manage` の役割 | なし |
| `languageSets` | 表示セットなし | | `manage` の役割 | なし |
| `grid` | 共通のグループを固定、固定の上限 0.6、進捗は最初のレビュー列（なければ最初の選択式の列）を行数で数える | | `manage` の役割 | なし |

- 「基盤の項目」に ○ のあるキーは、画面のローカルモードで、信頼の確認の対象です（[設定ファイルの確認](#設定ファイルの確認画面のローカルモード)）。
- 「設定の画面の欄」が「なし」のキーは、設定ファイルを編集して変えます。列と検証の、欄のない項目（選択肢、`options` など）は、設定の画面の「詳細」で JSON のまま書けます（[GETTING-STARTED.md の「作ったあとで変える」](GETTING-STARTED.md#作ったあとで変える)）。
- コードの設定（`loc-studio.config.ts`）にあるキーは、画面からは変えられません。

## すべてのキーを書いた例

次は、`ProjectConfig` の 20 のキーをすべて書いた設定ファイルです。それぞれのキーの意味は、あとの節にあります。実際のプロジェクトでは、要るキーだけを書きます。

```json
{
  "name": "MyGame",
  "languages": [
    { "id": "ja", "label": "日本語", "pinned": true },
    { "id": "en", "label": "英語", "basedOn": "ja", "group": "欧米", "hint": { "lang": "en" } },
    { "id": "ko", "label": "韓国語", "basedOn": "ja", "group": "アジア", "pinned": ["text"] },
    { "id": "legacy", "label": "旧訳（参照用）", "basedOn": "ja", "editable": false }
  ],
  "languageSets": { "出荷": ["ja", "en", "ko"] },

  "pluginDirs": ["loc-studio-plugins"],
  "storage": { "driver": "sqlite", "path": ".loc-studio/meta.db" },
  "tree": { "use": "builtin.globTree", "options": { "include": ["Text/**/*.csv"] } },
  "formats": [
    {
      "use": "builtin.csv",
      "match": "**/*.csv",
      "options": {
        "key": "ID",
        "text": { "ja": "JP", "en": "EN", "ko": "KR", "legacy": "OLD" },
        "columns": { "maxLength": "MaxLen", "note": "Note" }
      }
    }
  ],
  "syntaxes": ["builtin.braces", "builtin.tags"],
  "sources": {
    "teamStatus": { "use": "builtin.db", "options": { "namespace": "mygame.status" } }
  },
  "generators": {
    "mt": { "use": "llm.translate", "options": { "endpoint": "https://llm.example.internal/v1", "model": "my-model" } }
  },
  "actions": ["mystudio.trim"],
  "hooks": ["mystudio.resetOnSave"],
  "review": {
    "targets": [{ "use": "mystudio.openTicket", "options": { "baseUrl": "https://tracker.example.com" } }]
  },

  "columns": [
    { "use": "builtin.key", "id": "key" },
    { "id": "note", "kind": "meta", "scope": "entry", "label": "備考", "type": "string", "source": "file" },
    { "id": "due", "kind": "meta", "scope": "entry", "label": "期限", "type": "date", "source": "builtin.db" },
    { "use": "builtin.text", "id": "text" },
    { "use": "builtin.length", "id": "length", "languages": ["en", "ko"] },
    {
      "use": "builtin.textStatus",
      "id": "textStatus",
      "source": "teamStatus",
      "type": {
        "enum": [
          { "value": "todo", "label": "未着手", "color": "gray" },
          { "value": "wip", "label": "作業中", "color": "amber" },
          { "value": "done", "label": "確定", "color": "ink", "complete": true, "from": ["wip"], "roles": ["reviewer", "manager"] }
        ],
        "default": "todo"
      }
    },
    { "use": "builtin.reviewStatus", "id": "reviewStatus", "of": "text" },
    { "use": "llm.translation", "id": "mt", "generator": "mt", "languages": ["en", "ko"] },
    { "id": "tools", "kind": "actions", "scope": "language", "label": "操作", "actions": ["mystudio.trim"] }
  ],
  "validators": [
    "builtin.placeholders",
    "builtin.tagBalance",
    "builtin.maxLength",
    { "use": "builtin.whitespace", "severity": "info" },
    { "use": "builtin.untranslated", "languages": ["en", "ko"] }
  ],
  "validation": { "blockComplete": "error", "recheck": true },

  "roles": {
    "lqa": { "label": "LQA", "can": ["edit", "review"], "editColumns": ["textStatus"], "reviewColumns": ["reviewStatus"] }
  },

  "editor": {
    "referenceLanguages": ["en"],
    "referenceColumns": ["note", "mt"],
    "count": { "unit": "codepoints", "skipTokens": true }
  },
  "grid": { "pinCommon": true, "maxPinnedRatio": 0.6, "progressColumn": "reviewStatus", "progressUnit": "rows" },
  "localSettings": {
    "defaults": { "ui.theme": "light", "review.forwardOnPost": "ask" },
    "enforce": { "plugins.local.formats": "deny" }
  }
}
```

この設定が前提にしているものは、次の 3 つです。

- 見出しが `ID,JP,EN,KR,OLD,MaxLen,Note` の CSV（`Text/` の下）。
- プラグインフォルダ（`loc-studio-plugins/`）に置いた、アクション `mystudio.trim` と `mystudio.openTicket`（[plugins/action.md](plugins/action.md#例) の例）、フック `mystudio.resetOnSave`（[plugins/hook.md](plugins/hook.md#例) の例）。`actions`、`hooks`、`review.targets` には同梱の実装がないので、プラグインが要ります。プラグインを置かないときは、この 3 つのキーを書きません。
- `generators` の接続先（`endpoint`）は、例の URL です。生成を実行するまで、接続はしません。

2026-11-18 に、Windows 11（Node.js 26.5.1）で、この設定ファイルと、上の CSV（3 行）、2 つの文書から取り出したプラグインを一時のフォルダに置いて、次のことを確かめました。

- CLI の `plugins` とサービス層の `info()` で、読み込みエラーと警告が 1 件もないこと。最初に書いた例では、`editor.referenceColumns` に、`columns` にない列の ID を書いていて、サービス層が「設定の editor.referenceColumns にある列 "maxLength" は、設定の columns にありません。」の警告を出しました（上の例は、直したあとのものです）。
- `tree`、`validate`、`status` が、設定どおりに動くこと（リソース 1 つ、`MaxLen` の列を使った文字数の上限、空白の指摘が `info` になること）。
- `textStatus` を「未着手」から「確定」にする `set` が、選択肢の `from` で止められること（`更新 0 / ブロック 1`）。
- `run mystudio.trim` で本文の前後の空白を除いて `save` すると、フックがその言語の `textStatus` を「作業中」にし、そこからは「確定」にできること。
- 日付の列（`due`）に `2026-12-01` を書けて、`2026-02-30` は断られること。
- `generate mt --dry-run` が、英語と韓国語の 6 件を数えること（接続はしていません）。

画面では開いていません。`roles`、`editor`、`grid`、`languageSets`、`localSettings`、`review.targets` は、警告なしで読み込まれることだけを確かめました（動きは、それぞれの節と、サービス層のテストにあります）。

## use と options

実装（ツリー、フォーマット、記法、列ソース、列、生成器、アクション、バリデータ、独自描画）は、プラグインが `id` を付けて登録します。設定は `use` で `id` を指定して選び、実装に渡す値を `options` に書きます。

```json
{ "use": "mystudio.lineWidth", "options": { "maxWidth": 18, "maxLines": 3 }, "languages": ["ja"] }
```

`UseRef` は、文字列（`"builtin.globTree"`）か `{ "use": "...", "options": { ... } }` です。文字列は `options` が空の指定と同じです。`options` は、実装の関数が呼ばれるたびに `ctx.options` として渡されます（ツリーは `TreeContext.options`、フォーマットは `FormatContext.options`、列ソースは `ColumnSourceContext.options`、バリデータは `ValidateContext.options` など）。

同じ `id` が複数の層で登録されたら、後の層が勝ちます（`builtin`、アプリ、プロジェクト、個人の順）。上書きしたことは警告に出ます。層は [plugins/loading.md](plugins/loading.md#プラグインフォルダと層) にあります。設定が選んだ `id` が登録されていなければ、警告になります（`tree`、`formats`、`syntaxes`、`validators`、`hooks`、`sources`、列の `use`、列の `source` と `renderer` について。画面では、`actions`、`review.targets`、生成列の `generator` についても出ます）。

## name

```json
"name": "MyGame"
```

プロジェクトの名前です。画面の上のバーと、ツリーのいちばん上（CLI の `tree` の 1 行目）に出ます。省略すると、プロジェクトのフォルダ名になります。名前を変えても、DB の記録や信頼の確認には影響しません。

## languages

`LanguageDef` の配列です。1 つ以上が必要です。

| キー | 型 | 意味 |
| --- | --- | --- |
| `id` | `string` | 言語の ID。任意の文字列で、標準のロケールである必要はない（例: `"JaEnglish"`、`"zh-Hans"`）。アプリは中身を解釈しない。重複は不可 |
| `label` | `string` | 表示名。必須 |
| `basedOn` | `string` | 基にする言語の ID。存在する言語で、循環しないこと。省略した言語が原文の扱い。検証（`builtin.placeholders`、`builtin.untranslated`）、編集モーダルの「参照」、「要確認」の判定が使う |
| `editable` | `boolean` | `false` で読み取り専用。既定 `true`。本文の編集（`setText`）は `blocked` になる |
| `hint` | `{ font?, dir?, lang? }` | 表示の助け。`font`（フォント名）、`dir`（`"ltr"` / `"rtl"`）、`lang`（HTML の `lang`）。編集モーダル、表、詳細パネルが使う |
| `group` | `string` | 言語の切り替えパネルでのまとめ方（折りたためるグループ） |
| `pinned` | `boolean \| string[]` | 表の固定側に置くか。`true` で最初から固定。列 ID の配列を書くと、その言語の挙げた列だけを固定し、残りの列は横にスクロールする（空の配列は固定なしと同じ） |

```json
"languages": [
  { "id": "ja", "label": "日本語", "pinned": true },
  { "id": "JaEnglish", "label": "英語（日本語から翻訳）", "basedOn": "ja", "group": "英語" },
  { "id": "ar", "label": "アラビア語", "basedOn": "ja", "hint": { "dir": "rtl", "lang": "ar" } },
  { "id": "legacy", "label": "旧訳（参照用）", "basedOn": "ja", "editable": false }
]
```

## pluginDirs

```json
"pluginDirs": ["loc-studio-plugins", "tools/loc-plugins"]
```

プロジェクトのプラグインを探すフォルダを、プロジェクトのフォルダからの相対パスで並べます。省略すると `["loc-studio-plugins"]` です。

- 書くと、既定を置き換えます。`loc-studio-plugins` も使い続けるなら、配列に入れます。`"pluginDirs": ["my-plugins"]` と書いたプロジェクトで、CLI の `plugins` の「探したプラグインフォルダ」に `my-plugins` だけが出ることを確かめました。
- フォルダがなくても、エラーにはなりません（`plugins` に「フォルダなし」と出ます）。
- ここに並べたフォルダは、どれもプロジェクトの層（`project`）です。アプリのフォルダや個人のフォルダのプラグインは、この設定とは別に読み込まれます（[plugins/loading.md](plugins/loading.md#プラグインフォルダと層)）。
- 文字列の配列でないと、プロジェクトを開けません。
- 同梱のツリー（`builtin.globTree`）の既定の除外に入っているプラグインフォルダは、プロジェクトの直下の `loc-studio-plugins` だけです。別の名前のプラグインフォルダに `.csv` や `.tsv` があるときは、`tree` の `exclude` に足します。
- 基盤の項目です。画面のローカルモードでは信頼の確認の対象で、Web モードではサーバーの管理者だけが変えられます。Web モードでは、プロジェクトかアプリのフォルダの中にあるものだけを使います。

## tree

`tree` は、リソースの一覧と読み書きをする `TreeProvider` を選びます。既定は同梱の `builtin.globTree` で、プロジェクトのフォルダ以下のファイルを走査します。同梱のツリー、フォーマット、記法、バリデータ、列ソース、列の説明は、[bundled-plugins/builtin/](bundled-plugins/builtin/guide.md) にまとめてあります。

| `builtin.globTree` の options | 型 | 既定 | 意味 |
| --- | --- | --- | --- |
| `include` | `string[]` | `["**/*.csv", "**/*.tsv"]` | 対象にするパス（glob、`/` 区切り） |
| `exclude` | `string[]` | `["**/node_modules/**", "**/.git/**", "**/.loc-studio/**", "loc-studio-plugins/**"]` | 除外するパス。指定すると既定の除外を置き換えるので、`.loc-studio` と `loc-studio-plugins` も必要なら書き直す |

```json
"tree": { "use": "builtin.globTree", "options": { "include": ["Assets/Text/**/*.csv"] } }
```

glob は picomatch で、ドットで始まる名前にも一致します。シンボリックリンクは辿らず、プロジェクトのフォルダの外のパスは扱いません。書き込みは、同じフォルダに一時ファイルを作ってから置き換えます。読み込んだあとにファイルが書き換えられていたら、書かずに版の競合として扱います（版は更新時刻とサイズ）。

外部の API からリソースを読み書きする `TreeProvider` は、プラグインで書きます（[plugins/tree.md](plugins/tree.md)）。

## formats と syntaxes

### formats

`FormatUse[]` で、どのリソースをどのフォーマットで読むかを決めます。

| キー | 型 | 意味 |
| --- | --- | --- |
| `use` | `string` | フォーマットの ID |
| `match` | `string` | 対象のリソースのパス（glob）。省略すると、そのフォーマット自身の `match()`（拡張子や先頭のバイト）で判定 |
| `options` | `object` | フォーマットに渡す値 |

並べた順に評価し、最初に一致したものを使います。どれにも一致しないリソースは読めない扱いになります（「扱えるフォーマットがありません」）。`formats` を省略すると、登録されたすべてのフォーマットを、後の層のものから順に `match()` で判定します。

同梱は `builtin.csv`（`.csv`）と `builtin.tsv`（`.tsv`）です。文字コードは UTF-8、UTF-16、Shift_JIS を扱えます（下の `encoding`）。その文字コードとして不正なバイト列は、エラーにします。BOM の有無は保たれます。保存すると、変更したフィールドの生のテキストだけが変わり、ほかのバイトは変わりません（見出しにない列を足す場合は下記）。

| `builtin.csv` / `builtin.tsv` の options | 型 | 意味 |
| --- | --- | --- |
| `key` | `string` | キーの列の見出し。省略すると先頭の列 |
| `text` | `Record<言語 ID, 見出し>` | 言語の本文の列の見出し。省略した言語は、言語 ID と同じ見出しの列 |
| `columns` | `Record<string, 見出し>` | ファイル内の列。`"列 ID"`（行に 1 つ）か `"列 ID@言語 ID"` から見出しへの対応。値は文字列で、`source` が `"file"` の列（下記）やバリデータ（`maxLength`）が読む |
| `stableId` | `string` | 安定 ID の列の見出し |
| `delimiter` | `string` | 区切り文字。フォーマットの既定（CSV は `,`、TSV はタブ）を上書き |
| `encoding` | `"auto"` \| `"utf-8"` \| `"utf-16le"` \| `"utf-16be"` \| `"shift_jis"` | 文字コード。既定 `"auto"`（下記） |
| `addColumns` | `"all-rows"` \| `"header-only"` \| `"never"` | 書き込みに必要な列が見出しにないときの扱い。既定 `"all-rows"`（下記） |

```json
"formats": [
  {
    "use": "builtin.csv",
    "match": "**/*.csv",
    "options": {
      "key": "ID",
      "text": { "ja": "JP", "JaEnglish": "EN", "zh-Hans": "CN", "ko": "KR" },
      "columns": { "maxLength": "MaxLen" }
    }
  }
]
```

`encoding` は、リソースを読むときと書くときの文字コードです。

- `"auto"`（既定）: 先頭に UTF-16 の BOM があればその UTF-16、なければ UTF-8 として読みます。Shift_JIS は自動では見分けません。
- `"shift_jis"`: Shift_JIS（Windows-31J。`"sjis"`、`"cp932"` とも書けます）として読み書きします。フォルダごとに文字コードが違うときは、`formats` に `match` の違う項目を並べ、Shift_JIS のほうにだけ `encoding` を書きます（先に一致した項目を使います）。
- 書き戻しは、読んだときと同じ文字コードで行います。変更していないセルのバイトは変わりません。
- Shift_JIS のリソースに、Shift_JIS で表せない文字（ハングルや簡体字、絵文字など）を保存しようとすると、「文字「확」（U+D655）は Shift_JIS で表せません。」と出て保存は失敗し、ファイルは変わらず、編集は未保存のまま残ります。
- Shift_JIS には、同じ文字を表すバイト列が 2 通りあるもの（「Ⅰ」などの機種依存文字の一部）があります。読んで書き戻すと元のバイト列に戻らないファイルは、読む時点でエラーにします（黙ってバイト列を変えないため）。UTF-8 か UTF-16 に変換してから使ってください。
- 新しいリソース（リソースの作成）は、`encoding` の文字コードで作ります。`"auto"` は BOM なしの UTF-8、UTF-16 は BOM つきです。
- 知らない名前を書くと、そのリソースは読めません（「設定の encoding は … のいずれかで指定してください」）。

設定にある見出し（`text`、`columns`、`stableId`）がファイルにない場合、読み込みでは「設定にある列「FR」が見出しにありません。」の警告になり、その列は空として読みます。その列に空でない値を書くと、`addColumns` に従って列を足します。

- `"all-rows"`（既定）: 見出しの末尾に列を足し、各レコードの末尾にも空のフィールドを足して、表を長方形に保ちます。
- `"header-only"`: 見出しと、値を入れるレコードにだけフィールドを足します。ほかのレコードは変えません。
- `"never"`: 列を足さず、保存を失敗にします（「列「FR」が見出しにありません（…）。設定 addColumns が "never" のため列は足しません。」）。ドラフトは残ります。

足す列の見出しは、設定に書いた見出しです。`text` に対応のない言語は、言語 ID を見出しにします。空の値を書くだけでは列を足しません。上の 3 つの動作は、サンプルプロジェクトのコピーに言語 `fr`（見出し `FR`）とファイル内の列 `note@ja`（見出し `NoteJA`）を足し、サービス層の `setText`、`save`、`setCell` で確かめました。`"all-rows"` では、保存後の `ui.csv` が次のようになりました。

```csv
ID,JP,EN,CN,KR,MaxLen,FR,NoteJA
UI_OK,決定,OK,确定,확인,4,Valider,
UI_CANCEL,キャンセル,Cancel,取消,취소,6,,短く
UI_SAVE_CONFIRM,セーブしますか？,Save your progress?,要保存吗？,저장하시겠습니까?,12,,
UI_GOLD,所持金：{gold} G,Gold: {gold} G,持有金：{gold} G,소지금: {gold} G,,,
```

### syntaxes

記法は、本文の中の変数、タグ、制御コードの見つけ方です。検証（`builtin.placeholders` など）と色分けに使います。`syntaxes` に複数書くと前から順に適用し、前の記法が本文と判断した部分だけを、次の記法で分けます。フォーマットが自分の記法を持つ（`Format.syntax`）場合は、それを優先します。

| ID | 見つけるもの | トークンの種類 |
| --- | --- | --- |
| `builtin.braces` | `{name}`、`{0}`、`{player.name}` | `variable` |
| `builtin.printf` | `%s`、`%d`、`%1$s`、`%05.2f` など（`%%` は本文） | `variable` |
| `builtin.tags` | `<b>`、`</b>`、`<color=#ff0000>`、`<br/>` | `tag` |

## columns

`columns` は表の列の並びです。要素は、列の定義（`ColumnDef`）そのものか、プラグインが登録した列を選んで上書きする `ColumnUse` です。省略すると「キー」「本文」の 2 列（ID は `key` と `text`）だけになります。

### ColumnDef

| キー | 型 | 意味 |
| --- | --- | --- |
| `id` | `string` | 列の ID（必須）。セル ID（言語別の列は `列ID@言語ID`）、設定の `of`、DB の記録に残る |
| `kind` | `"key" \| "text" \| "meta" \| "computed" \| "actions" \| "generated" \| "review"` | 列の種類（必須） |
| `label` | `string` | 表示名 |
| `scope` | `"entry" \| "language"` | `entry`: 行に 1 つ。`language`: 言語ごとに 1 つ（必須） |
| `languages` | `string[]` | 特定の言語だけに出す。省略すると全言語 |
| `type` | `"string" \| "number" \| "boolean" \| "date" \| { enum, default? }` | 値の型。`"date"` は日付で、値は `"2026-11-15"` の形の文字列。画面では日付の入力欄で編集し、空にすると値を消す。形の違う値と、実在しない日付（2 月 30 日など）は、書き込みを `invalid` で断る |
| `source` | `string` | 値の出所。`sources` のキー、登録された列ソースの ID、または `"file"` |
| `of` | `string` | `kind: "review"` の対象の列の ID |
| `actions` | `string[]` | `kind: "actions"` に並べるアクションの ID |
| `generator` | `string` | `kind: "generated"` の生成器。`generators` のキー（なければ生成器の ID として探す） |
| `basis` | `"text"` | 値を付けた時点の本文の版を記録する。本文が変わると、その値に「変更あり」が付く |
| `history` | `boolean` | `false` で変更履歴の対象から外す |
| `options` | `object` | 列に渡す値。`compute`、`display`、独自描画が読む |
| `display` | `"link" \| "progress" \| "color" \| "tags"` | 同梱の見せ方（下記） |
| `renderer` | `string` | プラグインが登録した独自描画の ID。`display` より優先する（[plugins/renderer.md](plugins/renderer.md)） |
| `compute` | 関数 | `kind: "computed"` の値を作る関数。JSON には書けないので、プラグインが列として登録する |

種類ごとの動きは次のとおりです（画面と `packages/server` のコードから）。

- `key`: キー。値はフォーマットから来ます。
- `text`: 本文。フォーマット経由で読み書きし、編集は未保存の変更（ドラフト）を経由します。
- `meta`: ステータスなどの値。`source` が省略か `"file"` なら、ファイルの中の列（フォーマットの `meta` / `languageMeta`。CSV では `options.columns` で対応づけた列）です。それ以外は列ソースが読み書きします。`type` が `{ enum }` ならドロップダウン、`string` / `number` ならセル内で編集、`boolean` はチェックボックスです。
- `review`: レビュー。`of` で対象の列を指し、出所は `postReview` / `listReviews` を実装した列ソースです。
- `generated`: 生成列。生成器の結果をキャッシュして表示します。
- `actions`: アクションのボタンを並べる列です。
- `computed`: 計算列。プラグインが登録した列の `compute(ctx)` で、表示する行の分だけ計算します。保存せず、読み取り専用で、絞り込みに使えます。`ctx` は `entry`、`language` と `text`（言語の列のみ。未保存の編集を含む）、`row`、`options`（列の `options`）です。戻り値 `{ value, error? }` の `error` や、`compute` が投げた例外は、セルのエラーの印になります。`compute` のない計算列は警告になります。

### 同梱の見せ方（display）

`display` を書くと、コードを書かずにセルの見せ方を変えられます。効くのは `meta` 列（`type` が `string` / `number`）、計算列、生成列です。選択式の列（enum）、本文、キー、レビュー列、チェックボックス、アクション列には効きません。

| `display` | 見せ方 |
| --- | --- |
| `link` | 値が `http://` か `https://` の URL なら、新しいタブで開くリンクにする。それ以外は文字のまま |
| `progress` | 数値を棒と割合で出す。0〜1、列の `options.max` があれば 0〜`max` |
| `color` | 色見本と値を出す。色見本は `#rgb` などの 16 進、`rgb()` / `hsl()`、色の名前のときだけ |
| `tags` | 配列、または区切り文字（列の `options.separator`。既定 `,`）で分けた文字列を、札にして並べる |

```json
{ "id": "wiki", "kind": "meta", "scope": "entry", "label": "資料", "type": "string", "source": "builtin.db", "display": "link" }
```

### 登録された列を選ぶ（ColumnUse）

```json
{ "use": "builtin.textStatus", "id": "textStatus" }
{ "use": "builtin.reviewStatus", "id": "reviewStatus", "of": "text" }
{ "use": "builtin.textStatus", "id": "textStatus", "source": "tracker" }
```

`use` に登録された列の ID を書くと、その定義を複製し、書いたキーで上書きします。型が定めるキーは `id`、`label`、`languages`、`type`、`source`、`of`、`actions`、`generator`、`options`、`display`、`renderer` です。上書きはキーごとの置き換えで、`type` や `options` も中身を混ぜずに丸ごと置き換わります（`type` を書くと列挙の選択肢も置き換わります）。`compute` は登録された関数のままです。`id` を書かないと、列の ID は登録の ID（`builtin.textStatus` など）になるので、短い ID を付けます。

- ID が重複した列は、後ろのものを捨てます（警告）。
- レビュー列は、`of` が設定にある別の列を指していないと表示しません（警告）。
- `source` が `sources` にも登録された列ソースにもないと、列は出ますが、値は読み書きできません（警告）。
- `renderer` が登録されていないと、既定の見せ方で表示します（警告）。

### 同梱の列

`builtin.*` の 5 つが登録されています（`packages/builtin/src/default-columns.ts`）。選択肢や表示名はこのプラグインの既定値で、アプリの固定値ではありません。

| 登録 ID | kind / scope | 出所 | 内容 |
| --- | --- | --- | --- |
| `builtin.key` | `key` / `entry` | なし | キー |
| `builtin.text` | `text` / `language` | なし | 本文 |
| `builtin.textStatus` | `meta` / `language` | `builtin.db` | ラベル「テキスト」。`todo`（未着手）、`wip`（作業中）、`done`（確定、`complete`）。既定 `todo`。`basis: "text"` |
| `builtin.reviewStatus` | `review` / `language` | `builtin.reviews` | ラベル「レビュー」。`none`（未レビュー）、`doing`（レビュー中）、`back`（差し戻し、`requireComment`）、`ok`（承認、`complete`）。既定 `none`。`of: "text"` |
| `builtin.length` | `computed` / `language` | なし | ラベル「文字数」。本文（未保存の編集を含む）の Unicode のコードポイント数。`{ "use": "builtin.length", "id": "length" }` で選ぶ |

本文の列に `text` 以外の ID を付けたら、`reviewStatus` の `of` もその ID にします。

### 列挙（enum）の選択肢

```json
{
  "use": "builtin.textStatus",
  "id": "textStatus",
  "type": {
    "enum": [
      { "value": "todo", "label": "未着手", "color": "gray" },
      { "value": "translated", "label": "翻訳済み", "color": "blue" },
      { "value": "approved", "label": "承認", "color": "green", "complete": true }
    ],
    "default": "todo"
  }
}
```

| キー | 意味 |
| --- | --- |
| `value` | 保存する値 |
| `label` | 表示名。省略すると `value` |
| `color` | 色。`gray`（`grey` も同じ）、`ink`（`black` も同じ）、`amber`（`yellow`、`orange` も同じ）、`red`、`green`、`blue`、`purple`、または `#rrggbb` などの CSS の色 |
| `complete` | `true` の選択肢が進捗の分子になる（ツリーの進捗、`status` コマンド）。言語ごとの列では、`validation.blockComplete` の対象にもなる |
| `requireComment` | レビュー列で、この判定にコメントを必須にする |
| `from` | この値に変えられるのは、いまの値がここに並んだ値のときだけ。省略すると、どの値からでも変えられる |
| `roles` | この値を選べる役割の ID（Web モード）。省略すると、その列を変えられる役割なら誰でも選べる |

値のないセルは `default` の値とみなします。進捗は、`complete` の選択肢の数と全体の数の割合です。対象の値が変わった印の付いた値は、`complete` に数えません。

`from` と `roles` で、状態の進め方をスタジオの決まりに合わせられます。次の例は、「確定」にできるのは「作業中」からだけで、役割が reviewer か manager の人だけ、という決まりです。

```json
"enum": [
  { "value": "todo", "label": "未着手" },
  { "value": "wip", "label": "作業中" },
  { "value": "done", "label": "確定", "complete": true, "from": ["wip"], "roles": ["reviewer", "manager"] }
]
```

- 決まりに合わない変更は、`blocked` のエラーで断ります。複数行の一括変更では、合わない行だけを飛ばして、ほかの行を変えます。画面では、選べない選択肢が理由つきで選べなくなります。
- いまの値と同じ値にする変更は、遷移として扱いません。
- レビュー列の判定にも使えます。レビュー列では、直前の判定がいまの値です。
- `roles` は、ローカルモードとサーバーの管理者には効きません。`from` は誰にでも効きます。
- フックが返した変更（[hooks](#hooks)）は、`from` と `roles` にかかわらず反映します。
- 設定で書けない条件（行によって違う、ほかの列の値による、など）は、フックの `before` に書きます。

## sources

`sources` は、列ソースに名前と `options` を付けます。列の `source` には、この名前か、登録された列ソースの ID を書きます。

```json
"sources": {
  "tracker": { "use": "example.trackerStatus", "options": { "baseUrl": "http://127.0.0.1:4010" } },
  "reviewsB": { "use": "builtin.reviews", "options": { "namespace": "reviews.team-b" } }
}
```

同梱の列ソース:

| ID | 内容 | options |
| --- | --- | --- |
| `builtin.db` | ホストの DB（共有 DB）の `cells(名前空間)` に値を置く。変更した時点で保存。版番号で競合を検出 | `namespace`（既定 `builtin.db`） |
| `builtin.reviews` | レビューの投稿を `log(名前空間)` に追記する（書き換えも削除もしない）。セルの値は最新の投稿の判定で、その投稿のコメントと投稿者も表のセルに出る。リンクは `名前空間 + ".links"` に置く。値を直接は保存できない | `namespace`（既定 `builtin.reviews`） |

`namespace` を変えると、同じ列ソースでも置き場所を分けられます。

## validators

`validators` は、使うバリデータを並べます。文字列（ID）か、次の形です。

| キー | 型 | 意味 |
| --- | --- | --- |
| `use` | `string` | バリデータの ID |
| `options` | `object` | バリデータに渡す値 |
| `severity` | `"error" \| "warning" \| "info"` | 重さの上書き |
| `languages` | `string[]` | 対象の言語 |
| `columns` | `string[]` | 対象を絞る本文の列の ID（省略時はバリデータの既定、さらに省略すると本文の列すべて）。検証されるのは本文（`kind: "text"`）の列だけなので、本文以外の列の ID を書くと、そのバリデータはどのセルにも当たらない |

重さは、設定の `severity`、指摘そのものの `severity`、バリデータの既定、`"error"` の順で決まります。同じバリデータを、条件を変えて複数回書けます（サンプルでは言語ごとに `maxWidth` を変えています）。結果はファイルには書きません。

### 同梱のバリデータ

| ID | 既定の重さ | 見つけるもの（`code`） | options |
| --- | --- | --- | --- |
| `builtin.placeholders` | error | 基の言語と比べた、変数・タグ・制御コードの過不足（`placeholder-missing`、`placeholder-extra`）。基の言語がない言語と空の本文は対象外 | `ignoreTags`（`true` でタグを比べない。既定 `false`） |
| `builtin.tagBalance` | error | タグの対応と入れ子（`tag-unclosed`、`tag-unexpected-close`） | `voidTags`（閉じなくてよいタグ名の配列。既定 `["br"]`） |
| `builtin.maxLength` | error | 文字数の上限（`too-long`）。コードポイント数で数える。上限がなければ何もしない | `max`（数。指定すると行ごとの上限より優先）、`metaKey`（行の上限を読む `meta` のキー。既定 `"maxLength"`）、`count`（`"all"` で本文全体を数える。既定は変数・タグ・制御コードを除いた本文だけ） |
| `builtin.whitespace` | warning | 前後の空白と連続スペース（`leading-space`、`trailing-space`、`double-space`）。修正案つき | なし |
| `builtin.untranslated` | warning | 訳文が空、または原文と同じ（`empty`、`same-as-base`）。`empty` は原文が空でないときだけ、`same-as-base` は原文の本文の部分に文字（Unicode の Letter）があるときだけ指摘する。基の言語がない言語は対象外 | なし |

`builtin.maxLength` が行ごとの上限を読むには、CSV の見出しを `meta` に対応づけます（サンプルの `"columns": { "maxLength": "MaxLen" }`）。

## generators

`generators` は、生成器に名前と `options` を付けます。生成列（`kind: "generated"`）の `generator` が、この名前を指します。名前が見つからなければ、生成器の ID として探します。

同梱の `@loc-studio/plugin-llm` が、LLM（OpenAI 互換の API。LiteLLM など）を使う生成器を 2 つ登録します。同梱プラグインとは別のパッケージですが、画面、サービス層、CLI のすべてのコマンドで登録されます。このプラグインの使い方、設定項目、設計、実装は、[bundled-plugins/llm/](bundled-plugins/llm/guide.md) にまとめてあります。自作の生成器は [plugins/generator.md](plugins/generator.md) にあります。

| 生成器 | 作る値 | 設定の `columns` に `use` で足せる列 |
| --- | --- | --- |
| `llm.translate` | その言語の本文を、別の言語（既定は日本語）に翻訳した文章（機械翻訳、逆翻訳） | `llm.translation`（表示名「機械翻訳」） |
| `llm.evaluate` | その言語の本文（訳文）を原文と比べた判定。`OK`、`WARNING`（合っているか怪しい）、`NG` のどれか。理由は、判定の横に出る | `llm.evaluation`（表示名「翻訳の評価」。判定の 3 つを、色つきの選択肢として持つ） |

### LLM で機械翻訳と翻訳の評価をする

設定は 2 か所です。`generators` で、生成器に名前と接続先を付けます。`columns` に、同梱の列を `use` で足し、`generator` にその名前を書きます。

```json
"generators": {
  "mt": { "use": "llm.translate", "options": { "endpoint": "https://llm.example.internal/v1", "model": "my-model" } },
  "check": { "use": "llm.evaluate", "options": { "endpoint": "https://llm.example.internal/v1", "model": "my-model" } }
},
"columns": [
  { "use": "builtin.key", "id": "key" },
  { "use": "builtin.text", "id": "text" },
  { "use": "llm.translation", "id": "mt", "generator": "mt", "languages": ["JaEnglish", "ko"] },
  { "use": "llm.evaluation", "id": "mtCheck", "generator": "check", "languages": ["JaEnglish", "ko"] }
]
```

- `languages` には、翻訳や評価の対象にする言語（訳文の言語）を書きます。省くと、すべての言語に列が出ます。
- 機械翻訳の入力は、そのセルの言語の本文です。空の本文は生成しません。
- 評価の入力は、そのセルの言語の本文（訳文）と、原文の本文です。原文は、その言語の `basedOn`（基にする言語）の本文です。別の言語と比べたいときは、プラグインの設定の「比べる原文の言語」か、`options` の `source` に言語の ID を書きます。原文の言語が決まらない言語、原文の言語そのもの、原文か訳文が空の行は評価しません。
- 結果は、共有 DB にキャッシュします。本文（評価では、原文か訳文）が変わると、セルに「変更あり」の印が出て、前の結果はそのまま残ります。生成し直すと「最新」に戻ります。「変更あり」の行は、絞り込みの「要確認」と、条件式の `stale` で探せます。
- 評価の判定は、条件式と集計に使えます（`mtCheck@ko = NG`、`mtCheck@ko >= WARNING`。大小は `OK`、`WARNING`、`NG` の順）。
- 列の表示名や選択肢の表示名と色は、`use` の横に `label` や `type` を書くと変えられます（保存される値は `OK` / `WARNING` / `NG` のままにします）。
- 生成のしかた（セルのボタン、選んだ行、絞り込みに合う行、リソース全体、プロジェクト全体、コマンドライン）は、ほかの生成列と同じです（[QUERY.md の一括アクション](QUERY.md#一括アクション)、[CLI.md の generate](CLI.md#generate)）。

#### 接続先（generators の options）

接続先は、プロジェクト設定の `generators` の `options` に書きます。外部につなぐ値なので、設定の信頼の確認の対象で、Web モードではサーバーの管理者だけが変えられます。

| options | 型 | 既定 | 使う生成器 | 意味 |
| --- | --- | --- | --- | --- |
| `endpoint` | `string` | なし（必須） | 両方 | OpenAI 互換の API の基底 URL。`<endpoint>/chat/completions` に POST する |
| `model` | `string` | なし（必須） | 両方 | モデル名 |
| `apiKeySecret` | `string` | `"llm.apiKey"` | 両方 | API キーの秘密情報の名前。秘密情報がなければ、`Authorization` ヘッダーを付けずに送る |
| `temperature` | `number` | `0` | 両方 | |
| `timeoutMs` | `number` | `60000` | 両方 | 1 回の要求の制限時間 |
| `instructions` | `string` | なし | 両方 | プロンプトの後ろに足す文章（使う場所ごとの補足） |
| `prompt` | `string` | プラグインの設定の値 | 両方 | プロンプト。プラグインの設定より優先する |
| `to` | `string` | プラグインの設定の値 | `llm.translate` | 訳し先の言語の名前。プラグインの設定より優先する |
| `source` | `string` | プラグインの設定の値 | `llm.evaluate` | 比べる原文の言語の ID。プラグインの設定より優先する |

API キーは秘密情報 `llm.apiKey` から読みます（ローカル設定の `secrets.llm.apiKey`、または環境変数 `LOC_STUDIO_SECRET_LLM_APIKEY`）。設定ファイルには書かないでください。API キーはキャッシュの鍵に入りません。

`endpoint` か `model` がないと、生成は「オプション "endpoint" が設定されていません」で失敗し、何を設定に書けばよいかを添えて知らせます。

#### プロンプトなどの設定（プラグインの設定）

プロンプト、訳し先、比べる原文の言語は、プラグインの設定です。設定の画面の「プラグインの設定」のタブに、`@loc-studio/plugin-llm` の欄として出ます。値は、プロジェクトの `loc-studio-plugin-settings/%40loc-studio%2Fplugin-llm.json` に保存され、チームで共有されます（[plugins/settings.md](plugins/settings.md)）。Web モードでは、`manage` の権限がある役割が変えられます。

| 項目（設定ファイルのキー） | 既定 | 意味 |
| --- | --- | --- |
| 機械翻訳: 訳し先の言語（`translateTo`） | `日本語` | プロンプトの `{to}` に入る、言語の名前 |
| 機械翻訳: プロンプト（`translatePrompt`） | 「ユーザーが送る文章を{to}に翻訳してください。」で始まる 3 行 | モデルに渡す指示。`{to}` は訳し先の言語の名前に置き換わる |
| 翻訳の評価: 比べる原文の言語（`evaluateSource`） | なし（その言語の `basedOn`） | 原文として比べる言語の ID |
| 翻訳の評価: プロンプト（`evaluatePrompt`） | 判定の基準（OK / WARNING / NG の意味、変数とタグの確認、理由を日本語で書くこと） | モデルに渡す、判定の基準の指示。返事の形（判定と理由の JSON）の指示は、この後ろに自動で足す |

- プロンプトの欄は複数行で、「既定の文章を入力欄に入れる」を押すと、既定の文章から書き換えられます。欄を空にして保存すると、既定に戻ります。
- 同じ生成器を、場所ごとに別の値で使いたいときは、`generators` の `options`（`prompt`、`to`、`source`、`instructions`）に書きます。`options` の値が、プラグインの設定より優先されます。
- プロンプトや訳し先を変えると、キャッシュの鍵が変わります。前の値で作った結果は「変更あり」になり、生成し直せます。元の値に戻すと、前の結果がまた「最新」として出ます。

キャッシュの鍵は、生成器の ID、`version`、`cacheParams`、入力の全文です。`cacheParams` は、`llm.translate` では `endpoint`、`model`、訳し先、`instructions`、`temperature` と、既定から変えたときのプロンプトです。`llm.evaluate` では `endpoint`、`model`、プロンプト、`instructions`、`temperature` です（比べる原文は、入力のほうに入ります）。

#### まとめて送る件数（バッチサイズ）

どちらの生成器も、既定では 1 件ずつ送ります（1 回の要求に、1 つの本文）。生成のときにバッチサイズを指定すると、その件数を 1 回の要求にまとめて送ります（画面の生成の確認の「まとめて送る件数」、一括アクションの「まとめて送る行数」、コマンドラインの `generate --batch-size`、サービス層の `generate` の `batchSize`）。

- 1 件のときは、本文をそのまま送り、返事をそのまま結果にします。
- 2 件以上のときは、`id` を付けた JSON の配列で送り、モデルに `id` ごとの結果の配列を返させます。返事に足りない `id` があるなど、形の合わない返事は、そのまとまり全体を失敗にして、やり直します（2 回まで）。
- まとめる件数を増やすと、要求の回数は減りますが、モデルが形を崩しやすくなります。失敗が増えたら、件数を減らしてください。
- 同時に送る要求は 2 つまでです。

#### 確かめた範囲

- 生成器の単体のテストは、`fetch` を差し替えて行っています（`packages/plugin-llm/src/*.test.ts`）。
- サービス層、コマンドライン、画面は、手元に立てた OpenAI 互換のサーバー（`chat/completions` に決まった返事を返すもの）を相手に確かめています。生成、キャッシュ、「変更あり」、条件に合う行だけの生成、バッチサイズ、プラグインの設定は `packages/server/src/llm.test.ts`、画面の操作は `npm run check:browser` です。コマンドラインでも、同じサーバーを相手に、サンプルのプロジェクトの写しで `generate`（`--where`、`--keys`、`--batch-size`）と `query` を実行しました（[CLI.md の generate](CLI.md#generate) に出力があります）。
- 実際の LLM の API と、実際の LiteLLM には、接続して確かめていません。既定のプロンプトで、実際のモデルがどのくらい正しく判定するか、まとめて送ったときに形を守るかも、確かめていません。

## actions と review.targets

`actions` は、使うアクションを並べます（`UseRef`。`options` はアクションの `ctx.options` になります）。アクションは `target` を持ちます。

| `target` | 対象 | 呼ばれ方（サービス層） | 画面での置き場所 |
| --- | --- | --- | --- |
| `cell` | セル | 行ごとに呼ぶ。`cellId` が要る | アクション列のボタン、複数行を選んだときのバー |
| `row` | 行 | 行ごとに呼ぶ | アクション列のボタン、複数行を選んだときのバー |
| `column` | 列 | 1 回だけ呼ぶ。`cellId` が要る | 列見出しの「⋮」メニュー |
| `selection` | 選択範囲 | 1 回だけ呼ぶ（行を指定しなければ全行） | 複数行を選んだときのバー |
| `file` | ファイル | 1 回だけ呼ぶ（全行） | ツールバーの「アクション ▾」 |
| `review` | レビューの投稿 | 設定の `review.targets` に置き、投稿の転載で呼ぶ。`actions` に置いても `run` では実行できない | レビューの投稿パネル |

アクション列は、`kind: "actions"` の列の `actions` に ID を並べたものです。返ってきたセルの変更（`patches`）は、画面の編集と同じ規則で反映します。本文は未保存の変更になるので、保存が要ります。反映できなかった変更は理由つきのエラーとして返り、ほかの変更は反映します。`cell` 対象と `row` 対象は、対象が 20 行を超えるときに、ジョブとして実行します。CLI の `run` は、`review` 以外のすべての対象を実行できます（[CLI.md](CLI.md#run)）。

`review.targets` は、レビューの投稿の転載先です。`target: "review"` のアクションだけを置けます（そうでないと、画面の「警告とエラー」に警告が出ます）。アクションが `links`（チケットなどへのリンク）を返すと、投稿に紐づけて保存します。転載するかどうかは、ローカル設定 `review.forwardOnPost`（[ローカル設定](#ローカル設定)）で決まります。転載に失敗しても投稿は失敗にせず、警告になります。同じ投稿を同じ転載先へ二重に転載することはありません。

```json
"actions": ["mystudio.trim"],
"review": { "targets": [{ "use": "mystudio.openTicket", "options": { "baseUrl": "https://tracker.example.com" } }] }
```

このアクションの実装と、実行して確かめた結果は [plugins/action.md](plugins/action.md) にあります。

## hooks

```json
"hooks": [
  "mystudio.resetOnSave",
  { "use": "mystudio.freeze", "options": { "keys": ["UI_OK"] } }
]
```

書き込みの前後に呼ぶフック（プラグインが登録した `WorkflowHook`）を、呼ぶ順に並べます。フックは、書き込みを理由つきで止めたり、書き込みに続けてセルの値を変えたりできます。できごとの種類と書き方は [plugins/hook.md](plugins/hook.md) にあります。

同梱のフックはありません。ここに書いていないフックは、登録されていても呼ばれません。

## roles

Web モードで、利用者にプロジェクトごとに割り当てる役割の定義です。ローカルモードでは使いません（1 人で、すべてできます）。

同梱の役割は次の 4 つです。`roles` を書かなければ、この 4 つだけを使えます。

| ID | 表示名 | できること（`can`） |
| --- | --- | --- |
| `viewer` | 閲覧 | なし（見るだけ） |
| `translator` | 翻訳 | `edit`、`run` |
| `reviewer` | レビュー | `review`、`run` |
| `manager` | 管理 | `edit`、`review`、`run`、`structure`、`manage` |

`roles` に書いた役割は、同梱の役割に足されます。同梱と同じ ID で書くと、その役割を丸ごと置き換えます（同梱の権限や表示名は引き継ぎません）。

```json
"roles": {
  "lqa": {
    "label": "LQA",
    "can": ["edit", "review"],
    "editColumns": ["textStatus"],
    "reviewColumns": ["reviewStatus"]
  },
  "vendor": {
    "label": "外注",
    "can": ["edit", "run"],
    "resources": ["Assets/Text/dlc/**"],
    "actions": []
  }
}
```

| キー | 意味 |
| --- | --- |
| `label` | 画面に出す名前。省略すると役割の ID |
| `can` | できること。必須。下の表の値の配列（見ることは、役割を持つ全員ができる） |
| `editColumns` | `edit` で変えられる列の ID（本文の列も含む）。省略するとすべての列 |
| `reviewColumns` | `review` で投稿できるレビュー列の ID。省略するとすべてのレビュー列 |
| `actions` | `run` で実行できるアクションの ID。省略すると、設定の `actions` のすべて |
| `generators` | `run` で生成できる生成列の ID。省略するとすべての生成列 |
| `resources` | 見えるリソースのパス（glob）。省略するとすべて |

絞り込み（`editColumns` など）は、省略すると制限なし、空の配列にすると「どれもできない」です。

| `can` の値 | できること |
| --- | --- |
| `edit` | 本文の編集と保存、列の値の変更（レビュー列以外） |
| `review` | レビューの投稿と転載 |
| `run` | アクションと生成の実行 |
| `structure` | 行の追加・削除・キーの変更、リソースの作成 |
| `manage` | プロジェクト設定の一部の変更、プラグインの再読み込み、ほかの人が始めたジョブの取り消し |

決まりは次のとおりです。

- `resources` で見えないリソースは、ツリー、検索、統計、履歴など、どの読み出しでも「ない」ものとして扱います（あることを知らせません）。
- 保存、すべて保存、未保存の変更の取り消しは、その役割が変えられる本文のドラフトだけを扱い、ほかの人のドラフトは残します。
- 役割の定義の書き方が誤っていると（`can` が配列でない、知らない権限がある、など）、その役割では何も見えず、何もできません。プロジェクトを開いたときに警告が出ます。誤りで権限が広がらないよう、同梱の同じ ID の役割には戻しません。
- 割り当てに残っている役割が設定から消えると、その利用者は、見ることも含めて何もできません。
- サーバーの管理者は、役割の定義にかかわらず、すべてできます。
- `roles` を変えられるのは、サーバーの管理者だけです（`manage` の権限では変えられません）。変えた定義は、次の呼び出しから効きます。
- 言語の制限は、役割ではなく、利用者への割り当てに付けます（[WEB-MODE.md の 6 章](WEB-MODE.md#6-権限)）。

## editor

本文の編集画面（編集モーダル）の設定です。

```json
"editor": {
  "referenceLanguages": ["JaEnglish"],
  "referenceColumns": ["note", "maxLength", "backTranslation"],
  "count": { "unit": "width", "skipTokens": true }
}
```

| キー | 意味 |
| --- | --- |
| `referenceLanguages` | 参照欄に、基になる言語（`basedOn`）のほかに並べる言語の ID。原文が日本語で、英語を見ながら訳す言語があるときなどに使う |
| `referenceColumns` | 参照欄に出す列の ID（行に 1 つの列と、編集中の言語の列）。省略すると、その言語の生成列だけ。空の配列にすると列を出さない |
| `count.unit` | 本文の長さの数え方。`codepoints`（Unicode のコードポイント数。既定）、`utf16`（UTF-16 の単位の数）、`bytes`（UTF-8 のバイト数）、`width`（全角を 2、それ以外を 1 と数え、改行は数えない） |
| `count.skipTokens` | `true` にすると、変数・タグ・制御コード（記法が分けたトークン）を数えない |

参照欄では、基になる言語の本文の変数とタグに色が付き、押すと編集中の本文のカーソルの位置に入ります。

プロジェクトにない言語や列、知らない数え方を書くと、その値は使わず、警告が出ます。ここで決まるのは編集画面の表示だけで、文字数の上限の検証（`builtin.maxLength`）の数え方は、バリデータの `options` で別に決めます。

## validation

```json
"validation": { "blockComplete": "error", "recheck": true }
```

`blockComplete` に重さ（`"error"` / `"warning"` / `"info"`）を指定すると、その言語の本文にその重さ以上の問題があるとき、言語ごとの列の値を `complete` の選択肢に変える操作が `blocked` になります（画面の一括変更では、止めた行が通知されます）。行に 1 つの列の値の変更と、レビューの判定の投稿は、止めません。`false`（既定）で無効です。

`recheck` は、「要確認」の印を付けるかどうかです。既定は `true` で、訳文（`basedOn` のある言語）を保存したあとで基になる言語の本文が変わると、その訳文に印が付き、「要確認」の絞り込みに入ります。`false` にすると、印を付けず、絞り込みにも入りません。本文の変更への追従を、フックで列の値を戻すなど、別の決まりで行うスタジオ向けです。`false` のあいだも、訳文を保存したときの原文の版は記録するので、`true` に戻すと、そのあいだの変更にも正しく印が付きます。

## storage

共有 DB（チームで共有する値: ステータス、レビュー、変更履歴、生成結果のキャッシュ）の設定です。SQLite のファイルか、Postgres を選べます。

| キー | 型 | 意味 |
| --- | --- | --- |
| `driver` | `"sqlite" \| "postgres"` | DB の種類 |
| `path` | `string` | SQLite のファイルの場所（プロジェクトのフォルダからの相対、または絶対）。省略すると `.loc-studio/meta.db`。`${env:NAME}` が使える |
| `sharing` | `{ mode: "lockfile", staleAfterMs?, waitMs? }` | SQLite のファイルをネットワーク共有に置き、複数人で使うときの設定（下記）。Postgres では使わない |
| `url` | `string` | Postgres の接続文字列。`driver: "postgres"` では必須。`${env:NAME}` が使える |
| `schema` | `string` | Postgres のスキーマ名。既定 `loc_studio`。なければ作る |

`path` と `url` の `${env:NAME}` は、環境変数に置き換えます。変数がなければ、「環境変数 NAME が設定されていません」のエラーでプロジェクトを開けません。画面のローカルモードでは、設定ファイルを信頼したあとにだけ置き換えます（上の「設定ファイルの確認」）。Web モードでは、サーバーの設定の `projects[].env` に並べた名前だけを使えます。`LOC_STUDIO_LOCAL_TOKEN`、`LOC_STUDIO_INTERNAL_SECRET`、`LOC_STUDIO_ADMIN_USER`、`LOC_STUDIO_ADMIN_PASSWORD`、`LOC_STUDIO_SECRET_` で始まる名前は、どのモードでも参照できません（書くと、その名前を示す設定のエラーになります）。個人の環境に依存する場所や、パスワードを含む接続文字列を、共有の設定ファイルに直接書かないために使います。

```json
"storage": {
  "driver": "sqlite",
  "path": "${env:LOC_SHARE}/MyGame/meta.db",
  "sharing": { "mode": "lockfile", "staleAfterMs": 30000, "waitMs": 20000 }
}
```

この設定で、`LOC_SHARE` を指定すると指定先に `meta.db` が作られ（親フォルダも作られます）、指定しないとエラーになることを、CLI（`set`、`status`）で確かめました。

```json
"storage": { "driver": "postgres", "url": "${env:LOC_PG_URL}", "schema": "mygame" }
```

Postgres では、表を `schema` の中に作ります。1 つのデータベースを複数のプロジェクトで使うときは、プロジェクトごとにスキーマを変えます。接続するユーザーには、そのスキーマを作る権限（または作成済みのスキーマへの権限）が要ります。上の設定で、`LOC_PG_URL` を PostgreSQL 16 の一時クラスタに向けて CLI の `set` と `status` を実行し、値が保存されて読めること、スキーマ `mygame` に表ができること、`LOC_PG_URL` がないとプロジェクトを開けないことを確かめました。Postgres の動作の詳細は [packages/store/README.md](../packages/store/README.md) にあります。

もう 1 つの DB は、その PC の DB（`<個人の設定フォルダ>/projects/<プロジェクトのパスの SHA-256 の先頭 16 桁>/local.db`）です。未保存の本文（ドラフト）を置き、共有しません。`storage` が Postgres でも、その PC の DB は SQLite です。

### 共有モード（`sharing`）

ネットワーク共有上の SQLite は、SQLite 自身のファイルロックが信用できないため、WAL を使わず（`journal_mode = DELETE`、`synchronous = FULL`）、操作ごとに接続を開いて閉じます。

書き込みは、データベースの隣のロックファイル `<path>.lock` を排他作成して取ったロックの中で、1 人ずつ行います。ロックは 1 回の短い書き込みの間だけ持ち、読み取りはロックなしで行います。`waitMs`（既定 20000）待ってもロックを取れないと `locked` のエラーになり、誰が書き込み中かがメッセージに出ます。

`staleAfterMs`（既定 30000）より古いロックは、持ち主が止まったものとみなして、1 人だけが引き継ぎます。古さは、各 PC の時計ではなく、ファイルサーバーの時計（同じフォルダに書いた探り用ファイルの更新時刻）で測ります。保持中は 5 秒ごとにロックの更新時刻を更新します。画面は数秒ごとに共有 DB の変更番号を確かめ、ほかの人の変更が入ったら、表示中の行を読み直します。

共有 SQLite は、同じ 1 台の PC の複数プロセスでだけ確かめました。実際のネットワークファイルシステム（SMB、NFS など）で、排他作成や改名の原子性が期待どおりかは確かめていません。複数台の PC が同時に書く運用の前に、自分の環境で確かめてください。ロックファイルは `.gitignore` の対象にしてください（このリポジトリの `.gitignore` は `.loc-studio/*.db` などを除外しています）。

## languageSets と grid

```json
"languageSets": {
  "アジア": ["ja", "zh-Hans", "ko"],
  "出荷": ["ja", "JaEnglish"]
},
"grid": { "maxPinnedRatio": 0.5 }
```

| キー | 意味 |
| --- | --- |
| `languageSets` | 言語の切り替えパネルに出る表示セット（名前の後ろに ★）。値は言語 ID の配列 |
| `grid.maxPinnedRatio` | 固定した列の幅の合計が、表の幅に占める割合の上限（既定 0.6）。超えると、後ろの固定を一時的に外す |
| `grid.pinCommon` | 共通のグループ（キーなど）を左端に固定するか（既定 `true`）。`false` にすると、共通のグループも横にスクロールする |
| `grid.progressColumn` | ツリーに進捗を出す列の ID（選択肢に `complete` のある、ステータスやレビューの列）。省略すると、最初のレビュー列、なければ最初の選択式の列 |
| `grid.progressUnit` | 進捗の数え方。`rows`（行数。既定）、`characters`（原文の文字数。コードポイントの数）、`words`（原文を空白で区切った語数）。原文は、その言語の基になる言語（`basedOn`）の本文で、原文の言語自身の進捗は、その言語の本文で量る。行に 1 つの列は、最初の原文の言語の本文で量る。未保存の編集も量に入る。ツリーの進捗と、`status` コマンドの両方に効く。知らない値は警告にして、行数で数える |

## localSettings

```json
"localSettings": {
  "defaults": { "ui.theme": "light", "review.forwardOnPost": "ask" },
  "enforce": { "plugins.local.formats": "deny" }
}
```

プロジェクトの側から、利用者ごとのローカル設定（次の節）の初期値と固定を決めます。

| キー | 意味 |
| --- | --- |
| `defaults` | ローカル設定のキーから値への対応。利用者がその項目を設定していないときの初期値になる |
| `enforce` | ローカル設定のキーから値への対応。その項目を、この値に固定する。利用者は変えられない |

- 意味を持つキーは、[既知のキー](#既知のキー)の表のものです。ほかのキーを書いても、エラーにも警告にもなりません。`secrets.*` は、`defaults` に書いても、秘密情報としては読まれません（プラグインが読む秘密情報は、ローカル設定と環境変数のものだけです）。
- `secrets.*` と `plugins.trust` は、`enforce` に書いても無視します（[固定できないもの](#固定できないもの)）。
- 個人のプラグインフォルダのプラグインを禁止する `plugins.local` と `plugins.local.<欄>` は、`enforce` に書きます。
- 値の優先順位は、[優先順位](#優先順位)にあります。

## ローカル設定

ローカル設定はその PC だけの設定です。JSON のオブジェクトで、ドットを含むキーをそのまま並べます。

```json
{
  "user.name": "alice",
  "ui.theme": "dark",
  "review.forwardOnPost": "ask",
  "secrets.llm.apiKey": "sk-..."
}
```

Web モードでは、このファイルの代わりに、利用者ごとの設定をサーバーの DB に置きます。そこでは `user.name` はログイン名に固定され、`secrets.*` は利用者が変えられません（[WEB-MODE.md](WEB-MODE.md#8-ローカルモードとの違い)）。

### ファイルの場所

| 条件 | 場所 |
| --- | --- |
| 個人の設定フォルダを指定した（CLI の `--user-data-dir`、環境変数 `LOC_STUDIO_USER_DATA_DIR`、デスクトップ版の `userData`） | `<そのフォルダ>/settings.json`（`LOC_STUDIO_SETTINGS` は使わない） |
| 環境変数 `LOC_STUDIO_SETTINGS` がある | そのパス |
| Windows | `%APPDATA%\loc-studio\settings.json`（`APPDATA` がなければ `<ホーム>\AppData\Roaming\loc-studio\settings.json`） |
| macOS | `~/Library/Application Support/loc-studio/settings.json` |
| Linux | `$XDG_CONFIG_HOME/loc-studio/settings.json`（なければ `~/.config/loc-studio/settings.json`） |

上の行ほど優先します。ファイルがなければ空として扱います。JSON が壊れているか、オブジェクトでなければ、プロジェクトを開けません。BOM は無視します。画面の設定ダイアログは、このファイルを書き換えます（一時ファイルに書いて置き換えます）。パスは `loc-studio whoami` と、画面の設定の「ローカル」タブで確かめられます。

### 優先順位

値は、次の層を上から見て、最初にあったものになります。

1. `enforce`: プロジェクト設定の `localSettings.enforce`（固定）
2. `cli`: 起動引数と環境変数（`--user`、`LOC_STUDIO_USER`）。Web モードでは使わない
3. `local`: ローカル設定ファイル（Web モードでは利用者ごとの設定）
4. `defaults`: プロジェクト設定の `localSettings.defaults`
5. `app`: アプリの既定値（`review.forwardOnPost` = `"ask"` だけ）

固定された項目は、画面では変更できず、`setLocalSetting` も `locked` で失敗します。

```json
"localSettings": {
  "defaults": { "ui.theme": "light" },
  "enforce": { "plugins.local.formats": "deny" }
}
```

### 既知のキー

| キー | 値 | 意味 |
| --- | --- | --- |
| `user.name` | 文字列 | 記録（履歴、レビューの投稿、ステータスの更新者）に残す名前。`{hostname}` と `{osUser}` が使える。空白だけの値は無視する。どの層にもなければ PC 名 |
| `ui.theme` | `"light"` / `"dark"`（`"system"`、`"os"`、`"auto"` は OS の設定に合わせる） | 画面のテーマ。設定ダイアログの選択肢は「ライト」（light）、「ダーク」（dark）、「OS に合わせる」（system）。既定は light |
| `review.forwardOnPost` | `"always"` / `"ask"` / `"never"` | レビューの投稿をレビュー先へ転載するか。既定 `"ask"` |
| `secrets.<名前>` | 文字列 | 秘密情報。プラグインは `host.secrets.get("<名前>")` で読む。環境変数より優先。一覧では `********` に伏せる |
| `plugins.local` / `plugins.local.<欄>` | `"deny"`（`enforce` に書く） | 個人のプラグインフォルダ（local 層）のプラグインを禁止する |

`plugins.local.<欄>` の欄は、`trees`、`formats`、`syntaxes`、`sources`、`columns`、`generators`、`actions`、`validators`、`hooks`、`renderers` です。`plugins.local` を `"deny"` にすると、すべての種類を禁止します。禁止された実装は登録されず、警告が出ます。`enforce` で制限できるのは個人のフォルダ（local 層）だけです。これとは別に、画面のローカルモードでは、プロジェクトと個人のフォルダのプラグインとコードの設定を、利用者が信頼するまで読み込みません（下の `plugins.trust`）。サンプルプロジェクトは `"plugins.local.formats": "deny"` を設定しています。個人のフォルダにフォーマットを置くと禁止されることを、CLI の `plugins` で確かめました。

### 固定できないもの

`secrets.*` と、`plugins.trust` / `plugins.trust.*` は、`enforce` に書いても無視します。プロジェクトの設定ファイルを書ける人が、他人の秘密情報や信頼の設定を決められないようにするためです。書いてあると、画面の「警告とエラー」に名前が出ます（CLI の `plugins` には出ません）。

`plugins.trust` は、画面（サービス層の既定 `pluginTrust: "prompt"`）で信頼したプラグイン、コードの設定、設定ファイルの記録です。`{ [プロジェクトのルート]: { [パス]: 中身のハッシュ } }` の形で、確認のダイアログで信頼したとき、画面の設定のダイアログから設定ファイルを保存したとき、新しいプロジェクトを作ったとき（上の「設定ファイルの確認」）に書かれます。手で書く必要はなく、設定の一覧にも出ません。

プロジェクト設定の値は、ローカル設定にない項目の初期値（`defaults`）と固定（`enforce`）にしかなりません。プラグインがローカル設定を読む API はなく、プラグインが読めるのは `secrets.*` だけです。プラグインが自分で宣言した設定（プロジェクトの `loc-studio-plugin-settings/<プラグインの名前>.json`。チームで共有する値）は、[plugins/settings.md](plugins/settings.md) にあります。

## 環境変数

コードの `LOC_STUDIO_` を検索して集めたものです。

| 変数 | 読むもの | 意味 |
| --- | --- | --- |
| `LOC_STUDIO_PROJECT` | 画面（ローカルモード）。デスクトップ版は起動時に設定 | 起動時に開く既定のプロジェクトのフォルダ。Web モードでは使わない |
| `LOC_STUDIO_USER_DATA_DIR` | 画面。デスクトップ版は `userData` を設定 | 個人の設定フォルダ。`settings.json`、その PC の DB、個人のプラグインフォルダ `plugins/`、最近のプロジェクト一覧 `web-session.json` の置き場所。Web モードではデータフォルダ（`server.json` の既定の場所、`workspaces/`） |
| `LOC_STUDIO_MODE` | 画面（起動の仕組みと要求ごと） | 未設定か `local` でローカルモード、`web` で Web モード。ほかの値では起動の仕組みが起動を断る（ほかの方法で起動したサーバーは、すべての要求に 500 を返す） |
| `LOC_STUDIO_HOST` | 画面（起動の仕組み） | 待ち受けるアドレス。既定 `127.0.0.1`。`HOSTNAME` は見ない |
| `LOC_STUDIO_ALLOW_REMOTE_LOCAL` | 画面（起動の仕組み） | `1` のときだけ、ローカルモードでループバック以外のアドレスに待ち受ける（起動の合言葉は必要なまま） |
| `LOC_STUDIO_LOCAL_TOKEN` | 画面（ローカルモード） | 起動の合言葉（16 文字以上）。なければ起動の仕組みが作り、URL を表示する。`off` は合言葉を使わない開発用の設定で、ループバックで待ち受けるローカルモードだけで使える（警告が出る） |
| `LOC_STUDIO_ALLOWED_HOSTS` | 画面 | ループバックの名前のほかに受け付けるホスト名（カンマ区切り）。Web モードではサーバーの設定の `allowedHosts` に足される |
| `LOC_STUDIO_SERVER_CONFIG` | 画面（Web モード）、CLI の `user` / `member` / `server check` | サーバーの設定ファイルのパス。既定は `<LOC_STUDIO_USER_DATA_DIR>/server.json` |
| `LOC_STUDIO_ADMIN_USER`、`LOC_STUDIO_ADMIN_PASSWORD` | 画面（Web モード） | 両方あり、`auth.mode` が `password` で、アカウントが 1 つもないとき、この名前とパスワードで管理者を作る。サーバーはそのあと、この 2 つをプロセスの環境から消す。CLI の管理コマンドは使わない |
| `LOC_STUDIO_APP_DIR` | 画面、CLI。デスクトップ版は設定 | アプリのフォルダ。その中の `plugins/` を読む。CLI は `--app-dir` が優先 |
| `LOC_STUDIO_PLUGIN_DIRS` | コア（画面、CLI 共通） | プラグインを探す追加のフォルダ。OS のパス区切り（Windows は `;`、それ以外は `:`）で複数指定。アプリ層として扱う |
| `LOC_STUDIO_SETTINGS` | コア（`localSettingsPath`） | ローカル設定ファイルのパス。個人の設定フォルダを指定した場合は使わない |
| `LOC_STUDIO_USER` | コア（cli 層） | ユーザー名（`user.name`）。CLI の `--user` が優先。Web モードでは使わない |
| `LOC_STUDIO_SECRET_<名前>` | コア（秘密情報） | 秘密情報。名前は大文字にし、英数字以外を `_` に置き換える（`llm.apiKey` は `LOC_STUDIO_SECRET_LLM_APIKEY`）。ローカル設定の `secrets.<名前>` が優先 |
| `LOC_STUDIO_SDK_PATH` | CLI | プラグインが import する `@loc-studio/sdk` の入口を指定する（テストなどで使う） |
| `LOC_STUDIO_DEBUG` | CLI | 設定するとエラー時にスタックトレースも出す |
| `LOC_STUDIO_DESKTOP` | 画面 | `1` でデスクトップの殻から起動されたことを示す。デスクトップ版が設定するもので、利用者は設定しない |
| `LOC_STUDIO_BIND_HOST`、`LOC_STUDIO_INTERNAL_SECRET` | 画面 | 起動の仕組みが設定する内部の値（待ち受けたアドレスと、接続元のアドレスを渡すヘッダーの合言葉）。利用者は設定しない |
| `LOC_STUDIO_TEST_PG_URL`、`LOC_STUDIO_TEST_PG_BIN` | `packages/store` のテスト | Postgres のテストに使うサーバー、または `initdb` / `pg_ctl` の場所（[packages/store/README.md](../packages/store/README.md#テスト)） |

このほかに、画面の起動に `PORT`（既定 3000）、ローカル設定の場所の決定に `APPDATA`（Windows）と `XDG_CONFIG_HOME`（Linux）、ユーザー名の既定の決定に PC 名（`os.hostname()`、取れなければ `COMPUTERNAME` / `HOSTNAME`）と OS のユーザー名（取れなければ `USER` / `USERNAME`）を使います。デスクトップ版は内部で `ELECTRON_RUN_AS_NODE` を使います。

プラグインには、プロセスの環境変数が `host.env` として渡されます（例: `examples/remote-project` は API の場所を `EXAMPLE_API_URL` で受け取ります）。Web モードでは、`host.env` とプロジェクト設定の `${env:NAME}` に使える名前は、サーバーの設定の `projects[].env` に並べたものだけです（[WEB-MODE.md](WEB-MODE.md#3-サーバーの設定ファイル)）。秘密情報 `LOC_STUDIO_SECRET_<名前>` はこの制限を受けませんが、読めるのは `host.secrets.get` からだけです。`host.env` には、`LOC_STUDIO_SECRET_` で始まる名前と、`LOC_STUDIO_LOCAL_TOKEN`、`LOC_STUDIO_INTERNAL_SECRET`、`LOC_STUDIO_ADMIN_USER`、`LOC_STUDIO_ADMIN_PASSWORD` は、ローカルモードでも Web モードでも入りません。CLI の `plugins` / `tree` / `validate` / `whoami` だけは例外で、サービス層を通さないため、`host.env` にプロセスの環境変数がそのまま入り、`host.secrets.get` は環境変数だけを読みます（[plugins/host.md](plugins/host.md#cli-の-plugins--tree--validate--whoami-での違い)）。
