/**
 * 信頼の確認のために、読み込むと実行されうるコードを洗い出してハッシュにする。
 *
 * 決まり（確認のモードのとき）:
 * - 信頼する対象を読み込むときにコードとして読まれるファイルは、どれも (a) 基準のフォルダの中にあり、(b) 確認の一覧に出し、
 *   (c) ハッシュに入れる。静的に決められないもの（文字列でない import()、createRequire など）は推測せずに断る。
 * - 基準のフォルダ: フォルダのプラグインはそのフォルダ、1 ファイルのプラグインはそのファイルがあるフォルダ、
 *   コードの設定はプロジェクトのルート。
 * - import の見つけ方: TypeScript は Node の型の除去（module.stripTypeScriptTypes）で JavaScript にしてから、
 *   acorn で構文木にする（文字列・コメント・正規表現に惑わされない）。ESM と CommonJS の require を同じ木で見る。
 * - 解決: 読み込み（jiti）と同じ解決（拡張子の順、package.json の main、SDK の別名）を使い、実体のパスで確かめる。
 * - フォルダのプラグインは、フォルダの中のすべてのファイルをハッシュに入れ、すべてのコードのファイルに同じ確認をする。
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isBuiltin, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "acorn";
import type { Node } from "acorn";
import { ancestor } from "acorn-walk";
import { createJiti } from "jiti";

/** コードとして読むファイルの拡張子（ローダーが読めるもの）。 */
const CODE_EXTS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const TS_EXTS = new Set([".ts", ".mts", ".cts"]);
/** 確かめずに認める指定子（SDK の package.json の exports は "." だけなので、ちょうどこの文字列だけ）。 */
const SDK_SPECIFIER = "@loc-studio/sdk";
/** node:module のうち、コードを読み込まない（読み込み方を変えない）もの。 */
const SAFE_MODULE_MEMBERS = new Set(["builtinModules", "isBuiltin"]);

export interface CodeInspection {
  /** SHA-256（16 進）。files のパス（基準からの相対、"/" 区切り）と中身から作る。 */
  hash: string;
  /** ハッシュに入れたファイル（絶対パス。実体のパス）。 */
  files: string[];
  /** 読み込んではいけない理由（あれば）。ファイルと行を含む。 */
  error?: string;
}

export interface InspectOptions {
  /** プラグインの "@loc-studio/sdk" の行き先（ローダーと同じ別名）。 */
  sdkPath?: string;
}

const inside = (base: string, p: string): boolean => {
  const rel = path.relative(base, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** 1 ファイルのプラグインとコードの設定で、さらに断るもの（import のたどれる範囲だけをハッシュに入れるため）。 */
const STRICT_FIX =
  "1 ファイルのプラグインとコードの設定では、import でたどれるファイルだけをハッシュに入れるため使えません。plugin.json のあるフォルダのプラグインにすれば、フォルダの中のすべてのファイルがハッシュに入るので使えます";
/** 厳しい確認で、import / require も断る組み込み（ほかのファイルやコードを実行できる）。 */
const STRICT_BUILTINS = new Set(["vm", "worker_threads", "child_process", "cluster", "repl", "inspector", "wasi"]);

const HOW_TO_FIX =
  "文字列で書いた静的な import（import x from \"./x.js\"）にしてください。動的に読み込む必要があるなら、plugin.json のあるフォルダのプラグインにして、読み込むファイルをそのフォルダに置いてください";

export interface ScannedImport {
  spec: string;
  line: number;
}

export interface SourceScan {
  imports: ScannedImport[];
  /** 静的に決められない読み込みや、解析できないことの説明（行つき）。 */
  problems: { line: number; message: string }[];
}

interface AnyNode extends Node {
  [key: string]: unknown;
}

const isNode = (v: unknown): v is AnyNode => typeof v === "object" && v !== null && typeof (v as Node).type === "string";

/** 文字列リテラル、または式を含まないテンプレートリテラルなら、その文字列。 */
function literalString(n: unknown): string | undefined {
  if (!isNode(n)) return undefined;
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral" && Array.isArray(n.expressions) && n.expressions.length === 0) {
    const q = (n.quasis as { value: { cooked: string | null } }[])[0];
    return q?.value.cooked ?? undefined;
  }
  return undefined;
}

const lineOf = (n: Node): number => n.loc?.start.line ?? 0;

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** パターン（引数や分割代入）の中の名前。 */
function patternNames(p: unknown, out: Set<string>): void {
  if (!isNode(p)) return;
  switch (p.type) {
    case "Identifier":
      out.add(String(p.name));
      break;
    case "ObjectPattern":
      for (const prop of p.properties as AnyNode[]) patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      break;
    case "ArrayPattern":
      for (const el of p.elements as AnyNode[]) patternNames(el, out);
      break;
    case "AssignmentPattern":
      patternNames(p.left, out);
      break;
    case "RestElement":
      patternNames(p.argument, out);
      break;
  }
}

/** 文の並びに直接ある宣言の名前（let / const / class / function / var）。 */
function directDeclarations(body: unknown, out: Set<string>): void {
  if (!Array.isArray(body)) return;
  for (const st of body as AnyNode[]) {
    if (st.type === "VariableDeclaration") for (const d of st.declarations as AnyNode[]) patternNames(d.id, out);
    else if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && isNode(st.id)) out.add(String(st.id.name));
    else if ((st.type === "ExportNamedDeclaration" || st.type === "ExportDefaultDeclaration") && isNode(st.declaration)) directDeclarations([st.declaration], out);
  }
}

/** 関数の中の var（入れ子の関数の中は除く）。 */
function varDeclarations(n: unknown, out: Set<string>): void {
  if (!isNode(n)) return;
  if (n.type === "VariableDeclaration" && n.kind === "var") for (const d of n.declarations as AnyNode[]) patternNames(d.id, out);
  for (const [k, v] of Object.entries(n)) {
    if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
    for (const c of Array.isArray(v) ? v : [v]) if (isNode(c) && !FUNCTION_TYPES.has(c.type)) varDeclarations(c, out);
  }
}

const scopeCache = new WeakMap<object, Set<string>>();
/** その節点（関数、ブロック、プログラム）が作る名前の集まり。 */
function scopeNames(n: AnyNode): Set<string> {
  let names = scopeCache.get(n);
  if (names) return names;
  names = new Set();
  if (FUNCTION_TYPES.has(n.type)) {
    for (const param of n.params as AnyNode[]) patternNames(param, names);
    if (n.type === "FunctionExpression" && isNode(n.id)) names.add(String(n.id.name));
    const body = n.body as AnyNode;
    if (body.type === "BlockStatement") {
      directDeclarations(body.body, names);
      varDeclarations(body, names);
    }
  } else if (n.type === "BlockStatement" || n.type === "Program" || n.type === "StaticBlock") {
    directDeclarations(n.body, names);
    if (n.type === "Program") varDeclarations(n, names);
  } else if (n.type === "CatchClause") {
    patternNames(n.param, names);
  } else if ((n.type === "ForStatement" || n.type === "ForInStatement" || n.type === "ForOfStatement") && isNode(n.init ?? n.left)) {
    const head = (n.init ?? n.left) as AnyNode;
    if (head.type === "VariableDeclaration") for (const d of head.declarations as AnyNode[]) patternNames(d.id, names);
  }
  scopeCache.set(n, names);
  return names;
}

/** 名前が、外側のどこかでローカルに宣言されているか（されていなければ大域の名前）。 */
const shadowed = (name: string, ancestors: Node[]): boolean => ancestors.slice(0, -1).some((a) => scopeNames(a as AnyNode).has(name));

/** 名前を値として使っているか（プロパティのキーや obj.name の name ではない）。 */
function isReference(node: Node, parent: AnyNode | undefined): boolean {
  if (!parent) return true;
  if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node && !parent.computed) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (parent.type === "ImportSpecifier" || parent.type === "ExportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier") return false;
  if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return false;
  return true;
}

export interface ScanOptions {
  /**
   * 1 ファイルのプラグインとコードの設定（import のたどれる範囲だけをハッシュに入れる）のときの厳しい確認。
   * eval、Function、process.getBuiltinModule、module などの計算したプロパティ、モジュールの外側の arguments、
   * vm / worker_threads / child_process の import も断る。
   */
  strict?: boolean;
}

/** ソースから import / require を見つける。決められないものは problems に入れる。 */
export function scanSource(source: string, file: string, opts: ScanOptions = {}): SourceScan {
  const strict = opts.strict === true;
  const ext = path.extname(file).toLowerCase();
  let js = source;
  if (TS_EXTS.has(ext)) {
    try {
      // まず位置が変わらない型の除去。enum などがあれば変換する（行がずれることがある）。
      js = stripTypeScriptTypes(source, { mode: "strip" });
    } catch {
      try {
        js = stripTypeScriptTypes(source, { mode: "transform" });
      } catch (err) {
        return { imports: [], problems: [{ line: 0, message: `TypeScript として解析できません: ${(err as Error).message}` }] };
      }
    }
  }
  let ast: Node;
  const common = { ecmaVersion: "latest" as const, locations: true, allowHashBang: true };
  try {
    ast = parse(js, { ...common, sourceType: "module", allowAwaitOutsideFunction: true, allowImportExportEverywhere: true });
  } catch (errModule) {
    try {
      ast = parse(js, { ...common, sourceType: "script", allowReturnOutsideFunction: true });
    } catch {
      const e = errModule as Error & { loc?: { line: number } };
      return { imports: [], problems: [{ line: e.loc?.line ?? 0, message: `JavaScript として解析できません: ${e.message}` }] };
    }
  }

  const imports: ScannedImport[] = [];
  const problems: { line: number; message: string }[] = [];
  const moduleNames = new Set<string>();
  const add = (spec: string, n: Node): void => void imports.push({ spec, line: lineOf(n) });
  const refuse = (n: Node, what: string): void => void problems.push({ line: lineOf(n), message: `${what}は、読み込むファイルを前もって確かめられないため使えません。${HOW_TO_FIX}` });
  const refuseStrict = (n: Node, what: string): void => void problems.push({ line: lineOf(n), message: `${what}は、${STRICT_FIX}` });
  const builtinName = (spec: string): string => (spec.startsWith("node:") ? spec.slice(5) : spec).split("/")[0]!;
  const checkStrictImport = (spec: string, n: Node): void => {
    if (strict && isBuiltin(spec) && STRICT_BUILTINS.has(builtinName(spec))) refuseStrict(n, `組み込みのモジュール "${spec}" `);
  };

  const isModuleSpec = (s: string): boolean => s === "module" || s === "node:module";

  ancestor(ast, {
    ImportDeclaration(node) {
      const n = node as unknown as AnyNode;
      const spec = literalString(n.source);
      if (spec === undefined) return;
      add(spec, node);
      checkStrictImport(spec, node);
      if (isModuleSpec(spec)) {
        // 名前を指定した import の builtinModules / isBuiltin だけを認める（名前空間や既定の import は、ほかのメンバーに届くので断る）。
        for (const s of n.specifiers as AnyNode[]) {
          if (s.type === "ImportSpecifier") {
            const imported = (s.imported as AnyNode).name ?? (s.imported as AnyNode).value;
            if (!SAFE_MODULE_MEMBERS.has(String(imported))) refuse(node, `node:module の ${String(imported)} `);
          } else refuse(node, s.type === "ImportNamespaceSpecifier" ? "node:module の名前空間の import " : "node:module の既定の import ");
        }
      }
    },
    ExportNamedDeclaration(node) {
      const spec = literalString((node as unknown as AnyNode).source);
      if (spec !== undefined) {
        add(spec, node);
        checkStrictImport(spec, node);
        if (isModuleSpec(spec)) refuse(node, "node:module からの再エクスポート ");
      }
    },
    ExportAllDeclaration(node) {
      const spec = literalString((node as unknown as AnyNode).source);
      if (spec !== undefined) {
        add(spec, node);
        checkStrictImport(spec, node);
        if (isModuleSpec(spec)) refuse(node, "node:module からの再エクスポート ");
      }
    },
    ImportExpression(node) {
      const spec = literalString((node as unknown as AnyNode).source);
      if (spec === undefined) refuse(node, "文字列でない import() ");
      else {
        add(spec, node);
        checkStrictImport(spec, node);
        // 動的な import の結果は、どのメンバーを使うか確かめられないので、node:module は丸ごと断る。
        if (isModuleSpec(spec)) refuse(node, "import(\"node:module\") ");
      }
    },
    CallExpression(node) {
      const n = node as unknown as AnyNode;
      const callee = n.callee as AnyNode;
      const args = n.arguments as AnyNode[];
      if (callee.type === "Identifier" && callee.name === "require") {
        const spec = literalString(args[0]);
        if (spec === undefined || args.length !== 1) refuse(node, "文字列でない require() ");
        else {
          add(spec, node);
          checkStrictImport(spec, node);
          if (isModuleSpec(spec)) refuse(node, "require(\"node:module\") ");
        }
      }
      if (callee.type === "MemberExpression" && !callee.computed && (callee.object as AnyNode).type === "Identifier" && (callee.object as AnyNode).name === "require") {
        const prop = String((callee.property as AnyNode).name);
        if (prop === "resolve" && literalString(args[0]) === undefined) refuse(node, "文字列でない require.resolve() ");
      }
    },
    Identifier(node, _state, ancestors) {
      const n = node as unknown as AnyNode;
      const parent = ancestors[ancestors.length - 2] as AnyNode | undefined;
      const name = String(n.name);
      if (strict && isReference(node, parent)) {
        if ((name === "eval" || name === "Function") && !shadowed(name, ancestors)) {
          refuseStrict(node, name === "eval" ? "eval " : "Function（new Function など）");
          return;
        }
        if (name === "arguments") {
          // 関数（アロー関数を除く）の外の arguments は、CommonJS の包みの引数（require など）を指す。
          const inFunction = ancestors.slice(0, -1).some((a) => a.type === "FunctionDeclaration" || a.type === "FunctionExpression");
          if (!inFunction && !shadowed(name, ancestors)) refuseStrict(node, "関数の外の arguments ");
          return;
        }
        if (name === "module") {
          // module.exports / module.id などは認め、module を値として別の名前に入れたり、計算したプロパティで使ったりは断る。
          // 関数の中などで宣言した同じ名前の変数（const module = …）は、ここでいう module ではない。
          if (!shadowed(name, ancestors) && !(parent?.type === "MemberExpression" && parent.object === node && !parent.computed)) refuseStrict(node, "module を値として使うこと");
          return;
        }
      }
      if (name !== "require" && name !== "createRequire") return;
      if (parent) {
        // { require: ... } のキーや obj.require は、ここでいう require ではない。
        if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node && !parent.computed) return;
        if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) {
          if (name === "createRequire") refuse(node, "createRequire ");
          return;
        }
        if (parent.type === "ImportSpecifier" || parent.type === "ExportSpecifier") return; // ImportDeclaration で扱う
      }
      if (name === "createRequire") return void refuse(node, "createRequire ");
      // require を呼び出し以外に使う（別の名前に入れて呼ぶなど）。
      if (parent?.type === "CallExpression" && parent.callee === node) return;
      if (parent?.type === "MemberExpression" && parent.object === node) {
        const prop = parent.computed ? undefined : String((parent.property as AnyNode).name);
        if (prop === "resolve") return;
        return void refuse(node, `require.${prop ?? "[…]"} `);
      }
      refuse(node, "require を値として使うこと");
    },
    MemberExpression(node) {
      const n = node as unknown as AnyNode;
      const obj = n.object as AnyNode;
      const prop = n.computed ? literalString(n.property) : String((n.property as AnyNode).name);
      if (obj.type === "Identifier" && obj.name === "process" && prop === "dlopen") refuse(node, "process.dlopen ");
      if (obj.type === "Identifier" && obj.name === "module" && (prop === "require" || prop === "constructor")) refuse(node, `module.${prop} `);
      if (obj.type === "Identifier" && moduleNames.has(String(obj.name)) && !(prop !== undefined && SAFE_MODULE_MEMBERS.has(prop))) {
        refuse(node, `node:module の ${prop ?? "[…]"} `);
      }
      if (obj.type === "MetaProperty" && prop !== undefined && (prop === "resolve" || prop.startsWith("glob"))) refuse(node, `import.meta.${prop} `);
      if (obj.type === "MetaProperty" && prop === undefined) refuse(node, "import.meta[…] ");
      if (strict) {
        const objName = obj.type === "Identifier" ? String(obj.name) : undefined;
        if (objName === "process" && prop === "getBuiltinModule") refuseStrict(node, "process.getBuiltinModule ");
        if (n.computed && objName !== undefined && ["module", "require", "process", "globalThis", "global", "window", "self"].includes(objName)) {
          refuseStrict(node, `${objName}[…]（計算したプロパティ）`);
        }
        if (objName !== undefined && ["globalThis", "global", "window", "self"].includes(objName) && prop !== undefined && ["eval", "Function", "require", "process", "module"].includes(prop)) {
          refuseStrict(node, `${objName}.${prop} `);
        }
      }
    },
    VariableDeclarator(node) {
      // const m = require("node:module") のような束縛（require 自体は CallExpression で断る）。
      const n = node as unknown as AnyNode;
      const init = n.init as AnyNode | null;
      if (init?.type === "CallExpression" && (init.callee as AnyNode).type === "Identifier" && (init.callee as AnyNode).name === "require") {
        const spec = literalString((init.arguments as AnyNode[])[0]);
        if (spec && isModuleSpec(spec) && (n.id as AnyNode).type === "Identifier") moduleNames.add(String((n.id as AnyNode).name));
      }
    },
  });
  return { imports, problems };
}

/** 読み込み（jiti）と同じ解決をする関数。SDK の別名ごとに作り置く。 */
const resolvers = new Map<string, ReturnType<typeof createJiti>>();
function resolverFor(sdkPath: string | undefined): ReturnType<typeof createJiti> {
  const key = sdkPath ?? "";
  let j = resolvers.get(key);
  if (!j) {
    j = createJiti(import.meta.url, {
      alias: sdkPath ? { [SDK_SPECIFIER]: path.resolve(sdkPath) } : {},
      moduleCache: false,
      fsCache: false,
    });
    resolvers.set(key, j);
  }
  return j;
}

class Collector {
  readonly files = new Map<string, string>(); // 実体のパス → 基準からの相対
  readonly problems: string[] = [];
  private readonly visited = new Set<string>();
  private readonly jiti: ReturnType<typeof createJiti>;

  constructor(
    private readonly base: string,
    private readonly what: string,
    opts: InspectOptions,
    /** 1 ファイルのプラグインとコードの設定（import のたどれる範囲だけをハッシュに入れる）。 */
    private readonly strict = false,
  ) {
    this.jiti = resolverFor(opts.sdkPath);
  }

  private add(real: string): void {
    if (!this.files.has(real)) this.files.set(real, path.relative(this.base, real).split(path.sep).join("/"));
  }

  private problem(file: string, line: number, message: string): void {
    this.problems.push(`${file}${line > 0 ? `:${line}` : ""}: ${message}`);
  }

  /** フォルダの中のすべてのファイル（シンボリックリンクは実体で確かめる）。コードのファイルは import も確かめる。 */
  async walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      this.problems.push(`${dir} を読めませんでした: ${(err as Error).message}`);
      return;
    }
    for (const name of names.sort()) {
      const p = path.join(dir, name);
      let real: string;
      try {
        real = await realpath(p);
      } catch {
        this.problems.push(`${p} は壊れたシンボリックリンクです`);
        continue;
      }
      if (!inside(this.base, real)) {
        this.problems.push(`${p} は${this.what}の外（${real}）を指しています`);
        continue;
      }
      const st = await stat(real);
      if (st.isDirectory()) {
        // フォルダの中を指すリンクは、指す先を別にたどるので二重に数えない。
        if ((await lstat(p)).isSymbolicLink()) continue;
        await this.walk(p);
      } else if (st.isFile()) {
        if (CODE_EXTS.has(path.extname(real).toLowerCase())) await this.follow(real);
        else this.add(real);
      }
    }
  }

  /** ファイルを加え、コードなら import をたどる。 */
  async follow(file: string): Promise<void> {
    let real: string;
    try {
      real = await realpath(file);
    } catch {
      this.problems.push(`${file} がありません`);
      return;
    }
    if (this.visited.has(real)) return;
    this.visited.add(real);
    if (!inside(this.base, real)) {
      this.problems.push(`${file} は${this.what}の外（${real}）にあります`);
      return;
    }
    this.add(real);
    if (!CODE_EXTS.has(path.extname(real).toLowerCase())) return;
    const scan = scanSource(await readFile(real, "utf8"), real, { strict: this.strict });
    for (const p of scan.problems) this.problem(real, p.line, p.message);
    for (const imp of scan.imports) await this.resolveImport(real, imp);
  }

  private async resolveImport(from: string, { spec, line }: ScannedImport): Promise<void> {
    if (spec === SDK_SPECIFIER) return;
    if (spec.startsWith("node:") ? isBuiltin(spec) : isBuiltin(spec) && !spec.includes("..")) return;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec) || spec.startsWith("//")) {
      return this.problem(from, line, `import "${spec}" は使えません（URL や file: / data: は読み込みません）。${this.what}の中のファイルを相対パスで import してください`);
    }
    if (path.isAbsolute(spec) || path.win32.isAbsolute(spec) || spec.startsWith("/") || spec.startsWith("\\")) {
      return this.problem(from, line, `import "${spec}" は絶対パスです。${this.what}の中のファイルを相対パスで import してください`);
    }
    const relative = spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..";
    if (!relative && spec.split(/[\\/]/).some((s) => s === ".." || s === "." || s === "")) {
      return this.problem(from, line, `import "${spec}" は使えません（パッケージ名のあとに .. などを含む指定は読み込みません）`);
    }
    let resolved: string | undefined;
    try {
      resolved = this.jiti.esmResolve(spec, { parentURL: pathToFileURL(from).href, try: true }) as string | undefined;
    } catch {
      resolved = undefined;
    }
    if (!resolved || !resolved.startsWith("file:")) {
      return this.problem(
        from,
        line,
        relative
          ? `import "${spec}" のファイルが見つかりません`
          : `import "${spec}" は${this.what}の中（node_modules）にありません。信頼の確認では、${this.what}の外のパッケージは読み込めません`,
      );
    }
    let real: string;
    try {
      real = await realpath(fileURLToPath(resolved));
    } catch {
      return this.problem(from, line, `import "${spec}" の解決先 ${resolved} を確かめられませんでした`);
    }
    if (!inside(this.base, real)) {
      return this.problem(from, line, `import "${spec}" は${this.what}の外（${real}）に解決されます`);
    }
    await this.follow(real);
  }

  sortedEntries(): [string, string][] {
    return [...this.files.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  }

  async result(): Promise<CodeInspection> {
    const h = createHash("sha256");
    const entries = this.sortedEntries();
    for (const [abs, rel] of entries) {
      const data = await readFile(abs);
      h.update(`${rel}\u0000${data.length}\u0000`, "utf8");
      h.update(data);
    }
    const out: CodeInspection = { hash: h.digest("hex"), files: entries.map(([abs]) => abs) };
    if (this.problems.length > 0) out.error = [...new Set(this.problems)].join(" / ");
    return out;
  }
}

/**
 * プラグインのコードを確かめる。
 * @param root 1 ファイルのプラグインはそのファイル、フォルダのプラグインはフォルダ
 * @param entry 入口のファイル（フォルダのプラグイン。フォルダの中のすべてのコードを確かめるので、なくてもよい）
 */
export async function inspectPluginCode(root: string, entry?: string, opts: InspectOptions = {}): Promise<CodeInspection> {
  const st = await stat(root);
  if (st.isFile()) {
    const c = new Collector(await realpath(path.dirname(root)), "プラグインのフォルダ", opts, true);
    await c.follow(root);
    return c.result();
  }
  const base = await realpath(root);
  const c = new Collector(base, "プラグインのフォルダ", opts);
  await c.walk(base);
  if (entry && entry !== root) await c.follow(entry);
  return c.result();
}

/** コードの設定ファイルを確かめる（import はプロジェクトのルートの中だけ）。 */
export async function inspectConfigCode(projectRoot: string, file: string, opts: InspectOptions = {}): Promise<CodeInspection> {
  const c = new Collector(await realpath(projectRoot), "プロジェクトのフォルダ", opts, true);
  await c.follow(file);
  return c.result();
}

/** 文字列リテラルの指定子の一覧（テストと調べもの用）。 */
export function findImports(source: string, file = "x.mjs"): string[] {
  return [...new Set(scanSource(source, file).imports.map((i) => i.spec))];
}
