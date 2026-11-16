/**
 * 制限された状態のワークスペース。コードの設定（loc-studio.config.ts など）を信頼していないため、
 * JSON の設定だけでは開けないときに使う。DB もプラグインも開かず、コードも実行しない。
 * 画面が確認を出せるよう、info / plugins / settings / trustPlugins / untrustPlugins / reloadPlugins だけを受け付ける。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ROLES, localSettingsPath, PROJECT_CONFIG_JSON, readLocalSettings, resolveSetting } from "@loc-studio/core";
import type { SettingsLayers, UntrustedConfigError } from "@loc-studio/core";
import type { ProjectConfig } from "@loc-studio/sdk";
import { ApiError, WORKSPACE_METHODS } from "./api-types.js";
import type { ProjectInfo, SettingInfo, Workspace, WorkspaceOptions } from "./api-types.js";
import { currentCall, runWithCall } from "./call-context.js";
import { errorText } from "./context.js";
import { permissionsFor, roleList } from "./permissions.js";
import { APP_SETTING_DEFAULTS } from "./settings-api.js";
import { requireItems, requirePaths, untrustedInfo, verifyItems, writeTrustFile } from "./trust.js";
import { sensitivePathsOf } from "./workspace.js";

/** 制限された状態で使えるメソッド。 */
const ALLOWED = new Set<string>(["info", "plugins", "settings", "trustPlugins", "untrustPlugins", "reloadPlugins"]);

export async function openRestricted(
  opts: WorkspaceOptions,
  error: UntrustedConfigError,
  reopen: () => Promise<Workspace>,
): Promise<Workspace & { reopened?: Workspace }> {
  const env = opts.env ?? process.env;
  const root = path.resolve(opts.projectRoot);
  const localFile = opts.userDataDir !== undefined ? path.join(path.resolve(opts.userDataDir), "settings.json") : localSettingsPath(env);
  const userDataDir = path.resolve(opts.userDataDir ?? path.dirname(localFile));
  const jsonFile = path.join(root, PROJECT_CONFIG_JSON);
  let local = await readLocalSettings(localFile);
  const candidates = [...error.candidates];
  const warnings = [error.message];
  let closed = false;

  const layers = (): SettingsLayers => ({ local, app: APP_SETTING_DEFAULTS });
  const message = `プロジェクトの${candidates.length > 0 ? candidates.map((c) => (c.kind === "settings" ? "設定ファイル" : "コードの設定")).join("と") : "コードの設定"}を確認して信頼するまで、この操作はできません。`;

  async function rawJson(): Promise<ProjectConfig> {
    if (!existsSync(jsonFile)) return { languages: [] };
    try {
      const v: unknown = JSON.parse(await readFile(jsonFile, "utf8"));
      return v && typeof v === "object" && !Array.isArray(v) ? (v as ProjectConfig) : { languages: [] };
    } catch {
      return { languages: [] };
    }
  }

  function localList(): SettingInfo[] {
    const keys = new Set(Object.keys(local).filter((k) => k !== "plugins.trust"));
    for (const k of Object.keys(APP_SETTING_DEFAULTS)) keys.add(k);
    const out: SettingInfo[] = [];
    for (const key of [...keys].sort()) {
      const r = resolveSetting(key, layers());
      if (r) out.push({ key, value: key.startsWith("secrets.") ? "********" : r.value, source: r.source, locked: r.locked });
    }
    return out;
  }

  async function info(): Promise<ProjectInfo> {
    const json = await rawJson();
    return {
      name: typeof json.name === "string" ? json.name : path.basename(root),
      root,
      languages: [],
      columns: [],
      languageSets: {},
      grid: { pinCommon: true, maxPinnedRatio: 0.6, progressUnit: "rows" },
      editor: { referenceLanguages: [], count: { unit: "codepoints", skipTokens: false } },
      user: { name: "", source: "app", locked: false },
      storage: { path: "", shared: false },
      actions: [],
      reviewTargets: [],
      validators: [],
      blockComplete: false,
      warnings: [...warnings],
      pluginErrors: [],
      untrustedPlugins: candidates.length,
      restricted: true,
      changeSeq: 0,
      localSettings: Object.fromEntries(localList().map((s) => [s.key, s.value])),
      permissions: permissionsFor(currentCall()),
      roles: roleList(DEFAULT_ROLES),
      renderers: [],
    };
  }

  const self = {} as Record<string, unknown>;
  for (const m of WORKSPACE_METHODS) {
    if (!ALLOWED.has(m)) {
      self[m] = async () => {
        throw new ApiError("untrusted", message);
      };
    }
  }

  /** 信頼を変えたあと、普通の状態で開けるか試す（開けたら reopened に置き、外側が切り替える）。 */
  async function tryReopen(): Promise<void> {
    const next = await reopen();
    if (!next.restricted) ws.reopened = next;
    else {
      // まだ制限された状態（別の理由）。新しい状態の警告を出すため、そちらに切り替える。
      ws.reopened = next;
    }
  }

  const ws = Object.assign(self, {
    info,
    async plugins() {
      return { plugins: [], dirs: [], errors: [], warnings: [...warnings], untrusted: untrustedInfo(candidates) };
    },
    async settings() {
      return {
        local: localList(),
        localFile: currentCall() ? "" : localFile,
        project: await rawJson(),
        projectFromCode: [],
        projectFile: jsonFile,
        available: { columns: [], validators: [] },
      };
    },
    async trustPlugins(params: { items: { path: string; hash: string }[] }) {
      const items = requireItems(params);
      const hashes = await verifyItems(root, candidates, items);
      try {
        local = await writeTrustFile(localFile, root, (forRoot) => Object.assign(forRoot, hashes));
      } catch (err) {
        throw new ApiError("failed", errorText(err));
      }
      await tryReopen();
      return info();
    },
    async untrustPlugins(params: { paths: string[] }) {
      const paths = requirePaths(params);
      local = await writeTrustFile(localFile, root, (forRoot) => {
        for (const p of paths) delete forRoot[p];
      });
      return info();
    },
    async reloadPlugins() {
      await tryReopen();
      return info();
    },
    restricted: true as const,
    async waitForJob(): Promise<never> {
      throw new ApiError("untrusted", message);
    },
    async rendererModule() {
      return undefined;
    },
    withCall<T>(call: Parameters<Workspace["withCall"]>[0], fn: () => Promise<T>): Promise<T> {
      return runWithCall({ call }, fn);
    },
    // 設定を信頼するまでは、同梱の役割だけで確かめる。
    roles: () => DEFAULT_ROLES,
    redaction: () => ({ paths: sensitivePathsOf(opts, { root, userDataDir, localFile }), log: (m: string) => console.error(m) }),
    async close() {
      closed = true;
    },
    reopened: undefined as Workspace | undefined,
  });
  // Object.assign は getter を評価してしまうので、project は別に定義する。
  Object.defineProperty(ws, "project", {
    get() {
      throw new ApiError("untrusted", message);
    },
  });
  void closed;
  return ws as unknown as Workspace & { reopened?: Workspace };
}
