import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreConflictError } from "@loc-studio/sdk";
import { openStore } from "./index.js";
import { defineStoreContract, ref } from "./testing/store-contract.js";
import type { OpenStoreOptions, Store } from "./index.js";

let dir: string;
let dbPath: string;
const opened: Store[] = [];
let user = "alice";

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "loc-store-"));
  dbPath = path.join(dir, "sub", "db.sqlite");
  user = "alice";
});

afterEach(async () => {
  for (const s of opened.splice(0)) s.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function open(over: Partial<OpenStoreOptions> = {}): Promise<Store> {
  const s = await openStore({ path: dbPath, userName: () => user, hostName: "test-host", ...over });
  opened.push(s);
  return s;
}

const sharing = { mode: "lockfile" as const, retryDelayMs: 5, waitMs: 20000 };

defineStoreContract("SQLite（通常モード）", {
  fresh: async () => undefined,
  open: (o) => openStore({ path: dbPath, hostName: "test-host", ...o }),
  cleanup: async () => undefined,
});

defineStoreContract("SQLite（共有モード）", {
  fresh: async () => undefined,
  open: (o) => openStore({ path: dbPath, hostName: "test-host", sharing, ...o }),
  cleanup: async () => undefined,
});

describe("SQLite 固有", () => {
  it("通常モードは WAL", async () => {
    const s = await open();
    await s.kv("ns").set("k", 1);
    s.close();
    const db = new DatabaseSync(dbPath);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    db.close();
  });

  it("backup と integrityCheck", async () => {
    const s = await open();
    await s.cells("ns").set([{ ...ref("a"), value: "copied" }]);
    expect(await s.integrityCheck()).toEqual([]);
    const target = path.join(dir, "backups", "copy.sqlite");
    await s.backup(target);
    await s.cells("ns").set([{ ...ref("a"), value: "later" }]);
    await s.backup(target); // 既存のファイルを置き換える
    const copy = await open({ path: target });
    expect((await copy.cells("ns").get([ref("a")]))[0]?.value).toBe("later");
    expect(await copy.integrityCheck()).toEqual([]);
    expect((await fs.readdir(path.dirname(target))).filter((n) => n.includes(".tmp-"))).toEqual([]);
    await expect(s.backup(dbPath)).rejects.toThrow(/同じ/);
  });

  it(":memory: でも動く", async () => {
    const s = await open({ path: ":memory:" });
    await s.cells("ns").set([{ ...ref("a"), value: 1 }]);
    expect((await s.cells("ns").get([ref("a")]))[0]?.value).toBe(1);
    expect(s.path).toBe(":memory:");
  });

  it("新しすぎるスキーマの版は開かない", async () => {
    const s = await open();
    s.close();
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE meta SET value = 999 WHERE key = 'schema_version'");
    db.close();
    await expect(open()).rejects.toThrow(/999/);
  });
});

describe("共有モード", () => {
  const lockPath = () => `${dbPath}.lock`;
  const leftovers = async () => (await fs.readdir(path.dirname(dbPath))).filter((n) => n !== path.basename(dbPath));

  it("WAL を使わず、書き込みのたびにロックファイルが消える", async () => {
    const s = await open({ sharing });
    const cells = s.cells("ns");
    await cells.set([{ ...ref("a"), value: 1 }]);
    await expect(fs.access(lockPath())).rejects.toThrow();
    await s.log("ns").append([{ cell: ref("a"), data: "x" }]);
    await s.kv("ns").setMany({ a: 1 });
    await s.kv("ns").delete("a");
    await cells.renameEntry("r1", "a", "b");
    await s.log("ns").renameEntry("r1", "a", "b");
    await expect(cells.set([{ ...ref("b"), value: 9, expectedVersion: 5 }])).rejects.toBeInstanceOf(StoreConflictError);
    await s.backup(path.join(dir, "bk.sqlite"));
    // ロックファイル、ジャーナル、一時ファイルが残っていない。
    expect(await leftovers()).toEqual([]);
    expect((await cells.get([ref("b")]))[0]?.value).toBe(1);
    expect(await s.integrityCheck()).toEqual([]);

    const db = new DatabaseSync(dbPath);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    db.close();
  });

  it("並行した書き込みでもロックファイルが残らず、すべて反映される", async () => {
    const s = await open({ sharing });
    const other = await open({ sharing });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? s : other).log("ns").append([{ data: i }])));
    expect(await s.log("ns").list()).toHaveLength(20);
    expect(await leftovers()).toEqual([]);
  });

  it("通常モードで作った WAL のファイルを共有モードで開くと DELETE に戻す", async () => {
    const normal = await open();
    await normal.kv("ns").set("k", "v");
    normal.close();
    const s = await open({ sharing });
    expect(await s.kv("ns").get("k")).toBe("v");
    const db = new DatabaseSync(dbPath);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
    db.close();
  });

  it("共有モードで :memory: は使えない", async () => {
    await expect(open({ path: ":memory:", sharing })).rejects.toThrow(/:memory:/);
  });

  it("複数プロセスが版番号で数を増やしても取りこぼさない", async () => {
    const storeModule = fileURLToPath(new URL("./sqlite-store.ts", import.meta.url));
    const require = createRequire(import.meta.url);
    const jitiUrl = pathToFileURL(require.resolve("jiti")).href;
    // 子プロセスでは他パッケージをソースから読む（core はロックだけを使うので lock.ts を直接読む）。
    const alias = {
      "@loc-studio/sdk": fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url)),
      "@loc-studio/core": fileURLToPath(new URL("../../core/src/lock.ts", import.meta.url)),
    };
    const runner = path.join(dir, "runner.mjs");
    await fs.writeFile(
      runner,
      `
import { createJiti } from ${JSON.stringify(jitiUrl)};
const [storeModule, dbPath, name, aliasJson] = process.argv.slice(2);
const jiti = createJiti(import.meta.url, { alias: JSON.parse(aliasJson) });
const { openStore } = await jiti.import(storeModule);
const store = await openStore({
  path: dbPath,
  userName: () => name,
  hostName: "h",
  sharing: { mode: "lockfile", retryDelayMs: 5, waitMs: 30000 },
});
const cell = { resourceId: "r", entryKey: "counter", columnId: "n" };
const cells = store.cells("test");
const log = store.log("test");
for (let i = 0; i < 30; i++) {
  for (;;) {
    const [cur] = await cells.get([cell]);
    try {
      await cells.set([{ ...cell, value: (cur?.value ?? 0) + 1, expectedVersion: cur?.version ?? 0 }]);
      break;
    } catch (err) {
      if (err?.name !== "StoreConflictError") throw err;
    }
  }
  await log.append([{ cell, data: { by: name, i } }]);
}
store.close();
`,
    );
    // 先に作っておき、子プロセスの初期化の競合は別に試す必要がないようにする。
    (await open({ sharing })).close();
    const run = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [runner, storeModule, dbPath, name, JSON.stringify(alias)], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`子プロセス ${name} が終了コード ${code} で終了: ${stderr}`)),
        );
      });
    await Promise.all(["p1", "p2", "p3"].map(run));
    const s = await open({ sharing });
    const [counter] = await s.cells("test").get([{ resourceId: "r", entryKey: "counter", columnId: "n" }]);
    expect(counter?.value).toBe(90);
    expect(counter?.version).toBe(90);
    const logs = await s.log("test").list();
    expect(logs).toHaveLength(90);
    expect(new Set(logs.map((r) => r.by))).toEqual(new Set(["p1", "p2", "p3"]));
    expect(await s.integrityCheck()).toEqual([]);
    expect(await leftovers()).toEqual([]);
  }, 120_000);
});
