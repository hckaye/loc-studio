import { realpath } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import type {
  Change,
  ColumnDef,
  ColumnSourceContext,
  Format,
  FormatContext,
  LanguageDef,
  LanguageId,
  Options,
  ParsedDocument,
  Plugin,
  PluginHost,
  ProjectConfig,
  ResourceRef,
  RoleDef,
  TextSyntax,
  TextToken,
  TreeContext,
  TreeNode,
  TreeProvider,
  UseRef,
  ValidatorUse,
} from "@loc-studio/sdk";
import { cloneColumn, DEFAULT_COLUMNS, resolveColumns, resolveColumnSource } from "./columns.js";
import type { ResolvedColumnSource } from "./columns.js";
import { loadProjectConfig } from "./config.js";
import { createPluginHost } from "./host.js";
import { createProjectReader } from "./project-reader.js";
import { resolveRoles } from "./roles.js";
import { createMemoryDb } from "./memory-db.js";
import { defaultPluginDirs, loadPluginDirs } from "./plugin-loader.js";
import type { PluginCandidate } from "./plugin-loader.js";
import { EXTENSION_FIELDS, EXTENSION_KINDS, PluginRegistry } from "./registry.js";
import type { ExtensionKind, PluginDirSpec, PluginLoadError, ResolvedValidator } from "./types.js";

export interface OpenProjectOptions {
  /** 最初に登録する同梱のプラグイン（層は "builtin"）。 */
  builtins?: Plugin[];
  /** 配布したアプリのフォルダ。その中の plugins を読む。 */
  appDir?: string;
  /** 個人の設定フォルダ。その中の plugins を読む（層は "local"）。 */
  userDataDir?: string;
  env?: Record<string, string | undefined>;
  sdkPath?: string;
  /**
   * プラグインに渡すホストの機能（DB、利用者など）。
   * 省略時はメモリ上の DB と利用者名 "unknown" で作る（閉じると中身は消える）。
   */
  host?: PluginHost;
  /**
   * project / local 層のプラグインを読み込んでよいか。false を返したものは読み込まず（コードを import せず）、
   * untrustedPlugins に入れる。builtin / app 層には呼ばない。省略時はすべて読み込む（コマンドライン）。
   */
  trust?: (candidate: PluginCandidate) => boolean;
  /**
   * project 層のプラグインのフォルダを、実体がこのどれかの中にあるものに限る（Web モード: プロジェクトのルートとアプリのフォルダ）。
   * 外を指すフォルダは読み込まず、警告にする。
   */
  pluginDirRoots?: string[];
}

/** リソースを書くときの指定。 */
export interface WriteResourceOptions {
  /** いまの版がこれと違えば書かずにエラーにする（TreeProvider が対応している場合）。 */
  expectedRevision?: string;
}

export interface Project {
  readonly root: string;
  readonly config: ProjectConfig;
  readonly configFromCode: string[];
  readonly registry: PluginRegistry;
  readonly pluginDirs: PluginDirSpec[];
  readonly pluginErrors: PluginLoadError[];
  /** trust が false を返したため読み込まなかったプラグイン。 */
  readonly untrustedPlugins: PluginCandidate[];
  /** レジストリの警告と、プロジェクトは開けるが直したほうがよい設定の問題。 */
  readonly warnings: string[];
  readonly languages: LanguageDef[];
  /** プラグインに渡すホストの機能。reload しても同じものを使う。 */
  readonly host: PluginHost;
  language(id: LanguageId): LanguageDef | undefined;
  /** 設定の `columns` を解決した列の並び。問題のある列は除き、warnings に理由を出す。 */
  columns(): ColumnDef[];
  /** 列の値を読み書きする列ソース。列ソースを使わない列や、見つからない場合は undefined。 */
  columnSource(column: ColumnDef): ResolvedColumnSource | undefined;
  /** 列ソースを呼ぶときに渡す文脈。 */
  sourceContext(resolved: { options: Options }): ColumnSourceContext;
  tree(): Promise<TreeNode[]>;
  resources(): Promise<ResourceRef[]>;
  formatFor(resource: ResourceRef, head?: Uint8Array): { format: Format; options: Options } | undefined;
  /** 中身と、その中身の版。readDocument の revision は読んだ中身の版（版を出さない TreeProvider では undefined）。 */
  readDocument(
    resource: ResourceRef,
  ): Promise<{ document: ParsedDocument; format: Format; options: Options; bytes: Uint8Array; revision?: string }>;
  /**
   * 中身と版をまとめて読む。TreeProvider に readWithRevision があればそれを使い、なければ revision → read の順で呼ぶ
   * （読んでいる間に書き換えられても、古い版を返すだけで新しい中身を古い版と取り違えない）。
   */
  readWithRevision(resource: ResourceRef): Promise<{ data: Uint8Array; revision?: string }>;
  /** TreeProvider の write が投げた例外（RevisionConflictError など）は包まずにそのまま投げる。 */
  applyChanges(resource: ResourceRef, changes: Change[], opts?: WriteResourceOptions): Promise<void>;
  /** リソースのいまの版。TreeProvider が版を出さない場合は undefined。 */
  revision(resource: ResourceRef): Promise<string | undefined>;
  /** リソースのバイト列をそのまま読む（TreeProvider 経由）。 */
  readBytes(resource: ResourceRef): Promise<Uint8Array>;
  /** リソースのバイト列をそのまま書く（TreeProvider 経由）。 */
  writeBytes(resource: ResourceRef, data: Uint8Array, opts?: WriteResourceOptions): Promise<void>;
  /**
   * 新しいリソースの中身（行のない状態）を作る。場所からフォーマットを決め、Format.create で作る。
   * ツリーが作成に対応していない（TreeProvider.create がない）、フォーマットが決まらない、
   * フォーマットが作成に対応していない（Format.create がない）ときは、理由の分かる例外にする。
   */
  newResourceBytes(resourcePath: string): { data: Uint8Array; format: Format };
  /** 新しいリソースを作る（TreeProvider.create）。すでにあれば例外。 */
  createResource(resourcePath: string, data: Uint8Array): Promise<ResourceRef>;
  /**
   * リソースの変更の監視を始める（TreeProvider.watch）。戻り値は監視をやめる関数。
   * ツリーが監視に対応していなければ undefined。
   */
  watchResources(onChange: (resource: ResourceRef) => void): (() => void) | undefined;
  tokenizer(format?: Format): (text: string) => TextToken[];
  resolveValidators(): ResolvedValidator[];
  /** 役割の定義（同梱の役割に設定の `roles` を重ねたもの）。 */
  roles(): Record<string, RoleDef>;
  reload(): Promise<void>;
}

/** 設定の `tree` を省略したときに使うツリー。 */
export const DEFAULT_TREE: UseRef = { use: "builtin.globTree" };

/** 設定の `columns` を省略したときの列（columns.ts で定義）。 */
export { DEFAULT_COLUMNS };

/** 判定に渡す先頭のバイト数。 */
const HEAD_BYTES = 4096;

const normalizeUse = (ref: UseRef): { use: string; options: Options } =>
  typeof ref === "string" ? { use: ref, options: {} } :{ use: ref.use, options: ref.options ?? {} };

/** 設定の localSettings.enforce から、local 層で禁止する種類を求める。 */
export function localDenyKinds(config: ProjectConfig): ExtensionKind[] {
  const enforce = config.localSettings?.enforce ?? {};
  if (enforce["plugins.local"] === "deny") return [...EXTENSION_KINDS];
  return EXTENSION_KINDS.filter((kind) => enforce[`plugins.local.${EXTENSION_FIELDS[kind]}`] === "deny");
}

/**
 * 複数の記法を前から順に適用する。前の記法が "text" とした部分だけを次の記法で分ける。
 * 結果は途切れなく並び、つなげると本文全体になる。
 */
export function combineSyntaxes(syntaxes: TextSyntax[]): (text: string) => TextToken[] {
  return (text) => {
    if (text === "") return [];
    let tokens: TextToken[] = [{ kind: "text", value: text, range: { start: 0, end: text.length } }];
    for (const syntax of syntaxes) {
      const next: TextToken[] = [];
      for (const token of tokens) {
        if (token.kind !== "text") {
          next.push(token);
          continue;
        }
        const offset = token.range.start;
        for (const t of normalizeTokens(syntax.tokenize(token.value), token.value, syntax.id)) {
          next.push({ ...t, range: { start: t.range.start + offset, end: t.range.end + offset } });
        }
      }
      tokens = next;
    }
    return tokens;
  };
}

/** 記法の結果の隙間を "text" で埋め、範囲の壊れたものは記法の不具合として例外にする。 */
function normalizeTokens(tokens: TextToken[], text: string, syntaxId: string): TextToken[] {
  const out: TextToken[] = [];
  const gap = (start: number, end: number): TextToken => ({ kind: "text", value: text.slice(start, end), range: { start, end } });
  let pos = 0;
  for (const t of tokens) {
    const { start, end } = t.range;
    if (!(Number.isInteger(start) && Number.isInteger(end)) || start < pos || end < start || end > text.length) {
      throw new Error(
        `記法 "${syntaxId}" の結果の範囲が正しくありません（${start}〜${end}、本文の長さ ${text.length}）。トークンは重ならず、前から順に並べてください。`,
      );
    }
    if (start > pos) out.push(gap(pos, start));
    if (end > start) out.push({ ...t, value: text.slice(start, end), range: { start, end } });
    pos = end;
  }
  if (pos < text.length) out.push(gap(pos, text.length));
  return out;
}

function flattenTree(nodes: TreeNode[], out: ResourceRef[] = []): ResourceRef[] {
  for (const node of nodes) {
    if (node.kind === "resource" && node.resource) out.push(node.resource);
    if (node.children) flattenTree(node.children, out);
  }
  return out;
}

interface ProjectState {
  config: ProjectConfig;
  configFromCode: string[];
  registry: PluginRegistry;
  pluginDirs: PluginDirSpec[];
  pluginErrors: PluginLoadError[];
  untrustedPlugins: PluginCandidate[];
  warnings: string[];
  columns: ColumnDef[];
  roles: Record<string, RoleDef>;
}

async function buildState(root: string, opts: OpenProjectOptions): Promise<ProjectState> {
  const loaded = await loadProjectConfig(root, {
    ...(opts.sdkPath ? { sdkPath: opts.sdkPath } : {}),
    ...(opts.trust ? { trustConfig: opts.trust } : {}),
  });
  const config = loaded.config;
  const registry = new PluginRegistry();
  for (const plugin of opts.builtins ?? []) registry.register(plugin, { layer: "builtin" });

  const pluginDirs = defaultPluginDirs({
    projectRoot: root,
    config,
    ...(opts.appDir !== undefined ? { appDir: opts.appDir } : {}),
    ...(opts.userDataDir !== undefined ? { userDataDir: opts.userDataDir } : {}),
    env: opts.env ?? process.env,
  });
  const dirWarnings: string[] = [];
  const allowedDirs = opts.pluginDirRoots ? await filterPluginDirs(pluginDirs, opts.pluginDirRoots, dirWarnings) : pluginDirs;
  const { plugins, errors, untrusted } = await loadPluginDirs(allowedDirs, {
    ...(opts.sdkPath ? { sdkPath: opts.sdkPath } : {}),
    ...(opts.trust ? { trust: opts.trust } : {}),
  });
  const deny = localDenyKinds(config);
  for (const { plugin, origin } of plugins) {
    registry.register(plugin, origin, origin.layer === "local" && deny.length > 0 ? { deny } : undefined);
  }

  const resolved = resolveColumns(config, registry);
  const roles = resolveRoles(config, resolved.columns);
  const warnings = [...dirWarnings, ...registry.warnings, ...checkConfigRefs(config, registry), ...resolved.warnings, ...roles.warnings];
  if (loaded.codeError) warnings.unshift(loaded.codeError);
  if (loaded.untrustedCode) untrusted.unshift(loaded.untrustedCode);
  return {
    config,
    configFromCode: loaded.fromCode,
    registry,
    pluginDirs,
    pluginErrors: errors,
    untrustedPlugins: untrusted,
    warnings,
    columns: resolved.columns,
    roles: roles.roles,
  };
}

/** project 層のプラグインのフォルダのうち、実体が roots の外にあるものを除く。 */
async function filterPluginDirs(specs: PluginDirSpec[], roots: string[], warnings: string[]): Promise<PluginDirSpec[]> {
  const realRoots: string[] = [];
  for (const r of roots) {
    try {
      realRoots.push(await realpath(r));
    } catch {
      // ないフォルダは基準にしない
    }
  }
  const out: PluginDirSpec[] = [];
  for (const spec of specs) {
    if (spec.layer !== "project") {
      out.push(spec);
      continue;
    }
    let real: string;
    try {
      real = await realpath(spec.dir);
    } catch {
      out.push(spec); // ないフォルダは何も読み込まない
      continue;
    }
    const ok = realRoots.some((r) => {
      const rel = path.relative(r, real);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (ok) out.push(spec);
    else warnings.push(`プラグインのフォルダ ${spec.dir} はプロジェクトとアプリのフォルダの外にあるため、読み込みません。`);
  }
  return out;
}

/** 設定が名前で選んだ実装が登録されているかを確かめる。足りなくてもプロジェクトは開く。 */
function checkConfigRefs(config: ProjectConfig, registry: PluginRegistry): string[] {
  const warnings: string[] = [];
  const missing = (kind: ExtensionKind, id: string, where: string): void => {
    if (registry.get(kind, id) === undefined) {
      const ids = registry.list(kind).map((e) => `"${e.id}"`);
      warnings.push(`設定の ${where} にある ${kind} "${id}" は登録されていません（使える ${kind}: ${ids.join(", ") || "なし"}）。`);
    }
  };
  missing("tree", normalizeUse(config.tree ?? DEFAULT_TREE).use, "tree");
  config.formats?.forEach((f, i) => missing("format", f.use, `formats[${i}]`));
  config.syntaxes?.forEach((s, i) => missing("syntax", s, `syntaxes[${i}]`));
  config.validators?.forEach((v, i) => missing("validator", typeof v === "string" ? v : v.use, `validators[${i}]`));
  config.hooks?.forEach((h, i) => missing("hook", normalizeUse(h).use, `hooks[${i}]`));
  for (const [name, ref] of Object.entries(config.sources ?? {})) missing("source", normalizeUse(ref).use, `sources.${name}`);
  return warnings;
}

class ProjectImpl implements Project {
  readonly root: string;
  readonly host: PluginHost;
  private state: ProjectState;
  private readonly opts: OpenProjectOptions;
  private matchers = new Map<string, (p: string) => boolean>();
  private warnedSyntaxes = new Set<string>();

  constructor(root: string, state: ProjectState, opts: OpenProjectOptions, host: PluginHost) {
    this.root = root;
    this.host = host;
    this.state = state;
    this.opts = opts;
  }

  get config(): ProjectConfig {
    return this.state.config;
  }
  get configFromCode(): string[] {
    return this.state.configFromCode;
  }
  get registry(): PluginRegistry {
    return this.state.registry;
  }
  get pluginDirs(): PluginDirSpec[] {
    return this.state.pluginDirs;
  }
  get pluginErrors(): PluginLoadError[] {
    return this.state.pluginErrors;
  }
  get untrustedPlugins(): PluginCandidate[] {
    return this.state.untrustedPlugins;
  }
  get warnings(): string[] {
    return this.state.warnings;
  }
  get languages(): LanguageDef[] {
    return this.state.config.languages;
  }

  language(id: LanguageId): LanguageDef | undefined {
    return this.languages.find((l) => l.id === id);
  }

  columns(): ColumnDef[] {
    // 呼び出し側が書き換えても状態が壊れないよう、複製して返す。
    return cloneColumn(this.state.columns);
  }

  columnSource(column: ColumnDef): ResolvedColumnSource | undefined {
    return resolveColumnSource(column, this.config, this.registry);
  }

  sourceContext(resolved: { options: Options }): ColumnSourceContext {
    return { projectRoot: this.root, options: resolved.options, host: this.host };
  }

  private treeProvider(): { provider: TreeProvider; ctx: TreeContext } {
    const ref = normalizeUse(this.config.tree ?? DEFAULT_TREE);
    const provider = this.registry.require("tree", ref.use);
    return { provider, ctx: { projectRoot: this.root, options: ref.options, host: this.host } };
  }

  async tree(): Promise<TreeNode[]> {
    const { provider, ctx } = this.treeProvider();
    return provider.list(ctx);
  }

  async resources(): Promise<ResourceRef[]> {
    return flattenTree(await this.tree());
  }

  private globMatcher(glob: string): (p: string) => boolean {
    let m = this.matchers.get(glob);
    if (!m) {
      m = picomatch(glob, { dot: true });
      this.matchers.set(glob, m);
    }
    return m;
  }

  formatFor(resource: ResourceRef, head: Uint8Array = new Uint8Array()): { format: Format; options: Options } | undefined {
    const formats = this.config.formats;
    if (formats) {
      for (const use of formats) {
        const format = this.registry.get("format", use.use);
        if (!format) continue; // 警告は開いたときに出している。
        const applies = use.match !== undefined ? this.globMatcher(use.match)(resource.path) : format.match(resource, head);
        if (applies) return { format, options: use.options ?? {} };
      }
      return undefined;
    }
    // 設定がなければ登録されたものすべてで判定する。後の層で足したものを優先する。
    for (const { value } of [...this.registry.list("format")].reverse()) {
      if (value.match(resource, head)) return { format: value, options: {} };
    }
    return undefined;
  }

  private formatContext(resource: ResourceRef, options: Options): FormatContext {
    return { resource, languages: this.languages, options };
  }

  async readBytes(resource: ResourceRef): Promise<Uint8Array> {
    const { provider, ctx } = this.treeProvider();
    try {
      return await provider.read(resource, ctx);
    } catch (err) {
      throw new Error(`リソース ${resource.path} を読めませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async writeBytes(resource: ResourceRef, data: Uint8Array, opts?: WriteResourceOptions): Promise<void> {
    const { provider, ctx } = this.treeProvider();
    // 版の競合など、プロバイダーが投げた例外の種類を呼び出し側で見分けられるよう、包まずにそのまま投げる。
    await provider.write(resource, data, ctx, opts?.expectedRevision !== undefined ? { expectedRevision: opts.expectedRevision } : undefined);
  }

  newResourceBytes(resourcePath: string): { data: Uint8Array; format: Format } {
    const { provider } = this.treeProvider();
    if (typeof provider.create !== "function") {
      throw new Error(`ツリー "${provider.id}" は、新しいリソースの作成に対応していません。`);
    }
    const name = resourcePath.split("/").pop() ?? resourcePath;
    const candidate: ResourceRef = { id: resourcePath, path: resourcePath, name };
    const found = this.formatFor(candidate);
    if (!found) {
      const ids = this.registry.list("format").map((e) => `"${e.id}"`).join(", ") || "なし";
      throw new Error(`リソース ${resourcePath} を扱えるフォーマットがありません（登録されているフォーマット: ${ids}）。拡張子と、設定の formats を確かめてください。`);
    }
    if (typeof found.format.create !== "function") {
      throw new Error(`フォーマット "${found.format.id}" は、新しいリソースの作成に対応していません。`);
    }
    return { data: found.format.create([], this.formatContext(candidate, found.options)), format: found.format };
  }

  async createResource(resourcePath: string, data: Uint8Array): Promise<ResourceRef> {
    const { provider, ctx } = this.treeProvider();
    if (typeof provider.create !== "function") {
      throw new Error(`ツリー "${provider.id}" は、新しいリソースの作成に対応していません。`);
    }
    return provider.create(resourcePath, data, ctx);
  }

  watchResources(onChange: (resource: ResourceRef) => void): (() => void) | undefined {
    const { provider, ctx } = this.treeProvider();
    if (typeof provider.watch !== "function") return undefined;
    return provider.watch(ctx, onChange);
  }

  async revision(resource: ResourceRef): Promise<string | undefined> {
    const { provider, ctx } = this.treeProvider();
    if (!provider.revision) return undefined;
    return provider.revision(resource, ctx);
  }

  async readWithRevision(resource: ResourceRef): Promise<{ data: Uint8Array; revision?: string }> {
    const { provider, ctx } = this.treeProvider();
    try {
      if (provider.readWithRevision) {
        const r = await provider.readWithRevision(resource, ctx);
        return r.revision !== undefined ? { data: r.data, revision: r.revision } : { data: r.data };
      }
      const revision = provider.revision ? await provider.revision(resource, ctx) : undefined;
      const data = await provider.read(resource, ctx);
      return revision !== undefined ? { data, revision } : { data };
    } catch (err) {
      throw new Error(`リソース ${resource.path} を読めませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async readWithFormat(
    resource: ResourceRef,
  ): Promise<{ bytes: Uint8Array; format: Format; options: Options; revision?: string }> {
    const { data: bytes, revision } = await this.readWithRevision(resource);
    const found = this.formatFor(resource, bytes.subarray(0, HEAD_BYTES));
    if (!found) {
      const ids = this.registry.list("format").map((e) => `"${e.id}"`).join(", ") || "なし";
      throw new Error(`リソース ${resource.path} を扱えるフォーマットがありません（登録されているフォーマット: ${ids}）。`);
    }
    return revision !== undefined ? { bytes, ...found, revision } : { bytes, ...found };
  }

  async readDocument(
    resource: ResourceRef,
  ): Promise<{ document: ParsedDocument; format: Format; options: Options; bytes: Uint8Array; revision?: string }> {
    const { bytes, format, options, revision } = await this.readWithFormat(resource);
    const document = format.parse(bytes, this.formatContext(resource, options));
    return revision !== undefined ? { document, format, options, bytes, revision } : { document, format, options, bytes };
  }

  async applyChanges(resource: ResourceRef, changes: Change[], opts?: WriteResourceOptions): Promise<void> {
    if (changes.length === 0) return;
    const { bytes, format, options } = await this.readWithFormat(resource);
    const out = format.apply(bytes, changes, this.formatContext(resource, options));
    await this.writeBytes(resource, out, opts);
  }

  tokenizer(format?: Format): (text: string) => TextToken[] {
    let ids: string[] | undefined;
    if (format?.syntax) {
      if (this.registry.get("syntax", format.syntax)) {
        ids = [format.syntax];
      } else if (!this.warnedSyntaxes.has(format.syntax)) {
        this.warnedSyntaxes.add(format.syntax);
        this.state.warnings.push(
          `フォーマット "${format.id}" の記法 "${format.syntax}" は登録されていません。プロジェクトの既定の記法を使います。`,
        );
      }
    }
    ids ??= this.config.syntaxes ?? this.registry.list("syntax").map((e) => e.id);
    const syntaxes = ids.map((id) => this.registry.get("syntax", id)).filter((s): s is TextSyntax => s !== undefined);
    return combineSyntaxes(syntaxes);
  }

  resolveValidators(): ResolvedValidator[] {
    const result: ResolvedValidator[] = [];
    for (const item of this.config.validators ?? []) {
      const use: ValidatorUse = typeof item === "string" ? { use: item } : item;
      const validator = this.registry.get("validator", use.use);
      if (!validator) continue; // 警告は開いたときに出している。
      const resolved: ResolvedValidator = { validator, options: use.options ?? {} };
      if (use.severity !== undefined) resolved.severity = use.severity;
      if (use.languages !== undefined) resolved.languages = use.languages;
      if (use.columns !== undefined) resolved.columns = use.columns;
      result.push(resolved);
    }
    return result;
  }

  roles(): Record<string, RoleDef> {
    return this.state.roles;
  }

  async reload(): Promise<void> {
    // 読み直しに失敗したら例外にして、いまの状態はそのまま残す。
    const next = await buildState(this.root, this.opts);
    this.state = next;
    this.matchers = new Map();
    this.warnedSyntaxes = new Set();
  }
}

/** プロジェクトを開く。プラグインの読み込みに失敗しても開き、失敗は pluginErrors に入る。 */
export async function openProject(projectRoot: string, opts: OpenProjectOptions = {}): Promise<Project> {
  const root = path.resolve(projectRoot);
  const state = await buildState(root, opts);
  const userName = (): string => "unknown";
  // ホストの project（リソースと行を読む窓口）は、これから作るプロジェクト自身を読む。
  const self: { project?: Project } = {};
  const host =
    opts.host ??
    createPluginHost({
      db: createMemoryDb({ userName }),
      userName,
      projectRoot: root,
      env: opts.env ?? process.env,
      project: createProjectReader({ project: () => self.project! }),
    });
  self.project = new ProjectImpl(root, state, opts, host);
  return self.project;
}
