/**
 * loc-studio の拡張ポイント（10 の interface。画面側の独自描画 CellRenderer を含む）と、設定の型。
 *
 * 方針:
 * - アプリ本体は固定値を持たない。言語の一覧、ステータスの選択肢、列の並びなどは、すべて設定から来る。
 * - 同梱機能もスタジオ独自の機能も、ここにある同じ interface を実装する。
 * - 実装は「名前（id）」で登録し、設定は名前で選ぶ。実装に渡す値は呼び出し時の `options` で受け取る。
 */

/** プラグイン API の版。互換性のない変更をしたら上げる。 */
export const PLUGIN_API_VERSION = 1;

// ---------------------------------------------------------------------------
// 言語
// ---------------------------------------------------------------------------

/** 言語の ID。標準のロケールとは限らない（例: "MTEnglish"）。アプリは中身を解釈しない。 */
export type LanguageId = string;

export interface LanguageDef {
  id: LanguageId;
  label: string;
  /** 基にする言語。省略した言語が原文の扱い。 */
  basedOn?: LanguageId;
  /** false で読み取り専用。既定は true。 */
  editable?: boolean;
  hint?: { font?: string; dir?: "ltr" | "rtl"; lang?: string };
  /** 言語の切り替えパネルでのまとめ方。 */
  group?: string;
  /** グリッドの固定側に置くか。true でグループ全体、列 ID の配列でその列だけ。 */
  pinned?: boolean | string[];
}

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";

export type Options = Record<string, unknown>;

/** リソース（1 つのテキストファイルなど）。 */
export interface ResourceRef {
  /** プロジェクト内で一意の ID。同梱のツリーではプロジェクトからの相対パス（区切りは "/"）。 */
  id: string;
  /** プロジェクトのルートからの相対パス（区切りは "/"）。 */
  path: string;
  /** 表示名。 */
  name: string;
}

export interface Diagnostic {
  severity: Severity;
  message: string;
  /** 1 始まりの行番号。 */
  line?: number;
}

// ---------------------------------------------------------------------------
// 1. ツリーの構築
// ---------------------------------------------------------------------------

export interface TreeNode {
  id: string;
  name: string;
  kind: "folder" | "resource";
  children?: TreeNode[];
  /** kind が "resource" のとき必須。 */
  resource?: ResourceRef;
}

export interface TreeContext {
  /** プロジェクトのルートの絶対パス。設定ファイルの置き場所。リソースがここにあるとは限らない。 */
  projectRoot: string;
  /** 設定から渡された値。 */
  options: Options;
  /** ホストが提供する機能。リソースを外部の API から読み書きする実装は、ここの fetch と secrets を使う。 */
  host: PluginHost;
}

/**
 * リソースの一覧と読み書き。
 * コアはリソースをこの interface 経由でしか扱わない。同梱の実装はローカルのフォルダを読むが、
 * ローカルにファイルを置かず、ネットワークの API から読み書きする実装にも差し替えられる。
 */
export interface TreeProvider {
  id: string;
  /** どのリソースがあり、どんな階層で見せるか。 */
  list(ctx: TreeContext): Promise<TreeNode[]>;
  read(resource: ResourceRef, ctx: TreeContext): Promise<Uint8Array>;
  /**
   * 中身と、その中身の版を一度に返す（任意）。
   * API から読む実装では、読み込みと版の確認を 1 回の通信で済ませられ、間に書き換えられる隙もなくなる。
   * 実装があれば、コアは read と revision を別々に呼ばずにこれを使う。
   */
  readWithRevision?(resource: ResourceRef, ctx: TreeContext): Promise<{ data: Uint8Array; revision?: string }>;
  /**
   * expectedRevision を渡されたら、いまの版と違う場合は書かずに RevisionConflictError を投げる（対応できる実装だけ）。
   * それ以外の失敗（認証、通信など）は別のエラーにすること。コアは RevisionConflictError のときだけ読み直してやり直す。
   */
  write(
    resource: ResourceRef,
    data: Uint8Array,
    ctx: TreeContext,
    opts?: { expectedRevision?: string },
  ): Promise<void>;
  /** いまの版を表す文字列（更新時刻やハッシュ、ETag など）。外部で書き換えられたことの検出に使う（任意）。 */
  revision?(resource: ResourceRef, ctx: TreeContext): Promise<string | undefined>;
  /**
   * 変更の監視（任意）。戻り値は監視をやめる関数。
   * 実装があれば、ホストはプロジェクトを開いている間これを呼び、知らされたリソースを読み直す。
   */
  watch?(ctx: TreeContext, onChange: (resource: ResourceRef) => void): () => void;
  /**
   * 新しいリソースを作る（任意）。path は置き場所の指定（同梱のツリーではプロジェクトからの相対パス）。
   * 同じ場所にすでにあれば、上書きせずに例外にする。実装がなければ、画面から新しいリソースは作れない。
   */
  create?(path: string, data: Uint8Array, ctx: TreeContext): Promise<ResourceRef>;
}

// ---------------------------------------------------------------------------
// 2. ファイルフォーマット
// ---------------------------------------------------------------------------

export interface FormatContext {
  resource: ResourceRef;
  /** プロジェクトの言語の定義。 */
  languages: LanguageDef[];
  /** 設定から渡された値（列名と言語の対応など）。 */
  options: Options;
}

export interface EntryData {
  key: string;
  /** あればキー変更に追従できる。 */
  stableId?: string;
  text: Partial<Record<LanguageId, string>>;
  /** scope: entry、source: file の列。 */
  meta?: Record<string, unknown>;
  /** scope: language、source: file の列。 */
  languageMeta?: Partial<Record<LanguageId, Record<string, unknown>>>;
  /** 「エディタで開く」用。1 始まり。 */
  location?: { line: number };
}

export interface ParsedDocument {
  entries: EntryData[];
  /** 壊れた行など。UI に警告として出す。 */
  diagnostics?: Diagnostic[];
}

export type FieldRef =
  | { kind: "text"; language: LanguageId }
  | { kind: "meta"; column: string; language?: LanguageId };

export type Change =
  | { type: "set"; key: string; field: FieldRef; value: unknown }
  | { type: "add"; after?: string; entry: EntryData }
  | { type: "remove"; key: string }
  | { type: "rename"; key: string; newKey: string };

export interface Format {
  id: string;
  /** このフォーマットが扱うリソースか（拡張子や先頭バイトで判定）。 */
  match(resource: ResourceRef, head: Uint8Array): boolean;
  /** バイト列 → エントリの配列。エンコーディングの判定もここで行う。 */
  parse(input: Uint8Array, ctx: FormatContext): ParsedDocument;
  /** 変更点だけを元のバイト列に適用して返す（ロスレスな書き戻し）。触っていない部分は 1 バイトも変えない。 */
  apply(original: Uint8Array, changes: Change[], ctx: FormatContext): Uint8Array;
  /** 新規リソースの作成用（任意）。 */
  create?(entries: EntryData[], ctx: FormatContext): Uint8Array;
  /** 本文の記法の ID。省略時はプロジェクトの既定。 */
  syntax?: string;
}

// ---------------------------------------------------------------------------
// 3. 本文の記法
// ---------------------------------------------------------------------------

export interface TextToken {
  kind: "text" | "variable" | "tag" | "control";
  value: string;
  /** 本文中の位置（UTF-16 の添字。end は含まない）。 */
  range: { start: number; end: number };
}

/** 本文中の変数・タグ・制御コードの見つけ方。検証と色分け表示に使う。 */
export interface TextSyntax {
  id: string;
  /** 本文を、途切れなく並ぶトークンに分ける。range をつなげると本文全体になること。 */
  tokenize(text: string): TextToken[];
}

// ---------------------------------------------------------------------------
// 4. 列ソース / 5. 列
// ---------------------------------------------------------------------------

export interface EnumOption {
  /** 保存する値。 */
  value: string;
  /** 表示名。省略時は value。 */
  label?: string;
  color?: string;
  /** true の選択肢が進捗率の分子になる。 */
  complete?: boolean;
  /** レビュー列で、この判定にコメントを必須にする。 */
  requireComment?: boolean;
  /**
   * この値に変えられるのは、いまの値がここに並んだ値のときだけ（遷移の制限）。省略時はどの値からでも変えられる。
   * 値のないセルは、列の type.default の値として扱う。レビュー列では、直前の判定がいまの値。
   */
  from?: string[];
  /**
   * この値を選べる役割の ID（Web モード）。省略時は、列を変えられる役割なら誰でも選べる。
   * ローカルモードとサーバーの管理者には効かない。
   */
  roles?: string[];
}

/** "date" は日付（"2026-11-15" の形の文字列）。 */
export type ColumnType = "string" | "number" | "boolean" | "date" | { enum: EnumOption[]; default?: string };

export type ColumnKind = "key" | "text" | "meta" | "computed" | "actions" | "generated" | "review";

export interface ColumnDef {
  id: string;
  kind: ColumnKind;
  label?: string;
  /** entry: 行に 1 つ。language: 言語ごとに 1 つ。 */
  scope: "entry" | "language";
  /** 特定の言語だけに出す。省略時は全言語。 */
  languages?: LanguageId[];
  type?: ColumnType;
  /** 値の出所。列ソースの名前（設定の `sources` のキー）。 */
  source?: string;
  /** kind: "review" の対象の列。 */
  of?: string;
  /** kind: "actions" に並べるアクションの ID。 */
  actions?: string[];
  /** kind: "generated" の生成器の名前。 */
  generator?: string;
  /** 値を付けた時点の本文の版を記録する。 */
  basis?: "text";
  /** false で変更履歴の対象から外す。 */
  history?: boolean;
  /** 列に渡す値（compute、display、renderer などが使う）。 */
  options?: Options;
  /**
   * 同梱の見せ方。コードを書かずに選べる。
   * link: 値を URL として開ける。progress: 0〜1（options.max があれば 0〜max）の棒。color: 色見本。tags: 配列や区切り文字列を札に分ける。
   */
  display?: "link" | "progress" | "color" | "tags";
  /** 独自の見せ方。プラグインが登録した CellRenderer の id。display より優先する。 */
  renderer?: string;
  /**
   * kind: "computed" の値を作る関数。保存はしない。行を表示するたびに計算する。
   * 関数は設定ファイル（JSON）には書けないので、プラグインが列として登録し、設定は `use` で選ぶ。
   */
  compute?(ctx: ComputeContext): ComputedValue;
}

export interface ComputeContext {
  entry: Entry;
  /** scope: language の列では、その言語の定義。 */
  language?: LanguageDef;
  /** scope: language の列では、その言語の本文（未保存の編集を含む）。 */
  text?: string;
  row: RowReader;
  options: Options;
}

export interface ComputedValue {
  value: unknown;
  /** 問題があるときの説明。セルにエラーの印を出す。 */
  error?: string;
}

export interface CellRef {
  entryKey: string;
  resourceId: string;
  columnId: string;
  language?: LanguageId;
}

export interface CellValue extends CellRef {
  value: unknown;
  /** 値の版番号。同じセルを 2 人が変えたときの検出に使う。 */
  version?: number;
  updatedAt?: string;
  updatedBy?: string;
  /** 値を付けた時点の、対象（本文など）の版。 */
  basisHash?: string;
  /**
   * 値に添えたコメント（列ソースが load で返す。任意）。レビュー列の列ソースは、最新の投稿のコメントを入れる。
   * 表のレビュー列のセルに、付けた人（updatedBy）と並べて出る。
   */
  comment?: string;
}

/** 保存の要求。expectedVersion が今の版と違えば、上書きせずに競合として失敗させる。 */
export interface CellWrite extends CellRef {
  value: unknown;
  expectedVersion?: number;
  basisHash?: string;
}

export interface ColumnSourceContext {
  projectRoot: string;
  /** 設定の `sources` で渡された値。 */
  options: Options;
  /** ホスト（アプリ本体）が提供する機能。DB、利用者、秘密情報など。 */
  host: PluginHost;
}

/** レビューの投稿の要求。 */
export interface NewReviewPost {
  /** レビュー列のセル。 */
  cell: CellRef;
  verdict: string;
  comment: string;
  /** 投稿した時点の、対象の列の値の版。 */
  basisHash?: string;
}

/**
 * 列の値の出所。ファイル以外の値（進捗ステータス、レビューなど）は、すべてこの interface の実装が読み書きする。
 * 同梱の実装はホストの DB を使うが、外部の API につなぐ実装に差し替えられる。
 */
export interface ColumnSource {
  id: string;
  /** immediate: 変更した瞬間に保存。buffered: 編集バッファに積み、保存操作で書き出す。 */
  saveMode: "immediate" | "buffered";
  load(cells: CellRef[], ctx: ColumnSourceContext): Promise<CellValue[]>;
  save(values: CellWrite[], ctx: ColumnSourceContext): Promise<CellValue[]>;
  /** キーの変更や削除に追従する（任意）。 */
  onEntriesChanged?(changes: Change[], resource: ResourceRef, ctx: ColumnSourceContext): Promise<void>;
  subscribe?(ctx: ColumnSourceContext, onChange: (cells: CellRef[]) => void): () => void;
  /** レビュー列（kind: "review"）の出所になる場合に実装する。load はセルごとの最新の判定を返す。 */
  postReview?(post: NewReviewPost, ctx: ColumnSourceContext): Promise<ReviewPost>;
  listReviews?(cell: CellRef, ctx: ColumnSourceContext): Promise<ReviewPost[]>;
  /** 投稿に外部へのリンク（チケットなど）を紐づける（任意）。 */
  addReviewLinks?(reviewId: string, links: { label: string; url: string }[], ctx: ColumnSourceContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// ホストが提供する機能（プラグインから使う）
// ---------------------------------------------------------------------------

/** セルごとの値を置く場所。名前空間ごとに分かれる。 */
export interface CellStore {
  get(cells: CellRef[]): Promise<CellValue[]>;
  /** expectedVersion が合わないセルがあれば StoreConflictError を投げ、何も書かない。 */
  set(values: CellWrite[]): Promise<CellValue[]>;
  query(filter: { resourceId?: string; columnId?: string; language?: LanguageId }): Promise<CellValue[]>;
  /** キーの変更に追従する。 */
  renameEntry(resourceId: string, oldKey: string, newKey: string): Promise<void>;
}

export interface LogRecord<T = unknown> {
  id: string;
  cell?: CellRef;
  /** ISO 8601 の日時。 */
  at: string;
  /** その時点のユーザー名（文字列のまま残す）。 */
  by: string;
  data: T;
}

/** 追記だけの記録（レビューの投稿、変更履歴など）。書き換えも削除もしない。 */
export interface LogStore<T = unknown> {
  append(entries: { cell?: CellRef; data: T }[]): Promise<LogRecord<T>[]>;
  /** 新しい順。 */
  list(filter?: { cell?: CellRef; resourceId?: string; columnId?: string; limit?: number }): Promise<LogRecord<T>[]>;
  /** セルごとの最新の 1 件。なければ undefined。引数と同じ順で返す。 */
  latest(cells: CellRef[]): Promise<(LogRecord<T> | undefined)[]>;
  renameEntry(resourceId: string, oldKey: string, newKey: string): Promise<void>;
}

export interface KvStore {
  get(key: string): Promise<unknown>;
  getMany(keys: string[]): Promise<Record<string, unknown>>;
  set(key: string, value: unknown): Promise<void>;
  setMany(values: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * ホストの DB。SQLite でも Postgres でも同じ形で使える。
 * 共有モード（ネットワーク上の SQLite）の書き込みロックもホスト側が面倒を見る。
 */
export interface HostDb {
  cells(namespace: string): CellStore;
  log<T = unknown>(namespace: string): LogStore<T>;
  kv(namespace: string): KvStore;
}

/** 1 行分の値。entry は行の情報、row は本文と列の値を読む窓口。 */
export interface RowSnapshot {
  entry: Entry;
  row: RowReader;
}

/**
 * プロジェクトのリソースと行を読む窓口。ツリーとフォーマットを通して読むので、リソースがローカルのファイルでも
 * 外部の API でも同じに使える。プラグインは projectRoot のファイルを自分で読まず、これを使う。
 */
export interface ProjectReader {
  /** プロジェクトの言語の定義。 */
  readonly languages: LanguageDef[];
  /** 解決済みの列（設定の並び順）。 */
  readonly columns: ColumnDef[];
  /** リソースの一覧。Web モードでは、いまの利用者に見えるものだけ。 */
  resources(): Promise<ResourceRef[]>;
  /**
   * リソースの行（リソースの中の並び順）。本文は未保存の編集を含む。
   * keys で行を、columns で読み込む列ソースの列（省略時はすべて）を絞れる。大きなリソースでは絞ること。
   */
  rows(resourceId: string, opts?: { keys?: string[]; columns?: string[] }): Promise<RowSnapshot[]>;
}

export interface PluginHost {
  db: HostDb;
  /** いまの利用者。role は Web モードでの役割の ID（ローカルモードとコマンドラインでは undefined）。 */
  user: { name: string; role?: string };
  secrets: SecretReader;
  env: Record<string, string | undefined>;
  projectRoot: string;
  /** プロジェクトのリソースと行を読む。 */
  project: ProjectReader;
  /** 外部の API を呼ぶときに使う。 */
  fetch: typeof fetch;
  log(message: string): void;
}

// ---------------------------------------------------------------------------
// 共通: エントリと行
// ---------------------------------------------------------------------------

export interface Entry {
  key: string;
  stableId?: string;
  resource: ResourceRef;
  meta?: Record<string, unknown>;
}

/** 同じ行のほかの列、ほかの言語の値を読む。 */
export interface RowReader {
  /** その言語の本文。なければ undefined。 */
  text(language: LanguageId): string | undefined;
  /** 列の値。言語別の列は language を指定する。 */
  get(columnId: string, language?: LanguageId): unknown;
}

// ---------------------------------------------------------------------------
// 6. 生成
// ---------------------------------------------------------------------------

export interface GeneratorCellContext {
  entry: Entry;
  column: ColumnDef;
  language?: LanguageDef;
  row: RowReader;
  options: Options;
}

export interface GeneratorInput {
  /** キャッシュの鍵に入る入力の全文。 */
  text: string;
  language?: LanguageId;
  extra?: Record<string, unknown>;
}

export interface GeneratorOutput {
  value: string;
  meta?: Record<string, unknown>;
}

export interface GeneratorRunContext {
  options: Options;
  secrets: SecretReader;
  host: PluginHost;
  signal?: AbortSignal;
}

export interface Generator {
  id: string;
  /** 結果が変わる変更をしたら上げる。キャッシュの鍵に入る。 */
  version: string;
  /** 設定の options から、キャッシュの鍵に入れる値を選ぶ（モデル、訳し先、指示文など。接続キーは含めない）。 */
  cacheParams(options: Options): Record<string, unknown>;
  /** そのセルの入力。生成しないセルは null。 */
  input(ctx: GeneratorCellContext): GeneratorInput | null;
  run(inputs: GeneratorInput[], ctx: GeneratorRunContext): Promise<GeneratorOutput[]>;
  batchSize?: number;
  concurrency?: number;
  retries?: number;
}

// ---------------------------------------------------------------------------
// 7. アクション
// ---------------------------------------------------------------------------

export interface SecretReader {
  /** 接続キーなど。ローカル設定か環境変数から読む。なければ undefined。 */
  get(name: string): string | undefined;
}

export interface ReviewPost {
  id: string;
  /** レビュー列のセル。 */
  cell: CellRef;
  /** レビュー列の ID（cell.columnId と同じ）。 */
  columnId: string;
  verdict: string;
  comment: string;
  userName: string;
  createdAt: string;
  /** 投稿した時点の、対象の列の値の版。 */
  basisHash?: string;
  /** 外部へのリンク（転載したチケットなど）。 */
  links?: { label: string; url: string }[];
}

export interface CellPatch {
  entryKey: string;
  resourceId: string;
  columnId: string;
  language?: LanguageId;
  value: unknown;
}

export interface ActionContext {
  entry?: Entry;
  column?: ColumnDef;
  language?: LanguageDef;
  value?: unknown;
  row?: RowReader;
  /** target: "review" のときの投稿。 */
  review?: ReviewPost;
  /** target: "selection" / "file" / "column" のときの対象。 */
  entries?: Entry[];
  /** entries と同じ順に並んだ、各行の値を読む窓口（target: "selection" / "file" / "column"）。 */
  rows?: RowReader[];
  options: Options;
  secrets: SecretReader;
  env: Record<string, string | undefined>;
  host: PluginHost;
}

export interface ActionResult {
  patches?: CellPatch[];
  message?: string;
  open?: { url: string } | { file: string; line?: number };
  /** 外部に作ったもの（チケットなど）へのリンク。target: "review" では投稿に紐づけて保存する。 */
  links?: { label: string; url: string }[];
}

export interface Action {
  id: string;
  label: string;
  icon?: string;
  target: "cell" | "column" | "row" | "selection" | "file" | "review";
  columns?: string[];
  languages?: LanguageId[];
  when?(ctx: ActionContext): boolean;
  run(ctx: ActionContext): Promise<ActionResult>;
}

// ---------------------------------------------------------------------------
// 8. バリデーション
// ---------------------------------------------------------------------------

export interface ValidateContext {
  entry: Entry;
  column: ColumnDef;
  /** 言語の定義そのもの（id、basedOn など）。scope: entry の列では undefined。 */
  language?: LanguageDef;
  /** セルの値を文字列にしたもの（本文はそのまま。値のないセルは ""）。 */
  value: string;
  /** 列の値そのもの（本文以外の列では、数値や真偽値のまま。値のないセルは undefined）。 */
  raw?: unknown;
  /** TextSyntax が分けた変数・タグ・制御コード。 */
  tokens: TextToken[];
  /** 基になる言語の本文。原文や、基の本文がない場合は undefined。 */
  base?: { language: LanguageDef; value: string; tokens: TextToken[] };
  row: RowReader;
  /** 設定から渡された値。 */
  options: Options;
}

export interface ValidationIssue {
  /** 絞り込みと集計に使う。 */
  code: string;
  message: string;
  /** 省略時はバリデータの既定、設定の指定の順で決まる。 */
  severity?: Severity;
  /** 本文中の位置（UTF-16 の添字。end は含まない）。 */
  range?: { start: number; end: number };
  /** ワンクリックで直せる場合の修正案（本文全体を置き換える値）。 */
  fix?: { label: string; value: string };
}

/** リソース全体を見るバリデータが受け取る値。 */
export interface ResourceValidateContext {
  resource: ResourceRef;
  /** リソースの全行（リソースの中の並び順）。本文は未保存の編集を含む。 */
  rows: RowSnapshot[];
  languages: LanguageDef[];
  columns: ColumnDef[];
  /** 設定から渡された値。 */
  options: Options;
}

/** リソース全体を見て見つけた問題。どのセルの問題かを key（と language、columnId）で示す。 */
export interface ResourceIssue extends ValidationIssue {
  key: string;
  /** 言語ごとの列のセルのとき必須。 */
  language?: LanguageId;
  /** 問題のあるセルの列。省略時は本文の列。 */
  columnId?: string;
}

/**
 * validate（セルごと）と validateResource（リソース全体）の、少なくとも一方を実装する。
 */
export interface Validator {
  id: string;
  label: string;
  /** 結果が変わる変更をしたら上げる。キャッシュの鍵に入る。 */
  version: string;
  /**
   * validate の対象の列。省略時は本文（kind: "text"）の列。
   * 本文以外では、値を持つ列（kind: "meta"）を名指しできる。
   */
  columns?: string[];
  languages?: LanguageId[];
  /** 既定の重さ。設定で上書きできる。省略時は "error"。 */
  severity?: Severity;
  /** セルを 1 つずつ確かめる。 */
  validate?(ctx: ValidateContext): ValidationIssue[] | Promise<ValidationIssue[]>;
  /**
   * リソース全体を見て確かめる（キーの重複、同じ原文の訳の揺れなど、ほかの行と比べる検証）。
   * リソースや未保存の編集、列の値が変わるたびに、リソース全体に対して呼ばれる。
   */
  validateResource?(ctx: ResourceValidateContext): ResourceIssue[] | Promise<ResourceIssue[]>;
}

// ---------------------------------------------------------------------------
// 9. フック（書き込みの前後）
// ---------------------------------------------------------------------------

/** 変更のきっかけ。manual: 利用者の操作。bulk: 複数行の一括変更。action: アクションの変更点。 */
export type ChangeCause = "manual" | "bulk" | "action";

export interface CellChange {
  cell: CellRef;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * 書き込みのできごと。
 * - cells.set: 本文以外の列の値を変える（ステータスなど。changes は同じ列・同じ言語のセル）。
 * - text.save: 未保存の本文をリソースに保存する（changes は本文の列のセル）。
 * - review.post: レビューを投稿する（after では review に投稿が入る）。
 * - resource.write: リソースを書く（本文の保存、リソースの中の列の変更、行の追加・削除、リソースの作成で起きる）。
 * - entries.change: 行を足す・消す・キーを変える（changes はフォーマットに渡すものと同じ）。
 */
export type WorkflowEvent =
  | { type: "cells.set"; resource: ResourceRef; column: ColumnDef; language?: LanguageDef; changes: CellChange[]; cause: ChangeCause }
  | { type: "text.save"; resource: ResourceRef; column: ColumnDef; changes: CellChange[] }
  | {
      type: "review.post";
      resource: ResourceRef;
      column: ColumnDef;
      language?: LanguageDef;
      cell: CellRef;
      verdict: string;
      comment: string;
      /** 直前の判定（なければ列の type.default）。 */
      previous?: unknown;
      /** 保存された投稿（after だけ）。 */
      review?: ReviewPost;
    }
  | { type: "resource.write"; resource: ResourceRef }
  | { type: "entries.change"; resource: ResourceRef; changes: Change[] };

export interface WorkflowContext {
  /** 設定の hooks で渡された値。 */
  options: Options;
  host: PluginHost;
}

/** after が返す値。 */
export interface WorkflowResult {
  /**
   * 続けて反映するセルの変更（ステータスを戻すなど）。利用者の役割にかかわらず反映し、変更履歴には
   * きっかけがフックであること（cause: "hook"）とフックの id が残る。この変更では、フックはもう呼ばれない。
   * resource.write の after では返せない。
   */
  patches?: CellPatch[];
}

/**
 * 書き込みの前後に呼ばれる。スタジオごとの決まり（誰がどの状態にできるか、保存の前のチェックアウト、
 * 差し戻しでステータスを戻す、外部への通知など）を、アプリを変えずに足すための拡張ポイント。
 */
export interface WorkflowHook {
  id: string;
  /** 受け取るできごとの種類。省略時はすべて。 */
  events?: WorkflowEvent["type"][];
  /**
   * 書き込みの前。文字列を返すと、その書き込みをやめて、文字列を理由として利用者に見せる。
   * 例外を投げた場合も書き込みをやめる（フックの不具合として扱い、例外のメッセージを見せる）。
   */
  before?(event: WorkflowEvent, ctx: WorkflowContext): Promise<string | void> | string | void;
  /** 書き込みのあと。失敗しても書き込みは取り消さず、警告になる。 */
  after?(event: WorkflowEvent, ctx: WorkflowContext): Promise<WorkflowResult | void> | WorkflowResult | void;
}

// ---------------------------------------------------------------------------
// セルの独自描画（ブラウザで動く）
// ---------------------------------------------------------------------------

/**
 * セルの見せ方を、プラグインが持つブラウザ用のモジュールで差し替える。
 * モジュールはアプリのビルドには含めず、画面が実行時に読み込む（再ビルド不要）。
 * プラグインのほかの部分と違い、このモジュールだけはブラウザで動く。Node の機能は使えない。
 */
export interface CellRenderer {
  id: string;
  /**
   * ブラウザで動く ES モジュール（.js / .mjs）のファイル。プラグインのファイルがあるフォルダからの相対パス。
   * 既定の書き出し（default export）が CellRendererModule であること。
   */
  module: string;
}

/** ブラウザ用モジュールが受け取る情報。 */
export interface CellRenderContext {
  value: unknown;
  /** 計算列などのエラーの説明。 */
  error?: string;
  column: { id: string; label?: string; type?: ColumnType; options?: Options };
  language?: { id: LanguageId; label: string };
  entryKey: string;
  resourceId: string;
  theme: "light" | "dark";
  readOnly: boolean;
  /** 値を保存する。読み取り専用の列や、権限がない場合は undefined。 */
  setValue?(value: unknown): Promise<void>;
}

/**
 * ブラウザ用モジュールの既定の書き出しの形。
 * E はセルの要素の型。ブラウザ向けに型を付けて書くなら CellRendererModule<HTMLElement> とする
 * （SDK 自体は Node 用で、ブラウザの型を持たないため）。
 */
export interface CellRendererModule<E = unknown> {
  /**
   * セルの中身を element に描く。値が変わるたびに呼ばれる。
   * 後片付けが必要なら関数を返す（次の描画の前と、セルが消えるときに呼ばれる）。
   */
  render(element: E, ctx: CellRenderContext): void | (() => void);
}

// ---------------------------------------------------------------------------
// プラグイン
// ---------------------------------------------------------------------------

/**
 * 拡張ポイントの実装をまとめた単位。
 * プラグインは実装を登録するだけで、どれを使うかは設定（`use`）が決める。
 */
export interface Plugin {
  name: string;
  version?: string;
  /** 対応するプラグイン API の版。省略時は現在の版とみなす。 */
  apiVersion?: number;
  trees?: TreeProvider[];
  formats?: Format[];
  syntaxes?: TextSyntax[];
  sources?: ColumnSource[];
  columns?: ColumnDef[];
  generators?: Generator[];
  actions?: Action[];
  validators?: Validator[];
  hooks?: WorkflowHook[];
  renderers?: CellRenderer[];
  /**
   * このプラグインの設定の宣言。宣言すると、設定の画面の「プラグインの設定」に入力欄が出て、
   * 値はプロジェクトの `loc-studio-plugin-settings/<プラグインの名前>.json` に保存される。
   * 値は、入口の関数が受け取る `setup.settings.get(key)` で読む（PluginSetupContext）。
   */
  settings?: PluginSettingDef[];
}

/** プラグインの設定の 1 項目。 */
export interface PluginSettingDef {
  /** 設定ファイルのキー（プラグインの中で重複しない、空でない文字列）。 */
  key: string;
  /** 設定の画面に出す名前。 */
  label: string;
  /** 設定の画面に出す説明。 */
  description?: string;
  /** 値の種類。"enum" は options のどれか（値は文字列）。 */
  type: "string" | "number" | "boolean" | "enum";
  /** type: "enum" の選択肢（1 つ以上）。 */
  options?: { value: string; label?: string }[];
  /** 設定ファイルに値がないときの値。省略すると、値なし（undefined）。 */
  default?: string | number | boolean;
}

/** プラグインの設定の値を読む窓口。 */
export interface PluginSettingsReader {
  /**
   * 宣言した設定の値。設定ファイルに値がなければ default、default もなければ undefined。
   * 宣言していないキーを渡すと例外。読み込みが終わる前（入口の関数の中）で呼ぶと例外になるので、
   * validate や run など、拡張ポイントの関数の中で呼ぶ（呼ぶたびに、いまの値を返す）。
   */
  get(key: string): string | number | boolean | undefined;
}

/** 入口の関数（既定のエクスポートが関数のとき）が受け取るもの。 */
export interface PluginSetupContext {
  settings: PluginSettingsReader;
}

/** プラグインのファイルが既定で書き出すもの。値そのものか、値を返す関数。 */
export type PluginModule = Plugin | ((setup: PluginSetupContext) => Plugin | Promise<Plugin>);

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/** 名前で実装を選ぶ。文字列だけでも書ける。 */
export type UseRef = string | { use: string; options?: Options };

/**
 * プラグインが登録した列を名前で選び、必要なところだけ上書きする。
 * 例: { use: "builtin.textStatus", type: { enum: [...] } }
 */
export interface ColumnUse {
  use: string;
  id?: string;
  label?: string;
  languages?: LanguageId[];
  type?: ColumnType;
  source?: string;
  of?: string;
  actions?: string[];
  generator?: string;
  options?: Options;
  display?: ColumnDef["display"];
  renderer?: string;
}

export interface FormatUse {
  use: string;
  /** 対象のリソースのパス（glob）。省略時は Format.match だけで判定する。 */
  match?: string;
  options?: Options;
}

export interface ValidatorUse {
  use: string;
  options?: Options;
  severity?: Severity;
  languages?: LanguageId[];
  columns?: string[];
}

export interface StorageConfig {
  driver: "sqlite" | "postgres";
  /** SQLite のファイルの場所。`${env:NAME}` が使える。 */
  path?: string;
  /** ネットワーク上の SQLite を複数人で使うときの設定。 */
  sharing?: { mode: "lockfile"; staleAfterMs?: number; waitMs?: number };
  /** Postgres の接続先。`${env:NAME}` が使える。 */
  url?: string;
  /** Postgres のスキーマ名。1 つのデータベースを複数のプロジェクトで分けて使える。既定は "loc_studio"。 */
  schema?: string;
}

/** 役割に与える権限。見ること（view）は、役割を持つ全員ができる。 */
export type RoleCapability = "edit" | "review" | "run" | "structure" | "manage";

/**
 * 役割（Web モード）。利用者にはプロジェクトごとに役割を 1 つ割り当てる。
 * 省略した絞り込み（editColumns など）は「制限なし」。空の配列は「どれもできない」。
 */
export interface RoleDef {
  /** 画面に出す名前。省略時は役割の ID。 */
  label?: string;
  /**
   * edit: 本文と列の値の変更、保存。review: レビューの投稿と転載。run: アクションと生成の実行。
   * structure: 行の追加・削除・キーの変更、リソースの作成。
   * manage: プロジェクト設定の変更、プラグインの再読み込み、ほかの人のジョブの取り消し。
   */
  can: RoleCapability[];
  /** edit で変えられる列の ID（本文の列も含む）。省略時はすべての列。 */
  editColumns?: string[];
  /** review で投稿できるレビュー列の ID。省略時はすべてのレビュー列。 */
  reviewColumns?: string[];
  /** run で実行できるアクションの ID。省略時は設定の actions のすべて。 */
  actions?: string[];
  /** run で生成できる生成列の ID。省略時はすべての生成列。 */
  generators?: string[];
  /** 見えるリソースのパス（glob）。省略時はすべて。見えないリソースは、ないものとして扱う。 */
  resources?: string[];
}

/** 本文の編集画面の設定。 */
export interface EditorConfig {
  /**
   * 参照欄に、基になる言語（basedOn）のほかに並べる言語。中継の言語（たとえば日本語が原文で、英語を見ながら訳す）に使う。
   */
  referenceLanguages?: LanguageId[];
  /**
   * 参照欄に出す列の ID（行に 1 つの列と、編集中の言語の列）。備考、話者、文字数の上限などを訳しながら見るために使う。
   * 省略時は、その言語の生成列だけ。
   */
  referenceColumns?: string[];
  /** 本文の長さの数え方。 */
  count?: {
    /**
     * codepoints: Unicode のコードポイント数（既定）。utf16: UTF-16 の単位の数。bytes: UTF-8 のバイト数。
     * width: 全角を 2、それ以外を 1 と数えた幅（改行は数えない）。
     */
    unit?: "codepoints" | "utf16" | "bytes" | "width";
    /** true: 変数・タグ・制御コード（記法が分けたトークン）を数えない。 */
    skipTokens?: boolean;
  };
}

export interface ProjectConfig {
  name?: string;
  languages: LanguageDef[];
  editor?: EditorConfig;
  /**
   * 役割の定義（Web モード）。同梱の viewer / translator / reviewer / manager に足すか、同じ ID で置き換える。
   * サーバーの管理者は、ここの定義にかかわらずすべてできる。
   */
  roles?: Record<string, RoleDef>;
  /** プラグインを探すフォルダ（プロジェクトからの相対パス）。既定は ["loc-studio-plugins"]。 */
  pluginDirs?: string[];
  tree?: UseRef;
  formats?: FormatUse[];
  /** 既定の本文の記法（複数可。前から順に適用する）。 */
  syntaxes?: string[];
  /** 列ソースに名前を付ける。列の `source` はこの名前か、登録済みの列ソースの id。 */
  sources?: Record<string, UseRef>;
  /** 列の並び。列の定義そのものか、プラグインが登録した列の名前。 */
  columns?: (ColumnDef | ColumnUse)[];
  generators?: Record<string, UseRef>;
  actions?: UseRef[];
  /** 書き込みの前後に呼ぶフック。書いた順に呼ぶ。 */
  hooks?: UseRef[];
  validators?: (string | ValidatorUse)[];
  validation?: {
    blockComplete?: Severity | false;
    /**
     * 訳文を保存したあとで基になる言語の本文が変わったら「要確認」の印を付けるか。既定は true。
     * false にすると印を付けない（本文の変更への追従を、フックなど別の決まりで行うスタジオ向け）。
     */
    recheck?: boolean;
  };
  review?: { targets?: UseRef[] };
  storage?: StorageConfig;
  /** ローカル設定の初期値と固定。 */
  localSettings?: { defaults?: Record<string, unknown>; enforce?: Record<string, unknown> };
  languageSets?: Record<string, LanguageId[]>;
  grid?: {
    pinCommon?: boolean;
    maxPinnedRatio?: number;
    /**
     * ツリーに進捗を出す列の ID（選択肢に complete のある列）。
     * 省略時は、最初のレビュー列、なければ最初の選択式の列。
     */
    progressColumn?: string;
    /**
     * 進捗の数え方。rows: 行数（既定）。characters: 原文の文字数（コードポイント数）。words: 原文の語数（空白で区切った数）。
     * 原文は、その言語の基になる言語（basedOn）の本文。基になる言語のない言語と、行に 1 つの列では、最初の原文の言語の本文。
     */
    progressUnit?: "rows" | "characters" | "words";
  };
}
