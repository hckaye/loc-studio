/**
 * プロジェクトの共有 DB とサーバーの DB を Postgres にする（使い捨てのクラスタか LOC_STUDIO_TEST_PG_URL があるときだけ動く）。
 */
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startTestPg } from "../../store/src/testing/pg-server.js";
import { openServerRuntime } from "./runtime.js";
import { maskUrl } from "./pg-store.js";
import { makeTestProject, SDK_PATH, UI } from "./testing.js";

const server = await startTestPg();
const url = server.url;
const skipReason = "skipReason" in server ? server.skipReason : undefined;
if (skipReason) console.warn(skipReason);
const schemas: string[] = [];
const newSchema = (): string => {
  const s = `loc_server_test_${process.pid}_${schemas.length}_${Date.now() % 100000}`;
  schemas.push(s);
  return s;
};
afterAll(async () => {
  if (url && schemas.length > 0) {
    try {
      const pg = (await import("pg")).default;
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      for (const s of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      await pool.end();
    } catch (err) {
      console.warn(`テスト用のスキーマを消せませんでした: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if ("stop" in server) await server.stop();
});

describe.skipIf(!url)("Postgres", () => {
  it("storage.driver: postgres でプロジェクトの共有 DB を開き、開き直しても値が残る", async () => {
    const tp = await makeTestProject();
    try {
      const schema = newSchema();
      await tp.patchConfig({ storage: { driver: "postgres", url: "${env:TEST_PG_URL}", schema } });
      const env = { TEST_PG_URL: url! };
      const ws = await tp.open({ env });
      const info = await ws.info();
      expect(info.storage).toEqual({ path: maskUrl(url!), shared: true });
      await ws.setCell({ resourceId: UI, key: "UI_OK", cellId: "textStatus@ko", value: "done" });
      await ws.postReview({ resourceId: UI, key: "UI_OK", cellId: "reviewStatus@ko", verdict: "ok", comment: "" });
      await ws.close();
      const ws2 = await tp.open({ env });
      const d = await ws2.rowDetail({ resourceId: UI, key: "UI_OK" });
      expect(d.row.cells["textStatus@ko"]).toMatchObject({ value: "done", version: 1, updatedBy: "tester" });
      expect(d.row.cells["reviewStatus@ko"]!.value).toBe("ok");
      expect((await ws2.history({ resourceId: UI, key: "UI_OK" })).length).toBe(2);
    } finally {
      await tp.cleanup();
    }
  });

  it("サーバーの DB（アカウントなど）を Postgres に置く", async () => {
    const tp = await makeTestProject();
    const rt = await openServerRuntime({
      mode: "web",
      dataDir: path.join(tp.tmp, "data"),
      env: { LOC_STUDIO_ADMIN_USER: "root", LOC_STUDIO_ADMIN_PASSWORD: "root-password" },
      config: {
        projects: [{ id: "p", name: "P", root: tp.root }],
        auth: { mode: "password", sessionTtlHours: 1, proxyHeader: "x-forwarded-user", admins: [] },
        serverDb: { driver: "postgres", url: url!, schema: newSchema() },
      },
      sdkPath: SDK_PATH,
    });
    try {
      const { token } = await rt.auth!.login({ name: "root", password: "root-password", clientAddress: "127.0.0.1" });
      const root = (await rt.auth!.authenticate(token))!;
      const r = await rt.handle({ projectId: "p", method: "setCell", params: { resourceId: UI, key: "UI_OK", cellId: "textStatus@ja", value: "wip" }, user: root });
      expect(r).toMatchObject({ result: { updatedBy: "root" } });
    } finally {
      await rt.close();
      await tp.cleanup();
    }
  });
});

describe.skipIf(!!url)("Postgres（使えないとき）", () => {
  it.skip(`Postgres のテストを飛ばしました: ${skipReason ?? ""}`, () => undefined);
});
