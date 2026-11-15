/**
 * 解析したドキュメントのキャッシュ。
 * リソースは Project（TreeProvider と Format）経由でしか読まない。
 */
import type { Project } from "@loc-studio/core";
import type { Diagnostic, EntryData, Format, LanguageId, Options, ParsedDocument, ResourceRef, TextToken, TreeNode } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { IssueInfo } from "./api-types.js";

export interface CachedValidation {
  value: string;
  base: string | undefined;
  issues: IssueInfo[];
}

export interface DocState {
  resource: ResourceRef;
  format: Format;
  options: Options;
  entries: EntryData[];
  /** キー → entries の添字。 */
  index: Map<string, number>;
  diagnostics: Diagnostic[];
  /** TreeProvider が版を出さない場合は undefined。 */
  revision?: string;
  /** 最後に TreeProvider の版を確かめた時刻（performance.now()）。 */
  checkedAt: number;
  /** 読み直すたびに変わる番号（統計のキャッシュの鍵）。 */
  version: number;
  tokenize: (text: string) => TextToken[];
  /** 検索用に小文字にした値（必要になったときに作る）。 */
  lower?: { keys: string[]; texts: Map<LanguageId, string[]> };
  /** バリデーションの結果。キーは `${key}\0${language}`。 */
  validation: Map<string, CachedValidation>;
}

let versionSeq = 0;

/** 版の確認の既定の間隔。ネットワークの向こうのリソースで、表示のたびに API を呼ばないため。 */
export const DEFAULT_REVISION_CHECK_INTERVAL_MS = 3000;

export function flattenTree(nodes: TreeNode[], out: ResourceRef[] = []): ResourceRef[] {
  for (const node of nodes) {
    if (node.kind === "resource" && node.resource) out.push(node.resource);
    if (node.children) flattenTree(node.children, out);
  }
  return out;
}

export class DocumentCache {
  private resources = new Map<string, ResourceRef>();
  private resourcesLoaded = false;
  private states = new Map<string, DocState>();
  private loading = new Map<string, Promise<DocState>>();
  /** setParsed / invalidate のたびに増える。読み込み中に新しい状態が入ったら、古い読み込みの結果は捨てる。 */
  private gens = new Map<string, number>();

  /**
   * @param revisionCheckIntervalMs 版の確認の間隔。この間は TreeProvider の revision を呼ばずにキャッシュを使う（0 で毎回確かめる）。
   */
  constructor(
    private readonly project: () => Project,
    private readonly revisionCheckIntervalMs: number = DEFAULT_REVISION_CHECK_INTERVAL_MS,
  ) {}

  /** ツリーを読み直し、リソースの一覧を更新する。 */
  async refreshTree(): Promise<TreeNode[]> {
    const nodes = await this.project().tree();
    const map = new Map<string, ResourceRef>();
    for (const r of flattenTree(nodes)) map.set(r.id, r);
    this.resources = map;
    this.resourcesLoaded = true;
    for (const id of [...this.states.keys()]) if (!map.has(id)) this.invalidate(id);
    return nodes;
  }

  async allResources(): Promise<ResourceRef[]> {
    if (!this.resourcesLoaded) await this.refreshTree();
    return [...this.resources.values()];
  }

  async resource(id: string): Promise<ResourceRef> {
    if (typeof id !== "string" || id === "") throw new ApiError("invalid", "resourceId を指定してください。");
    let r = this.resources.get(id);
    if (!r) {
      await this.refreshTree();
      r = this.resources.get(id);
    }
    if (!r) throw new ApiError("not-found", `リソース "${id}" が見つかりません。`);
    return r;
  }

  /** キャッシュ済みの状態（版の確認も読み込みもしない）。 */
  peek(id: string): DocState | undefined {
    return this.states.get(id);
  }

  /**
   * 解析済みのドキュメント。版が変わっていたら読み直す。
   * 版の確認は revisionCheckIntervalMs に 1 回まで（force で必ず確かめる）。
   */
  async get(id: string, opts: { force?: boolean } = {}): Promise<DocState> {
    const resource = await this.resource(id);
    const state = this.states.get(id);
    if (state) {
      if (state.revision === undefined) return state;
      const now = performance.now();
      if (!opts.force && this.revisionCheckIntervalMs > 0 && now - state.checkedAt < this.revisionCheckIntervalMs) return state;
      const rev = await this.project().revision(resource);
      if (rev === state.revision) {
        state.checkedAt = now;
        return state;
      }
    }
    return this.load(resource);
  }

  /** キャッシュを捨てて読み直す。 */
  async reload(id: string): Promise<DocState> {
    const resource = await this.resource(id);
    this.invalidate(id);
    return this.load(resource);
  }

  private load(resource: ResourceRef): Promise<DocState> {
    const pending = this.loading.get(resource.id);
    if (pending) return pending;
    const gen = this.gens.get(resource.id) ?? 0;
    const p = (async () => {
      const project = this.project();
      let read;
      try {
        // 中身と版は 1 回で読む（TreeProvider.readWithRevision があればそれを使う）。
        read = await project.readDocument(resource);
      } catch (err) {
        throw new ApiError("failed", err instanceof Error ? err.message : String(err));
      }
      const state = this.makeState(resource, read.document, read.format, read.options, read.revision);
      if ((this.gens.get(resource.id) ?? 0) === gen) this.states.set(resource.id, state);
      return state;
    })();
    this.loading.set(resource.id, p);
    const clear = (): void => {
      if (this.loading.get(resource.id) === p) this.loading.delete(resource.id);
    };
    p.then(clear, clear);
    return p;
  }

  /** 保存の直後など、手元で解析した結果を入れる。 */
  setParsed(resource: ResourceRef, doc: ParsedDocument, format: Format, options: Options, revision: string | undefined): DocState {
    this.gens.set(resource.id, (this.gens.get(resource.id) ?? 0) + 1);
    this.loading.delete(resource.id);
    const state = this.makeState(resource, doc, format, options, revision);
    this.states.set(resource.id, state);
    return state;
  }

  invalidate(id: string): void {
    this.gens.set(id, (this.gens.get(id) ?? 0) + 1);
    this.states.delete(id);
    this.loading.delete(id);
  }

  /** 設定やプラグインを読み直したとき。フォーマットや記法が変わりうるので全部捨てる。 */
  clear(): void {
    for (const id of [...this.states.keys(), ...this.loading.keys()]) this.invalidate(id);
    this.resources = new Map();
    this.resourcesLoaded = false;
  }

  private makeState(
    resource: ResourceRef,
    doc: ParsedDocument,
    format: Format,
    options: Options,
    revision: string | undefined,
  ): DocState {
    const index = new Map<string, number>();
    doc.entries.forEach((e, i) => {
      // 同じキーが重なったら最初の行を使う（フォーマットの診断に任せる）。
      if (!index.has(e.key)) index.set(e.key, i);
    });
    const state: DocState = {
      resource,
      format,
      options,
      entries: doc.entries,
      index,
      diagnostics: doc.diagnostics ?? [],
      checkedAt: performance.now(),
      version: ++versionSeq,
      tokenize: this.project().tokenizer(format),
      validation: new Map(),
    };
    if (revision !== undefined) state.revision = revision;
    return state;
  }
}

/** 検索用の小文字の値を作る（初回だけ）。 */
export function lowerOf(doc: DocState, languages: LanguageId[]): { keys: string[]; texts: Map<LanguageId, string[]> } {
  if (!doc.lower) doc.lower = { keys: doc.entries.map((e) => e.key.toLowerCase()), texts: new Map() };
  for (const lang of languages) {
    if (!doc.lower.texts.has(lang)) doc.lower.texts.set(lang, doc.entries.map((e) => (e.text[lang] ?? "").toLowerCase()));
  }
  return doc.lower;
}
