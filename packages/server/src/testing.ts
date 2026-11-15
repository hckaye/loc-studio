/**
 * テスト用の補助（公開 API ではない。index.ts からは出さない）。
 * サンプルのプロジェクトを一時フォルダに写して使い、元は変えない。
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@loc-studio/sdk";
import type { Workspace, WorkspaceOptions } from "./api-types.js";
import { createWorkspace } from "./workspace.js";

export const SAMPLE_PROJECT = fileURLToPath(new URL("../../../examples/sample-project", import.meta.url));
export const SDK_PATH = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));

export const CHAPTER = "Assets/Text/chapter01.csv";
export const UI = "Assets/Text/system/ui.csv";

export interface TestProject {
  tmp: string;
  root: string;
  userDataDir: string;
  /** 開いたワークスペース（cleanup で閉じる）。 */
  open(extra?: Partial<WorkspaceOptions>): Promise<Workspace>;
  /** プロジェクト設定の JSON を書き換える。 */
  patchConfig(patch: Record<string, unknown>): Promise<void>;
  read(rel: string): Promise<string>;
  write(rel: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeTestProject(opts: { sample?: boolean; user?: string; plugins?: Plugin[] } = {}): Promise<TestProject> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "loc-server-"));
  const root = path.join(tmp, "proj");
  const userDataDir = path.join(tmp, "user");
  await mkdir(userDataDir, { recursive: true });
  if (opts.sample !== false) await cp(SAMPLE_PROJECT, root, { recursive: true });
  else await mkdir(root, { recursive: true });
  await writeFile(path.join(userDataDir, "settings.json"), JSON.stringify({ "user.name": opts.user ?? "tester" }));
  const opened: Workspace[] = [];
  const abs = (rel: string): string => path.join(root, ...rel.split("/"));
  return {
    tmp,
    root,
    userDataDir,
    async open(extra = {}) {
      const ws = await createWorkspace({
        projectRoot: root,
        userDataDir,
        env: {},
        sdkPath: SDK_PATH,
        // テストでは外部の変更をすぐ見られるよう、版を毎回確かめる。
        revisionCheckIntervalMs: 0,
        // サンプルのプラグインフォルダを使うので、信頼を扱うテスト以外は確認なしで読み込む。
        pluginTrust: "always",
        ...(opts.plugins ? { extraBuiltins: opts.plugins } : {}),
        ...extra,
      });
      opened.push(ws);
      return ws;
    },
    async patchConfig(patch) {
      const file = path.join(root, "loc-studio.project.json");
      const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete config[k];
        else config[k] = v;
      }
      await writeFile(file, JSON.stringify(config, null, 2));
    },
    read: (rel) => readFile(abs(rel), "utf8"),
    async write(rel, content) {
      await mkdir(path.dirname(abs(rel)), { recursive: true });
      await writeFile(abs(rel), content);
    },
    async cleanup() {
      for (const ws of opened) await ws.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * 確認のモードで開いたワークスペースの、プロジェクトの設定ファイル（kind: "settings"）を信頼する。
 * 設定ファイルの信頼が主題でないテストで、プラグインやコードの設定の信頼だけを確かめるときに使う。
 */
export async function trustSettings(ws: Workspace): Promise<void> {
  const item = (await ws.plugins()).untrusted.find((u) => u.kind === "settings");
  if (item) await ws.trustPlugins({ items: [{ path: item.path, hash: item.hash }] });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
