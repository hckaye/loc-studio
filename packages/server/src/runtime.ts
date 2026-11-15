/**
 * Web の層が使う入口。モード（local / web）に応じて、サーバーの DB、認証、プロジェクトごとのワークスペースをまとめる。
 * ローカルモードの従来の使い方（createWorkspace と dispatch を直接使う）はこれを使わなくても動く。
 */
import path from "node:path";
import { openStore } from "@loc-studio/store";
import type { Store } from "@loc-studio/store";
import type { Plugin } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { Role, Workspace, WorkspaceOptions } from "./api-types.js";
import { openAuthService } from "./auth/service.js";
import type { AuthService, AuthUser, Membership } from "./auth/service.js";
import { openPostgres } from "./pg-store.js";
import { dispatch, toRpcError } from "./rpc.js";
import { redactError } from "./redact.js";
import type { RpcResponse } from "./rpc.js";
import { loadServerConfig, serverConfigPath } from "./server-config.js";
import type { ServerConfig, ServerProject } from "./server-config.js";
import { createWorkspace } from "./workspace.js";

export interface ServerRuntimeOptions {
  mode: "local" | "web";
  /** ワークスペースのデータ（ドラフトなど）とサーバーの設定ファイルの既定の置き場所。 */
  dataDir: string;
  env?: Record<string, string | undefined>;
  /** Web モードの設定。省略時は serverConfigPath(env, dataDir) のファイルを読む。ローカルモードでは任意（プロジェクトの一覧に使う）。 */
  config?: ServerConfig;
  appDir?: string;
  sdkPath?: string;
  extraBuiltins?: Plugin[];
  now?: () => Date;
  /** ワークスペースを開くときに足すもの（テスト用。revisionCheckIntervalMs など）。 */
  workspaceOptions?: Partial<WorkspaceOptions>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  /** Web モード: この利用者の役割（管理者は manager）。 */
  role?: Role;
  languages?: string[];
}

export interface HandleRequest {
  projectId: string;
  method: string;
  params?: unknown;
  /** Web モードでは必須（authenticate / authenticateProxyUser の結果）。ローカルモードでは使わない。 */
  user?: AuthUser;
}

/** 管理の操作。どれも actor が管理者でなければ forbidden。 */
export interface AdminApi {
  listUsers(actor: AuthUser): Promise<AuthUser[]>;
  createUser(actor: AuthUser, input: { name: string; password?: string; displayName?: string; admin?: boolean }): Promise<AuthUser>;
  updateUser(actor: AuthUser, name: string, patch: { displayName?: string; admin?: boolean; disabled?: boolean }): Promise<AuthUser>;
  setPassword(actor: AuthUser, name: string, password: string): Promise<void>;
  deleteUser(actor: AuthUser, name: string): Promise<void>;
  listMemberships(actor: AuthUser, projectId?: string): Promise<Membership[]>;
  setMembership(actor: AuthUser, projectId: string, user: string, m: { role: Role; languages?: string[] }): Promise<Membership>;
  removeMembership(actor: AuthUser, projectId: string, user: string): Promise<void>;
}

export interface ServerRuntime {
  readonly mode: "local" | "web";
  readonly config: ServerConfig | undefined;
  /** Web モードだけ。 */
  readonly auth: AuthService | undefined;
  /** 利用者が開けるプロジェクト（Web モード）。ローカルモードでは設定のプロジェクトすべて。 */
  projects(user?: AuthUser): Promise<ProjectSummary[]>;
  /** プロジェクトのワークスペース（初回に開き、以後は同じものを返す）。 */
  workspace(projectId: string): Promise<Workspace>;
  /** RPC の 1 回の呼び出し。Web モードでは user の権限で呼ぶ。失敗も { error } で返す。 */
  handle(req: HandleRequest): Promise<RpcResponse>;
  /** 独自描画のモジュール（Web モードでは、そのプロジェクトを開ける利用者だけ）。 */
  rendererModule(req: { projectId: string; id: string; user?: AuthUser }): Promise<{ source: string; hash: string; contentType: "text/javascript" } | undefined>;
  readonly admin: AdminApi;
  close(): Promise<void>;
}

export async function openServerRuntime(opts: ServerRuntimeOptions): Promise<ServerRuntime> {
  const env = opts.env ?? process.env;
  const mode = opts.mode;
  if (mode !== "local" && mode !== "web") throw new Error(`モードは "local" か "web" にしてください（"${String(mode)}"）。`);
  const config = opts.config ?? (mode === "web" ? loadServerConfig(serverConfigPath(env, opts.dataDir), env) : undefined);

  let serverDb: Store | undefined;
  let auth: AuthService | undefined;
  if (mode === "web") {
    const dbUserName = (): string => "server";
    serverDb =
      config!.serverDb.driver === "postgres"
        ? await openPostgres({
            url: config!.serverDb.url,
            userName: dbUserName,
            ...(config!.serverDb.schema ? { schema: config!.serverDb.schema } : {}),
            ...(opts.now ? { now: opts.now } : {}),
          })
        : await openStore({ path: config!.serverDb.path, userName: dbUserName, ...(opts.now ? { now: opts.now } : {}) });
    const a = config!.auth;
    let proxySecret: string | undefined;
    if (a.proxySecretEnv !== undefined) {
      proxySecret = env[a.proxySecretEnv];
      // 合言葉を設定したのに値がないときは、名前のヘッダーだけを信じることになるので開かない。
      if (!proxySecret) throw new Error(`auth.proxySecretEnv の環境変数 ${a.proxySecretEnv} が設定されていません。`);
    }
    auth = openAuthService({
      db: serverDb,
      config: {
        mode: a.mode,
        sessionTtlHours: a.sessionTtlHours,
        ...(a.sessionMaxHours !== undefined ? { sessionMaxHours: a.sessionMaxHours } : {}),
        proxyHeader: a.proxyHeader,
        ...(a.proxySecretHeader !== undefined ? { proxySecretHeader: a.proxySecretHeader } : {}),
        ...(proxySecret !== undefined ? { proxySecret } : {}),
        admins: a.admins,
      },
      ...(opts.now ? { now: opts.now } : {}),
    });
    const adminUser = env["LOC_STUDIO_ADMIN_USER"];
    const adminPassword = env["LOC_STUDIO_ADMIN_PASSWORD"];
    if (a.mode === "password" && adminUser && adminPassword) {
      await auth.bootstrapAdmin({ name: adminUser, password: adminPassword });
    }
    // 最初の管理者のパスワードを、プラグインなどから読めるところに残さない。
    delete env["LOC_STUDIO_ADMIN_PASSWORD"];
    delete env["LOC_STUDIO_ADMIN_USER"];
  }

  const workspaces = new Map<string, Promise<Workspace>>();
  let closed = false;

  const projectOf = (projectId: string): ServerProject => {
    const p = config?.projects.find((x) => x.id === projectId);
    if (p) return p;
    // ローカルモードでは、設定にないプロジェクトはフォルダのパスとして開く（従来の画面の使い方）。
    if (mode === "local" && typeof projectId === "string" && path.isAbsolute(projectId)) return { id: projectId, name: path.basename(projectId), root: projectId };
    throw new ApiError("not-found", `プロジェクト "${String(projectId)}" はありません。`);
  };

  function workspace(projectId: string): Promise<Workspace> {
    if (closed) return Promise.reject(new ApiError("failed", "サーバーは閉じられています。"));
    const project = projectOf(projectId);
    let ws = workspaces.get(project.id);
    if (!ws) {
      const options: WorkspaceOptions = {
        projectRoot: project.root,
        env,
        ...(opts.appDir !== undefined ? { appDir: opts.appDir } : {}),
        ...(opts.sdkPath !== undefined ? { sdkPath: opts.sdkPath } : {}),
        ...(opts.extraBuiltins ? { extraBuiltins: opts.extraBuiltins } : {}),
        ...(mode === "web"
          ? {
              // サーバーに置いたプロジェクトとアプリのプラグインは管理者が置いたもの。個人のフォルダは使わない。
              userDataDir: path.join(opts.dataDir, "workspaces", project.id),
              pluginTrust: "always" as const,
              localPlugins: false,
              userSettings: auth!.userSettingsStore(),
              webMode: {
                allowedEnv: project.env ?? [],
                pluginDirRoots: [project.root, ...(opts.appDir !== undefined ? [opts.appDir] : [])],
                sensitivePaths: [opts.dataDir, ...(config?.serverDb.driver === "sqlite" ? [config.serverDb.path] : [])],
              },
            }
          : { userDataDir: opts.dataDir }),
        ...(opts.workspaceOptions ?? {}),
      };
      ws = createWorkspace(options);
      workspaces.set(project.id, ws);
      // 開けなかったら次の呼び出しでやり直せるよう、覚えたものを捨てる。
      ws.catch(() => {
        if (workspaces.get(project.id) === ws) workspaces.delete(project.id);
      });
    }
    return ws;
  }

  async function callFor(projectId: string, user: AuthUser | undefined) {
    if (mode === "local") return undefined;
    if (!user) throw new ApiError("unauthorized", "ログインしてください。");
    projectOf(projectId);
    const call = await auth!.callContextFor(user, projectId);
    if (!call) throw new ApiError("forbidden", `プロジェクト "${projectId}" を開く権限がありません。`);
    return call;
  }

  async function requireAdmin(actor: AuthUser | undefined): Promise<AuthService> {
    if (mode !== "web" || !auth) throw new ApiError("forbidden", "利用者の管理は Web モードだけでできます。");
    if (!actor) throw new ApiError("unauthorized", "ログインしてください。");
    // 渡された利用者の情報が古くても、いまの DB で管理者かどうかを確かめる。
    const current = await auth.getUser(actor.name);
    if (!current || current.disabled || !current.admin) throw new ApiError("forbidden", "管理者だけができる操作です。");
    return auth;
  }

  const admin: AdminApi = {
    listUsers: async (actor) => (await requireAdmin(actor)).listUsers(),
    createUser: async (actor, input) => (await requireAdmin(actor)).createUser(input),
    async updateUser(actor, name, patch) {
      const a = await requireAdmin(actor);
      // 自分を管理者から外したり無効にしたりして、誰も管理できなくなるのを防ぐ。
      if (name === actor.name && (patch.admin === false || patch.disabled === true)) {
        throw new ApiError("invalid", "自分自身を管理者から外したり、無効にしたりはできません。");
      }
      return a.updateUser(name, patch);
    },
    setPassword: async (actor, name, password) => (await requireAdmin(actor)).setPassword(name, password),
    async deleteUser(actor, name) {
      const a = await requireAdmin(actor);
      if (name === actor.name) throw new ApiError("invalid", "自分自身は削除できません。");
      return a.deleteUser(name);
    },
    listMemberships: async (actor, projectId) => (await requireAdmin(actor)).listMemberships(projectId !== undefined ? { projectId } : {}),
    async setMembership(actor, projectId, user, m) {
      const a = await requireAdmin(actor);
      projectOf(projectId);
      return a.setMembership(projectId, user, m);
    },
    removeMembership: async (actor, projectId, user) => (await requireAdmin(actor)).removeMembership(projectId, user),
  };

  return {
    mode,
    config,
    auth,
    async projects(user) {
      const all = config?.projects ?? [];
      if (mode === "local") return all.map((p) => ({ id: p.id, name: p.name }));
      if (!user) throw new ApiError("unauthorized", "ログインしてください。");
      const out: ProjectSummary[] = [];
      for (const p of all) {
        const call = await auth!.callContextFor(user, p.id);
        if (!call) continue;
        const s: ProjectSummary = { id: p.id, name: p.name, role: call.role };
        if (call.languages) s.languages = call.languages;
        out.push(s);
      }
      return out;
    },
    workspace,
    async handle(req) {
      try {
        const call = await callFor(req.projectId, req.user);
        const ws = await workspace(req.projectId);
        return dispatch(ws, req.method, req.params, call);
      } catch (err) {
        // ワークスペースを開けないなどの内部のエラーは、管理者でない利用者には伏せる。
        const e = toRpcError(err);
        return { error: mode === "web" && !req.user?.admin ? redactError(e, { paths: [], log: (m) => console.error(m) }, req.method) : e };
      }
    },
    async rendererModule(req) {
      try {
        await callFor(req.projectId, req.user);
        return (await workspace(req.projectId)).rendererModule(req.id);
      } catch {
        return undefined;
      }
    },
    admin,
    async close() {
      if (closed) return;
      closed = true;
      for (const p of workspaces.values()) {
        const ws = await p.catch(() => undefined);
        await ws?.close();
      }
      workspaces.clear();
      serverDb?.close();
    },
  };
}
