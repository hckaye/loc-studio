/**
 * ワークスペースの内部状態と、各メソッドが共通に使う補助。
 */
import { columnAppliesTo, resolveUserName, secretEnvName, isEnforceable } from "@loc-studio/core";
import type { Project, ResolvedColumnSource, ResolvedSetting, SettingsLayers } from "@loc-studio/core";
import type { Store } from "@loc-studio/store";
import type {
  Action,
  CellRef,
  ColumnDef,
  Entry,
  EntryData,
  Generator,
  LanguageDef,
  LanguageId,
  Options,
  SecretReader,
  UseRef,
} from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { HistoryCause, JobInfo, UserSettingsStore } from "./api-types.js";
import { DocumentCache } from "./documents.js";
import type { DocState } from "./documents.js";
import { DraftStore, DRAFTS_NS } from "./drafts.js";
import { textHash } from "./hash.js";
import { JobManager, JOBS_LOG_NS } from "./jobs.js";
import { KeyedMutex } from "./mutex.js";
import { currentCall, currentCallState } from "./call-context.js";

export const HISTORY_NS = "core.history";
export const TEXT_VERSIONS_NS = "core.text-versions";
export const TEXT_BASIS_NS = "core.text-basis";
export const GENERATED_NS = "core.generated";
export const GENERATED_CELLS_NS = "core.generated-cells";
export const REVIEW_FORWARDS_NS = "core.review-forwards";

export interface HistoryData {
  oldValue: unknown;
  newValue: unknown;
  cause: HistoryCause;
  causeRef?: string;
}

export const normalizeUse = (ref: UseRef): { use: string; options: Options } =>
  typeof ref === "string" ? { use: ref, options: {} } : { use: ref.use, options: ref.options ?? {} };

export const enumOf = (column: ColumnDef) =>
  typeof column.type === "object" && column.type !== null && Array.isArray(column.type.enum) ? column.type : undefined;

/** 値のない enum の列は type.default とみなす。 */
export const defaultValue = (column: ColumnDef): unknown => enumOf(column)?.default;

/** 値をリソースの中に持つ列（フォーマット経由で読み書きする meta 列）。 */
export const isFileColumn = (column: ColumnDef): boolean =>
  column.kind === "meta" && (column.source === undefined || column.source === "file");

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface WsContextInit {
  project: Project;
  shared: Store;
  local: Store;
  /** プラグインに見せる環境変数（Web モードでは許可した名前だけ）。 */
  env: Record<string, string | undefined>;
  /** 秘密情報（LOC_STUDIO_SECRET_*）を読む環境変数。省略時は env。 */
  secretEnv?: Record<string, string | undefined>;
  layers: SettingsLayers;
  localFile: string;
  userDataDir: string;
  storagePath: string;
  storageShared: boolean;
  revisionCheckIntervalMs?: number;
  userSettings?: UserSettingsStore;
  /** 確認のモード（pluginTrust: "prompt"）か。 */
  promptTrust?: boolean;
}

export class WsContext {
  project!: Project;
  readonly shared: Store;
  readonly local: Store;
  readonly env: Record<string, string | undefined>;
  layers: SettingsLayers;
  readonly localFile: string;
  readonly userDataDir: string;
  readonly storagePath: string;
  readonly storageShared: boolean;
  readonly userSettings?: UserSettingsStore;
  readonly promptTrust: boolean;

  readonly docs: DocumentCache;
  readonly drafts: DraftStore;
  readonly jobs: JobManager;
  readonly locks = new KeyedMutex();
  /** 実行中に起きた、利用者に知らせたい問題（転載の失敗など）。新しいものを後ろに足す。 */
  readonly runtimeWarnings: string[] = [];
  /** このワークスペースを通した変更のたびに増える（ドラフトも含む）。 */
  localSeq = 0;
  /** 設定・プラグインを読み直すたびに増える。 */
  configGen = 0;

  private columnsCache?: { gen: number; columns: ColumnDef[]; byId: Map<string, ColumnDef> };
  private sourceCache = new Map<string, ResolvedColumnSource | undefined>();
  private userCache?: ResolvedSetting<string>;
  private knownTextHashes = new Set<string>();
  readonly secrets: SecretReader;

  constructor(init: WsContextInit) {
    this.project = init.project;
    this.shared = init.shared;
    this.local = init.local;
    this.env = init.env;
    this.layers = init.layers;
    this.localFile = init.localFile;
    this.userDataDir = init.userDataDir;
    this.storagePath = init.storagePath;
    this.storageShared = init.storageShared;
    if (init.userSettings) this.userSettings = init.userSettings;
    this.promptTrust = init.promptTrust === true;
    this.docs = new DocumentCache(() => this.project, init.revisionCheckIntervalMs);
    this.drafts = new DraftStore(this.local.cells(DRAFTS_NS), () => this.textColumn()?.id);
    this.jobs = new JobManager(
      () => this.shared.log<JobInfo>(JOBS_LOG_NS),
      () => this.userName(),
      (m) => this.warn(m),
      () => this.bump(),
    );
    const layers = (): SettingsLayers => this.layers;
    this.secrets = {
      get(name) {
        // ローカル設定の "secrets.<名前>" を先に見て、なければ環境変数。
        const local = layers().local?.[`secrets.${name}`];
        if (typeof local === "string" && local !== "") return local;
        const fromEnv = (init.secretEnv ?? init.env)[secretEnvName(name)];
        return fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 利用者と設定
  // ---------------------------------------------------------------------------

  userInfo(): ResolvedSetting<string> {
    // Web モードの呼び出しの中では、アカウントの名前（設定では変えられない）。
    const call = currentCall();
    if (call) return { key: "user.name", value: call.user.name, source: "enforce", locked: true };
    this.userCache ??= resolveUserName(this.layers);
    return this.userCache;
  }

  /** いまの設定の層。Web モードの呼び出しの中では、その利用者の設定を local の層に使う。 */
  currentLayers(): SettingsLayers {
    return currentCallState()?.layers ?? this.layers;
  }

  /** 記録に残すいまのユーザー名。共有 DB とプラグインのホストが同じ関数を使う。 */
  userName(): string {
    return this.userInfo().value;
  }

  setLayers(layers: SettingsLayers): void {
    this.layers = layers;
    this.userCache = undefined;
  }

  isLocked(key: string): boolean {
    const enforce = this.currentLayers().enforce;
    return enforce !== undefined && Object.prototype.hasOwnProperty.call(enforce, key) && enforce[key] !== undefined && isEnforceable(key);
  }

  bump(): void {
    this.localSeq++;
  }

  warn(message: string): void {
    // 同じ警告を何度も積まない（info を呼ぶたびに確かめる警告など）。
    if (this.runtimeWarnings.includes(message)) return;
    this.runtimeWarnings.push(message);
    if (this.runtimeWarnings.length > 100) this.runtimeWarnings.splice(0, this.runtimeWarnings.length - 100);
    this.project.host.log(message);
  }

  /** 設定やプラグインを読み直したあとの後始末。 */
  async afterReload(): Promise<void> {
    this.configGen++;
    this.columnsCache = undefined;
    this.sourceCache = new Map();
    this.docs.clear();
    await this.drafts.load();
  }

  // ---------------------------------------------------------------------------
  // 列と言語
  // ---------------------------------------------------------------------------

  columns(): ColumnDef[] {
    if (!this.columnsCache || this.columnsCache.gen !== this.configGen) {
      const columns = this.project.columns();
      this.columnsCache = { gen: this.configGen, columns, byId: new Map(columns.map((c) => [c.id, c])) };
    }
    return this.columnsCache.columns;
  }

  column(id: string): ColumnDef | undefined {
    this.columns();
    return this.columnsCache!.byId.get(id);
  }

  textColumn(): ColumnDef | undefined {
    return this.columns().find((c) => c.kind === "text");
  }

  requireTextColumn(): ColumnDef {
    const col = this.textColumn();
    if (!col) throw new ApiError("invalid", "本文の列（kind: \"text\"）が設定の columns にありません。");
    return col;
  }

  columnSource(column: ColumnDef): ResolvedColumnSource | undefined {
    if (!this.sourceCache.has(column.id)) this.sourceCache.set(column.id, this.project.columnSource(column));
    return this.sourceCache.get(column.id);
  }

  language(id: LanguageId): LanguageDef | undefined {
    return this.project.language(id);
  }

  requireLanguage(id: LanguageId): LanguageDef {
    const l = this.language(id);
    if (!l) throw new ApiError("invalid", `言語 "${id}" はプロジェクトにありません。`);
    return l;
  }

  /** 列がその言語に出るか（entry スコープの列は undefined のときだけ）。 */
  applies(column: ColumnDef, language: LanguageId | undefined): boolean {
    if (column.scope === "entry") return language === undefined;
    return language !== undefined && columnAppliesTo(column, language);
  }

  cellId(column: ColumnDef, language?: LanguageId): string {
    return column.scope === "language" ? `${column.id}@${language ?? ""}` : column.id;
  }

  parseCellId(cellId: string): { column: ColumnDef; language?: LanguageDef } {
    if (typeof cellId !== "string" || cellId === "") throw new ApiError("invalid", "cellId を指定してください。");
    const direct = this.column(cellId);
    if (direct && direct.scope === "entry") return { column: direct };
    for (let i = cellId.indexOf("@"); i >= 0; i = cellId.indexOf("@", i + 1)) {
      const column = this.column(cellId.slice(0, i));
      if (!column || column.scope !== "language") continue;
      const language = this.language(cellId.slice(i + 1));
      if (!language) continue;
      if (!columnAppliesTo(column, language.id)) {
        throw new ApiError("invalid", `列 "${column.id}" は言語 "${language.id}" にはありません。`);
      }
      return { column, language };
    }
    throw new ApiError("not-found", `セル "${cellId}" に当たる列がありません（entry の列は "列 ID"、言語の列は "列 ID@言語 ID"）。`);
  }

  // ---------------------------------------------------------------------------
  // 行
  // ---------------------------------------------------------------------------

  entryOf(doc: DocState, key: string): EntryData {
    if (typeof key !== "string") throw new ApiError("invalid", "key を指定してください。");
    const i = doc.index.get(key);
    const e = i === undefined ? undefined : doc.entries[i];
    if (!e) throw new ApiError("not-found", `リソース "${doc.resource.id}" にキー "${key}" の行がありません。`);
    return e;
  }

  toEntry(doc: DocState, data: EntryData): Entry {
    const e: Entry = { key: data.key, resource: doc.resource };
    if (data.stableId !== undefined) e.stableId = data.stableId;
    if (data.meta !== undefined) e.meta = data.meta;
    return e;
  }

  /** 本文（ドラフトがあればドラフト）。 */
  effectiveText(resourceId: string, data: EntryData, language: LanguageId): string | undefined {
    const d = this.drafts.get(resourceId, data.key, language);
    return d ? d.value : data.text[language];
  }

  cellRef(resourceId: string, key: string, column: ColumnDef, language?: LanguageId): CellRef {
    const ref: CellRef = { resourceId, entryKey: key, columnId: column.id };
    if (column.scope === "language" && language !== undefined) ref.language = language;
    return ref;
  }

  // ---------------------------------------------------------------------------
  // 実装の解決
  // ---------------------------------------------------------------------------

  /** 設定の actions で選ばれたアクション。 */
  configuredActions(): { action: Action; options: Options }[] {
    return this.resolveActions(this.project.config.actions ?? []);
  }

  /** 設定 review.targets のレビュー先。 */
  reviewTargets(): { action: Action; options: Options }[] {
    return this.resolveActions(this.project.config.review?.targets ?? []);
  }

  private resolveActions(refs: UseRef[]): { action: Action; options: Options }[] {
    const out: { action: Action; options: Options }[] = [];
    for (const ref of refs) {
      const { use, options } = normalizeUse(ref);
      const action = this.project.registry.get("action", use);
      if (action) out.push({ action, options });
    }
    return out;
  }

  /** 生成列の生成器と options。設定 generators の名前から引く。 */
  generatorFor(column: ColumnDef): { generator: Generator; options: Options; name: string } | undefined {
    if (column.kind !== "generated" || column.generator === undefined) return undefined;
    const ref = this.project.config.generators?.[column.generator];
    // 設定に名前がなければ、生成器の id として引く。
    const { use, options } = ref !== undefined ? normalizeUse(ref) : { use: column.generator, options: {} };
    const generator = this.project.registry.get("generator", use);
    return generator ? { generator, options, name: column.generator } : undefined;
  }

  // ---------------------------------------------------------------------------
  // 記録
  // ---------------------------------------------------------------------------

  /** 本文の全文を版（ハッシュ）で引けるよう kv("core.text-versions") に残し、版を返す。 */
  async rememberTexts(texts: string[]): Promise<string[]> {
    const hashes = texts.map(textHash);
    const toWrite: Record<string, string> = {};
    texts.forEach((t, i) => {
      const h = hashes[i]!;
      if (!this.knownTextHashes.has(h)) toWrite[h] = t;
    });
    const keys = Object.keys(toWrite);
    if (keys.length > 0) {
      await this.shared.kv(TEXT_VERSIONS_NS).setMany(toWrite);
      for (const k of keys) this.knownTextHashes.add(k);
    }
    return hashes;
  }

  async appendHistory(entries: { cell: CellRef; data: HistoryData }[]): Promise<void> {
    if (entries.length === 0) return;
    await this.shared.log<HistoryData>(HISTORY_NS).append(entries);
  }

  /** history: false の列は履歴に残さない。 */
  recordsHistory(column: ColumnDef): boolean {
    return column.history !== false;
  }
}
