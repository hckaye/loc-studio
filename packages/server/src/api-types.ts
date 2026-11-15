/**
 * サービス層の公開の型（画面とコマンドラインが使う DTO）。
 * どの値も JSON にできる形にする（RPC でそのまま返すため）。
 */
import type { ExtensionKind, PluginLayer, PluginLoadError, Project, SettingSource } from "@loc-studio/core";
import type {
  Action,
  ActionResult,
  ColumnDef,
  Diagnostic,
  LanguageDef,
  LanguageId,
  Plugin,
  ProjectConfig,
  ResourceRef,
  ReviewPost,
  Severity,
} from "@loc-studio/sdk";

export interface WorkspaceOptions {
  projectRoot: string;
  /** この下の plugins/ がアプリ層のプラグインフォルダ。 */
  appDir?: string;
  /** ローカル設定とその PC の DB の置き場所。既定は localSettingsPath() のフォルダ。 */
  userDataDir?: string;
  env?: Record<string, string | undefined>;
  /** 起動引数由来のローカル設定（"user.name" など）。 */
  cliSettings?: Record<string, unknown>;
  sdkPath?: string;
  /** builtinPlugin と llmPlugin に加えて登録するもの。 */
  extraBuiltins?: Plugin[];
  /** false で個人の設定フォルダ（local 層）のプラグインを読まない（Web モード）。既定 true。 */
  localPlugins?: boolean;
  /** 呼び出しに CallContext があるとき、ローカル設定の代わりに使う利用者ごとの設定。 */
  userSettings?: UserSettingsStore;
  /**
   * Web モードの制限（ServerRuntime が付ける）。
   * - allowedEnv: プロジェクトの設定の ${env:NAME} と、プラグインのホストの env に出す環境変数の名前（既定はなし）
   * - pluginDirRoots: project 層のプラグインのフォルダは、実体がこの中にあるものだけ（プロジェクトとアプリのフォルダ）
   */
  webMode?: { allowedEnv: string[]; pluginDirRoots: string[]; sensitivePaths?: string[] };
  /**
   * リソースの版（TreeProvider.revision）を確かめる間隔（ミリ秒）。この間の rows などはキャッシュを使う。
   * 既定 3000。0 で毎回確かめる。save と reloadResource は常に確かめる。
   */
  revisionCheckIntervalMs?: number;
  /**
   * project / local 層のプラグインの信頼。"prompt"（既定）: 利用者が trustPlugins で信頼したもの（中身のハッシュが同じもの）だけ読み込む。
   * "always": すべて読み込む（コマンドラインなど、利用者が自分で開いたプロジェクト）。builtin / app 層は常に読み込む。
   */
  pluginTrust?: "prompt" | "always";
}

/**
 * 設定ファイル（kind: "settings"）の確認の画面の 1 行。基盤の項目は何も省かずに出す。
 * value は JSON のスカラーの形（パスワードは伏せる。制御文字と書字方向の制御文字は <U+202E> の形にする。長い値は省いた印を付ける）。
 */
export interface SummaryRow {
  label: string;
  value: string;
  /** 文字列が接続先の URL のとき、実際の接続先（ホスト:ポート）。http:/host、http:\\host、user@host の形でも本当の行き先。 */
  host?: string;
  /** 補足（URL のユーザー情報、環境変数で決まる接続先、秘密情報の名前など）。 */
  note?: string;
}

/** 利用者が確認したもの（plugins() の untrusted の path と hash をそのまま返す）。 */
export interface TrustItem {
  path: string;
  hash: string;
}

export interface UntrustedPluginInfo {
  /**
   * "plugin": プラグイン。"config": プロジェクトのコードの設定（loc-studio.config.ts など）。
   * "settings": プロジェクトの設定ファイル（loc-studio.project.json）の基盤の項目と、参照する環境変数の名前。
   */
  kind: "plugin" | "config" | "settings";
  path: string;
  layer: PluginLayer;
  hash: string;
  /** ハッシュに入れたファイル（読み込むと実行されうるもの。絶対パス）。確認の画面に出す。 */
  files: string[];
  /** "settings" のとき: 確認の画面に出す要約（共有 DB、環境変数の名前、プラグインのフォルダ、生成器など。展開前の値で、パスワードは伏せる）。 */
  summary?: SummaryRow[];
}

export type ValidateIssue = IssueInfo & { key: string; language?: LanguageId; cellId: string };

export interface ValidateResult {
  resources: { resourceId: string; issues: ValidateIssue[]; diagnostics: Diagnostic[]; error?: string }[];
  summary: { error: number; warning: number; info: number; cells: number };
}

export interface ActionInfo {
  id: string;
  label: string;
  icon?: string;
  target: Action["target"];
  columns?: string[];
  languages?: LanguageId[];
}

export interface ProjectInfo {
  name: string;
  root: string;
  languages: LanguageDef[];
  /** 解決済み。並び順どおり。 */
  columns: ColumnDef[];
  languageSets: Record<string, LanguageId[]>;
  grid: { pinCommon: boolean; maxPinnedRatio: number };
  user: { name: string; source: SettingSource; locked: boolean };
  storage: { path: string; shared: boolean };
  actions: ActionInfo[];
  /** 設定 review.targets のレビュー先（target: "review" のアクション）。 */
  reviewTargets: ActionInfo[];
  validators: { id: string; label: string }[];
  blockComplete: Severity | false;
  warnings: string[];
  pluginErrors: PluginLoadError[];
  /** 信頼されていないため読み込んでいないプラグインとコードの設定の数（plugins().untrusted に詳細）。 */
  untrustedPlugins: number;
  /**
   * true: コードの設定を信頼するまで開けない、制限された状態。info / plugins / settings / trustPlugins / untrustPlugins /
   * reloadPlugins だけが使え、ほかのメソッドは ApiError "untrusted"。
   */
  restricted?: boolean;
  changeSeq: number;
  /** 解決済みのローカル設定の値（秘密情報は settings() と同じく伏せる）。Web モードでは呼び出した利用者の設定。 */
  localSettings: Record<string, unknown>;
  /** 呼び出した利用者ができること（ローカルモードではすべて）。 */
  permissions: Permissions;
  /** 読み込んだ（信頼された）プラグインの独自描画。hash はモジュールのファイルの SHA-256（キャッシュの区別に使う）。 */
  renderers: { id: string; pluginName: string; hash: string }[];
}

export interface TreeNodeInfo {
  id: string;
  name: string;
  kind: "folder" | "resource";
  children?: TreeNodeInfo[];
  resource?: ResourceRef;
  /** 未保存の本文の件数（フォルダは配下の合計）。0 のときは省く。 */
  unsaved?: number;
}

export interface ProgressCount {
  complete: number;
  total: number;
}

export interface ResourceStats {
  resourceId: string;
  entries: number;
  unsaved: number;
  /**
   * enum 型の列（レビュー列を含む）ごと・言語ごとの進捗。complete の選択肢の数 / 全体。
   * 対象の値が変わった印の付いた値は complete に数えない。entry スコープの列は言語の位置に "*" を使う。
   */
  progress: Record<string, Record<LanguageId, ProgressCount>>;
  issues: { error: number; warning: number; info: number };
}

export interface IssueInfo {
  validatorId: string;
  code: string;
  message: string;
  severity: Severity;
  range?: { start: number; end: number };
  fix?: { label: string; value: string };
}

export interface CellInfo {
  /** 本文はドラフトがあればドラフトの値。 */
  value: unknown;
  /** 本文のみ: リソースに保存されている値（ドラフトがあるとき）。 */
  saved?: string;
  /** 本文のみ: 未保存。 */
  draft?: boolean;
  /** 本文のみ: 未保存の編集を書いた人。 */
  draftBy?: string;
  version?: number;
  updatedAt?: string;
  updatedBy?: string;
  /** basisHash が、対象の列のいまの値の版と違う（レビュー列、basis: "text" の列、生成列）。 */
  stale?: boolean;
  /** 本文のみ: 最後に編集したあとで、基になる言語の本文が変わった。 */
  needsRecheck?: boolean;
  /** 本文のみ。 */
  issues?: IssueInfo[];
  /** 生成列のみ。 */
  generated?: "fresh" | "stale" | "missing";
  /** 値を付けた時点の対象の版（あれば）。textVersion で全文を引ける。 */
  basisHash?: string;
  /** 計算列のみ: 計算の問題（compute が返した error、または投げた例外のメッセージ）。 */
  error?: string;
}

export interface RowInfo {
  key: string;
  index: number;
  cells: Record<string, CellInfo>;
}

export interface RowsRequest {
  resourceId: string;
  /** 表示中の言語だけ読み込む。 */
  languages: LanguageId[];
  offset: number;
  limit: number;
  /** キーと、表示中の言語の本文の部分一致（大文字小文字を区別しない）。 */
  search?: string;
  /** 列の値での絞り込み（未設定は列の type.default とみなす）。 */
  filters?: { cellId: string; values: unknown[] }[];
  /** 表示中の言語のどれかの本文が空。 */
  onlyUntranslated?: boolean;
  /** 表示中の言語のどれかに、この重さ以上の問題がある。 */
  onlyIssues?: Severity;
  /** 表示中の言語のどれかに stale か needsRecheck のセルがある。 */
  onlyStale?: boolean;
  /** どれかの言語に未保存の本文がある。 */
  onlyUnsaved?: boolean;
}

export interface RowsResponse {
  total: number;
  totalAll: number;
  rows: RowInfo[];
  revision?: string;
  diagnostics: Diagnostic[];
}

export type HistoryCause = "manual" | "action" | "bulk" | "external" | "review" | "generate";

export interface HistoryInfo {
  id: string;
  at: string;
  by: string;
  cellId: string;
  oldValue: unknown;
  newValue: unknown;
  cause: HistoryCause;
  causeRef?: string;
}

export interface ReviewInfo extends ReviewPost {
  stale: boolean;
  /** 投稿の直後の転載で起きた問題（投稿そのものは成功している）。 */
  warnings?: string[];
}

export interface SettingInfo {
  key: string;
  value: unknown;
  source: SettingSource;
  locked: boolean;
}

export interface PluginInfo {
  name: string;
  version?: string;
  layer: PluginLayer;
  path?: string;
  provides: Record<ExtensionKind, string[]>;
}

export interface JobInfo {
  id: string;
  kind: "generate" | "action" | "validate";
  label: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  total: number;
  done: number;
  failed: number;
  skipped: number;
  startedBy: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface SearchHit {
  resourceId: string;
  key: string;
  language?: LanguageId;
  snippet: string;
}

export type ApiErrorCode =
  | "not-found"
  | "conflict"
  | "invalid"
  | "blocked"
  | "locked"
  | "failed"
  /** 権限がない（Web モード）。 */
  | "forbidden"
  /** プロジェクトのコードの設定を信頼するまで使えない（制限された状態のワークスペース）。 */
  | "untrusted"
  /** 認証されていない、またはログインに失敗した（Web モード）。 */
  | "unauthorized"
  /** ログインの失敗が続いたため、しばらく受け付けない。 */
  | "throttled";

/** 役割（Web モード）。 */
export type Role = "viewer" | "translator" | "reviewer" | "manager";

/** 呼び出しごとの利用者（Web モード）。ないときはローカルモード。 */
export interface CallContext {
  user: { name: string; displayName?: string };
  role: Role;
  /** 編集とレビューをこの言語のセルに限る。省略時はすべての言語。 */
  languages?: string[];
  /**
   * サーバーの管理者（AuthService.callContextFor が付ける）。プロジェクトの基盤の設定（storage、pluginDirs など）を変えられ、
   * サーバーのパスや接続先を伏せない。
   */
  admin?: boolean;
}

/** いまの利用者ができること。 */
export interface Permissions {
  role: Role;
  can: { edit: boolean; review: boolean; run: boolean; manage: boolean };
  languages?: string[];
}

/** 利用者ごとの設定の置き場所（Web モード。ServerRuntime が AuthService で用意する）。 */
export interface UserSettingsStore {
  get(userName: string): Promise<Record<string, unknown>>;
  set(userName: string, values: Record<string, unknown>): Promise<void>;
}

/** 失敗は ApiError で投げる。RPC 層は { error: { code, message, data } } にして返す。 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly data?: unknown;
  constructor(code: ApiErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export interface SetTextParams {
  resourceId: string;
  key: string;
  language: LanguageId;
  value: string;
  /**
   * 編集を始めたときの値（ドラフトがあればドラフトの値）。渡すと、いまの値と違うときは上書きせずに conflict にする
   * （data: { value: いまの値, by: 変えた人 }）。省略時は従来どおり上書きする。
   */
  baseValue?: string;
}

export interface GenerateParams {
  columnId: string;
  scope: "cell" | "selection" | "resource" | "project";
  resourceId?: string;
  keys?: string[];
  languages?: LanguageId[];
  dryRun?: boolean;
}

export interface RunActionParams {
  actionId: string;
  resourceId: string;
  keys?: string[];
  cellId?: string;
  language?: LanguageId;
}

export interface RunActionResult {
  message?: string;
  open?: ActionResult["open"];
  patched: number;
  jobId?: string;
  /** 反映できなかった変更点の理由。 */
  errors?: string[];
}

/** 引数のないメソッドも RPC の都合で 1 つ受け取る（無視する）。 */
export type NoParams = Record<string, never> | undefined | void;

export interface WorkspaceApi {
  // 読み取り
  info(params?: NoParams): Promise<ProjectInfo>;
  tree(params?: NoParams): Promise<TreeNodeInfo[]>;
  stats(params: { resourceIds: string[] }): Promise<ResourceStats[]>;
  rows(req: RowsRequest): Promise<RowsResponse>;
  rowDetail(params: { resourceId: string; key: string }): Promise<{ row: RowInfo; languages: LanguageId[] }>;
  history(params: { resourceId: string; key: string; cellId?: string; limit?: number }): Promise<HistoryInfo[]>;
  reviews(params: { resourceId: string; key: string; cellId: string }): Promise<ReviewInfo[]>;
  textVersion(params: { hash: string }): Promise<{ text?: string }>;
  /** 保存せずに本文を確かめる（入力中の確認用）。何も保存しない。 */
  validateText(params: { resourceId: string; key: string; language: LanguageId; value: string }): Promise<IssueInfo[]>;
  search(params: { query: string; languages?: LanguageId[]; limit?: number }): Promise<SearchHit[]>;
  settings(params?: NoParams): Promise<{
    local: SettingInfo[];
    localFile: string;
    project: ProjectConfig;
    projectFromCode: string[];
    projectFile: string;
  }>;
  plugins(params?: NoParams): Promise<{
    plugins: PluginInfo[];
    dirs: { dir: string; layer: PluginLayer; exists: boolean }[];
    errors: PluginLoadError[];
    warnings: string[];
    untrusted: UntrustedPluginInfo[];
  }>;
  jobs(params?: NoParams): Promise<JobInfo[]>;
  job(params: { id: string }): Promise<JobInfo>;
  changes(params: { since: number }): Promise<{ changeSeq: number; changed: boolean; localSeq: number }>;

  // 書き込み
  setText(params: SetTextParams): Promise<{ cell: CellInfo; unsaved: number }>;
  discardDrafts(params: { resourceId: string; keys?: string[] }): Promise<{ unsaved: number }>;
  save(params: { resourceId: string }): Promise<{ saved: number; conflicts: { key: string; language: LanguageId }[] }>;
  saveAll(params?: NoParams): Promise<{
    resources: number;
    saved: number;
    conflicts: number;
    conflictList: { resourceId: string; key: string; language: LanguageId }[];
  }>;
  /** 複数のリソースを確かめる（一括用）。読めないリソースはそのリソースの error に出し、ほかは続ける。 */
  validate(params?: { resourceIds?: string[]; languages?: LanguageId[] }): Promise<ValidateResult>;
  setCell(params: { resourceId: string; key: string; cellId: string; value: unknown; expectedVersion?: number }): Promise<CellInfo>;
  setCells(params: { resourceId: string; keys: string[]; cellId: string; value: unknown }): Promise<{ updated: number; blocked: string[] }>;
  postReview(params: {
    resourceId: string;
    key: string;
    cellId: string;
    verdict: string;
    comment: string;
    forward?: boolean;
  }): Promise<ReviewInfo>;
  forwardReview(params: { resourceId: string; key: string; cellId: string; reviewId: string; actionId: string }): Promise<ReviewInfo>;
  runAction(params: RunActionParams): Promise<RunActionResult>;
  generate(params: GenerateParams): Promise<{ jobId?: string; total: number; cached: number; toRun: number }>;
  cancelJob(params: { id: string }): Promise<JobInfo>;
  setLocalSetting(params: { key: string; value: unknown }): Promise<SettingInfo[]>;
  updateProjectSettings(params: { patch: Record<string, unknown> }): Promise<ProjectInfo>;
  reloadPlugins(params?: NoParams): Promise<ProjectInfo>;
  /**
   * 確認したプラグインとコードの設定を信頼する（ハッシュをローカル設定に残し、読み直す）。
   * いまの中身のハッシュが items の hash と違えば conflict（data: { path, hash: いまのハッシュ }）。
   */
  trustPlugins(params: { items: TrustItem[] }): Promise<ProjectInfo>;
  /** プラグインの信頼を取り消す（読み直す）。 */
  untrustPlugins(params: { paths: string[] }): Promise<ProjectInfo>;
  reloadResource(params: { resourceId: string }): Promise<{ revision?: string }>;
}

export interface Workspace extends WorkspaceApi {
  readonly project: Project;
  /** ジョブが終わるまで待つ（コマンドライン用。RPC では公開しない）。 */
  waitForJob(id: string): Promise<JobInfo>;
  /** 独自描画のモジュール（.js / .mjs）の中身。読み込んだプラグインに登録されたものだけ。RPC では公開しない。 */
  rendererModule(id: string): Promise<{ source: string; hash: string; contentType: "text/javascript" } | undefined>;
  /** fn を利用者 call の呼び出しとして実行する（利用者ごとの設定を読み込む）。dispatch が使う。 */
  withCall<T>(call: CallContext, fn: () => Promise<T>): Promise<T>;
  /** コードの設定を信頼するまでの制限された状態か。 */
  readonly restricted: boolean;
  /** 管理者でない利用者に返す値から伏せるパス（dispatch の伏せる処理が使う）と、伏せた内部のエラーを残す先。 */
  redaction(): { paths: { prefix: string; label: string }[]; log(message: string): void };
  close(): Promise<void>;
}

/** RPC で公開するメソッド名の一覧（許可リスト）。 */
export const WORKSPACE_METHODS = [
  "info",
  "tree",
  "stats",
  "rows",
  "rowDetail",
  "history",
  "reviews",
  "textVersion",
  "validateText",
  "search",
  "settings",
  "plugins",
  "jobs",
  "job",
  "changes",
  "setText",
  "discardDrafts",
  "save",
  "saveAll",
  "validate",
  "setCell",
  "setCells",
  "postReview",
  "forwardReview",
  "runAction",
  "generate",
  "cancelJob",
  "setLocalSetting",
  "updateProjectSettings",
  "reloadPlugins",
  "trustPlugins",
  "untrustPlugins",
  "reloadResource",
] as const satisfies readonly (keyof WorkspaceApi)[];

// 一覧に漏れがないことを型で確かめる（WorkspaceApi にメソッドを足したら、ここも足す）。
type MissingMethods = Exclude<keyof WorkspaceApi, (typeof WORKSPACE_METHODS)[number]>;
const _allMethodsListed: MissingMethods extends never ? true : MissingMethods = true;
void _allMethodsListed;
