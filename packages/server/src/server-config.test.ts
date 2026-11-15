import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadServerConfig, parseServerConfig, serverConfigPath } from "./server-config.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-srvcfg-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("サーバーの設定", () => {
  it("既定値、相対パスの解決、${env:NAME} の展開", async () => {
    const file = path.join(tmp, "server.json");
    await writeFile(
      file,
      JSON.stringify({
        projects: [{ id: "mygame", name: "MyGame", root: "games/${env:GAME}" }, { id: "b", root: "/abs/b" }],
        auth: { admins: ["alice"] },
      }),
    );
    const c = loadServerConfig(file, { GAME: "mygame" });
    expect(c.projects).toEqual([
      { id: "mygame", name: "MyGame", root: path.join(tmp, "games", "mygame"), env: [] },
      { id: "b", name: "b", root: path.resolve("/abs/b"), env: [] },
    ]);
    expect(c.auth).toEqual({ mode: "password", sessionTtlHours: 168, sessionMaxHours: 720, proxyHeader: "x-forwarded-user", admins: ["alice"], trustedProxyHops: 0 });
    expect(c.serverDb).toEqual({ driver: "sqlite", path: path.join(tmp, "server.db") });

    const pg = parseServerConfig(
      { projects: [], auth: { mode: "proxy", proxyHeader: "X-Remote-User" }, serverDb: { driver: "postgres", url: "${env:PG}", schema: "loc" } },
      { baseDir: tmp, env: { PG: "postgres://u:secret@h/db" } },
    );
    expect(pg.serverDb).toEqual({ driver: "postgres", url: "postgres://u:secret@h/db", schema: "loc" });
    expect(pg.auth.proxyHeader).toBe("x-remote-user");
  });

  it("問題をまとめて出す", () => {
    let message = "";
    try {
      parseServerConfig(
        {
          projects: [{ id: "a b", root: "/x" }, { id: "a", root: "" }, { id: "c", root: "/c" }, { id: "c", root: "/c2" }],
          auth: { mode: "magic", sessionTtlHours: -1, admins: [1] },
          serverDb: { driver: "mysql" },
        },
        { baseDir: tmp, env: {}, where: "テスト" },
      );
    } catch (err) {
      message = (err as Error).message;
    }
    for (const part of ["テスト", "projects[0].id", "projects[1].root", '"c" が重複', "auth.mode", "sessionTtlHours", "auth.admins", "serverDb.driver"]) {
      expect(message).toContain(part);
    }
    expect(() => parseServerConfig({ projects: [], serverDb: { driver: "postgres", url: "${env:NOPE}" } }, { baseDir: tmp, env: {} })).toThrow(/NOPE/);
    expect(() => parseServerConfig([], { baseDir: tmp, env: {} })).toThrow(/オブジェクト/);
  });

  it("ファイルが読めない・壊れている", async () => {
    expect(() => loadServerConfig(path.join(tmp, "none.json"))).toThrow(/読めませんでした/);
    await writeFile(path.join(tmp, "bad.json"), "{");
    expect(() => loadServerConfig(path.join(tmp, "bad.json"))).toThrow(/壊れています/);
  });

  it("設定ファイルの場所", () => {
    expect(serverConfigPath({ LOC_STUDIO_SERVER_CONFIG: "/etc/loc.json" }, tmp)).toBe("/etc/loc.json");
    expect(serverConfigPath({ LOC_STUDIO_USER_DATA_DIR: "/data" }, tmp)).toBe(path.join("/data", "server.json"));
    expect(serverConfigPath({}, tmp)).toBe(path.join(tmp, "server.json"));
  });
});
