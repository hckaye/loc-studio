/**
 * examples/remote-project が、ローカルにリソースのファイルを持たず、API だけで端から端まで動くこと。
 * モック API はこのプロセスの中で起動し、プロジェクトは一時フォルダに写して使う（元は変えない）。
 */
import { cp, mkdtemp, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "./api-types.js";
import type { Workspace } from "./api-types.js";
import { SDK_PATH } from "./testing.js";
import { createWorkspace } from "./workspace.js";

const EXAMPLE = fileURLToPath(new URL("../../../examples/remote-project", import.meta.url));
const TOKEN = "test-token";
const SECRET_ENV = "LOC_STUDIO_SECRET_EXAMPLE_APITOKEN";

interface MockApi {
  url: string;
  requests: string[];
  failNext(method: string, pathPrefix: string, status: number, count?: number): void;
  close(): Promise<void>;
}
let api: MockApi;
let tmp: string;
let root: string;
let ws: Workspace | undefined;

const authed = (extra: Record<string, string> = {}): Record<string, string> => ({ authorization: `Bearer ${TOKEN}`, ...extra });
const getJson = async (p: string): Promise<any> => (await fetch(`${api.url}${p}`, { headers: authed() })).json();

async function open(token: string = TOKEN, extra: { revisionCheckIntervalMs?: number } = {}): Promise<Workspace> {
  ws = await createWorkspace({
    ...extra,
    projectRoot: root,
    userDataDir: path.join(tmp, "user"),
    env: { EXAMPLE_API_URL: api.url, [SECRET_ENV]: token },
    sdkPath: SDK_PATH,
    pluginTrust: "always",
  });
  return ws;
}

beforeAll(async () => {
  const mod = (await import(pathToFileURL(path.join(EXAMPLE, "mock-api", "server.mjs")).href)) as {
    startMockApi(o: { port: number; token: string }): Promise<MockApi>;
  };
  api = await mod.startMockApi({ port: 0, token: TOKEN });
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  await fetch(`${api.url}/reset`, { method: "POST", headers: authed() });
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-remote-"));
  root = path.join(tmp, "proj");
  await cp(EXAMPLE, root, { recursive: true });
  await mkdir(path.join(tmp, "user"), { recursive: true });
  await writeFile(path.join(tmp, "user", "settings.json"), JSON.stringify({ "user.name": "tester" }));
});
afterEach(async () => {
  await ws?.close();
  ws = undefined;
  await rm(tmp, { recursive: true, force: true });
});

const rowsOf = (w: Workspace, resourceId: string, languages = ["ja", "en"]) => w.rows({ resourceId, languages, offset: 0, limit: 50 });

describe("remote-project（API だけのプロジェクト）", () => {
  it("tree と rows が API から来る", async () => {
    const w = await open();
    const tree = await w.tree();
    expect(tree.map((n) => [n.name, n.kind])).toEqual([
      ["quests", "folder"],
      ["ui", "folder"],
    ]);
    expect(tree[0]!.children!.map((c) => c.id)).toEqual(["quests/main"]);

    const r = await rowsOf(w, "quests/main");
    expect(r.rows.map((x) => x.key)).toEqual(["q1.title", "q1.body", "q2.title"]);
    expect(r.rows[0]!.cells["text@en"]!.value).toBe("Morning of Departure");
    expect(r.revision).toBeTruthy();
  });

  it("setText + save は API に書き、プロジェクトのフォルダにリソースを作らない", async () => {
    const before = (await readdir(root)).sort();
    const w = await open();
    await w.setText({ resourceId: "ui/common", key: "ok", language: "en", value: "Okay" });
    expect(await w.save({ resourceId: "ui/common" })).toEqual({ saved: 1, conflicts: [] });
    const doc = await getJson("/resources/ui/common");
    expect(doc.entries.find((e: any) => e.key === "ok").texts.en).toBe("Okay");
    expect(doc.entries.find((e: any) => e.key === "cancel").texts.en).toBe("Cancel");
    // 保存のあと、新しい版で読み直せている。
    const r = await rowsOf(w, "ui/common");
    expect(r.rows[0]!.cells["text@en"]!.value).toBe("Okay");
    await w.close();
    ws = undefined;
    // 増えたのは共有 DB のフォルダだけ（リソースのファイルは作られない）。
    expect((await readdir(root)).sort()).toEqual([...before, ".loc-studio"].sort());
  });

  it("API 側で別のセルが変わっていたら、読み直して当て直す（上書きしない）", async () => {
    const w = await open();
    await rowsOf(w, "ui/common");
    await w.setText({ resourceId: "ui/common", key: "ok", language: "en", value: "Okay" });
    // 読み込みのあと、保存の前に、別の人が別のセルを書いた。
    const cur = await getJson("/resources/ui/common");
    cur.entries.find((e: any) => e.key === "cancel").texts.en = "Abort";
    expect((await fetch(`${api.url}/resources/ui/common`, { method: "PUT", headers: authed(), body: JSON.stringify(cur) })).status).toBe(200);

    expect(await w.save({ resourceId: "ui/common" })).toEqual({ saved: 1, conflicts: [] });
    const doc = await getJson("/resources/ui/common");
    expect(doc.entries.find((e: any) => e.key === "ok").texts.en).toBe("Okay");
    expect(doc.entries.find((e: any) => e.key === "cancel").texts.en).toBe("Abort");
  });

  it("API 側で同じセルが変わっていたら、競合として書かずに残す", async () => {
    const w = await open();
    await rowsOf(w, "ui/common");
    await w.setText({ resourceId: "ui/common", key: "ok", language: "en", value: "Okay" });
    const cur = await getJson("/resources/ui/common");
    cur.entries.find((e: any) => e.key === "ok").texts.en = "Fine";
    await fetch(`${api.url}/resources/ui/common`, { method: "PUT", headers: authed(), body: JSON.stringify(cur) });

    expect(await w.save({ resourceId: "ui/common" })).toEqual({ saved: 0, conflicts: [{ key: "ok", language: "en" }] });
    const doc = await getJson("/resources/ui/common");
    expect(doc.entries.find((e: any) => e.key === "ok").texts.en).toBe("Fine");
  });

  it("ステータス列は API に保存され、組み込みの DB には入らない。版の不一致は conflict", async () => {
    const w = await open();
    const c = await w.setCell({ resourceId: "quests/main", key: "q1.title", cellId: "textStatus@en", value: "wip" });
    expect(c).toMatchObject({ value: "wip", version: 1 });
    const remote = await getJson("/status?resource=quests/main");
    expect(remote).toHaveLength(1);
    expect(remote[0]).toMatchObject({ entryKey: "q1.title", columnId: "textStatus", language: "en", value: "wip", version: 1 });
    expect(remote[0].basisHash).toBeTruthy();

    // rows もその値を API から読む。
    const r = await rowsOf(w, "quests/main");
    expect(r.rows[0]!.cells["textStatus@en"]).toMatchObject({ value: "wip", version: 1 });

    // 組み込みの DB（共有 DB）には、この列のセルがない。
    const inDb = await w.project.host.db.cells("builtin.db").query({ resourceId: "quests/main" });
    expect(inDb.filter((x) => x.columnId === "textStatus")).toEqual([]);

    // 古い版で書くと conflict。
    const err = await w
      .setCell({ resourceId: "quests/main", key: "q1.title", cellId: "textStatus@en", value: "done", expectedVersion: 0 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("conflict");
    expect((await getJson("/status?resource=quests/main"))[0].value).toBe("wip");

    // 合う版なら通る。
    const ok = await w.setCell({ resourceId: "quests/main", key: "q1.title", cellId: "textStatus@en", value: "done", expectedVersion: 1 });
    expect(ok).toMatchObject({ value: "done", version: 2 });
  });

  it("レビュー列は組み込みの出所のまま動く", async () => {
    const w = await open();
    const post = await w.postReview({ resourceId: "quests/main", key: "q1.title", cellId: "reviewStatus@en", verdict: "ok", comment: "よい" });
    expect(post.verdict).toBe("ok");
    const r = await rowsOf(w, "quests/main");
    expect(r.rows[0]!.cells["reviewStatus@en"]!.value).toBe("ok");
    // API の /status には何も行かない。
    expect(await getJson("/status?resource=quests/main")).toEqual([]);
  });

  for (const status of [401, 503]) {
    it(`書き込みが HTTP ${status} なら、やり直さずに 1 回で失敗を伝え、ドラフトを残す`, async () => {
      const w = await open();
      await w.setText({ resourceId: "ui/common", key: "ok", language: "en", value: "Okay" });
      api.requests.length = 0;
      api.failNext("PUT", "/resources/", status);
      const err = await w.save({ resourceId: "ui/common" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("failed");
      expect((err as ApiError).message).toContain(`HTTP ${status}`);
      expect(api.requests.filter((r) => r.startsWith("PUT "))).toHaveLength(1);
      expect((await w.tree()).find((n) => n.name === "ui")!.unsaved).toBe(1);
      // 直れば同じドラフトで保存できる。
      expect(await w.save({ resourceId: "ui/common" })).toEqual({ saved: 1, conflicts: [] });
      expect((await getJson("/resources/ui/common")).entries[0].texts.en).toBe("Okay");
    });
  }

  it("書き込みが HTTP 412 なら、読み直して当て直す", async () => {
    const w = await open();
    await w.setText({ resourceId: "ui/common", key: "ok", language: "en", value: "Okay" });
    api.requests.length = 0;
    api.failNext("PUT", "/resources/", 412);
    expect(await w.save({ resourceId: "ui/common" })).toEqual({ saved: 1, conflicts: [] });
    const resourceCalls = api.requests.filter((r) => r.includes("/resources/ui"));
    expect(resourceCalls.slice(0, 4)).toEqual([
      "GET /resources/ui/common",
      "PUT /resources/ui/common",
      "GET /resources/ui/common",
      "PUT /resources/ui/common",
    ]);
    expect((await getJson("/resources/ui/common")).entries[0].texts.en).toBe("Okay");
  });

  it("間隔の間は rows を何度呼んでも版の確認（HEAD）をしない。間隔 0 なら毎回確かめる", async () => {
    const w = await open(TOKEN); // 既定の間隔（3000 ms）
    api.requests.length = 0;
    for (let i = 0; i < 5; i++) await rowsOf(w, "ui/common");
    await w.rowDetail({ resourceId: "ui/common", key: "ok" });
    expect(api.requests.filter((r) => r === "GET /resources/ui/common")).toHaveLength(1);
    expect(api.requests.filter((r) => r.startsWith("HEAD "))).toEqual([]);
    await w.close();

    const eager = await open(TOKEN, { revisionCheckIntervalMs: 0 });
    api.requests.length = 0;
    for (let i = 0; i < 3; i++) await rowsOf(eager, "ui/common");
    expect(api.requests.filter((r) => r === "GET /resources/ui/common")).toHaveLength(1);
    expect(api.requests.filter((r) => r === "HEAD /resources/ui/common")).toHaveLength(2);
  });

  it("トークンが違うと、トークンを含まない読める失敗になる", async () => {
    const w = await open("wrong-token");
    const err = await w.tree().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("HTTP 401");
    expect(message).toContain(api.url);
    expect(message).not.toContain("wrong-token");
  });
});
