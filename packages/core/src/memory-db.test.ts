import { describe, expect, it } from "vitest";
import { StoreConflictError } from "@loc-studio/sdk";
import type { CellRef } from "@loc-studio/sdk";
import { createMemoryDb } from "./memory-db.js";

const cell = (entryKey: string, language?: string, columnId = "status"): CellRef => ({
  entryKey,
  resourceId: "a.csv",
  columnId,
  ...(language !== undefined ? { language } : {}),
});

const fixed = () => {
  let user = "alice";
  let t = 0;
  const db = createMemoryDb({ userName: () => user, now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)) });
  return { db, setUser: (u: string) => (user = u) };
};

describe("createMemoryDb / cells", () => {
  it("版は 1 から始まり、書くたびに増える。誰がいつ書いたかを残す", async () => {
    const { db, setUser } = fixed();
    const cells = db.cells("ns");
    const [v1] = await cells.set([{ ...cell("k", "ja"), value: "todo", basisHash: "h1" }]);
    expect(v1).toMatchObject({ value: "todo", version: 1, updatedBy: "alice", basisHash: "h1" });
    setUser("bob");
    const [v2] = await cells.set([{ ...cell("k", "ja"), value: "done", expectedVersion: 1 }]);
    expect(v2).toMatchObject({ value: "done", version: 2, updatedBy: "bob" });
    expect(v2?.basisHash).toBeUndefined();
    expect(await cells.get([cell("k", "ja"), cell("missing", "ja")])).toEqual([v2]);
  });

  it("expectedVersion が合わなければ何も書かずに StoreConflictError。ないセルは版 0", async () => {
    const { db } = fixed();
    const cells = db.cells("ns");
    await cells.set([{ ...cell("a"), value: 1 }]);
    const err = await cells
      .set([
        { ...cell("a"), value: 2, expectedVersion: 1 },
        { ...cell("b"), value: 3, expectedVersion: 0 },
        { ...cell("c"), value: 4, expectedVersion: 2 },
        { ...cell("a", "en"), value: 5, expectedVersion: 1 },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreConflictError);
    const conflicts = (err as StoreConflictError).conflicts;
    expect(conflicts.map((c) => [c.cell.entryKey, c.cell.language, c.current])).toEqual([
      ["c", undefined, undefined],
      ["a", "en", undefined],
    ]);
    // 何も書いていない。
    expect((await cells.get([cell("a")]))[0]?.value).toBe(1);
    expect(await cells.get([cell("b")])).toEqual([]);

    await cells.set([{ ...cell("x"), value: "v" }]);
    const err2 = (await cells.set([{ ...cell("x"), value: "w", expectedVersion: 0 }]).catch((e: unknown) => e)) as StoreConflictError;
    expect(err2.conflicts[0]?.current).toMatchObject({ value: "v", version: 1 });
  });

  it("名前空間は分かれる。query で絞り込む。renameEntry でキーの変更に追従する", async () => {
    const { db } = fixed();
    await db.cells("one").set([
      { ...cell("k", "ja"), value: 1 },
      { ...cell("k", "en"), value: 2 },
      { ...cell("k", "ja", "other"), value: 3 },
      { entryKey: "k", resourceId: "b.csv", columnId: "status", language: "ja", value: 4 },
    ]);
    expect(await db.cells("two").get([cell("k", "ja")])).toEqual([]);
    expect((await db.cells("one").query({ resourceId: "a.csv" })).map((v) => v.value).sort()).toEqual([1, 2, 3]);
    expect((await db.cells("one").query({ columnId: "status", language: "ja" })).map((v) => v.value).sort()).toEqual([1, 4]);

    await db.cells("one").renameEntry("a.csv", "k", "k2");
    expect(await db.cells("one").get([cell("k", "ja")])).toEqual([]);
    const [moved] = await db.cells("one").get([cell("k2", "ja")]);
    expect(moved).toMatchObject({ entryKey: "k2", value: 1, version: 1 });
    // ほかのリソースは動かない。
    expect(await db.cells("one").query({ resourceId: "b.csv" })).toHaveLength(1);
  });

  it("値は複製して出し入れする", async () => {
    const { db } = fixed();
    const value = { list: [1] };
    const [stored] = await db.cells("ns").set([{ ...cell("k"), value }]);
    value.list.push(2);
    (stored!.value as { list: number[] }).list.push(3);
    const [got] = await db.cells("ns").get([cell("k")]);
    expect(got?.value).toEqual({ list: [1] });
    (got!.value as { list: number[] }).list.push(4);
    expect((await db.cells("ns").get([cell("k")]))[0]?.value).toEqual({ list: [1] });
  });
});

describe("createMemoryDb / log", () => {
  it("追記だけ。list は新しい順で、絞り込みと件数の上限がある", async () => {
    const { db, setUser } = fixed();
    const log = db.log<{ n: number }>("reviews");
    const [r1] = await log.append([{ cell: cell("a", "ja"), data: { n: 1 } }]);
    setUser("bob");
    await log.append([
      { cell: cell("b", "ja"), data: { n: 2 } },
      { data: { n: 3 } },
      { cell: cell("a", "ja"), data: { n: 4 } },
    ]);
    expect(r1).toMatchObject({ by: "alice", at: "2026-01-01T00:00:00.000Z", data: { n: 1 } });
    expect(typeof r1?.id).toBe("string");
    expect((await log.list()).map((r) => r.data.n)).toEqual([4, 3, 2, 1]);
    expect((await log.list({ limit: 2 })).map((r) => r.data.n)).toEqual([4, 3]);
    expect((await log.list({ cell: cell("a", "ja") })).map((r) => r.data.n)).toEqual([4, 1]);
    expect((await log.list({ cell: cell("a") })).map((r) => r.data.n)).toEqual([]);
    expect((await log.list({ resourceId: "a.csv", limit: 2 })).map((r) => r.data.n)).toEqual([4, 2]);
    expect((await log.list({ columnId: "nope" }))).toEqual([]);
    const ids = new Set((await log.list()).map((r) => r.id));
    expect(ids.size).toBe(4);
    expect(await db.log("other").list()).toEqual([]);
  });

  it("latest はセルごとの最新 1 件を引数の順で返す。renameEntry で追従する", async () => {
    const { db } = fixed();
    const log = db.log<string>("ns");
    await log.append([
      { cell: cell("a"), data: "a1" },
      { cell: cell("b"), data: "b1" },
      { cell: cell("a"), data: "a2" },
    ]);
    const latest = await log.latest([cell("b"), cell("none"), cell("a")]);
    expect(latest.map((r) => r?.data)).toEqual(["b1", undefined, "a2"]);

    await log.renameEntry("a.csv", "a", "z");
    expect((await log.latest([cell("a"), cell("z")])).map((r) => r?.data)).toEqual([undefined, "a2"]);
    expect((await log.list({ cell: cell("z") })).map((r) => r.data)).toEqual(["a2", "a1"]);
  });

  it("記録は複製して出し入れする", async () => {
    const { db } = fixed();
    const log = db.log<{ tags: string[] }>("ns");
    const data = { tags: ["x"] };
    const [rec] = await log.append([{ data }]);
    data.tags.push("y");
    rec!.data.tags.push("z");
    expect((await log.list())[0]?.data).toEqual({ tags: ["x"] });
  });
});

describe("createMemoryDb / kv", () => {
  it("get / getMany / set / setMany / delete", async () => {
    const { db } = fixed();
    const kv = db.kv("cache");
    expect(await kv.get("a")).toBeUndefined();
    await kv.set("a", { n: 1 });
    await kv.setMany({ b: 2, c: [3] });
    expect(await kv.getMany(["a", "b", "missing"])).toEqual({ a: { n: 1 }, b: 2 });
    await kv.delete("a");
    expect(await kv.get("a")).toBeUndefined();
    expect(await db.kv("other").get("b")).toBeUndefined();
    const c = (await kv.get("c")) as number[];
    c.push(4);
    expect(await kv.get("c")).toEqual([3]);
  });
});
