import path from "node:path";
import { builtinPlugin } from "@loc-studio/builtin";
import {
  EXTENSION_KINDS,
  cliSettingsFromEnv,
  localSettingsPath,
  openProject,
  readLocalSettings,
  resolveUserName,
  severityAtLeast,
  summarizeValidation,
  validateProject,
} from "@loc-studio/core";
import type { CellValidation, Project, ResolvedIssue } from "@loc-studio/core";
import type { Severity, TreeNode } from "@loc-studio/sdk";
import { llmPlugin } from "@loc-studio/plugin-llm";
import { UsageError, USAGE, globToRegExp, parseCliArgs } from "./args.js";
import type { CliOptions } from "./args.js";
import { existsSync } from "node:fs";
import { runAdminCommand } from "./admin.js";
import { OpenFailure, apiErrorCode, runBatchCommand } from "./batch.js";
import { runInit } from "./init.js";

export interface CliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** 標準入力の全体を読む（--password-stdin 用）。なければ --password-stdin は使えない。 */
  stdin?: () => Promise<string>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function open(opts: CliOptions, io: CliIO): Promise<Project> {
  const dir = path.resolve(io.cwd, opts.project ?? ".");
  const appDir = opts.appDir ?? io.env["LOC_STUDIO_APP_DIR"];
  const userDataDir = opts.userDataDir ?? path.dirname(localSettingsPath(io.env));
  const sdkPath = io.env["LOC_STUDIO_SDK_PATH"];
  return openProject(dir, {
    builtins: [builtinPlugin, llmPlugin],
    ...(appDir ? { appDir: path.resolve(io.cwd, appDir) } : {}),
    userDataDir: path.resolve(io.cwd, userDataDir),
    env: io.env,
    ...(sdkPath ? { sdkPath } : {}),
  });
}

const json = (io: CliIO, value: unknown): void => io.stdout(JSON.stringify(value, null, 2) + "\n");

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

async function cmdPlugins(project: Project, opts: CliOptions, io: CliIO): Promise<number> {
  const plugins = project.registry.plugins().map(({ plugin, origin }) => ({
    name: plugin.name,
    version: plugin.version ?? null,
    layer: origin.layer,
    path: origin.path ?? null,
  }));
  const extensions = Object.fromEntries(
    EXTENSION_KINDS.map((kind) => [
      kind,
      project.registry.list(kind).map((e) => ({ id: e.id, plugin: e.pluginName, layer: e.origin.layer })),
    ]),
  );
  const dirs = project.pluginDirs.map((d) => ({ dir: d.dir, layer: d.layer, exists: existsSync(d.dir) }));
  const errors = project.pluginErrors;
  // 同じ警告が重ねて入っていても 1 行にする（出所は core / server 側の可能性がある。CLI では重複を作っていない）。
  const warnings = [...new Set(project.warnings)];

  if (opts.json) {
    json(io, { plugins, extensions, pluginDirs: dirs, errors, warnings });
    return errors.length > 0 ? 1 : 0;
  }

  const out: string[] = ["プラグイン:"];
  for (const p of plugins) {
    out.push(`  ${p.name}  ${p.version ?? "-"}  [${p.layer}]  ${p.path ?? "(同梱)"}`);
  }
  out.push("", "登録された実装:");
  for (const kind of EXTENSION_KINDS) {
    const list = extensions[kind] ?? [];
    if (list.length === 0) continue;
    out.push(`  ${kind}:`);
    for (const e of list) out.push(`    ${e.id}  <- ${e.plugin} [${e.layer}]`);
  }
  out.push("", "探したプラグインフォルダ:");
  if (dirs.length === 0) out.push("  (なし)");
  for (const d of dirs) out.push(`  [${d.layer}] ${d.dir}  ${d.exists ? "" : "(フォルダなし)"}`.trimEnd());
  if (errors.length > 0) {
    out.push("", "読み込みエラー:");
    for (const e of errors) out.push(`  [${e.layer}] ${e.path}: ${e.message}`);
  }
  if (warnings.length > 0) {
    out.push("", "警告:");
    for (const w of warnings) out.push(`  ${w}`);
  }
  io.stdout(out.join("\n") + "\n");
  return errors.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

interface TreeOut {
  name: string;
  kind: "folder" | "resource";
  path?: string;
  format?: string;
  entries?: number;
  error?: string;
  children?: TreeOut[];
}

async function describeNode(project: Project, node: TreeNode): Promise<TreeOut> {
  if (node.kind === "folder") {
    const children: TreeOut[] = [];
    for (const child of node.children ?? []) children.push(await describeNode(project, child));
    return { name: node.name, kind: "folder", children };
  }
  const out: TreeOut = { name: node.name, kind: "resource" };
  if (!node.resource) return { ...out, error: "リソースの情報がありません" };
  out.path = node.resource.path;
  try {
    const { document, format } = await project.readDocument(node.resource);
    out.format = format.id;
    out.entries = document.entries.length;
  } catch (err) {
    out.error = errText(err);
  }
  return out;
}

function printTree(nodes: TreeOut[], depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  for (const n of nodes) {
    if (n.kind === "folder") {
      out.push(`${pad}${n.name}/`);
      printTree(n.children ?? [], depth + 1, out);
    } else if (n.error) {
      out.push(`${pad}${n.name}  (読めません: ${n.error})`);
    } else {
      out.push(`${pad}${n.name}  ${n.entries} 件  [${n.format}]`);
    }
  }
}

async function cmdTree(project: Project, opts: CliOptions, io: CliIO): Promise<number> {
  const nodes: TreeOut[] = [];
  for (const node of await project.tree()) nodes.push(await describeNode(project, node));
  if (opts.json) {
    json(io, { tree: nodes });
  } else {
    const out: string[] = [`${project.config.name ?? path.basename(project.root)}/`];
    printTree(nodes, 1, out);
    io.stdout(out.join("\n") + "\n");
  }
  const hasError = (list: TreeOut[]): boolean => list.some((n) => n.error !== undefined || hasError(n.children ?? []));
  return hasError(nodes) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

interface IssueOut {
  key: string;
  language: string | null;
  columnId: string;
  validatorId: string;
  code: string;
  severity: Severity;
  message: string;
  range?: { start: number; end: number };
}

interface ResourceOut {
  path: string;
  issues: IssueOut[];
  diagnostics: { severity: Severity; message: string; line?: number }[];
  /** 読めなかった・解析できなかったときの理由。 */
  error?: string;
}

const toIssues = (results: CellValidation[]): IssueOut[] =>
  results.flatMap((r) =>
    r.issues.map((i: ResolvedIssue): IssueOut => ({
      key: r.target.entry.key,
      language: r.target.language?.id ?? null,
      columnId: r.target.column.id,
      validatorId: i.validatorId,
      code: i.code,
      severity: i.severity,
      message: i.message,
      ...(i.range ? { range: i.range } : {}),
    })),
  );

async function cmdValidate(project: Project, opts: CliOptions, io: CliIO): Promise<number> {
  if (opts.languages) {
    const unknown = opts.languages.filter((l) => project.language(l) === undefined);
    if (unknown.length > 0) {
      throw new UsageError(
        `プロジェクトにない言語です: ${unknown.join(", ")}（使える言語: ${project.languages.map((l) => l.id).join(", ")}）`,
      );
    }
  }
  let resources = await project.resources();
  if (opts.resources) {
    const re = globToRegExp(opts.resources);
    resources = resources.filter((r) => re.test(r.path));
  }
  const outs: ResourceOut[] = [];
  const all: CellValidation[] = [];
  // 1 つのリソースが読めなくても、ほかは検証する（読めないものは自分の行に出す）。
  for (const resource of resources) {
    try {
      const [v] = await validateProject(project, {
        resources: [resource],
        ...(opts.languages ? { languages: opts.languages } : {}),
      });
      if (!v) throw new Error("検証の結果がありません。");
      // 形式の問題は検証とは別に、ファイルを読んだときの診断として出す。
      const { document } = await project.readDocument(v.resource);
      all.push(...v.results);
      outs.push({
        path: v.resource.path,
        issues: toIssues(v.results),
        diagnostics: (document.diagnostics ?? []).map((d) => ({
          severity: d.severity,
          message: d.message,
          ...(d.line !== undefined ? { line: d.line } : {}),
        })),
      });
    } catch (err) {
      outs.push({ path: resource.path, issues: [], diagnostics: [], error: errText(err) });
    }
  }
  const unreadable = outs.filter((r) => r.error !== undefined).length;

  const base = summarizeValidation(all);
  const diagnostics = outs.reduce((n, r) => n + r.diagnostics.length, 0);
  const summary = {
    error: base.error,
    warning: base.warning,
    info: base.info,
    byCode: base.byCode,
    cellsChecked: all.length,
    cellsWithIssues: base.cells,
    diagnostics,
    resources: outs.length,
    unreadable,
  };

  const failing =
    unreadable > 0 ||
    (opts.failOn !== "never" &&
    (outs.some((r) => r.issues.some((i) => severityAtLeast(i.severity, opts.failOn as Severity))) ||
      outs.some((r) => r.diagnostics.some((d) => severityAtLeast(d.severity, opts.failOn as Severity)))));

  if (opts.json) {
    json(io, { resources: outs, summary });
    return failing ? 1 : 0;
  }

  const lines: string[] = [];
  let printed = 0;
  let omitted = 0;
  for (const r of outs) {
    if (r.error !== undefined) {
      lines.push(`${r.path}  (読めません: ${r.error})`, "");
      continue;
    }
    if (r.issues.length === 0 && r.diagnostics.length === 0) continue;
    lines.push(r.path);
    for (const d of r.diagnostics) {
      lines.push(`  ${d.severity.padEnd(7)} (ファイルの形式)${d.line !== undefined ? ` ${d.line} 行目` : ""} ${d.message}`);
    }
    for (const i of r.issues) {
      if (printed >= opts.maxIssues) {
        omitted++;
        continue;
      }
      printed++;
      lines.push(`  ${i.severity.padEnd(7)} ${i.key}  ${i.language ?? "-"}  ${i.validatorId}  ${i.code}  ${i.message}`);
    }
    lines.push("");
  }
  if (omitted > 0) lines.push(`（ほか ${omitted} 件は --max-issues ${opts.maxIssues} のため表示を省略）`, "");
  lines.push(
    `検証したセル: ${summary.cellsChecked}（問題のあるセル: ${summary.cellsWithIssues}）、リソース: ${summary.resources}`,
    `error ${summary.error} / warning ${summary.warning} / info ${summary.info}` +
      (diagnostics > 0 ? ` / ファイルの形式の警告 ${diagnostics}` : "") +
      (unreadable > 0 ? ` / 読めないリソース ${unreadable}` : ""),
  );
  const codes = Object.entries(base.byCode).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (codes.length > 0) {
    lines.push("コード別:");
    for (const [code, n] of codes) lines.push(`  ${code}: ${n}`);
  }
  io.stdout(lines.join("\n") + "\n");
  return failing ? 1 : 0;
}

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

async function cmdWhoami(project: Project, opts: CliOptions, io: CliIO): Promise<number> {
  // ほかのコマンドと同じく、--user-data-dir があれば <そのフォルダ>/settings.json を読む。
  const file =
    opts.userDataDir !== undefined
      ? path.join(path.resolve(io.cwd, opts.userDataDir), "settings.json")
      : localSettingsPath(io.env);
  const local = await readLocalSettings(file);
  const cli: Record<string, unknown> = { ...cliSettingsFromEnv(io.env) };
  if (opts.user !== undefined && opts.user !== "") cli["user.name"] = opts.user;
  const resolved = resolveUserName({
    ...(project.config.localSettings?.enforce ? { enforce: project.config.localSettings.enforce } : {}),
    cli,
    local,
    ...(project.config.localSettings?.defaults ? { defaults: project.config.localSettings.defaults } : {}),
  });
  if (opts.json) {
    json(io, { userName: resolved.value, source: resolved.source, locked: resolved.locked, localSettingsPath: file });
  } else {
    io.stdout(
      `ユーザー名: ${resolved.value}\n出所: ${resolved.source}${resolved.locked ? "（プロジェクトの設定で固定）" : ""}\nローカル設定ファイル: ${file}\n`,
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------

/** コマンドを実行して終了コードを返す。プロセスには触れないので、テストから直接呼べる。 */
export async function run(argv: string[], io: CliIO): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    io.stderr(`${errText(err)}\n詳しくは loc-studio --help を参照してください。\n`);
    return 2;
  }
  if (opts.command === "help") {
    io.stdout(USAGE);
    return 0;
  }
  if (opts.command === "init") {
    try {
      return await runInit(opts, io);
    } catch (err) {
      io.stderr(`${errText(err)}\n`);
      if (io.env["LOC_STUDIO_DEBUG"] && err instanceof Error && err.stack) io.stderr(`${err.stack}\n`);
      if (err instanceof UsageError) return 2;
      return apiErrorCode(err) ?? 1;
    }
  }
  if (["user", "member", "server"].includes(opts.command)) {
    try {
      return await runAdminCommand(opts, io);
    } catch (err) {
      io.stderr(`${errText(err)}\n`);
      if (io.env["LOC_STUDIO_DEBUG"] && err instanceof Error && err.stack) io.stderr(`${err.stack}\n`);
      if (err instanceof UsageError) return 2;
      return apiErrorCode(err) ?? 1;
    }
  }
  if (["generate", "run", "status", "query", "save", "set", "entry", "resource"].includes(opts.command)) {
    try {
      return await runBatchCommand(opts, io);
    } catch (err) {
      io.stderr(`${errText(err)}\n`);
      if (io.env["LOC_STUDIO_DEBUG"]) {
        const cause = err instanceof OpenFailure ? err.cause : err;
        if (cause instanceof Error && cause.stack) io.stderr(`${cause.stack}\n`);
      }
      if (err instanceof OpenFailure || err instanceof UsageError) return 2;
      return apiErrorCode(err) ?? 1;
    }
  }
  try {
    const project = await open(opts, io).catch((err: unknown) => {
      const dir = path.resolve(io.cwd, opts.project ?? ".");
      throw new OpenError(`プロジェクトを開けませんでした（${dir}）: ${errText(err)}`, err);
    });
    switch (opts.command) {
      case "plugins":
        return await cmdPlugins(project, opts, io);
      case "tree":
        return await cmdTree(project, opts, io);
      case "validate":
        return await cmdValidate(project, opts, io);
      case "whoami":
        return await cmdWhoami(project, opts, io);
      default:
        throw new Error(`未対応のコマンドです: ${opts.command}`);
    }
  } catch (err) {
    io.stderr(`${errText(err)}\n`);
    if (io.env["LOC_STUDIO_DEBUG"]) {
      const cause = err instanceof OpenError ? err.cause : err;
      if (cause instanceof Error && cause.stack) io.stderr(`${cause.stack}\n`);
    }
    return 2;
  }
}

class OpenError extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message);
  }
}
