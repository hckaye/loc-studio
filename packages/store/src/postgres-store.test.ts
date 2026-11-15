import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreConflictError } from "@loc-studio/sdk";
import { EXPORT_FORMAT, openPostgresStore } from "./index.js";
import type { OpenPostgresStoreOptions, Store } from "./index.js";
import { startTestPg } from "./testing/pg-server.js";
import { defineStoreContract, ref } from "./testing/store-contract.js";

const server = await startTestPg();
const url = server.url;
const skipReason = "skipReason" in server ? server.skipReason : undefined;
if (skipReason) console.warn(skipReason);
afterAll(async () => {
  await admin?.end();
  if ("stop" in server) await server.stop();
});

const admin = url ? new pg.Pool({ connectionString: url, max: 3 }) : undefined;
const createdSchemas = new Set<string>();

function newSchemaName(): string {
  const name = `t_${randomBytes(6).toString("hex")}`;
  createdSchemas.add(name);
  return name;
}

async function dropSchemas(): Promise<void> {
  for (const s of createdSchemas) await admin!.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  createdSchemas.clear();
}

let schema = "";

defineStoreContract("Postgres", {
  fresh: async () => {
    if (!url) return;
    schema = newSchemaName();
  },
  open: (o) => openPostgresStore({ url: url!, schema, ...o }),
  cleanup: async () => {
    if (url) await dropSchemas();
  },
  ...(skipReason ? { skip: skipReason } : {}),
});

const describePg = url ? describe : describe.skip;

describePg(`Postgres 固有${skipReason ? `（${skipReason}）` : ""}`, () => {
  const opened: Store[] = [];
  let dir: string;

  beforeEach(async () => {
    schema = newSchemaName();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "loc-pg-test-"));
  });

  afterEach(async () => {
    for (const s of opened.splice(0)) s.close();
    await dropSchemas();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function open(over: Partial<OpenPostgresStoreOptions> = {}): Promise<Store> {
    const s = await openPostgresStore({ url: url!, schema, userName: () => "alice", ...over });
    opened.push(s);
    return s;
  }

  it("複数のクライアントが版番号で数を増やしても取りこぼさず、デッドロックも表に出ない", async () => {
    const clients = 4;
    const workersPerClient = 2;
    const increments = 15;
    await (await open()).kv("warm").set("k", 1); // スキーマを先に作る
    const stores = await Promise.all(
      Array.from({ length: clients }, (_, i) => open({ userName: () => `c${i}`, maxConnections: 3 })),
    );
    const cell = { resourceId: "r", entryKey: "counter", columnId: "n" };
    let conflicts = 0;
    const worker = async (s: Store) => {
      for (let i = 0; i < increments; i++) {
        for (;;) {
          const [cur] = await s.cells("test").get([cell]);
          try {
            await s
              .cells("test")
              .set([
                { ...cell, value: ((cur?.value as number | undefined) ?? 0) + 1, expectedVersion: cur?.version ?? 0 },
              ]);
            break;
          } catch (err) {
            if (!(err instanceof StoreConflictError)) throw err;
            conflicts++;
          }
        }
        await s.log("test").append([{ cell, data: { i } }]);
      }
    };
    await Promise.all(stores.flatMap((s) => Array.from({ length: workersPerClient }, () => worker(s))));
    const total = clients * workersPerClient * increments;
    const [counter] = await stores[0]!.cells("test").get([cell]);
    expect(counter?.value).toBe(total);
    expect(counter?.version).toBe(total);
    expect(await stores[0]!.log("test").list()).toHaveLength(total);
    expect(conflicts).toBeGreaterThan(0); // 実際に競合が起きたこと
  }, 60_000);

  it("まだないセルを同時に作ると、1 人だけが成功し、ほかは競合になる", async () => {
    await (await open()).kv("warm").set("k", 1);
    const stores = await Promise.all(Array.from({ length: 8 }, (_, i) => open({ userName: () => `u${i}` })));
    for (let round = 0; round < 5; round++) {
      const cell = ref(`new-${round}`);
      const results = await Promise.allSettled(
        stores.map((s, i) => s.cells("ns").set([{ ...cell, value: i, expectedVersion: 0 }])),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      for (const f of failed) {
        expect(f.reason).toBeInstanceOf(StoreConflictError);
        expect((f.reason as StoreConflictError).conflicts[0]?.current?.version).toBe(1);
      }
    }
  }, 30_000);

  it("同じセルを逆の順で同時に書いてもデッドロックのエラーにならない", async () => {
    const a = await open({ maxConnections: 4 });
    const b = await open({ maxConnections: 4 });
    const cells = ["x", "y", "z"].map((k) => ref(k));
    const rounds = 25;
    const run = (s: Store, order: typeof cells) =>
      Promise.all(Array.from({ length: rounds }, (_, i) => s.cells("ns").set(order.map((c) => ({ ...c, value: i })))));
    await Promise.all([run(a, cells), run(b, [...cells].reverse())]);
    const got = await a.cells("ns").get(cells);
    expect(got.map((c) => c.version)).toEqual([rounds * 2, rounds * 2, rounds * 2]);
  }, 30_000);

  it("変更番号は並行した書き込みの数だけ増える", async () => {
    const stores = await Promise.all(Array.from({ length: 4 }, () => open({ maxConnections: 4 })));
    const before = await stores[0]!.changeSeq();
    await Promise.all(stores.flatMap((s, i) => Array.from({ length: 10 }, (_, j) => s.kv("ns").set(`k${i}-${j}`, j))));
    expect(await stores[1]!.changeSeq()).toBe(before + 40);
  });

  it("空のスキーマを複数のサーバーが同時に開いても準備は 1 回だけ", async () => {
    const stores = await Promise.all(Array.from({ length: 6 }, () => open()));
    expect(await stores[0]!.integrityCheck()).toEqual([]);
    // 準備（版 0 → 最新）で 1 回だけ増える。
    expect(await stores[3]!.changeSeq()).toBe(1);
    const res = await admin!.query(`SELECT value FROM "${schema}".meta WHERE key = 'schema_version'`);
    expect(res.rows).toHaveLength(1);
  });

  it("スキーマが違えば互いに見えない", async () => {
    const a = await open();
    const otherSchema = newSchemaName();
    const b = await open({ schema: otherSchema });
    await a.cells("ns").set([{ ...ref("k"), value: "A" }]);
    await b.cells("ns").set([{ ...ref("k"), value: "B" }]);
    await a.log("ns").append([{ data: 1 }]);
    await a.kv("ns").set("k", "A");
    expect((await a.cells("ns").get([ref("k")]))[0]?.value).toBe("A");
    expect((await b.cells("ns").get([ref("k")]))[0]).toMatchObject({ value: "B", version: 1 });
    expect(await b.log("ns").list()).toEqual([]);
    expect(await b.kv("ns").get("k")).toBeUndefined();
    expect(b.path).toContain(`#${otherSchema}`);
  });

  it("値は書いた JSON のまま戻る（JSONB では受け付けない \\u0000 も）", async () => {
    const s = await open();
    const value = { z: 1, a: [2, { y: "\u0000末尾" }], big: 12345678901234567890, small: 1e-300, neg: -0.5 };
    await s.cells("ns").set([{ ...ref("k"), value }]);
    const [got] = await s.cells("ns").get([ref("k")]);
    expect(got?.value).toEqual(value);
    expect(Object.keys(got?.value as object)).toEqual(["z", "a", "big", "small", "neg"]);
    await s.kv("ns").set("k", "\u0000");
    expect(await s.kv("ns").get("k")).toBe("\u0000");
  });

  it("backup は JSON Lines に書き出す", async () => {
    const s = await open({ now: () => new Date("2026-05-06T07:08:09.000Z") });
    await s.cells("ns").set([
      { ...ref("a"), value: { deep: ["日本語", 1] }, basisHash: "h" },
      { ...ref("b", "note", null), value: null },
    ]);
    await s.log("ns").append([{ cell: ref("a"), data: { verdict: "ok" } }, { data: 2 }]);
    await s.kv("cache").setMany({ k1: [1, 2], k2: "v" });
    const target = path.join(dir, "out", "export.jsonl");
    await s.backup(target);
    await s.backup(target); // 置き換える
    const lines = (await fs.readFile(target, "utf8"))
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      type: "header",
      format: EXPORT_FORMAT,
      formatVersion: 1,
      schema,
      schemaVersion: 1,
    });
    expect(lines[0]?.changeSeq).toBe(await s.changeSeq());
    const cells = lines.filter((l) => l.type === "cell");
    expect(cells).toEqual([
      {
        type: "cell",
        ns: "ns",
        resourceId: "r1",
        entryKey: "a",
        columnId: "status",
        language: "ja",
        version: 1,
        updatedAt: "2026-05-06T07:08:09.000Z",
        updatedBy: "alice",
        basisHash: "h",
        value: { deep: ["日本語", 1] },
      },
      expect.objectContaining({ entryKey: "b", language: "", basisHash: null, value: null }),
    ]);
    const logs = lines.filter((l) => l.type === "log");
    expect(logs.map((l) => l.data)).toEqual([{ verdict: "ok" }, 2]);
    expect(logs[1]).toMatchObject({ resourceId: null, by: "alice" });
    expect(lines.filter((l) => l.type === "kv").map((l) => [l.key, l.value])).toEqual([
      ["k1", [1, 2]],
      ["k2", "v"],
    ]);
    expect((await fs.readdir(path.dirname(target))).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("backup は大きな表も少しずつ書き出す", async () => {
    const s = await open();
    const n = 5000;
    await s.cells("ns").set(Array.from({ length: n }, (_, i) => ({ ...ref(`k${i}`), value: "x".repeat(100) })));
    const target = path.join(dir, "big.jsonl");
    await s.backup(target);
    const text = await fs.readFile(target, "utf8");
    expect(text.trimEnd().split("\n")).toHaveLength(1 + n);
  });

  it("integrityCheck は版と行の簡単な確認をする", async () => {
    const s = await open();
    expect(await s.integrityCheck()).toEqual([]);
    await admin!.query(`DELETE FROM "${schema}".change_counter WHERE slot = 0`);
    expect(await s.integrityCheck()).toEqual([expect.stringContaining("変更番号")]);
  });

  it("新しすぎるスキーマの版は開かない", async () => {
    (await open()).close();
    await admin!.query(`UPDATE "${schema}".meta SET value = 999 WHERE key = 'schema_version'`);
    await expect(open()).rejects.toThrow(/999/);
  });

  it("接続できないときのエラーにパスワードを出さない", async () => {
    const bad = "postgres://someone:secret-pw@127.0.0.1:1/nodb";
    const err = await openPostgresStore({ url: bad, userName: () => "x", schema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("127.0.0.1");
    expect((err as Error).message).not.toContain("secret-pw");
  });
});
