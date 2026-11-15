/**
 * Store の契約テスト。SQLite と Postgres の両方に同じ場合を当てる。
 * 各実装のテストファイルから defineStoreContract を呼ぶ。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreConflictError } from "@loc-studio/sdk";
import type { CellRef, CellWrite } from "@loc-studio/sdk";
import type { Store } from "../common.js";

export interface StoreHarness {
  /** 各テストの前に呼ぶ。空の保存先を用意する。 */
  fresh(): Promise<void>;
  /** いまの保存先を開く。同じテストの中で何度呼んでも同じ保存先を開く。 */
  open(opts: { userName: () => string; now?: () => Date }): Promise<Store>;
  /** 各テストの後に呼ぶ（開いたストアは閉じた後）。 */
  cleanup(): Promise<void>;
  /** 設定すると、その理由を名前に付けて全体を飛ばす（サーバーがない環境など）。 */
  skip?: string;
}

/** language に null を渡すと「言語なし」のセル。 */
export const ref = (
  entryKey: string,
  columnId = "status",
  language: string | null = "ja",
  resourceId = "r1",
): CellRef => (language === null ? { resourceId, entryKey, columnId } : { resourceId, entryKey, columnId, language });

export function defineStoreContract(name: string, harness: StoreHarness): void {
  const d = harness.skip ? describe.skip : describe;
  d(`Store の契約: ${name}${harness.skip ? `（${harness.skip}）` : ""}`, () => {
    const opened: Store[] = [];
    let user = "alice";

    beforeEach(async () => {
      user = "alice";
      await harness.fresh();
    });

    afterEach(async () => {
      for (const s of opened.splice(0)) s.close();
      await harness.cleanup();
    });

    async function open(over: { now?: () => Date } = {}): Promise<Store> {
      const s = await harness.open({ userName: () => user, ...over });
      opened.push(s);
      return s;
    }

    describe("cells", () => {
      it("set / get の基本と版番号", async () => {
        const s = await open({ now: () => new Date("2026-01-02T03:04:05.000Z") });
        const cells = s.cells("ns");
        const [a] = await cells.set([{ ...ref("k1"), value: "done", basisHash: "h1" }]);
        expect(a).toEqual({
          ...ref("k1"),
          value: "done",
          version: 1,
          updatedAt: "2026-01-02T03:04:05.000Z",
          updatedBy: "alice",
          basisHash: "h1",
        });
        user = "bob";
        const [b] = await cells.set([{ ...ref("k1"), value: "wip" }]);
        expect(b?.version).toBe(2);
        expect(b?.updatedBy).toBe("bob");
        expect(b?.basisHash).toBeUndefined();
        const got = await cells.get([ref("k1"), ref("missing")]);
        expect(got).toEqual([b]);
      });

      it("get は引数の順に返し、存在しないものは含めない", async () => {
        const s = await open();
        const cells = s.cells("ns");
        await cells.set([
          { ...ref("a"), value: 1 },
          { ...ref("b"), value: 2 },
          { ...ref("c", "note", null), value: 3 },
        ]);
        const got = await cells.get([ref("c", "note", null), ref("x"), ref("a"), ref("b")]);
        expect(got.map((c) => c.value)).toEqual([3, 1, 2]);
        expect(got[0]).not.toHaveProperty("language");
        expect(await cells.get([])).toEqual([]);
      });

      it("language なしと空でない language は別のセル", async () => {
        const s = await open();
        const cells = s.cells("ns");
        await cells.set([
          { ...ref("k", "c", null), value: "none" },
          { ...ref("k", "c", "ja"), value: "ja" },
        ]);
        const got = await cells.get([ref("k", "c", null), ref("k", "c", "ja")]);
        expect(got.map((c) => c.value)).toEqual(["none", "ja"]);
      });

      it("set は入力の順に返す。同じセルが 2 回あれば順に版が進む", async () => {
        const s = await open();
        const cells = s.cells("ns");
        const out = await cells.set([
          { ...ref("b"), value: "B" },
          { ...ref("a"), value: "A1" },
          { ...ref("a"), value: "A2", expectedVersion: 1 },
        ]);
        expect(out.map((c) => [c.entryKey, c.value, c.version])).toEqual([
          ["b", "B", 1],
          ["a", "A1", 1],
          ["a", "A2", 2],
        ]);
        expect((await cells.get([ref("a")]))[0]?.value).toBe("A2");
      });

      it("expectedVersion が合わなければ何も書かず、競合をすべて返す", async () => {
        const s = await open();
        const cells = s.cells("ns");
        await cells.set([{ ...ref("a"), value: "A" }]);
        await cells.set([{ ...ref("a"), value: "A2" }]);
        const seqBefore = await s.changeSeq();
        const writes: CellWrite[] = [
          { ...ref("new"), value: "N", expectedVersion: 0 }, // 合っている
          { ...ref("a"), value: "X", expectedVersion: 1 }, // 今は 2
          { ...ref("ghost"), value: "G", expectedVersion: 3 }, // 存在しない（0）
        ];
        let err: unknown;
        try {
          await cells.set(writes);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(StoreConflictError);
        const conflicts = (err as StoreConflictError).conflicts;
        expect(conflicts).toHaveLength(2);
        expect(conflicts[0]?.cell).toEqual(ref("a"));
        expect(conflicts[0]?.current?.value).toBe("A2");
        expect(conflicts[0]?.current?.version).toBe(2);
        expect(conflicts[1]?.cell).toEqual(ref("ghost"));
        expect(conflicts[1]?.current).toBeUndefined();
        // 何も書かれていない。
        expect(await cells.get([ref("new"), ref("ghost")])).toEqual([]);
        expect((await cells.get([ref("a")]))[0]?.version).toBe(2);
        expect(await s.changeSeq()).toBe(seqBefore);
      });

      it("expectedVersion 0 は「まだない」ことを要求する", async () => {
        const s = await open();
        const cells = s.cells("ns");
        await cells.set([{ ...ref("a"), value: 1, expectedVersion: 0 }]);
        await expect(cells.set([{ ...ref("a"), value: 2, expectedVersion: 0 }])).rejects.toBeInstanceOf(
          StoreConflictError,
        );
        await cells.set([{ ...ref("a"), value: 2, expectedVersion: 1 }]);
        expect((await cells.get([ref("a")]))[0]).toMatchObject({ value: 2, version: 2 });
      });

      it("query は resourceId / columnId / language の組み合わせで絞る", async () => {
        const s = await open();
        const cells = s.cells("ns");
        await cells.set([
          { ...ref("a", "status", "ja", "r1"), value: 1 },
          { ...ref("a", "status", "en", "r1"), value: 2 },
          { ...ref("a", "note", "ja", "r1"), value: 3 },
          { ...ref("b", "status", "ja", "r2"), value: 4 },
          { ...ref("c", "note", null, "r2"), value: 5 },
        ]);
        const vals = async (f: Parameters<typeof cells.query>[0]) => (await cells.query(f)).map((c) => c.value).sort();
        expect(await vals({})).toEqual([1, 2, 3, 4, 5]);
        expect(await vals({ resourceId: "r1" })).toEqual([1, 2, 3]);
        expect(await vals({ columnId: "status" })).toEqual([1, 2, 4]);
        expect(await vals({ language: "ja" })).toEqual([1, 3, 4]);
        expect(await vals({ resourceId: "r1", columnId: "status", language: "en" })).toEqual([2]);
        expect(await vals({ resourceId: "r2", columnId: "note" })).toEqual([5]);
      });

      it("renameEntry はセルを移し、新しいキーに既存の値があればそちらを残す", async () => {
        const s = await open();
        const cells = s.cells("ns");
        await cells.set([
          { ...ref("old", "status"), value: "old-status" },
          { ...ref("old", "note"), value: "old-note" },
          { ...ref("new", "note"), value: "new-note" },
          { ...ref("old", "status", "ja", "r2"), value: "other-resource" },
        ]);
        await cells.renameEntry("r1", "old", "new");
        expect(await cells.query({ resourceId: "r1" })).toHaveLength(2);
        const got = await cells.get([ref("new", "status"), ref("new", "note")]);
        expect(got.map((c) => c.value)).toEqual(["old-status", "new-note"]);
        expect(await cells.get([ref("old", "status"), ref("old", "note")])).toEqual([]);
        expect((await cells.get([ref("old", "status", "ja", "r2")]))[0]?.value).toBe("other-resource");
        await cells.renameEntry("r1", "new", "new"); // 何もしない
      });
    });

    describe("JSON の往復", () => {
      const samples: unknown[] = [
        null,
        0,
        -1.5,
        1e300,
        Number.MAX_SAFE_INTEGER,
        true,
        false,
        "",
        "日本語のテキスト 🎮👾 한국어 中文",
        "改行\nタブ\t引用符\"'\\",
        [],
        [1, "a", null, [2, { x: 3 }]],
        { a: { b: { c: [1, 2, { d: "深い" }] } }, "": "空のキー", ["__proto__"]: 1 },
      ];

      it("セル・記録・キーと値で正確に往復する", async () => {
        const s = await open();
        const cells = s.cells("ns");
        const writes = samples.map((value, i) => ({ ...ref(`k${i}`), value }));
        const stored = await cells.set(writes);
        expect(stored.map((c) => c.value)).toEqual(samples);
        const got = await cells.get(writes);
        expect(got.map((c) => c.value)).toEqual(samples);

        const log = s.log("ns");
        await log.append(samples.map((data) => ({ data })));
        expect((await log.list()).map((r) => r.data).reverse()).toEqual(samples);

        const kv = s.kv("ns");
        await kv.setMany(Object.fromEntries(samples.map((v, i) => [`k${i}`, v])));
        for (let i = 0; i < samples.length; i++) expect(await kv.get(`k${i}`)).toEqual(samples[i]);
      });

      it("値の undefined は null として保存する", async () => {
        const s = await open();
        const [c] = await s.cells("ns").set([{ ...ref("a"), value: undefined }]);
        expect(c?.value).toBeNull();
        expect((await s.cells("ns").get([ref("a")]))[0]?.value).toBeNull();
      });
    });

    describe("log", () => {
      it("append は id / at / by を付けて返し、list は新しい順", async () => {
        const s = await open({ now: () => new Date("2026-03-04T05:06:07.000Z") });
        const log = s.log<{ n: number }>("reviews");
        const recs = await log.append([{ cell: ref("a"), data: { n: 1 } }, { data: { n: 2 } }]);
        expect(recs).toHaveLength(2);
        expect(recs[0]).toMatchObject({ cell: ref("a"), at: "2026-03-04T05:06:07.000Z", by: "alice", data: { n: 1 } });
        expect(recs[1]).not.toHaveProperty("cell");
        expect(recs[0]?.id).not.toBe(recs[1]?.id);
        user = "bob";
        await log.append([{ cell: ref("a", "status", null), data: { n: 3 } }]);
        const all = await log.list();
        expect(all.map((r) => r.data.n)).toEqual([3, 2, 1]);
        expect(all[0]?.by).toBe("bob");
        expect(all[0]?.cell).toEqual(ref("a", "status", null));
        expect(all[2]).toEqual(recs[0]);
      });

      it("list はセル、resourceId、columnId、limit で絞る", async () => {
        const s = await open();
        const log = s.log<number>("h");
        await log.append([
          { cell: ref("a", "status", "ja", "r1"), data: 1 },
          { cell: ref("a", "status", "en", "r1"), data: 2 },
          { cell: ref("b", "note", "ja", "r1"), data: 3 },
          { cell: ref("a", "status", "ja", "r2"), data: 4 },
          { data: 5 },
          { cell: ref("a", "status", "ja", "r1"), data: 6 },
        ]);
        const d = async (f?: Parameters<typeof log.list>[0]) => (await log.list(f)).map((r) => r.data);
        expect(await d()).toEqual([6, 5, 4, 3, 2, 1]);
        expect(await d({ cell: ref("a", "status", "ja", "r1") })).toEqual([6, 1]);
        expect(await d({ resourceId: "r1" })).toEqual([6, 3, 2, 1]);
        expect(await d({ columnId: "status" })).toEqual([6, 4, 2, 1]);
        expect(await d({ resourceId: "r1", columnId: "note" })).toEqual([3]);
        expect(await d({ limit: 2 })).toEqual([6, 5]);
        expect(await d({ resourceId: "r1", limit: 1 })).toEqual([6]);
        expect(await d({ limit: 0 })).toEqual([]);
      });

      it("latest はセルごとの最新 1 件を引数の順に返す（多数のセル）", async () => {
        const s = await open();
        const log = s.log<{ i: number; round: number }>("reviews");
        const n = 1500; // チャンクの境目をまたぐ
        const refs = Array.from({ length: n }, (_, i) => ref(`k${i}`));
        await log.append(refs.map((cell, i) => ({ cell, data: { i, round: 1 } })));
        await log.append(refs.filter((_, i) => i % 2 === 0).map((cell, j) => ({ cell, data: { i: j * 2, round: 2 } })));
        const query = [ref("missing"), ...refs.slice().reverse()];
        const latest = await log.latest(query);
        expect(latest).toHaveLength(n + 1);
        expect(latest[0]).toBeUndefined();
        for (let q = 1; q <= n; q++) {
          const i = n - q;
          expect(latest[q]?.data).toEqual({ i, round: i % 2 === 0 ? 2 : 1 });
          expect(latest[q]?.cell).toEqual(refs[i]);
        }
        expect(await log.latest([])).toEqual([]);
      });

      it("renameEntry は記録のキーを移す", async () => {
        const s = await open();
        const log = s.log<string>("reviews");
        await log.append([
          { cell: ref("old"), data: "x" },
          { cell: ref("old", "status", "ja", "r2"), data: "y" },
        ]);
        await log.renameEntry("r1", "old", "new");
        expect((await log.list({ cell: ref("new") })).map((r) => r.data)).toEqual(["x"]);
        expect(await log.list({ cell: ref("old") })).toEqual([]);
        expect((await log.latest([ref("new"), ref("old", "status", "ja", "r2")])).map((r) => r?.data)).toEqual([
          "x",
          "y",
        ]);
      });
    });

    describe("kv", () => {
      it("get / getMany / set / setMany / delete", async () => {
        const s = await open();
        const kv = s.kv("cache");
        expect(await kv.get("nope")).toBeUndefined();
        await kv.set("a", { x: 1 });
        await kv.set("a", { x: 2 });
        await kv.setMany({ b: "B", c: null, ["__proto__"]: "p" });
        expect(await kv.get("a")).toEqual({ x: 2 });
        expect(await kv.get("c")).toBeNull();
        const many = await kv.getMany(["a", "b", "c", "zz", "__proto__"]);
        expect(Object.keys(many).sort()).toEqual(["__proto__", "a", "b", "c"]);
        expect(many.b).toBe("B");
        expect(Object.getOwnPropertyDescriptor(many, "__proto__")?.value).toBe("p");
        expect(many.zz).toBeUndefined();
        await kv.delete("a");
        await kv.delete("never-existed");
        expect(await kv.get("a")).toBeUndefined();
        expect(await kv.getMany([])).toEqual({});
      });
    });

    describe("名前空間とストア全体", () => {
      it("名前空間は互いに見えない", async () => {
        const s = await open();
        await s.cells("one").set([{ ...ref("a"), value: 1 }]);
        await s.cells("two").set([{ ...ref("a"), value: 2 }]);
        expect((await s.cells("one").get([ref("a")]))[0]).toMatchObject({ value: 1, version: 1 });
        expect((await s.cells("two").query({})).map((c) => c.value)).toEqual([2]);
        expect(await s.cells("three").get([ref("a")])).toEqual([]);

        await s.log("one").append([{ cell: ref("a"), data: "L1" }]);
        expect(await s.log("two").list()).toEqual([]);
        expect(await s.log("two").latest([ref("a")])).toEqual([undefined]);

        await s.kv("one").set("k", "v1");
        expect(await s.kv("two").get("k")).toBeUndefined();

        await s.cells("two").renameEntry("r1", "a", "b");
        expect((await s.cells("one").get([ref("a")]))[0]?.value).toBe(1);
      });

      it("閉じて開き直しても残る", async () => {
        const s1 = await open();
        await s1.cells("ns").set([{ ...ref("a"), value: "persist" }]);
        await s1.log("ns").append([{ cell: ref("a"), data: 1 }]);
        await s1.kv("ns").set("k", [1, 2]);
        const seq = await s1.changeSeq();
        s1.close();
        const s2 = await open();
        expect((await s2.cells("ns").get([ref("a")]))[0]).toMatchObject({ value: "persist", version: 1 });
        expect((await s2.log("ns").list()).map((r) => r.data)).toEqual([1]);
        expect(await s2.kv("ns").get("k")).toEqual([1, 2]);
        expect(await s2.changeSeq()).toBe(seq);
      });

      it("変更番号は書き込みのたびに 1 ずつ増える", async () => {
        const s = await open();
        const start = await s.changeSeq();
        await s.cells("ns").set([
          { ...ref("a"), value: 1 },
          { ...ref("b"), value: 2 },
        ]);
        expect(await s.changeSeq()).toBe(start + 1);
        await s.log("ns").append([{ data: 1 }]);
        await s.kv("ns").set("k", 1);
        await s.kv("ns").setMany({ a: 1, b: 2 });
        await s.kv("ns").delete("k");
        await s.cells("ns").renameEntry("r1", "a", "c");
        await s.log("ns").renameEntry("r1", "a", "c");
        expect(await s.changeSeq()).toBe(start + 7);
        // 読み取りと空の書き込みでは増えない。
        await s.cells("ns").get([ref("a")]);
        await s.cells("ns").set([]);
        await s.log("ns").append([]);
        expect(await s.changeSeq()).toBe(start + 7);
      });

      it("別の接続の書き込みに変更番号で気づける", async () => {
        const a = await open();
        const b = await open();
        const before = await b.changeSeq();
        await a.kv("ns").set("k", 1);
        expect(await b.changeSeq()).toBe(before + 1);
        expect(await b.kv("ns").get("k")).toBe(1);
      });

      it("close は何度呼んでもよく、閉じた後の操作は分かるエラーになる", async () => {
        const s = await open();
        s.close();
        s.close();
        await expect(s.cells("ns").get([ref("a")])).rejects.toThrow(/閉じられています/);
        await expect(s.cells("ns").set([{ ...ref("a"), value: 1 }])).rejects.toThrow(/閉じられています/);
        await expect(s.kv("ns").set("k", 1)).rejects.toThrow(/閉じられています/);
        await expect(s.changeSeq()).rejects.toThrow(/閉じられています/);
      });
    });

    // 速さ（時間の予算）は store.perf.test.ts で、単独で走らせて確かめる（`npm run test:perf`）。
    describe("まとまった量", () => {
      it("10,000 セルを 1 回の set で書き、読み戻せ、版を確かめた更新もまとめてできる", async () => {
        const s = await open();
        const cells = s.cells("perf");
        const writes = Array.from({ length: 10_000 }, (_, i) => ({
          ...ref(`key_${i}`, "status", i % 2 ? "ja" : "en", `res${i % 7}`),
          value: { i, text: `値 ${i}` },
        }));
        const written = await cells.set(writes);
        expect(written.every((c) => c.version === 1)).toBe(true);
        const got = await cells.get(writes);
        expect(got).toHaveLength(10_000);
        expect(got[0]?.value).toEqual({ i: 0, text: "値 0" });
        expect(got[9999]?.value).toEqual({ i: 9999, text: "値 9999" });
        // 2 回目は全件が更新（版 2）。
        const again = await cells.set(writes.map((w) => ({ ...w, value: { i: w.value.i, text: "更新" }, expectedVersion: 1 })));
        expect(again).toHaveLength(10_000);
        expect(again.every((c) => c.version === 2)).toBe(true);
        expect((await cells.get([writes[5000]!]))[0]?.value).toEqual({ i: 5000, text: "更新" });
        // 版が 1 つでも合わなければ、10,000 件のどれも書かない。
        await expect(cells.set(writes.map((w, i) => ({ ...w, value: "x", expectedVersion: i === 9999 ? 1 : 2 })))).rejects.toThrow();
        expect((await cells.get([writes[0]!]))[0]).toMatchObject({ value: { i: 0, text: "更新" }, version: 2 });
      });
    });
  });
}
