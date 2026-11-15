/**
 * 外部の変更の監視: ツリーの watch と、列ソースの subscribe。
 * 版を出さない（revision のない）ツリーと、ホストの DB を使わない列ソースを登録し、
 * 「知らせを受けるまでは古い値のまま、受けたら読み直す」ことを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CellRef, CellValue, Plugin, ResourceRef, TreeNode } from "@loc-studio/sdk";
import type { Workspace } from "./api-types.js";
import { makeTestProject } from "./testing.js";
import type { TestProject } from "./testing.js";

const RES: ResourceRef = { id: "mem/a.csv", path: "mem/a.csv", name: "a.csv" };
const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** メモリ上のリソース（外部のサービスにあるリソースの代わり）。 */
let content: string;
let treeListeners: Set<(resource: ResourceRef) => void>;
/** 外部のサービスにあるステータス（セルの値）。 */
let external: Map<string, string>;
let sourceListeners: Set<(cells: CellRef[]) => void>;
let failWatch: boolean;

const cellKey = (c: CellRef): string => `${c.entryKey}@${c.language ?? ""}`;

const plugin: Plugin = {
  name: "watch-test",
  trees: [
    {
      // 版を出さないツリー: 知らせがなければ、ホストは読み直すきっかけを持たない。
      id: "w.tree",
      list: async (): Promise<TreeNode[]> => [{ id: RES.id, name: RES.name, kind: "resource", resource: RES }],
      read: async () => encode(content),
      write: async (_r, data) => void (content = new TextDecoder().decode(data)),
      watch(_ctx, onChange) {
        if (failWatch) throw new Error("接続できません");
        treeListeners.add(onChange);
        return () => void treeListeners.delete(onChange);
      },
    },
  ],
  sources: [
    {
      id: "w.tracker",
      saveMode: "immediate",
      load: async (cells) => cells.flatMap((c): CellValue[] => (external.has(cellKey(c)) ? [{ ...c, value: external.get(cellKey(c)) }] : [])),
      save: async (values) => values.map((v) => (external.set(cellKey(v), String(v.value)), { ...v })),
      subscribe(_ctx, onChange) {
        sourceListeners.add(onChange);
        return () => void sourceListeners.delete(onChange);
      },
    },
  ],
};

const STATUS = {
  id: "st",
  kind: "meta",
  scope: "language",
  source: "tracker",
  type: { default: "todo", enum: [{ value: "todo" }, { value: "done", complete: true }] },
};

let tp: TestProject;
let ws: Workspace;

beforeEach(async () => {
  content = "ID,JP,EN,CN,KR,MaxLen\nA,あ,a,,,\nB,い,b,,,\n";
  treeListeners = new Set();
  sourceListeners = new Set();
  external = new Map();
  failWatch = false;
  tp = await makeTestProject({ plugins: [plugin] });
  const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
  await tp.patchConfig({ tree: "w.tree", sources: { tracker: "w.tracker" }, columns: [...config.columns, STATUS] });
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

const textOf = async (key: string): Promise<unknown> => (await ws.rowDetail({ resourceId: RES.id, key })).row.cells["text@ja"]!.value;
const localSeq = async (): Promise<number> => (await ws.changes({ since: 0 })).localSeq;
const done = async (): Promise<number> => (await ws.stats({ resourceIds: [RES.id] }))[0]!.progress["st"]!["ko"]!.complete;

describe("ツリーの watch", () => {
  it("知らせを受けるまでは読み込んだ中身のまま。受けたら読み直し、画面に変更を伝える", async () => {
    expect(await textOf("A")).toBe("あ");
    content = content.replace("A,あ", "A,書き換え");
    expect(await textOf("A")).toBe("あ"); // 版を出さないツリーなので、まだ気づけない
    const seq = await localSeq();
    expect(treeListeners.size).toBe(1);
    for (const notify of treeListeners) notify(RES);
    expect(await textOf("A")).toBe("書き換え");
    expect(await localSeq()).toBeGreaterThan(seq);
  });

  it("設定を読み直すと監視を始め直し、閉じるとやめる（重ねて監視しない）", async () => {
    await ws.reloadPlugins();
    await ws.reloadPlugins();
    expect([treeListeners.size, sourceListeners.size]).toEqual([1, 1]);
    await ws.close();
    expect([treeListeners.size, sourceListeners.size]).toEqual([0, 0]);
  });

  it("監視を始められなくても、プロジェクトは開き、警告になる", async () => {
    failWatch = true;
    const ws2 = await tp.open();
    expect((await ws2.info()).warnings.filter((w) => w.includes("接続できません"))).toHaveLength(1);
    expect((await ws2.rows({ resourceId: RES.id, languages: ["ja"], offset: 0, limit: 10 })).total).toBe(2);
  });
});

describe("列ソースの subscribe", () => {
  it("外部で値が変わったと知らせを受けたら、覚えていた統計を捨てて読み直し、画面に変更を伝える", async () => {
    expect(await done()).toBe(0);
    external.set("A@ko", "done");
    expect(await done()).toBe(0); // 統計は覚えているので、まだ変わらない
    const seq = await localSeq();
    for (const notify of sourceListeners) notify([{ resourceId: RES.id, entryKey: "A", columnId: "st", language: "ko" }]);
    expect(await done()).toBe(1);
    expect(await localSeq()).toBeGreaterThan(seq);
  });
});
