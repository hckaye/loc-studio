import { describe, expect, it } from "vitest";
import { createMemoryDb, createPluginHost } from "@loc-studio/core";
import { StoreConflictError } from "@loc-studio/sdk";
import type { CellRef, ColumnSourceContext, HostDb, Options } from "@loc-studio/sdk";
import { dbSource } from "./db-source.js";

const makeCtx = (db: HostDb, options: Options = {}): ColumnSourceContext => ({
  projectRoot: "/p",
  options,
  host: createPluginHost({ db, userName: () => "alice", projectRoot: "/p", env: {} }),
});

const cell = (entryKey: string, language = "ja"): CellRef => ({ entryKey, resourceId: "a.csv", columnId: "status", language });
const resource = { id: "a.csv", path: "a.csv", name: "a.csv" };

describe("dbSource", () => {
  it("即時保存で、保存した値を読む。値のないセルは返さない", async () => {
    // 記録に残る名前は DB の userName から来る（ホストと同じ関数を渡す）。
    const db = createMemoryDb({ userName: () => "alice" });
    const ctx = makeCtx(db);
    expect(dbSource.id).toBe("builtin.db");
    expect(dbSource.saveMode).toBe("immediate");
    const [saved] = await dbSource.save([{ ...cell("k"), value: "wip", basisHash: "h" }], ctx);
    expect(saved).toMatchObject({ value: "wip", version: 1, updatedBy: "alice", basisHash: "h" });
    const loaded = await dbSource.load([cell("k"), cell("none")], ctx);
    expect(loaded).toEqual([saved]);
    // 既定の名前空間は builtin.db。
    expect(await db.cells("builtin.db").get([cell("k")])).toEqual([saved]);
  });

  it("options.namespace で置き場所を分ける", async () => {
    const db = createMemoryDb();
    await dbSource.save([{ ...cell("k"), value: "a" }], makeCtx(db, { namespace: "team" }));
    expect(await dbSource.load([cell("k")], makeCtx(db))).toEqual([]);
    expect((await dbSource.load([cell("k")], makeCtx(db, { namespace: "team" })))[0]?.value).toBe("a");
    await expect(dbSource.load([cell("k")], makeCtx(db, { namespace: 1 }))).rejects.toThrow("namespace");
  });

  it("expectedVersion が合わなければ StoreConflictError", async () => {
    const ctx = makeCtx(createMemoryDb());
    await dbSource.save([{ ...cell("k"), value: "a", expectedVersion: 0 }], ctx);
    await expect(dbSource.save([{ ...cell("k"), value: "b", expectedVersion: 0 }], ctx)).rejects.toBeInstanceOf(StoreConflictError);
    const [v] = await dbSource.save([{ ...cell("k"), value: "b", expectedVersion: 1 }], ctx);
    expect(v?.version).toBe(2);
  });

  it("キーの変更に追従し、ほかの変更は無視する", async () => {
    const ctx = makeCtx(createMemoryDb());
    await dbSource.save([{ ...cell("old"), value: "done" }, { ...cell("gone"), value: "wip" }], ctx);
    await dbSource.onEntriesChanged!(
      [
        { type: "rename", key: "old", newKey: "new" },
        { type: "remove", key: "gone" },
        { type: "set", key: "x", field: { kind: "text", language: "ja" }, value: "v" },
      ],
      resource,
      ctx,
    );
    expect(await dbSource.load([cell("old")], ctx)).toEqual([]);
    expect((await dbSource.load([cell("new")], ctx))[0]).toMatchObject({ entryKey: "new", value: "done" });
    expect((await dbSource.load([cell("gone")], ctx))[0]?.value).toBe("wip");
  });
});
