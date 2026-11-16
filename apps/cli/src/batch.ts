/**
 * サービス層（createWorkspace）を通すコマンド。画面と同じキャッシュ・履歴・ドラフトを使う。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError, createWorkspace } from "@loc-studio/server";
import type { JobInfo, ProjectInfo, TreeNodeInfo, Workspace } from "@loc-studio/server";
import { UsageError, globToRegExp } from "./args.js";
import type { CliOptions } from "./args.js";
import type { CliIO } from "./commands.js";

const POLL_MS = 200;
const PAGE = 1000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const json = (io: CliIO, value: unknown): void => io.stdout(JSON.stringify(value, null, 2) + "\n");

export async function openWorkspace(opts: CliOptions, io: CliIO): Promise<Workspace> {
  const dir = path.resolve(io.cwd, opts.project ?? ".");
  const appDir = opts.appDir ?? io.env["LOC_STUDIO_APP_DIR"];
  const sdkPath = io.env["LOC_STUDIO_SDK_PATH"];
  return createWorkspace({
    projectRoot: dir,
    ...(appDir ? { appDir: path.resolve(io.cwd, appDir) } : {}),
    ...(opts.userDataDir !== undefined ? { userDataDir: path.resolve(io.cwd, opts.userDataDir) } : {}),
    env: io.env,
    ...(sdkPath ? { sdkPath } : {}),
    // コマンドラインは利用者の明示の実行なので、プロジェクト・ローカルのプラグインを確認なしで読む。
    pluginTrust: "always",
    ...(opts.user !== undefined && opts.user !== "" ? { cliSettings: { "user.name": opts.user } } : {}),
  });
}

/** ApiError の終了コード。対象や引数の誤り（invalid / not-found）は 2、それ以外は 1。 */
export function apiErrorCode(err: unknown): number | undefined {
  if (!(err instanceof ApiError)) return undefined;
  return err.code === "invalid" || err.code === "not-found" ? 2 : 1;
}

interface ResourceNode {
  id: string;
  path: string;
}

function flatten(nodes: TreeNodeInfo[], out: ResourceNode[] = []): ResourceNode[] {
  for (const n of nodes) {
    if (n.kind === "folder") flatten(n.children ?? [], out);
    else if (n.resource) out.push({ id: n.resource.id, path: n.resource.path });
  }
  return out;
}

async function selectResources(ws: Workspace, glob: string | undefined): Promise<ResourceNode[]> {
  const all = flatten(await ws.tree());
  if (glob === undefined) return all;
  const re = globToRegExp(glob);
  return all.filter((r) => re.test(r.path));
}

function checkLanguages(info: ProjectInfo, languages: string[] | undefined): void {
  if (!languages) return;
  const unknown = languages.filter((l) => !info.languages.some((d) => d.id === l));
  if (unknown.length > 0) {
    throw new UsageError(
      `プロジェクトにない言語です: ${unknown.join(", ")}（使える言語: ${info.languages.map((l) => l.id).join(", ")}）`,
    );
  }
}

const THROTTLE_GIVE_UP_MS = 60_000;
const THROTTLE_DEFAULT_WAIT_MS = 1_000;

/**
 * ジョブの開始が throttled（1 人あたり・ワークスペースあたりの上限）で断られたら、
 * 少し待ってやり直す（同じ利用者の別のプロセスがジョブを走らせているとき）。約 1 分で諦める。
 */
async function startWithRetry<T>(io: CliIO, what: string, start: () => Promise<T>, opts: { giveUpMs?: number } = {}): Promise<T> {
  const giveUp = opts.giveUpMs ?? THROTTLE_GIVE_UP_MS;
  const began = Date.now();
  let notified = false;
  for (;;) {
    try {
      return await start();
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== "throttled") throw err;
      const hint = (err.data as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
      const wait = typeof hint === "number" && hint > 0 ? Math.min(hint, 10_000) : THROTTLE_DEFAULT_WAIT_MS;
      if (Date.now() - began + wait > giveUp) {
        throw new ApiError("throttled", `${what}: ジョブの上限に達していて、${Math.round(giveUp / 1000)} 秒待っても空きませんでした（${err.message}）`);
      }
      if (!notified) {
        io.stderr(`${what}: ジョブの上限に達しています。空くまで待ちます（${err.message}）\n`);
        notified = true;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** ジョブが終わるまで待ち、進み具合が変わるたびに stderr へ 1 行出す。 */
async function waitWithProgress(ws: Workspace, jobId: string, io: CliIO, prefix: string): Promise<JobInfo> {
  let finished = false;
  const done = ws.waitForJob(jobId).finally(() => {
    finished = true;
  });
  done.catch(() => undefined);
  let last = "";
  while (!finished) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      done.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, POLL_MS);
      }),
    ]);
    clearTimeout(timer);
    if (finished) break;
    const j = await ws.job({ id: jobId });
    const line = `${prefix}${j.done + j.failed + j.skipped}/${j.total}（失敗 ${j.failed}）`;
    if (line !== last) {
      io.stderr(`${line}\n`);
      last = line;
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

async function cmdGenerate(ws: Workspace, opts: CliOptions, io: CliIO): Promise<number> {
  const columnId = opts.args[0] as string;
  checkLanguages(await ws.info(), opts.languages);
  const lang = opts.languages ? { languages: opts.languages } : {};

  // --resources 指定時は 1 リソースにつき 1 ジョブ、なければプロジェクト全体で 1 ジョブ。
  type Scope = { scope: "project" } | { scope: "resource"; resourceId: string };
  let scopes: Scope[] = [{ scope: "project" }];
  if (opts.resources !== undefined) {
    const found = await selectResources(ws, opts.resources);
    if (found.length === 0) throw new ApiError("not-found", `--resources "${opts.resources}" に一致するリソースがありません。`);
    scopes = found.map((r) => ({ scope: "resource", resourceId: r.id }));
  }

  const totals = { total: 0, cached: 0, toRun: 0 };
  if (opts.dryRun) {
    for (const s of scopes) {
      const r = await ws.generate({ columnId, ...s, ...lang, dryRun: true });
      totals.total += r.total;
      totals.cached += r.cached;
      totals.toRun += r.toRun;
    }
    if (opts.json) json(io, { columnId, dryRun: true, ...totals });
    else io.stdout(`${columnId}（ドライラン）: 全体 ${totals.total} / キャッシュ済み ${totals.cached} / 実行する分 ${totals.toRun}\n`);
    return 0;
  }

  // ジョブは 1 つずつ「始める → 終わるまで待つ」。上限（1 人あたり 3 つ）を超えて同時に積まない。
  // リソースが読めない・生成に失敗するものがあっても、ほかのリソースは続ける。
  let generated = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const [i, s] of scopes.entries()) {
    const label = s.scope === "resource" ? s.resourceId : "プロジェクト全体";
    const r = await startWithRetry(io, label, () => ws.generate({ columnId, ...s, ...lang }));
    totals.total += r.total;
    totals.cached += r.cached;
    totals.toRun += r.toRun;
    if (!r.jobId) continue;
    const info = await waitWithProgress(ws, r.jobId, io, `[${i + 1}/${scopes.length}] ${label}: `);
    generated += info.done;
    failed += info.failed;
    if (info.status === "failed" || info.status === "cancelled") {
      // 失敗の件数が 0 でも（ジョブ自体の失敗）、失敗として数える。
      if (info.failed === 0) failed += Math.max(1, info.total - info.done);
    }
    if (info.error) errors.push(`${label}: ${info.error}`);
  }
  const summary = { columnId, total: totals.total, cached: totals.cached, generated, failed, errors };
  if (opts.json) {
    json(io, summary);
  } else {
    io.stdout(`${columnId}: 全体 ${summary.total} / キャッシュ済み ${summary.cached} / 生成 ${generated} / 失敗 ${failed}\n`);
    for (const e of errors) io.stderr(`エラー: ${e}\n`);
  }
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function allKeys(ws: Workspace, resourceId: string): Promise<string[]> {
  const keys: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const r = await ws.rows({ resourceId, languages: [], offset, limit: PAGE });
    keys.push(...r.rows.map((x) => x.key));
    if (keys.length >= r.totalAll || r.rows.length === 0) return keys;
  }
}

async function cmdRun(ws: Workspace, opts: CliOptions, io: CliIO): Promise<number> {
  const actionId = opts.args[0] as string;
  const info = await ws.info();
  checkLanguages(info, opts.languages);
  const action = info.actions.find((a) => a.id === actionId);
  if (!action) {
    throw new ApiError(
      "not-found",
      `アクション "${actionId}" は設定の actions にありません（使えるアクション: ${info.actions.map((a) => a.id).join(", ") || "なし"}）。`,
    );
  }
  if (action.target === "review") throw new ApiError("invalid", `アクション "${actionId}" はレビュー先です。run では使えません。`);
  if (opts.where !== undefined) {
    if (opts.keys) throw new UsageError("--where と --keys は、どちらか一方だけを指定してください。");
    if (action.target === "file" || action.target === "column") {
      throw new UsageError(`アクション "${actionId}"（target: ${action.target}）は、ファイルや列の全体が対象なので、--where は使えません。対象のファイルは --resources で絞ってください。`);
    }
  }
  // --where: 条件に合う行だけを対象にする（条件の「対象の言語」は --languages。省略時はすべての言語）。行を選ぶのはサービス層。
  const filter = opts.where !== undefined ? { where: opts.where, languages: opts.languages ?? info.languages.map((l) => l.id) } : undefined;
  const resources = await selectResources(ws, opts.resources);
  if (opts.resources !== undefined && resources.length === 0) {
    throw new ApiError("not-found", `--resources "${opts.resources}" に一致するリソースがありません。`);
  }

  // cell / column 対象は、列 × 言語のセルごとに呼ぶ。
  let cellIds: (string | undefined)[] = [undefined];
  if (action.target === "cell" || action.target === "column") {
    const columnIds = opts.column !== undefined ? [opts.column] : (action.columns ?? []);
    if (columnIds.length === 0) {
      throw new ApiError("invalid", `アクション "${actionId}"（target: ${action.target}）は列の指定が必要です。--column <id> を付けてください。`);
    }
    const langs = opts.languages ?? action.languages ?? info.languages.map((l) => l.id);
    cellIds = [];
    for (const cid of columnIds) {
      const col = info.columns.find((c) => c.id === cid);
      if (!col) throw new ApiError("not-found", `列 "${cid}" はありません。`);
      if (col.scope === "entry") cellIds.push(cid);
      else for (const l of langs) if (!col.languages || col.languages.includes(l)) cellIds.push(`${cid}@${l}`);
    }
  }

  const results: {
    resource: string;
    cellId?: string;
    matched?: number;
    message?: string;
    patched: number;
    jobDone?: number;
    jobFailed?: number;
    errors: string[];
  }[] = [];
  let failed = 0;

  for (const res of resources) {
    let keys: string[] | undefined;
    if (filter) {
      // 行はサービス層が条件で選ぶ。
    } else if (action.target === "cell" || action.target === "row" || action.target === "selection") {
      if (opts.keys) {
        const existing = new Set(await allKeys(ws, res.id));
        keys = opts.keys.filter((k) => existing.has(k));
        if (keys.length === 0) continue;
      } else if (action.target !== "selection") {
        keys = await allKeys(ws, res.id);
        if (keys.length === 0) continue;
      }
    }
    const perLang = action.target === "row" && opts.languages ? opts.languages : [undefined];
    for (const cellId of cellIds) {
      for (const language of perLang) {
        const entry: (typeof results)[number] = { resource: res.path, patched: 0, errors: [] };
        if (cellId !== undefined) entry.cellId = cellId;
        try {
          // 1 件ずつ「始める → 終わるまで待つ」ので、上限に当たるのは別のプロセスがジョブを走らせているときだけ。
          const r = await startWithRetry(io, res.path, () =>
            ws.runAction({
              actionId,
              resourceId: res.id,
              ...(keys ? { keys } : {}),
              ...(filter ? { filter } : {}),
              ...(cellId !== undefined ? { cellId } : {}),
              ...(language !== undefined ? { language } : {}),
            }),
          );
          // 条件に合う行のないリソースは、結果に出さない。
          if (filter && r.matched === 0) continue;
          if (r.matched !== undefined) entry.matched = r.matched;
          entry.patched = r.patched;
          if (r.message) entry.message = r.message;
          if (r.errors) entry.errors.push(...r.errors);
          if (r.jobId) {
            const j = await waitWithProgress(ws, r.jobId, io, `${res.path}: `);
            entry.jobDone = j.done;
            entry.jobFailed = j.failed;
            if (j.error) entry.errors.push(j.error);
            if (j.status === "failed" || j.status === "cancelled" || j.failed > 0) entry.errors.push(`ジョブが ${j.status} で終わりました（失敗 ${j.failed}）。`);
          }
        } catch (err) {
          const code = apiErrorCode(err);
          if (code === 2) throw err;
          entry.errors.push(errText(err));
        }
        if (entry.errors.length > 0) failed++;
        results.push(entry);
      }
    }
  }

  const patched = results.reduce((n, r) => n + r.patched, 0);
  // 条件に合った行の数（リソースごとの数の合計。セルや言語ごとに呼んだ分は、1 回分だけ数える）。
  const matchedByResource = new Map<string, number>();
  for (const r of results) if (r.matched !== undefined) matchedByResource.set(r.resource, r.matched);
  const matched = [...matchedByResource.values()].reduce((n, m) => n + m, 0);
  if (opts.json) {
    json(io, { actionId, ...(filter ? { matched } : {}), patched, failed, results });
  } else {
    if (filter && results.length === 0) io.stdout("条件に合う行がありません。\n");
    for (const r of results) {
      const head = `${r.resource}${r.cellId ? ` ${r.cellId}` : ""}`;
      io.stdout(`${head}: ${r.matched !== undefined ? `条件に合う行 ${r.matched} / ` : ""}反映 ${r.patched}${r.jobDone !== undefined ? ` / ジョブ 完了 ${r.jobDone} 失敗 ${r.jobFailed ?? 0}` : ""}\n`);
      if (r.message) for (const line of r.message.split("\n")) io.stdout(`  ${line}\n`);
      for (const e of r.errors) io.stderr(`  エラー: ${e}\n`);
    }
    io.stdout(`${action.label}（${actionId}）: リソース ${new Set(results.map((r) => r.resource)).size}${filter ? ` / 条件に合う行 ${matched}` : ""} / 反映 ${patched} / 失敗 ${failed}\n`);
    if (patched > 0) io.stdout("本文の変更は未保存です。save で書き込んでください。\n");
  }
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function cmdStatus(ws: Workspace, opts: CliOptions, io: CliIO): Promise<number> {
  checkLanguages(await ws.info(), opts.languages);
  const resources = await selectResources(ws, opts.resources);
  // 1 つのリソースが読めなくても、ほかは処理する。
  const pct = (c: number, t: number): number => (t === 0 ? 100 : Math.round((c / t) * 1000) / 10);
  const outs = [];
  for (const r of resources) {
    try {
      const s = (await ws.stats({ resourceIds: [r.id] }))[0];
      const progress: Record<string, Record<string, { complete: number; total: number; percent: number }>> = {};
      for (const [col, langs] of Object.entries(s?.progress ?? {})) {
        for (const [lang, p] of Object.entries(langs)) {
          if (opts.languages && lang !== "*" && !opts.languages.includes(lang)) continue;
          (progress[col] ??= {})[lang] = { ...p, percent: pct(p.complete, p.total) };
        }
      }
      outs.push({
        path: r.path,
        entries: s?.entries ?? 0,
        unsaved: s?.unsaved ?? 0,
        issues: s?.issues ?? { error: 0, warning: 0, info: 0 },
        progress,
        error: undefined as string | undefined,
      });
    } catch (err) {
      outs.push({
        path: r.path,
        entries: 0,
        unsaved: 0,
        issues: { error: 0, warning: 0, info: 0 },
        progress: {},
        error: errText(err),
      });
    }
  }
  const unreadable = outs.filter((o) => o.error !== undefined).length;
  // 進捗の数の単位（設定の grid.progressUnit）。行数でないときは、何を数えた数かを出す。
  const unit = (await ws.info()).grid.progressUnit;
  if (opts.json) {
    json(io, { resources: outs.map(({ error, ...o }) => (error !== undefined ? { ...o, error } : o)), unreadable, progressUnit: unit });
    return unreadable > 0 ? 1 : 0;
  }
  const lines: string[] = [];
  if (unit !== "rows" && outs.length > 0) lines.push(`進捗は、原文の${unit === "characters" ? "文字数" : "語数"}で数えています。`, "");
  for (const o of outs) {
    if (o.error !== undefined) {
      lines.push(`${o.path}  (読めません: ${o.error})`, "");
      continue;
    }
    lines.push(
      o.path,
      `  エントリ ${o.entries} / 未保存 ${o.unsaved} / 問題 error ${o.issues.error} warning ${o.issues.warning} info ${o.issues.info}`,
    );
    for (const [col, langs] of Object.entries(o.progress)) {
      const cells = Object.entries(langs).map(([l, p]) => `${l === "*" ? "-" : l} ${p.complete}/${p.total} (${p.percent}%)`);
      lines.push(`  ${col}: ${cells.join("  ")}`);
    }
    lines.push("");
  }
  if (outs.length === 0) lines.push("対象のリソースがありません。");
  io.stdout(lines.join("\n") + "\n");
  return unreadable > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

async function cmdSave(ws: Workspace, opts: CliOptions, io: CliIO): Promise<number> {
  const r = await ws.saveAll();
  if (opts.json) json(io, r);
  else io.stdout(`保存: リソース ${r.resources} / セル ${r.saved} / 競合 ${r.conflicts}\n`);
  if (r.conflicts > 0) {
    io.stderr(`${r.conflicts} 件の競合があり、書かずに残しました。画面で確かめてください。\n`);
    for (const c of r.conflictList) io.stderr(`  ${c.resourceId}  ${c.key}  ${c.language}\n`);
  }
  return r.conflicts > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

async function cmdSet(ws: Workspace, opts: CliOptions, io: CliIO): Promise<number> {
  const [cellId, value] = opts.args as [string, string];
  if (opts.resource === undefined) throw new UsageError("set には --resource <path> が必要です。");
  if (!opts.keys || opts.keys.length === 0) throw new UsageError("set には --keys <k1,k2> が必要です。");
  const all = flatten(await ws.tree());
  const res = all.find((r) => r.path === opts.resource || r.id === opts.resource);
  if (!res) throw new ApiError("not-found", `リソース "${opts.resource}" が見つかりません。`);
  const r = await ws.setCells({ resourceId: res.id, keys: opts.keys, cellId, value });
  if (opts.json) json(io, { resource: res.path, cellId, value, ...r });
  else {
    io.stdout(`${res.path} ${cellId} = ${value}: 更新 ${r.updated} / ブロック ${r.blocked.length}\n`);
    if (r.blocked.length > 0) io.stdout(`  ブロックされた行: ${r.blocked.join(", ")}\n`);
  }
  return 0;
}

async function findResource(ws: Workspace, opts: CliOptions, command: string): Promise<ResourceNode> {
  if (opts.resource === undefined) throw new UsageError(`${command} には --resource <path> が必要です。`);
  const res = flatten(await ws.tree()).find((r) => r.path === opts.resource || r.id === opts.resource);
  if (!res) throw new ApiError("not-found", `リソース "${opts.resource}" が見つかりません。`);
  return res;
}

/** entry add / remove / rename: 行を足す・消す・キーを変える（すぐリソースに書く）。 */
async function cmdEntry(ws: Workspace, opts: CliOptions, io: CliIO): Promise<number> {
  const res = await findResource(ws, opts, `entry ${opts.sub ?? ""}`);
  let changes: Parameters<Workspace["editEntries"]>[0]["changes"];
  let summary: string;
  if (opts.sub === "add") {
    const [key] = opts.args as [string];
    changes = [{ type: "add", key, ...(opts.after !== undefined ? { after: opts.after } : {}), ...(opts.text ? { text: opts.text } : {}) }];
    summary = `行 ${key} を追加`;
  } else if (opts.sub === "remove") {
    if (!opts.keys || opts.keys.length === 0) throw new UsageError("entry remove には --keys <k1,k2> が必要です。");
    changes = opts.keys.map((key) => ({ type: "remove" as const, key }));
    summary = `${opts.keys.length} 行を削除（${opts.keys.join(", ")}）`;
  } else {
    const [key, newKey] = opts.args as [string, string];
    changes = [{ type: "rename", key, newKey }];
    summary = `キー ${key} を ${newKey} に変更`;
  }
  const r = await ws.editEntries({ resourceId: res.id, changes });
  if (opts.json) json(io, { resource: res.path, changes, entries: r.entries });
  else io.stdout(`${res.path}: ${summary}（${r.entries} 行）\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

/** query: 条件に合う行を、リソースをまたいで数え、集計し、CSV / TSV に書き出す。読めないリソースがあれば終了コード 1。 */
async function cmdQuery(ws: Workspace, opts: CliOptions, io: CliIO): Promise<number> {
  const info = await ws.info();
  checkLanguages(info, opts.languages);
  const languages = opts.languages ?? info.languages.map((l) => l.id);
  const resources = opts.resources !== undefined ? await selectResources(ws, opts.resources) : undefined;
  if (resources !== undefined && resources.length === 0) throw new UsageError(`--resources に合うリソースがありません: ${opts.resources}`);
  const request = {
    languages,
    ...(resources ? { resourceIds: resources.map((r) => r.id) } : {}),
    ...(opts.where !== undefined ? { where: opts.where } : {}),
    ...(opts.groupBy && opts.groupBy.length > 0 ? { groupBy: opts.groupBy } : {}),
    ...(opts.columns ? { cells: opts.columns } : {}),
  };

  if (opts.format !== undefined) {
    // 集計の区切りがあれば集計を、なければ行を書き出す。
    const table = request.groupBy ? "groups" : "rows";
    const r = await ws.exportQuery({ ...request, format: opts.format, table });
    const text = `${opts.bom ? "\uFEFF" : ""}${r.text}`;
    if (opts.out !== undefined) {
      const file = path.resolve(io.cwd, opts.out);
      await writeFile(file, text, "utf8");
      io.stdout(`${r.rows} 行を書き出しました: ${file}${r.truncated ? "（行数の上限で打ち切りました）" : ""}\n`);
    } else {
      io.stdout(text);
      if (r.truncated) io.stderr("行数の上限で打ち切りました。\n");
    }
    return 0;
  }

  const r = await ws.query({ ...request, limit: opts.limit ?? 0 });
  if (opts.json) {
    json(io, r);
    return r.unreadable.length > 0 ? 1 : 0;
  }
  const lines: string[] = [`条件に合う行: ${r.matched.rows} / ${r.totalRows} 行（原文 ${r.matched.characters} 文字 / ${r.matched.words} 語）`];
  for (const res of r.resources) if (res.matched > 0) lines.push(`  ${res.path}: ${res.matched} / ${res.total}`);
  for (const u of r.unreadable) lines.push(`  ${u.path}  (読めません: ${u.error})`);
  if (r.groups) {
    lines.push("", `集計（${(opts.groupBy ?? []).join(", ")}）:`);
    for (const g of r.groups) lines.push(`  ${g.labels.join(" / ")}: ${g.rows} 行（${g.characters} 文字 / ${g.words} 語）`);
  }
  if (r.rows.length > 0) {
    lines.push("", "行:");
    for (const row of r.rows) {
      lines.push(`  ${row.path}  ${row.key}`);
      for (const [cellId, cell] of Object.entries(row.cells)) {
        const value = cell.value === undefined || cell.value === null || cell.value === "" ? "" : typeof cell.value === "string" ? cell.value : JSON.stringify(cell.value);
        // 改行のある値も 1 行で見せる。
        if (value !== "") lines.push(`    ${cellId}: ${value.replace(/\r?\n/g, "\\n")}`);
      }
    }
    if (r.rows.length < r.matched.rows) lines.push(`  …（${r.matched.rows} 行のうち ${r.rows.length} 行。--limit で増やせます）`);
  }
  io.stdout(lines.join("\n") + "\n");
  return r.unreadable.length > 0 ? 1 : 0;
}

/** resource create: 行のない新しいリソースを作る。 */
async function cmdResource(ws: Workspace, opts: CliOptions, io: CliIO): Promise<number> {
  const [resourcePath] = opts.args as [string];
  const { resource } = await ws.createResource({ path: resourcePath });
  if (opts.json) json(io, { resource });
  else io.stdout(`リソースを作りました: ${resource.path}\n`);
  return 0;
}

/** サービス層を通すコマンドを実行する。ワークスペースは必ず閉じる。 */
export async function runBatchCommand(opts: CliOptions, io: CliIO): Promise<number> {
  const dir = path.resolve(io.cwd, opts.project ?? ".");
  let ws: Workspace;
  try {
    ws = await openWorkspace(opts, io);
  } catch (err) {
    throw new OpenFailure(`プロジェクトを開けませんでした（${dir}）: ${errText(err)}`, err);
  }
  try {
    switch (opts.command) {
      case "generate":
        return await cmdGenerate(ws, opts, io);
      case "run":
        return await cmdRun(ws, opts, io);
      case "status":
        return await cmdStatus(ws, opts, io);
      case "query":
        return await cmdQuery(ws, opts, io);
      case "save":
        return await cmdSave(ws, opts, io);
      case "set":
        return await cmdSet(ws, opts, io);
      case "entry":
        return await cmdEntry(ws, opts, io);
      case "resource":
        return await cmdResource(ws, opts, io);
      default:
        throw new Error(`サービス層のコマンドではありません: ${opts.command}`);
    }
  } finally {
    await ws.close();
  }
}

export class OpenFailure extends Error {
  constructor(message: string, override readonly cause: unknown) {
    super(message);
  }
}
