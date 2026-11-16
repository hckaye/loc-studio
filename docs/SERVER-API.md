# サービス層（`packages/server`）の仕様

画面（`apps/web`）と、コマンドライン（`apps/cli`）の `generate` / `run` / `status` / `save` / `set` は、このサービス層を通して動きます（コマンドラインの `plugins` / `tree` / `validate` / `whoami` は、`@loc-studio/core` を直接使います）。サービス層はフレームワークに依存しません。すべてのメソッドは、JSON にできる引数を 1 つ受け取り、JSON にできる値を返します。画面はこれを 1 つの RPC の口（`POST /api/rpc/<method>`）で呼びます。Web モードの入口（`openServerRuntime`、認証、権限）と、HTTP の口とその守り（ホスト名、起動の合言葉、オリジン、本文の上限、HTTP の状態）は [WEB-MODE.md](WEB-MODE.md#10-api実装者向け) にあります。

```ts
export function createWorkspace(opts: WorkspaceOptions): Promise<Workspace>;

export interface WorkspaceOptions {
  projectRoot: string;
  appDir?: string;            // この下の plugins/ がアプリ層のプラグインフォルダ
  userDataDir?: string;       // ローカル設定とその PC の DB の置き場所。既定は localSettingsPath() のフォルダ
  env?: Record<string, string | undefined>;
  cliSettings?: Record<string, unknown>;   // 起動引数由来のローカル設定（"user.name" など）
  sdkPath?: string;
  extraBuiltins?: Plugin[];   // builtinPlugin と llmPlugin に加えて登録するもの
  revisionCheckIntervalMs?: number;  // リソースの版を確かめる間隔。既定 3000、0 で毎回
  pluginTrust?: "prompt" | "always"; // 既定 "prompt"（下の「プラグインの信頼」）
  localPlugins?: boolean;             // false で個人の設定フォルダ（local 層）のプラグインを読まない（Web モード）。既定 true
  userSettings?: UserSettingsStore;   // CallContext のある呼び出しで、ローカル設定の代わりに使う利用者ごとの設定（Web モード）
  webMode?: { allowedEnv: string[]; pluginDirRoots: string[]; sensitivePaths?: string[] };  // Web モード: ${env:} とホストの env に見せる名前、プロジェクトのプラグインフォルダの基準、伏せるパス
}
export interface UserSettingsStore { get(userName: string): Promise<Record<string, unknown>>; set(userName: string, values: Record<string, unknown>): Promise<void> }

export interface Workspace extends WorkspaceApi {
  readonly project: Project;  // @loc-studio/core
  waitForJob(id: string): Promise<JobInfo>;   // コマンドライン用。RPC では公開しない
  /** 独自描画のモジュール（.js / .mjs）。読み込んだ（信頼された）プラグインに登録されたものだけ。それ以外は undefined。RPC では公開しない */
  rendererModule(id: string): Promise<{ source: string; hash: string; contentType: "text/javascript" } | undefined>;
  /** fn を利用者 call の呼び出しとして実行する（dispatch が使う） */
  withCall<T>(call: CallContext, fn: () => Promise<T>): Promise<T>;
  /** 設定ファイルやコードの設定を信頼するまでの制限された状態か（下の「プラグインの信頼」） */
  readonly restricted: boolean;
  /** 管理者でない呼び出しに返す値から伏せるパスと、伏せたエラーの詳細を書く先（dispatch が使う） */
  redaction(): { paths: { prefix: string; label: string }[]; log(message: string): void };
  close(): Promise<void>;
}

/** RPC で公開するメソッド名の一覧（許可リスト）。 */
export const WORKSPACE_METHODS: readonly (keyof WorkspaceApi)[];

/**
 * RPC の口（rpc.ts）。WORKSPACE_METHODS にない名前は not-found。ApiError、StoreConflictError（→ conflict）、LockTimeoutError（→ locked）、その他（→ failed）をエラーの形にする。
 * call（Web モードの利用者）を渡すと、METHOD_CAPABILITIES で権限を確かめ（足りなければ forbidden）、呼び出しの間の記録をその利用者の名前で残す。
 * call がなければローカルモード（すべて許す。従来どおり）。
 */
export function dispatch(workspace: WorkspaceApi, method: string, params: unknown, call?: CallContext): Promise<{ result: unknown } | { error: { code; message; data? } }>;

export interface CallContext { user: { name: string; displayName?: string }; role: "viewer" | "translator" | "reviewer" | "manager"; languages?: string[]; admin?: boolean /* サーバーの管理者 */ }
```

引数のないメソッド（info など）も、RPC の都合で引数を 1 つ受け取り、無視します。

`createWorkspace` は次の順に処理します。

1. ローカル設定を読みます（`userDataDir` を指定したら `<userDataDir>/settings.json`、なければ `localSettingsPath(env)`）。
2. プロジェクト設定を読みます。
3. 設定の層（enforce / cli = `cliSettingsFromEnv(env)` + `cliSettings` / local / defaults / アプリの既定値）を作り、ユーザー名を決めます（enforce と defaults は、プロジェクト設定の `localSettings` から来ます）。
4. 共有 DB とその PC の DB を開きます。共有 DB は、`storage.driver` が `"postgres"` なら `openPostgresStore`（`storage.url` と `storage.schema`。`url` の `${env:NAME}` を展開）、それ以外は `openStore`（`storage.path`。省略時は `<projectRoot>/.loc-studio/meta.db`、`${env:NAME}` を展開）で開きます。その PC の DB は、常に SQLite の `<userDataDir>/projects/<projectRoot の SHA-256 の先頭 16 桁>/local.db` です。
5. `createPluginHost` を作ります（db は共有 DB）。共有 DB とホストは同じ関数でユーザー名を読むので、設定の変更は次の書き込みから記録に反映されます。
6. `openProject(projectRoot, { builtins: [builtinPlugin, llmPlugin, ...extraBuiltins], host, ... })` でプロジェクトを開きます。

## 用語

| 用語 | 意味 |
| --- | --- |
| セルの ID | entry スコープの列は `columnId`、language スコープの列は `columnId@languageId` |
| 本文の版 | 本文の SHA-256（16 進）。`basisHash` に使う |
| ドラフト | 未保存の本文の編集。その PC の DB の `cells("core.drafts")` に置く |

## 型

```ts
export interface ProjectInfo {
  name: string;
  root: string;
  languages: LanguageDef[];
  columns: ColumnDef[];                       // 解決済み。並び順どおり
  languageSets: Record<string, LanguageId[]>;
  grid: { pinCommon: boolean; maxPinnedRatio: number; progressColumn?: string; progressUnit: "rows" | "characters" | "words" };   // progressUnit は進捗の数（stats の progress）の単位
  user: { name: string; source: SettingSource; locked: boolean };
  storage: { path: string; shared: boolean };
  actions: ActionInfo[];
  reviewTargets: ActionInfo[];                // 設定 review.targets のレビュー先
  validators: { id: string; label: string }[];
  blockComplete: Severity | false;
  warnings: string[];
  pluginErrors: PluginLoadError[];
  untrustedPlugins: number;                   // 信頼の確認を待っているプラグイン、コードの設定、設定ファイルの数
  restricted?: boolean;                       // 制限された状態（設定ファイルやコードの設定を信頼するまで）のとき true
  permissions: Permissions;  // 呼び出した利用者ができること（ローカルモードではすべて）。形は「Web モード」の節
  roles: { id: string; label: string }[];  // 割り当てに選べる役割
  editor: { referenceLanguages: LanguageId[]; referenceColumns?: string[]; count: { unit: "codepoints" | "utf16" | "bytes" | "width"; skipTokens: boolean } };  // 編集画面の設定（解決済み）
  renderers: { id: string; pluginName: string; hash: string }[];   // 読み込んだプラグインの独自描画。hash はモジュールのファイルの SHA-256
  changeSeq: number;
  localSettings: Record<string, unknown>;     // 解決済みのローカル設定の値（秘密情報は settings() と同じく伏せる）
}
export interface ActionInfo { id: string; label: string; icon?: string; target: Action["target"]; columns?: string[]; languages?: LanguageId[] }

export interface TreeNodeInfo { id: string; name: string; kind: "folder" | "resource"; children?: TreeNodeInfo[]; resource?: ResourceRef; unsaved?: number }

export interface ResourceStats {
  resourceId: string;
  entries: number;
  unsaved: number;
  /** enum 型の列（レビュー列を含む）ごと・言語ごとの進捗。complete の選択肢の数 / 全体。対象の値が変わった印の付いた値は complete に数えない。entry スコープの列は言語の位置に "*"。 */
  progress: Record<string /* columnId */, Record<LanguageId, { complete: number; total: number }>>;
  issues: { error: number; warning: number; info: number };
}

export interface IssueInfo { validatorId: string; code: string; message: string; severity: Severity; range?: { start: number; end: number }; fix?: { label: string; value: string } }

export interface CellInfo {
  value: unknown;                 // 本文はドラフトがあればドラフトの値
  saved?: string;                 // 本文のみ: リソースに保存されている値（ドラフトがあるとき）
  draft?: boolean;                // 本文のみ: 未保存
  draftBy?: string;               // 本文のみ: 未保存の編集を書いた人
  version?: number;
  updatedAt?: string;
  updatedBy?: string;
  comment?: string;               // 列ソースが値に添えたコメント（レビュー列なら、最新の投稿のコメント。空なら付かない）
  stale?: boolean;                // basisHash が、対象の列のいまの値の版と違う（レビュー列、basis: "text" の列、生成列）
  needsRecheck?: boolean;         // 本文のみ: 最後に編集したあとで、基になる言語の本文が変わった
  issues?: IssueInfo[];           // 本文のみ
  generated?: "fresh" | "stale" | "missing";   // 生成列のみ
  error?: string;                 // 計算列のみ: compute が返した error、または投げた例外のメッセージ
  basisHash?: string;             // 値を付けた時点の対象の版（textVersion で全文を引ける）
}
export interface RowInfo { key: string; index: number; cells: Record<string, CellInfo> }

export interface RowsRequest {
  resourceId: string;
  languages: LanguageId[];        // 表示中の言語だけ読み込む
  offset: number;
  limit: number;
  search?: string;                // キーと、表示中の言語の本文の部分一致（大文字小文字を区別しない）
  sort?: { cellId: string; dir?: "asc" | "desc" };   // 並べ替え。省略時はリソースの中の順。数値は数の順、選択式の列は選択肢の並び順、ほかは文字の順（文字の中の数字は数として比べる）。値のない行は最後
  filters?: { cellId: string; values?: unknown[]; contains?: string }[];   // 列の値での絞り込み。values: どれかと同じ（未設定は列の type.default とみなす）。contains: 値を文字にしたものに含む（大文字小文字を区別しない）
  onlyUntranslated?: boolean;     // 表示中の言語のどれかの本文が空
  onlyIssues?: Severity;          // 表示中の言語のどれかに、この重さ以上の問題がある
  onlyStale?: boolean;            // 表示中の言語に stale か needsRecheck のセルがある
  onlyUnsaved?: boolean;          // どれかの言語（表示していない言語も）に未保存の本文がある
}
export interface RowsResponse { total: number; totalAll: number; rows: RowInfo[]; revision?: string; diagnostics: Diagnostic[] }

export interface HistoryInfo { id: string; at: string; by: string; cellId: string; oldValue: unknown; newValue: unknown; cause: "manual" | "action" | "bulk" | "external" | "review" | "generate"; causeRef?: string }
export interface ReviewInfo extends ReviewPost { stale: boolean; warnings?: string[] /* 投稿直後の転載の問題 */ }

export interface SettingInfo { key: string; value: unknown; source: SettingSource; locked: boolean }
export interface PluginInfo { name: string; version?: string; layer: PluginLayer; path?: string; provides: Record<ExtensionKind, string[]> }
export interface JobInfo { id: string; kind: "generate" | "action" | "validate"; label: string; status: "queued" | "running" | "done" | "failed" | "cancelled"; total: number; done: number; failed: number; skipped: number; startedBy: string; startedAt: string; finishedAt?: string; error?: string }

/** 失敗は ApiError で投げる。RPC 層は { error: { code, message, data } } にして返す。 */
export class ApiError extends Error { code: "not-found" | "conflict" | "invalid" | "blocked" | "locked" | "failed" | "forbidden" | "unauthorized" | "throttled" | "untrusted"; data?: unknown }
// forbidden: 権限がない（Web モード） / unauthorized: ログインしていない・ログインの失敗 / throttled: ログインの失敗が続いた、混んでいる、ジョブが多すぎる（data.retryAfterMs があることがある。同じアドレスからのログインが重なったときは data.reason が "address-busy"） / untrusted: 制限された状態で使えないメソッド
```

## メソッド（`WorkspaceApi`）

### 読み取り


- `info(): ProjectInfo`
- `tree(): TreeNodeInfo[]`: 構造と未保存の件数だけ（速い）。
- `stats({ resourceIds }): ResourceStats[]`: `resourceIds` は 500 個まで（重複は除く。超えたら `invalid`）。重いので画面は裏で少しずつ呼ぶ。結果はリソースの版と DB の変更番号が同じ間キャッシュする。
- `rows(req: RowsRequest): RowsResponse`: `limit` は 2000 までに切り詰め、`filters` は 50 個まで（超えたら `invalid`）、`languages` の重複は除く。`where` は条件式で、かつ・または・否定を組み合わせられる（書き方は [QUERY.md](QUERY.md#条件式の書き方)。4,000 文字、条件 200 個まで。書き方や列の誤りは、リソースを読む前に `invalid`）。ページの分だけ列ソースを読み、バリデーションする。絞り込みがあるときだけ、必要な列の値を全行ぶん読む。
- `rowDetail({ resourceId, key }): { row: RowInfo; languages: LanguageId[] }`: 全言語・全列。
- `history({ resourceId, key, cellId?, limit? }): HistoryInfo[]`: `limit` は 1000 までに切り詰める。
- `reviews({ resourceId, key, cellId }): ReviewInfo[]`
- `textVersion({ hash }): { text?: string }`: 本文の版（SHA-256）から、その時点の全文を `kv("core.text-versions")` で引く。レビューの basisHash や履歴の版に使う。
- `validateText({ resourceId, key, language, value }): IssueInfo[]`: 保存せずに 1 つのセルの本文を確かめる（入力中の確認用）。バリデータ、記法、重さの決め方は保存済みの本文と同じで、基の言語の本文はいまの値（ドラフト込み）。ドラフト、結果のキャッシュ、履歴、変更番号には触らない。知らないキー・言語・リソースは `not-found`。
- `search({ query, languages?, limit? }): { resourceId: string; key: string; language?: LanguageId; snippet: string }[]`: リソースをまたぐ検索。
- `query(req: QueryRequest): QueryResponse`: リソースをまたいで、条件に合う行を数え、集計し、一覧にする。条件は `rows` と同じ（`search`、`filters`、`where`、`onlyUntranslated`、`onlyIssues`、`onlyStale`、`onlyUnsaved`。条件どうしは「かつ」）。`resourceIds` を省くと、見えるすべてのリソースが対象（10,000 個まで。見えないリソースや、ないリソースを名指しすると `not-found`）。`resourceIds: []` は、リソースを読まずに条件の書き方だけを確かめるのに使える。戻り値は、`matched`（合う行の数と、原文の文字数・語数）、`totalRows`（対象の行の数）、`resources`（リソースごとの `matched` と `total`。合う行が 0 のものも入る）、`unreadable`（読めなかったリソース。ほかのリソースは続ける）、`groups`（`groupBy` を書いたときの集計）、`rows`（`offset` から `limit` 個。`limit` の既定は 0 で、2000 までに切り詰める。並びは、リソースの順、その中の行の順）。`cells` は返すセルの ID（500 個まで。省略時は、`languages` のすべての列。キーの列は入れない）。`groupBy` は 4 つまでで、1 つの値に決まる欄だけが使える（`textStatus@ja`、`resource`、`issues@en` など。言語を省いた言語ごとの列と `@any` / `@all` は `invalid`）。集計は、選択式の列は選択肢の順、`issues` は重さの順、そのほかは値の順に並び、空の値は最後の 1 つの組になる（`values` は `null`、`labels` は「（空）」）。原文の量は、最初の原文の言語（`basedOn` のない最初の言語）の本文（未保存の編集を含む）で量る。
- `exportQuery(req: QueryRequest & { format: "csv" | "tsv"; table?: "rows" | "groups" }): { text: string; rows: number; truncated: boolean }`: `query` の結果を CSV / TSV の文字列にする。`table: "rows"`（既定）は、見出しが `resource`、`key`、セルの ID の行の一覧（200,000 行まで。超えたら打ち切って `truncated: true`）。`table: "groups"` は、見出しが `groupBy` の欄、`rows`、`characters`、`words` の集計（`groupBy` がなければ `invalid`）。区切り文字、引用符、改行を含む値と、前後に空白のある値は引用符で囲み、行の終わりは CRLF。BOM は付けない。
- `uiState(): { state: Record<string, unknown> | null }`: 画面の状態（開いていたリソース、絞り込み、並べ替え、列の表示、お気に入りの条件など）。その PC の DB（`local.db` の `kv("core.ui-state")`）に、プロジェクトごとに置く。Web モードでは、呼び出した利用者ごとに分ける。中身の形は画面が決め、サービス層は見ない。保存したことがなければ `null`。
- `tokens({ resourceId, texts }): TextToken[][]`: 本文を、そのリソースの記法でトークンに分ける（`texts` と同じ順・同じ数）。画面の色分けと、変数の差し込みに使う。`texts` は 200 個、合わせて 100 万文字まで。
- `settings(): { local: SettingInfo[]; localFile: string; project: ProjectConfig; projectFromCode: string[]; projectFile: string; available: { columns: { id; label?; kind; scope }[]; validators: { id; label }[] } }`: `available` は、設定の `columns` / `validators` に名前（`use`）で書ける、登録済みの列と検証（設定で使っていないものも含む）。設定の画面が、足せる列と検証の選択肢に使う。制限された状態では空
- `plugins(): { plugins: PluginInfo[]; dirs: { dir: string; layer: PluginLayer; exists: boolean }[]; errors: PluginLoadError[]; warnings: string[]; untrusted: { kind: "plugin" | "config" | "settings"; path: string; layer: PluginLayer; hash: string; files: string[]; summary?: SummaryRow[] }[] }`: `untrusted` は信頼の確認を待っているプラグイン、コードの設定、設定ファイル（`files` はハッシュに入れたファイルの絶対パス）。`summary` は `kind: "settings"` のときだけあり、確認の画面に出す要約（`SummaryRow { label; value; host?; note? }`）。基盤の項目をすべて、options は葉ごとに 1 行で出す（`label` は「生成器 backTranslation の options.endpoint」のような項目のパス、`value` は JSON のスカラー。文字列は引用符つき）。値は展開する前の書かれたままの形で、接続文字列のパスワードは `****` に伏せる。ネットワークの URL として読める文字列には `host`（実際の接続先のホストとポート。`http:/host`、`http:\\host`、`user@host` の形でも本当の行き先）を付ける。`postgres:` / `postgresql:` / `socket:` の URL では、`host` はドライバー（`pg-connection-string`）と同じ決め方の接続先で、クエリの `host` / `port` が `//` のあとより優先される。ソケットのディレクトリはそのパスを、ホストやポートがないときは既定の `localhost` / `5432` を出し、それぞれ注意（PGHOST / PGPORT で変わることがある）を付ける。`hostaddr` は接続先を変えず（このアプリのドライバーは使わない）、注意を付ける。クエリの `host`、`hostaddr`、`port`、`sslrootcert`、`sslcert`、`sslkey`、`options`、`service`、`target_session_attrs` は、どれも「… の ?host」のような自分の行を必ず出す。この決め方は、`packages/store/src/pg-destination.test.ts` が 16 個の URL で `pg-connection-string` の `parse()` と比べている。`note` は、URL のユーザー情報、環境変数で決まる接続先やパス、秘密情報の名前らしい項目名（`secret`、`token`、`password`、`credential`、`api[-_]?key` を大文字小文字を区別せずに含むもの、英小文字か数字のあとに大文字の `Key` で終わるもの（`apiKey`、`accessKey`）。`key`、`hotkey`、`monkey` は含まない）の注意。制御文字と書字方向の制御文字は `<U+XXXX>`、500 文字を超える値は印を付けて切る。1 つの項目で葉が 40 を超えるときは、最初の 40 行、残りの数の行、残りのうち URL・パス・`${env:` を含む葉を出す。ツリー、生成器、アクション、列ソース、レビュー先のどれかがあれば、最後に秘密情報についての行を足す（`packages/core/src/settings-trust.ts`）。
- `validate({ resourceIds?, languages? }): { resources: { resourceId: string; issues: (IssueInfo & { key: string; language?: string; cellId: string })[]; diagnostics: Diagnostic[]; error?: string }[]; summary: { error: number; warning: number; info: number; cells: number } }`: 一括のバリデーション（コマンドライン向け）。省略時は全リソース・全言語。各リソースは最新の中身を読み直して確かめる（本文はドラフト込み）。読めない・解析できない・知らないリソースはそのリソースの `error` に出し、ほかは続ける。`cells` は問題が 1 つ以上あるセルの数。知らない言語は `invalid`。
- `jobs(): JobInfo[]`、`job({ id }): JobInfo`
- `changes({ since }): { changeSeq: number; changed: boolean; localSeq: number }`: 共有 DB の変更番号（changed は since と違うか）。`localSeq` はこのワークスペースを通した変更（ドラフトを含む）のたびに増えるメモリ上の番号。画面は数秒ごとに呼び、どちらかが進んでいたら表示中の行を読み直す。

### 書き込み


- `setText({ resourceId, key, language, value, baseValue? }): { cell: CellInfo; unsaved: number }`: ドラフトに積む。`baseValue`（編集を始めたときの値。ドラフトがあればドラフトの値）を渡すと、いまの値（ドラフト込み）が違い、かつ新しい値とも違うときは上書きせずに `conflict`（data: `{ value: いまの値, by?: 変えた人 }`。by はドラフトを書いた人、ドラフトがなければその本文の最後の履歴の人）。省略すると、この確認をせずに上書きする。ドラフトには書いた人を残す（`CellInfo.draftBy`）。保存済みの値と同じになったらドラフトを消す。読み取り専用の言語（`editable: false`）は `blocked`。
- `discardDrafts({ resourceId, keys? }): { unsaved: number }`
- `save({ resourceId }): { saved: number; conflicts: { key: string; language: LanguageId }[] }`: ドラフトを `Format.apply` で書き戻し、`TreeProvider.write` する。外部で書き換えられていたら読み直してからドラフトを当て直す。ドラフトを作ったときの保存済みの値と、いまのリソースの値が違うセルは競合として書かずに残す。書いたセルは、履歴（cause: manual）と、基になる言語の本文の版（needsRecheck 用）を記録する。
- `saveAll(): { resources: number; saved: number; conflicts: number; conflictList: { resourceId: string; key: string; language: string }[] }`
- `setCell({ resourceId, key, cellId, value, expectedVersion? }): CellInfo`: 列ソースに保存する。本文の列には使えない（`setText` を使う）。`basis: "text"` の列は、その言語の本文の版を basisHash に付ける。版が合わなければ `conflict`（data にいまの値）。`blockComplete` が有効で、complete の選択肢への変更かつその言語の本文にその重さ以上の問題があれば `blocked`。履歴に記録する。
- `setCells({ resourceId, keys, cellId, value }): { updated: number; blocked: string[] }`: 複数行の一括変更（cause: bulk）。`blockComplete` で止められた行は書かずに `blocked` にキーを返す。
- `postReview({ resourceId, key, cellId, verdict, comment, forward? }): ReviewInfo`: レビュー列の出所の `postReview` を呼ぶ。basisHash は対象の列（`of`）のいまの値の版。`requireComment` の選択肢でコメントが空なら `invalid`。履歴に記録する（cause: review）。そのあと、設定 `review.targets` のレビュー先（`target: "review"` のアクション）へ転載する: ローカル設定 `review.forwardOnPost` が `always`、または `ask` で `forward` が true のとき。転載の失敗は投稿を失敗にせず、結果の `links` が増えないだけにして、警告を `warnings` に残す。
- `forwardReview({ resourceId, key, cellId, reviewId, actionId }): ReviewInfo`: 手動の転載。`actionId` は設定 `review.targets` にあるアクションだけ（登録されていても設定にないものは `not-found`）。すでにそのアクションのリンクがあれば何もしない。
- `runAction({ actionId, resourceId, keys?, filter?, cellId?, language? }): { matched?: number; message?: string; open?: ActionResult["open"]; patched: number; jobId?: string; errors?: string[] }`: `target` が cell / row なら各行に対して実行し、返ってきた patches を `setText` / `setCell` と同じ規則で反映する（cause: action）。selection / file / column は 1 回だけ呼ぶ。対象が 20 行を超えるときはジョブにして `jobId` を返す。本文への patch は `setText` と同じくドラフトに積む（保存時の履歴の cause は action、causeRef はアクション id）。反映できなかった patch は `errors` に理由を返す（ほかの patch は反映する）。cell / row には keys か filter が必要、cell / column には cellId が必要。`target: "review"` のアクションは forwardReview で使う。`filter`（`RowFilter & { languages }`。`rows` / `query` と同じ条件）を渡すと、keys の代わりに、そのリソースの条件に合う行を対象にする（cell / row は合う行ごとに、selection は合う行をまとめて 1 回）。結果の `matched` は、条件に合った行の数。合う行がなければ、アクションを呼ばずに `{ patched: 0, matched: 0 }` を返す。keys と filter の併用、file / column のアクションへの filter は `invalid`。リソースをまたいで実行するときは、呼び出す側が `query` の `resources`（合う行のあるリソース）を順に回す（画面の「一括アクション」と、コマンドラインの `run --where` がそうしている）。
- `generate({ columnId, scope: "cell" | "selection" | "resource" | "project", resourceId?, keys?, languages?, dryRun? }): { jobId?: string; total: number; cached: number; toRun: number }`: 生成列の生成。`dryRun` なら件数だけ返す。キャッシュにある分は飛ばす。結果は `kv("core.generated")` に置き、セルごとに「最後に使った鍵と入力の版」を `cells("core.generated-cells")` に置く。1 件ずつ書くので、中断しても済んだ分は残る。`total` は入力のあるセルの数（`input` が null のセルは数えない）。同じ入力のセルは 1 回だけ生成器に渡す。ジョブは `batchSize`（既定 10）、`concurrency`（既定 1）、`retries`（既定 0）に従い、`cancelJob` はバッチの合間に止める。キャッシュの鍵 ＝ SHA-256(版の印 ＋ 生成器 id ＋ version ＋ stableStringify(cacheParams(options)) ＋ stableStringify(入力))。生成列の `generator` は設定 `generators` の名前（なければ生成器の id として引く）。
- `cancelJob({ id }): JobInfo`
- `editEntries({ resourceId, changes }): { entries: number; revision?: string }`: 行を足す・消す・キーを変える。`changes` は `{ type: "add", key, after?, text?, meta? }`、`{ type: "remove", key }`、`{ type: "rename", key, newKey }` の配列（1000 個まで）で、書いた順に当て、すぐリソースに書く。途中の変更が当てられなければ、1 つも書かない（`failed`）。フォーマットが行の変更に対応していないときも `failed` で、リソースは変えない。キーの変更では、未保存の編集、履歴、要再確認の記録、生成の記録を新しいキーに移し、列ソースの `onEntriesChanged` を設定の名前ごとに 1 回呼ぶ。削除では未保存の編集だけを捨て、共有 DB の記録は残す。フックは `entries.change` と `resource.write`。
- `createResource({ path }): { resource: ResourceRef }`: 行のない新しいリソースを作る（`Format.create` と `TreeProvider.create`）。`path` は区切りが `/` の相対的な書き方だけ（`..`、絶対パス、`\` は `invalid`）。すでにあれば `conflict`。ツリーかフォーマットが作成に対応していなければ `invalid`。役割の `resources` で見えない場所は `forbidden`。

ジョブを作るメソッド（`generate`、ジョブになる `runAction`）は、実行中・待機中のジョブが利用者ごとに 3 つ、ワークスペースごとに 20 個に達していたら `throttled`。
- `setLocalSetting({ key, value }): SettingInfo[]`: 固定された項目は `locked`。`null` で削除。`user.name` を変えたら以後の記録に反映する。`secrets.<名前>` は秘密情報（一覧では伏せる。環境変数より優先）。`review.forwardOnPost` は `always` / `ask`（アプリの既定）/ `never`。
- `setUiState({ state }): { saved: boolean }`: 画面の状態を保存する（`null` で消す）。オブジェクトでない値と、JSON にして 524,288 文字を超える状態は `invalid`。自分の状態だけを変えるので、読むだけの役割でも呼べる。
- `updateProjectSettings({ patch }): ProjectInfo`: `loc-studio.project.json` の最上位のキーを置き換える（null で削除）。コードの設定にあるキーは `locked`。書いたあと設定とプラグインを読み直す。読み直せない設定なら、ファイルを元に戻して `invalid`。`storage` の変更はワークスペースを開き直すまで反映しない。`"prompt"` のときは、更新のために読んだファイルの中身で基盤の項目が信頼済みなら、書いたあとの内容を自動で信頼する。読めない、または JSON として解析できないファイルは、`failed` で何も書かない。書く前の内容が信頼済みでなければ（アプリの外で変わっていた）、patch は書くが信頼はせず、ワークスペースは制限された状態に切り替わる（戻り値の `restricted` が `true`）。Web モードで `call.admin` でない呼び出しは、`name`、`languages`、`columns`、`validators`、`validation`、`languageSets`、`grid`、`localSettings` だけを変えられる。`storage`、`pluginDirs`、`tree`、`formats`、`syntaxes`、`sources`、`generators`、`actions`、`review` を含む patch は全体を `forbidden`（`data.keys`）、設定にない項目は `invalid`（`data.keys`）。
- `reloadPlugins(): ProjectInfo`
- `trustPlugins({ items: { path, hash }[] }): ProjectInfo`: `plugins().untrusted` のプラグイン、コードの設定、設定ファイルを信頼する。`hash` には利用者が確かめたときの値（`untrusted[].hash`）を渡す。いまのハッシュが違えば `conflict`（`data: { path, hash: いまのハッシュ }`）。確認待ちでないパスは `not-found`。古い `{ paths }` の形は `invalid`。ハッシュをローカル設定 `plugins.trust` に残して読み直す。
- `untrustPlugins({ paths }): ProjectInfo`: 信頼を取り消して読み直す（記録のないパスは無視）。
- `reloadResource({ resourceId }): { revision?: string }`: キャッシュを捨てて読み直す。

## 実装の決まり

- リソースの読み書きは `project.readDocument` / `project.applyChanges` など `Project` 経由だけ。`fs` でリソースに触らない（リソースがネットワークの向こうにある実装でも動くこと）。
- 解析したドキュメントはリソースごとにキャッシュする。読み込みは `project.readDocument`（中身と版を一緒に返す。`TreeProvider.readWithRevision` があれば 1 回の呼び出し、なければ `revision` → `read`）。
- 版の確認（`TreeProvider.revision`）は、リソースごとに `revisionCheckIntervalMs`（既定 3000 ミリ秒）に 1 回まで。その間の `rows` / `rowDetail` などはキャッシュを使う（ネットワークの向こうのリソースで、表示のたびに API を呼ばないため）。0 で毎回確かめる。`save`（とファイル内の列の書き込み）は毎回読み直し、`reloadResource` は必ず読み直す。版が変わっていたら読み直す。`revision` がない実装では、明示の読み直しと保存のときだけ更新する。
- 書き込みは、読んだときの版を `expectedRevision` にして `project.writeBytes` で行う。TreeProvider が `RevisionConflictError` を投げたときだけ読み直して当て直す（最初を含めて 3 回まで。超えたら `conflict`）。ほかの失敗（認証、通信、5xx など）はやり直さず、すぐ `ApiError("failed")` にする（メッセージに TreeProvider のメッセージをそのまま含める）。どちらの場合もドラフトは消さない。プラグインの SDK が別のモジュールとして読まれることがあるので、判定は `instanceof` に加えてエラーの `name` も見る。
- 5 万行のリソースで `rows`（絞り込みなし、limit 200）が 100 ミリ秒程度で返ること。行ごとに DB を呼ばず、ページ単位でまとめて呼ぶ。
- 生成列の値と状態は `rows` で一緒に返す（キャッシュにあれば値、入力の版が違えば stale）。
- 履歴は `host.db.log("core.history")` に、cell 付きで追記する。本文の版の中身は `kv("core.text-versions")`（鍵 ＝ 版、値 ＝ 全文）に置き、レビューや履歴から「その時点の本文」を引けるようにする。
- ユーザー名は `resolveUserName`（enforce、cli、local、defaults、PC 名の順に探し、最初に見つかったもの）。記録にはその時点の名前を文字列で残す。
- 同時に 2 つの書き込みが走っても壊れないよう、リソースごとの保存は直列にする（setText / discardDrafts / save / ファイル内の列の書き込み）。
- ドラフト: `cells("core.drafts")`（その PC の DB）、セル ＝ リソース ＋ キー ＋ 本文の列 ＋ 言語、値 ＝ `{ value, savedHash, cause, causeRef? }`。savedHash はドラフトを作ったときの保存済みの本文の版。CellStore に削除がないので、消したドラフトは値 null で上書きする。保存は毎回リソースを読み直し、いまの本文の版が savedHash と違い、ドラフトとも違うセルを競合にする（いまの本文がドラフトと同じなら競合にせずドラフトを消す）。書く前に版が変わったら（`RevisionConflictError`）読み直して当て直す（上の規則）。
- 要再確認: 訳文（`basedOn` のある言語）を保存したとき、保存後の基の言語の本文の版を共有 DB の `cells("core.text-basis")` に残す。記録があり、いまの（保存済みの）基の本文の版と違えば `needsRecheck`。ツールで保存していない訳文には付けない。設定の `validation.recheck` が `false` のときは、記録は続けるが、`needsRecheck` を付けず、`onlyStale` の絞り込みにも入れない。
- stale: レビュー列は最新の投稿の basisHash と、対象の列（`of`）の同じ言語のいまの値の版（本文と文字列の値はそのままの SHA-256、それ以外の値は stableStringify した値の SHA-256）を比べる。`basis: "text"` の列は同じ言語の本文（ドラフト込み）と比べる。basisHash のない値は stale にしない。
- 値のない enum の列は `type.default`（版なし）として返す。
- 出所がファイル（`source` なし、または `"file"`）の meta 列は `setCell` ですぐリソースに書く（`expectedVersion` は使わない）。
- レビュー先への転載は `kv("core.review-forwards")`（鍵 ＝ 投稿 id ＋ アクション id）に記録し、同じアクションへの 2 回目は何もしない。
- 終わったジョブは共有 DB の `log("core.jobs")` に残す。ジョブは 1 つずつ実行する。
- `storage: { driver: "postgres", url: "${env:…}", schema? }` なら、共有 DB を `openPostgresStore` で開く（その PC の DB は SQLite のまま）。`url` がなければ開くときにエラー。`info().storage.path` は接続文字列（パスワードは `****` に伏せる）、`shared` は `true`。
- 計算列（`kind: "computed"`）: `rows` / `rowDetail` で返す行だけ `column.compute` を呼ぶ（entry スコープは行に 1 回、language スコープは表示中の言語ごと。`text` はドラフト込みの本文、`options` は列の `options`）。結果の `value` を `CellInfo.value` に、`error` を `CellInfo.error` に入れる。`compute` が投げたら、そのセルだけ `error` にして表は返す。読み取り専用（`setCell` は `invalid`）で、`filters` に使える（絞り込みのときは対象の全行で計算する）。
- `localSettings.enforce` に固定できない項目（`secrets.*`、`plugins.trust*`）があれば、無視したうえで `ProjectInfo.warnings` に名前を出す。

## Web モード（呼び出しごとの利用者と権限）

詳しくは [WEB-MODE.md](WEB-MODE.md) にあります。サービス層の決まりは次のとおりです。

- `dispatch(ws, method, params, call)` は、まず `METHOD_CAPABILITIES[method]` の権限を役割が持つか確かめ、次に `ws.withCall(call, …)` の中でメソッドを呼ぶ。呼び出しの間（そこから始まったジョブも含めて）、共有 DB・その PC の DB・プラグインのホストのユーザー名は `call.user.name` になる（AsyncLocalStorage）。
- 書き込みの直前にも、役割と言語の制限を確かめる（アクションの変更点も同じ規則で、許されない変更点は `errors` に入る）。
- `call.admin` でない呼び出しの結果とエラーは伏せる（`packages/server/src/redact.ts`。内容は [WEB-MODE.md の 8 章](WEB-MODE.md#8-ローカルモードとの違い)）。
- `setLocalSetting` は利用者ごとの設定（`userSettings`）を書く。`user.name` と `secrets.*` は `forbidden`。`settings().localFile` は空文字。`user.name` は `{ value: アカウント名, source: "enforce", locked: true }`。
- `cancelJob`: ほかの人が始めたジョブを止められるのは、`manage` の権限がある役割だけ（ほかは `forbidden`）。
- 役割の定義は `ws.roles()`（同梱の役割に、設定の `roles` を重ねたもの）。`dispatch` はこれでメソッドの権限を確かめ、`withCall` が呼び出しの間の役割の定義にする。設定にない役割は、すべてのメソッドが `forbidden`。`call.admin` は、役割の定義にかかわらずすべてできる。
- 役割の `resources` で見えないリソースは、`ctx.docs.resource()` が `not-found` にする（リソースを受け取るメソッドは、必ずここを通す）。ツリー、検索、統計、一括の検証、プロジェクト全体の生成、`host.project.resources()` は、見えるリソースだけを対象にする。
- `ProjectInfo.permissions` は `{ role, roleLabel?, can: { edit, review, run, structure, manage }, unrestricted?, languages?, editColumns?, reviewColumns?, actions?, generators? }`。`unrestricted` は、ローカルモードとサーバーの管理者で `true`（役割の定義と、選択肢の `roles` に縛られない）。`ProjectInfo.roles` は、割り当てに選べる役割の `{ id, label }` の一覧。
- フックが返した変更（`cause: "hook"`）は、役割と、選択肢の `from` / `roles` を確かめずに反映する。記録に残る名前は、きっかけになった利用者のまま。

## 独自描画（CellRenderer）

- 列の `display`（`"link" | "progress" | "color" | "tags"`）と `renderer`（プラグインが登録した CellRenderer の id）は `info().columns` にそのまま出る。登録されていない `renderer` は警告。
- `info().renderers` は読み込んだ（信頼された）プラグインの独自描画。モジュールのファイルが .js / .mjs でない、プラグインのフォルダの外を指す（シンボリックリンクの実体も確かめる）、読めないものは出さずに警告にする。
- `Workspace.rendererModule(id)` はそのファイルの中身だけを返す（画面はこれを URL で配り、`import()` する。`hash` をキャッシュの区別に使う）。

## 新しいプロジェクトの作成

プロジェクトがまだないので、`WorkspaceApi` のメソッドではなく、パッケージの関数として出しています（`packages/server/src/new-project.ts`）。画面のローカルモード（`POST /api/session/inspect`、`POST /api/session/create`）と、コマンドラインの `init` が呼びます。Web モードの画面からは呼べません（どちらの口も 403）。

- `inspectProjectFolder({ root, encoding? }): FolderInspection`: 作る前にフォルダを確かめる。何も書かない。`root` は絶対パス（相対パスは `invalid`）。フォルダがなければ `exists: false`（失敗にしない）。フォルダでないものは `invalid`。すでに `loc-studio.project.json` か `loc-studio.config.*` があれば、その名前を `configFile` に入れる。CSV / TSV は、同梱のツリー（`builtin.globTree`）の既定と同じ決まりで探し、数を `totalResources` に、先頭の 30 個の見出しの行を `resources[].headers` に入れる。読めないファイル（文字コードが違うなど）は、`resources[].error` に理由を入れて続ける。`encoding` は同梱の CSV / TSV と同じ値（`auto` / `utf-8` / `utf-16le` / `utf-16be` / `shift_jis`）。
- `buildProjectConfig(input): object`: 設定を組み立てるだけで、書かない。
- `createProject(input, { localSettingsFile? }): { root, configFile, config, firstResource?, trusted }`: フォルダがなければ作り、`loc-studio.project.json` を書く。すでに設定ファイルのあるフォルダは `conflict` で、設定ファイルを変えない。入力の誤りは `invalid` で、フォルダも作らない。
  - `input.name`（必須）、`input.languages`（`{ id, label?, basedOn?, pinned? }` の配列。1 つ以上）。言語の ID は、半角の英数字で始まり、英数字と `-` `_` だけの 40 文字まで。`any` と `all`（条件式の語）は使えない。`label` が空なら ID を使う。
  - `input.statusColumn` / `input.reviewColumn`（既定は付ける）: 同梱の進捗の列とレビューの列を `columns` に書く。両方外すと `columns` を書かない（キーと本文だけになる）。
  - `input.whitespaceValidator` / `input.untranslatedValidator`（既定は付ける）: 同梱の空白の検証（`builtin.whitespace`）と未翻訳の検証（`builtin.untranslated`）を `validators` に書く。両方外すと `validators` を書かない。
  - `input.mapping`（`{ key?, text?, encoding? }`）: すでにある CSV / TSV の列の対応。既定（先頭の列がキー、言語 ID と同じ見出しが本文、文字コードは `auto`）と違うところがあるときだけ、`formats` に `builtin.csv` と `builtin.tsv` を同じ `options` で書く。同じ見出しを 2 つの役目に使うと `invalid`。
  - `input.firstResource`: 最初に作るリソースの場所。書き方（相対パス、`.csv` か `.tsv`）を確かめて返すだけで、作るのは呼び出し側が、開いたワークスペースの `createResource` で行う（フックとフォーマットを通すため）。
  - `localSettingsFile` を渡すと、書いた設定ファイルに基盤の項目（`formats`）があるとき、そのハッシュをローカル設定 `plugins.trust` に記録する（`trusted: true`）。記録するのは、いま書いた中身のハッシュだけ。

雛形に入れるものは、利用者が選んだ言語と、同梱の実装の選択だけにする（[ARCHITECTURE.md の 8 章](ARCHITECTURE.md#8-決め打ちにしているもの)）。

## プラグインの信頼

プロジェクトを開くと、プラグインフォルダのコードとコードの設定（`loc-studio.config.*`）が動きます。設定ファイル（`loc-studio.project.json`）は、保存先、プラグインのフォルダ、外部の接続先、使う環境変数を決めます。`pluginTrust: "prompt"`（既定。画面のローカルモード）では、project 層と local 層のプラグイン、コードの設定、設定ファイルの基盤の項目を、利用者が信頼するまで使いません（コードは import せず、設定は展開も接続もしません）。builtin 層と app 層（管理者がアプリの隣に置いたもの）は常に読み込みます。`"always"` はすべて確認なしで読み込みます（コマンドラインと Web モード）。

- 信頼はローカル設定 `plugins.trust` に `{ [projectRoot]: { [パス]: ハッシュ } }` で残す（固定できない項目。`settings()` の一覧と `ProjectInfo.localSettings` には出さず、`setLocalSetting` でも変えられない）。いまのハッシュが記録と同じときだけ読み込むので、書き換えたものは確認し直しになる。
- コードのハッシュは core の `packages/core/src/code-graph.ts` が作る。フォルダのプラグインは、フォルダの中のすべてのファイル（`node_modules` を含む）。シンボリックリンクは実体で確かめ、フォルダの外を指していればエラー。単一ファイルのプラグインは、そのファイルと、相対 import を推移的にたどったファイル（import した JSON なども含む）で、どれもプラグインのファイルがあるフォルダの中にあること。コードの設定も同じ規則で、基準はプロジェクトのフォルダ。
- import は構文解析で見つける（`acorn`。TypeScript は `module.stripTypeScriptTypes` で型を取り除いてから）。解決はローダー（jiti）と同じ手順で行い、実体のパスが基準のフォルダの中にあることを確かめる。指定子は、Node の組み込み、`@loc-studio/sdk`（この名前だけ）、基準のフォルダの中に解決されるパッケージだけを認める。絶対パス、URL、`..` を含むパッケージ名は認めない。
- 読み込むファイルを前もって決められない書き方はエラーにする（ファイル名と行番号つき）: 引数が文字列でない `import()` / `require()`、値として使う `require`、引数が文字列でない `require.resolve`、`module.require`、`require.resolve` 以外の `require` のプロパティ、`module.constructor`、`createRequire`、`node:module` の `builtinModules` / `isBuiltin` 以外のメンバー、`require("node:module")`、`import("node:module")`、`node:module` の名前空間の import と既定の import、`node:module` からの再エクスポート（`node:module` から認めるのは、名前を指定した静的な import の `builtinModules` / `isBuiltin` だけ）、`process.dlopen`、`import.meta.resolve`、`import.meta.glob` の類、`import.meta[式]`、構文解析できないファイル。フォルダのプラグインは、フォルダの中のコードのファイルすべて（`node_modules` も）を検査する。
- 単一ファイルのプラグインとコードの設定には、さらに厳しい検査をする（ハッシュに入るのが import でたどれるファイルだけのため）。`eval` の参照、値として使う `Function`、`process.getBuiltinModule`、`module` / `require` / `process` / `globalThis` / `global` / `window` / `self` への計算したプロパティのアクセス、それらのグローバルの `eval` / `Function` / `require` / `process` / `module`、アロー関数でない関数の外の `arguments`、値として使う `module`、組み込みの `vm` / `worker_threads` / `child_process` / `cluster` / `repl` / `inspector` / `wasi` の読み込み（静的な import、`import()`、`require`、再エクスポート）を断る。関数の中で宣言した同じ名前のローカル変数（`module` も）は断らない。フォルダのプラグインにはこの検査をしない。この検査はサンドボックスではない。
- 設定ファイルのハッシュは、JSON の基盤の項目（`storage`、`pluginDirs`、`tree`、`formats`、`syntaxes`、`sources`、`generators`、`actions`、`review`）をキーの順をそろえて並べたものと、ファイルが参照する `${env:NAME}` の名前の一覧から作る。基盤の項目も環境変数の参照もなければ、確認は要らない。ほかのキーの変更ではハッシュは変わらない。
- import したあとにもう一度ハッシュを作り、確認のときと違えば、読み込んだものを使わず、確認待ちに戻す（そのあいだに変わったコードは 1 回動いている）。
- この確認（import のたどり方とシンボリックリンク）は `"prompt"` のときだけ行う。`plugin.json` の `main` がプラグインのフォルダの中を指すことは、どのモードでも確かめる。
- 信頼していないプラグインの実装を設定が参照していても、プロジェクトは開く（「登録されていません」の警告）。画面は `ProjectInfo.untrustedPlugins` と `plugins().untrusted` を見て確認を出し、`trustPlugins` を呼ぶ。
- core の `openProject(root, { trust })` と `loadProjectConfig(root, { trustConfig })` が判定を受け取る。`trust` が false を返したプラグインは import せず `project.untrustedPlugins` に入る。省略するとすべて読み込む。

### 制限された状態

`"prompt"` で、設定ファイルを信頼していないとき、ワークスペースは制限された状態で開く。設定ファイルに基盤の項目か `${env:NAME}` の参照があるプロジェクトは、最初に開いたときにこの状態になる。コードの設定を信頼していないときは、信頼済みの JSON だけで設定として使えれば、JSON の設定だけで普通に開く（コードの設定は `untrusted` に `kind: "config"` で出る）。JSON がない、または JSON だけでは設定の形を満たさないときは、制限された状態で開く。設定ファイルとコードの設定の両方が確認待ちなら、`untrusted` に両方が並ぶ。

- 環境変数を展開せず、DB を開かず、ネットワークに接続しない。ツリー、フォーマット、列ソース、生成器、アクションの実装を作らず、秘密情報も読まない。プラグインも、信頼済みのコードの設定も読み込まない。
- 使えるのは `info`、`plugins`、`settings`、`trustPlugins`、`untrustPlugins`、`reloadPlugins` だけで、ほかのメソッドは `untrusted`。
- `info()` は `restricted: true`、`Workspace.restricted` は `true`。
- `trustPlugins` が成功すると、同じ `Workspace` のまま開き直す。設定ファイルを信頼して開き直すと、設定で決まるプラグインフォルダのプラグインが `untrusted` に出ることがある（確認は 2 段になる）。コードの設定がまだ確認待ちで JSON だけでは足りなければ、制限された状態のまま。
- `plugins().untrusted` は、制限された状態になった時点の内容。そのあとでファイルが変わったら、`trustPlugins` は `conflict` を返す。`reloadPlugins` で読み直すと、新しい内容になる（信頼済みの内容に戻っていれば、普通の状態で開く）。
- あとで設定ファイルの基盤の項目やコードの設定がアプリの外で書き換えられると、次に設定を読み直したとき（`reloadPlugins` など）に、また制限された状態に切り替わる。ドラフトは PC ごとの DB にあるので消えない。
- コードの設定が確認の条件を満たさない（外への import など）ときは、信頼の候補にも出ない。JSON だけでは足りなければ、条件を直すまで制限された状態のまま。
