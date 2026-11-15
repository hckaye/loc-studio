/**
 * ワークスペースの組み立て: 設定の層 → ユーザー名 → 共有 DB とその PC の DB → プラグインのホスト → プロジェクト。
 */
import path from "node:path";
import { builtinPlugin } from "@loc-studio/builtin";
import {
  cliSettingsFromEnv,
  createPluginHost,
  createProjectReader,
  expandEnv,
  loadProjectConfig,
  UntrustedConfigError,
  isReservedEnvName,
  withoutReservedEnv,
  localSettingsPath,
  openProject,
  readLocalSettings,
} from "@loc-studio/core";
import type { Project } from "@loc-studio/core";
import { llmPlugin } from "@loc-studio/plugin-llm";
import { openStore } from "@loc-studio/store";
import type { Store } from "@loc-studio/store";
import { runAction } from "./actions.js";
import { ApiError, WORKSPACE_METHODS } from "./api-types.js";
import { openRestricted } from "./restricted.js";
import type { Workspace, WorkspaceOptions } from "./api-types.js";
import { WsContext } from "./context.js";
import { discardDrafts, save, saveAll, setCell, setCells, setText } from "./editing.js";
import { createResource, editEntries, followStableIds } from "./structure.js";
import { generate } from "./generate.js";
import { textHash } from "./hash.js";
import { history, textVersion } from "./history.js";
import { info, plugins } from "./plugins-api.js";
import { tokens, validateText } from "./issues.js";
import { forwardReview, postReview, reviews } from "./reviews.js";
import { rowDetail, rows, stats, tree } from "./rows.js";
import { search } from "./search.js";
import { currentCall, runWithCall } from "./call-context.js";
import { maskUrl, openPostgres } from "./pg-store.js";
import { canManage } from "./permissions.js";
import { rendererModule } from "./renderers.js";
import type { CallContext } from "./api-types.js";
import { trustChecker, trustPlugins, untrustPlugins } from "./trust.js";
import { validate } from "./validate.js";
import { layersFromConfig, reloadProject, setLocalSetting, settings, updateProjectSettings } from "./settings-api.js";

/** 共有 DB の既定の場所（プロジェクトからの相対）。 */
export const DEFAULT_STORAGE_PATH = path.join(".loc-studio", "meta.db");

/**
 * ワークスペースを開く。pluginTrust が "prompt" で、コードの設定を信頼していないため JSON の設定だけでは開けないときは、
 * 制限された状態（restricted）で開く。信頼すると、同じオブジェクトのまま普通の状態に切り替わる。
 */
export async function createWorkspace(opts: WorkspaceOptions): Promise<Workspace> {
  const holder: { impl: Workspace } = { impl: await openImpl(opts) };
  return makeOuter(holder, opts);
}

async function openImpl(opts: WorkspaceOptions): Promise<Workspace> {
  try {
    return await openFull(opts);
  } catch (err) {
    if (err instanceof UntrustedConfigError) return openRestricted(opts, err, () => openImpl(opts));
    throw err;
  }
}

/** 戻り値が ProjectInfo のメソッド（制限された状態に切り替わったら、その info を返す）。 */
const RETURNS_INFO = new Set<string>(["info", "reloadPlugins", "trustPlugins", "untrustPlugins", "updateProjectSettings"]);

function makeOuter(holder: { impl: Workspace }, opts: WorkspaceOptions): Workspace {
  const switchTo = async (next: Workspace): Promise<void> => {
    const prev = holder.impl;
    holder.impl = next;
    if (prev !== next) await prev.close();
  };
  const outer = {} as Record<string, unknown>;
  for (const method of WORKSPACE_METHODS) {
    outer[method] = async (params: unknown) => {
      const impl = holder.impl;
      try {
        const r = await (impl[method] as (p: unknown) => Promise<unknown>).call(impl, params);
        // 制限された状態で信頼されると、中で普通の状態に開き直す。
        const reopened = (impl as { reopened?: Workspace }).reopened;
        if (reopened && holder.impl === impl) {
          await switchTo(reopened);
          return RETURNS_INFO.has(method) ? reopened.info() : r;
        }
        return r;
      } catch (err) {
        if (!(err instanceof UntrustedConfigError)) throw err;
        // 読み直したら、コードの設定を信頼しないと開けなくなった（書き換えられた）。制限された状態に切り替える。
        await switchTo(await openRestricted(opts, err, () => openImpl(opts)));
        if (RETURNS_INFO.has(method)) return holder.impl.info();
        throw new ApiError("untrusted", err.message);
      }
    };
  }
  const ws = outer as unknown as Workspace;
  Object.defineProperties(ws, {
    project: { get: () => holder.impl.project },
    restricted: { get: () => holder.impl.restricted },
  });
  ws.waitForJob = (id) => holder.impl.waitForJob(id);
  ws.rendererModule = (id) => holder.impl.rendererModule(id);
  ws.withCall = (call, fn) => holder.impl.withCall(call, fn);
  ws.roles = () => holder.impl.roles();
  ws.redaction = () => holder.impl.redaction();
  ws.close = () => holder.impl.close();
  return ws;
}

/** Web モードでは、プロジェクトの設定とプラグインに見せる環境変数を、サーバーの設定で許した名前だけにする。 */
function projectEnvOf(opts: WorkspaceOptions, env: Record<string, string | undefined>): Record<string, string | undefined> {
  // 秘密を扱う予約された名前は、どのモードでも出さない（秘密は host.secrets だけで読む）。
  if (!opts.webMode) return withoutReservedEnv(env);
  const out: Record<string, string | undefined> = {};
  for (const name of opts.webMode.allowedEnv) if (env[name] !== undefined && !isReservedEnvName(name)) out[name] = env[name];
  return out;
}

/** 管理者でない利用者に見せないパス。 */
export function sensitivePathsOf(opts: WorkspaceOptions, extra: { root: string; userDataDir: string; localFile: string; storagePath?: string }) {
  const paths: { prefix: string; label: string }[] = [
    { prefix: extra.root, label: "<project>" },
    { prefix: extra.userDataDir, label: "<data>" },
    { prefix: extra.localFile, label: "<settings>" },
  ];
  if (opts.appDir) paths.push({ prefix: path.resolve(opts.appDir), label: "<app>" });
  if (extra.storagePath) paths.push({ prefix: extra.storagePath, label: "<storage>" });
  for (const p of opts.webMode?.sensitivePaths ?? []) paths.push({ prefix: path.resolve(p), label: "<server>" });
  // 長いものから当てる（入れ子のパスで短いほうが先に当たらないように）。
  return paths.filter((p) => p.prefix !== "").sort((a, b) => b.prefix.length - a.prefix.length);
}

async function openFull(opts: WorkspaceOptions): Promise<Workspace> {
  const env = opts.env ?? process.env;
  const root = path.resolve(opts.projectRoot);
  const localFile = opts.userDataDir !== undefined ? path.join(path.resolve(opts.userDataDir), "settings.json") : localSettingsPath(env);
  const userDataDir = path.resolve(opts.userDataDir ?? path.dirname(localFile));
  const loaderOpts = opts.sdkPath !== undefined ? { sdkPath: opts.sdkPath } : undefined;

  const local = await readLocalSettings(localFile);
  // 共有 DB とプラグインのホストは同じ関数でユーザー名を読む（設定の変更がすぐ記録に反映される）。
  let ctx: WsContext | undefined;
  // 信頼の判定は、その時点のローカル設定を読む（trustPlugins のあとの読み直しで反映される）。
  const trust = (opts.pluginTrust ?? "prompt") === "always" ? undefined : trustChecker(root, () => (ctx ? ctx.layers.local : local));
  // コードの設定も、信頼するまで import しない（JSON だけで開けなければ UntrustedConfigError）。
  const loaded = await loadProjectConfig(root, { ...(loaderOpts ?? {}), ...(trust ? { trustConfig: trust } : {}) });
  // 環境変数は、設定ファイルを確認したあとで初めて写す（確認前は読まない）。
  const projectEnv = projectEnvOf(opts, env);
  const layers = layersFromConfig(loaded.config, {
    cli: { ...cliSettingsFromEnv(env), ...(opts.cliSettings ?? {}) },
    local,
  });

  const storage = loaded.config.storage;
  const postgres = storage?.driver === "postgres";
  let pgUrl: string | undefined;
  if (postgres) {
    if (typeof storage.url !== "string" || storage.url === "") {
      throw new Error(`設定の storage.driver が "postgres" のときは storage.url を指定してください（${root}）。`);
    }
    pgUrl = expandEnv(storage.url, projectEnv);
  }
  // schema は SDK の StorageConfig にまだないので、緩く読む。
  const pgSchema = (storage as { schema?: unknown } | undefined)?.schema;
  if (pgSchema !== undefined && (typeof pgSchema !== "string" || pgSchema === "")) {
    throw new Error(`設定の storage.schema は空でない文字列にしてください（${root}）。`);
  }
  const storagePath = postgres
    ? maskUrl(pgUrl!)
    : storage?.path !== undefined
      ? path.resolve(root, expandEnv(storage.path, projectEnv))
      : path.join(root, DEFAULT_STORAGE_PATH);
  const localDbPath = path.join(userDataDir, "projects", textHash(root).slice(0, 16), "local.db");

  const userName = (): string => (ctx ? ctx.userName() : "unknown");

  let shared: Store | undefined;
  let localDb: Store | undefined;
  try {
    shared = postgres
      ? await openPostgres({ url: pgUrl!, userName, ...(typeof pgSchema === "string" ? { schema: pgSchema } : {}) })
      : await openStore({ path: storagePath, userName, ...(storage?.sharing ? { sharing: storage.sharing } : {}) });
    localDb = await openStore({ path: localDbPath, userName });
    const sharedStore = shared;
    // ctx ができる前にプラグインが秘密情報を読むことはないが、念のため ctx 経由で読む。
    const opened = (): WsContext => {
      if (!ctx) throw new Error("host.project は、プロジェクトを開き終えるまで使えません（ツリーの list の中などでは使えません）。");
      return ctx;
    };
    const host = createPluginHost({
      db: sharedStore,
      userName,
      userRole: () => currentCall()?.role,
      projectRoot: root,
      env: projectEnv,
      secrets: { get: (name) => ctx?.secrets.get(name) },
      // 解析結果のキャッシュ、未保存の編集、役割の resources（見えるリソース）を通して読む。
      project: createProjectReader({
        project: () => opened().project,
        resources: () => opened().docs.allResources(),
        entries: async (resourceId) => {
          const doc = await opened().docs.get(resourceId);
          return { resource: doc.resource, entries: doc.entries };
        },
        draftText: (resourceId, key, language) => opened().drafts.get(resourceId, key, language)?.value,
      }),
    });
    const project: Project = await openProject(root, {
      ...(trust ? { trust } : {}),
      ...(opts.webMode ? { pluginDirRoots: opts.webMode.pluginDirRoots } : {}),
      builtins: [builtinPlugin, llmPlugin, ...(opts.extraBuiltins ?? [])],
      ...(opts.appDir !== undefined ? { appDir: opts.appDir } : {}),
      // Web モードでは個人の設定フォルダのプラグインを読まない。
      ...(opts.localPlugins !== false ? { userDataDir } : {}),
      env,
      ...(opts.sdkPath !== undefined ? { sdkPath: opts.sdkPath } : {}),
      host,
    });
    ctx = new WsContext({
      project,
      shared: sharedStore,
      local: localDb,
      env: projectEnv,
      secretEnv: env,
      promptTrust: trust !== undefined,
      layers: layersFromConfig(project.config, layers),
      localFile,
      userDataDir,
      storagePath,
      storageShared: postgres || storage?.sharing !== undefined,
      ...(opts.userSettings ? { userSettings: opts.userSettings } : {}),
      ...(opts.revisionCheckIntervalMs !== undefined ? { revisionCheckIntervalMs: opts.revisionCheckIntervalMs } : {}),
    });
    await ctx.drafts.load();
    const ready = ctx;
    ctx.docs.onLoaded = (state) => followStableIds(ready, state);
    ctx.startWatching();
  } catch (err) {
    ctx?.stopWatching();
    shared?.close();
    localDb?.close();
    throw err;
  }
  return makeWorkspace(ctx, sensitivePathsOf(opts, { root, userDataDir, localFile, ...(postgres ? {} : { storagePath }) }));
}

/** CallContext の形を確かめる（ホストのアプリが作るものだが、権限の判定の元なので厳しく見る）。 */
export function validateCall(call: CallContext): void {
  if (typeof call?.user?.name !== "string" || call.user.name === "") throw new ApiError("invalid", "CallContext の user.name がありません。");
  if (typeof call.role !== "string" || call.role === "") throw new ApiError("invalid", "CallContext の role がありません。");
  if (call.languages !== undefined && (!Array.isArray(call.languages) || call.languages.some((l) => typeof l !== "string"))) {
    throw new ApiError("invalid", "CallContext の languages は文字列の配列にしてください。");
  }
}

function makeWorkspace(ctx: WsContext, sensitive: { prefix: string; label: string }[]): Workspace {
  let closed = false;
  const live = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (closed) throw new ApiError("failed", "ワークスペースは閉じられています。");
      return fn(...args);
    };
  const infoFn = () => info(ctx);
  const ws: Workspace = {
    get project() {
      return ctx.project;
    },
    info: live(async () => infoFn()),
    tree: live(async () => tree(ctx)),
    stats: live(async (p) => stats(ctx, p)),
    rows: live(async (p) => rows(ctx, p)),
    rowDetail: live(async (p) => rowDetail(ctx, p)),
    history: live(async (p) => history(ctx, p)),
    reviews: live(async (p) => reviews(ctx, p)),
    textVersion: live(async (p) => textVersion(ctx, p)),
    validateText: live(async (p) => validateText(ctx, p)),
    search: live(async (p) => search(ctx, p)),
    tokens: live(async (p) => tokens(ctx, p)),
    settings: live(async () => settings(ctx)),
    plugins: live(async () => plugins(ctx)),
    validate: live(async (p) => validate(ctx, p ?? {})),
    trustPlugins: live(async (p) => trustPlugins(ctx, p, infoFn)),
    restricted: false,
    redaction: () => ({ paths: sensitive, log: (m: string) => ctx.project.host.log(m) }),
    untrustPlugins: live(async (p) => untrustPlugins(ctx, p, infoFn)),
    jobs: live(async () => ctx.jobs.list()),
    job: live(async (p) => ctx.jobs.get(p?.id)),
    changes: live(async (p) => {
      const changeSeq = await ctx.shared.changeSeq();
      return { changeSeq, changed: changeSeq !== Number(p?.since), localSeq: ctx.localSeq };
    }),
    setText: live(async (p) => setText(ctx, p)),
    discardDrafts: live(async (p) => discardDrafts(ctx, p)),
    save: live(async (p) => save(ctx, p)),
    saveAll: live(async () => saveAll(ctx)),
    setCell: live(async (p) => setCell(ctx, p)),
    setCells: live(async (p) => setCells(ctx, p)),
    postReview: live(async (p) => postReview(ctx, p)),
    forwardReview: live(async (p) => forwardReview(ctx, p)),
    runAction: live(async (p) => runAction(ctx, p)),
    generate: live(async (p) => generate(ctx, p)),
    cancelJob: live(async (p) => {
      // Web モードでは、ほかの人が始めたジョブを止められるのは manage の権限がある人だけ。
      const call = currentCall();
      if (call && !canManage() && ctx.jobs.get(p?.id).startedBy !== call.user.name) {
        throw new ApiError("forbidden", "ほかの人が始めたジョブは止められません（manage の権限がある役割だけができます）。");
      }
      return ctx.jobs.cancel(p?.id);
    }),
    editEntries: live(async (p) => editEntries(ctx, p)),
    createResource: live(async (p) => createResource(ctx, p)),
    setLocalSetting: live(async (p) => setLocalSetting(ctx, p)),
    updateProjectSettings: live(async (p) => updateProjectSettings(ctx, p, infoFn)),
    reloadPlugins: live(async () => {
      await reloadProject(ctx);
      return infoFn();
    }),
    reloadResource: live(async (p) => {
      const doc = await ctx.docs.reload(p?.resourceId);
      ctx.bump();
      return doc.revision !== undefined ? { revision: doc.revision } : {};
    }),
    roles: () => ctx.project.roles(),
    waitForJob: (id) => ctx.jobs.wait(id),
    rendererModule: async (id) => (closed ? undefined : rendererModule(ctx, id)),
    async withCall(call, fn) {
      validateCall(call);
      const layers = {
        ...ctx.layers,
        // 利用者ごとの設定を local の層に使う。起動引数（cli）の層は使わない。
        local: ctx.userSettings ? await ctx.userSettings.get(call.user.name) : {},
      };
      delete layers.cli;
      return runWithCall({ call, layers, roles: ctx.project.roles() }, fn);
    },
    async close() {
      if (closed) return;
      closed = true;
      ctx.stopWatching();
      await ctx.jobs.close();
      ctx.shared.close();
      ctx.local.close();
    },
  };
  return ws;
}
