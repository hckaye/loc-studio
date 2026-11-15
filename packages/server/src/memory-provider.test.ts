/**
 * リソースがファイルにない（メモリ上の TreeProvider）場合と、CSV でないフォーマットで、端から端まで動くこと。
 */
import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RevisionConflictError } from "@loc-studio/sdk";
import type { Change, Format, Plugin, TreeProvider } from "@loc-studio/sdk";
import type { Workspace } from "./api-types.js";
import { makeTestProject } from "./testing.js";
import type { TestProject } from "./testing.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** メモリ上のリソース。版は書くたびに増える。 */
const store = new Map<string, { data: Uint8Array; rev: number }>();
let writes = 0;

const memTree: TreeProvider = {
  id: "mem.tree",
  async list() {
    return [
      {
        id: "remote",
        name: "remote",
        kind: "folder",
        children: [...store.keys()].sort().map((id) => ({ id, name: id, kind: "resource" as const, resource: { id, path: id, name: id } })),
      },
    ];
  },
  async read(resource) {
    const r = store.get(resource.id);
    if (!r) throw new Error(`ない: ${resource.id}`);
    return r.data.slice();
  },
  async write(resource, data, _ctx, opts) {
    const r = store.get(resource.id);
    if (opts?.expectedRevision !== undefined && String(r?.rev) !== opts.expectedRevision) throw new RevisionConflictError(resource.id);
    writes++;
    store.set(resource.id, { data: data.slice(), rev: (r?.rev ?? 0) + 1 });
  },
  async revision(resource) {
    const r = store.get(resource.id);
    return r ? String(r.rev) : undefined;
  },
};

/** 1 行 1 エントリの "key=ja|en" 形式。変えた行だけを書き換える。 */
const pipeFormat: Format = {
  id: "mem.pipe",
  match: (r) => r.path.endsWith(".pipe"),
  parse(input, ctx) {
    const langs = ctx.languages.map((l) => l.id);
    const entries = dec
      .decode(input)
      .split("\n")
      .filter((l) => l.includes("="))
      .map((line, i) => {
        const [key, rest] = line.split("=") as [string, string];
        const parts = rest.split("|");
        return { key, text: Object.fromEntries(langs.map((l, j) => [l, parts[j] ?? ""])), location: { line: i + 1 } };
      });
    return { entries };
  },
  apply(original, changes: Change[], ctx) {
    const langs = ctx.languages.map((l) => l.id);
    const lines = dec.decode(original).split("\n");
    for (const c of changes) {
      if (c.type !== "set" || c.field.kind !== "text") throw new Error("未対応の変更");
      const lang = c.field.language;
      const i = lines.findIndex((l) => l.startsWith(`${c.key}=`));
      if (i < 0) throw new Error(`キーがありません: ${c.key}`);
      const parts = lines[i]!.slice(c.key.length + 1).split("|");
      parts[langs.indexOf(lang)] = String(c.value);
      lines[i] = `${c.key}=${parts.join("|")}`;
    }
    return enc.encode(lines.join("\n"));
  },
};

const memPlugin: Plugin = { name: "mem", trees: [memTree], formats: [pipeFormat] };

let tp: TestProject;
let ws: Workspace;
beforeEach(async () => {
  store.clear();
  writes = 0;
  store.set("a.pipe", { data: enc.encode("# comment line\nhello=こんにちは|Hello\nbye=さようなら|Bye\n"), rev: 1 });
  tp = await makeTestProject({ sample: false, plugins: [memPlugin] });
  await tp.write(
    "loc-studio.project.json",
    JSON.stringify({
      name: "Remote",
      languages: [
        { id: "ja", label: "日本語" },
        { id: "en", label: "英語", basedOn: "ja" },
      ],
      tree: "mem.tree",
      formats: [{ use: "mem.pipe" }],
      columns: [
        { use: "builtin.key", id: "key" },
        { use: "builtin.text", id: "text" },
        { use: "builtin.textStatus", id: "status" },
        { use: "builtin.reviewStatus", id: "review", of: "text" },
      ],
      validators: ["builtin.untranslated"],
    }),
  );
  ws = await tp.open();
});
afterEach(async () => {
  await tp.cleanup();
});

describe("メモリ上のリソース + 独自フォーマット", () => {
  it("rows / setText / save / setCell / postReview", async () => {
    const tree = await ws.tree();
    expect(tree[0]!.children!.map((c) => c.id)).toEqual(["a.pipe"]);

    let r = await ws.rows({ resourceId: "a.pipe", languages: ["ja", "en"], offset: 0, limit: 10 });
    expect(r.rows.map((x) => x.key)).toEqual(["hello", "bye"]);
    expect(r.revision).toBe("1");
    expect(r.rows[0]!.cells["text@en"]!.value).toBe("Hello");
    expect(r.rows[0]!.cells["status@en"]).toEqual({ value: "todo" });

    await ws.setText({ resourceId: "a.pipe", key: "bye", language: "en", value: "Goodbye" });
    expect(await ws.save({ resourceId: "a.pipe" })).toEqual({ saved: 1, conflicts: [] });
    expect(dec.decode(store.get("a.pipe")!.data)).toBe("# comment line\nhello=こんにちは|Hello\nbye=さようなら|Goodbye\n");
    expect(writes).toBe(1);

    const c = await ws.setCell({ resourceId: "a.pipe", key: "bye", cellId: "status@en", value: "done" });
    expect(c).toMatchObject({ value: "done", version: 1 });
    const post = await ws.postReview({ resourceId: "a.pipe", key: "bye", cellId: "review@en", verdict: "ok", comment: "よい" });
    expect(post.stale).toBe(false);

    r = await ws.rows({ resourceId: "a.pipe", languages: ["en"], offset: 0, limit: 10 });
    expect(r.revision).toBe("2");
    expect(r.rows[1]!.cells).toMatchObject({
      "text@en": { value: "Goodbye" },
      "status@en": { value: "done", version: 1 },
      "review@en": { value: "ok" },
    });
    const h = await ws.history({ resourceId: "a.pipe", key: "bye" });
    expect(h.map((x) => x.cause).sort()).toEqual(["manual", "manual", "review"]);

    // プロジェクトのフォルダにはリソースのファイルを作っていない。
    const files = (await readdir(tp.root)).filter((f) => f !== ".loc-studio");
    expect(files).toEqual(["loc-studio.project.json"]);
  });

  it("TreeProvider の版が変わったら自動で読み直す", async () => {
    await ws.rows({ resourceId: "a.pipe", languages: ["en"], offset: 0, limit: 10 });
    store.set("a.pipe", { data: enc.encode("hello=やあ|Hi\n"), rev: 5 });
    const r = await ws.rows({ resourceId: "a.pipe", languages: ["en"], offset: 0, limit: 10 });
    expect(r.rows.map((x) => x.cells["text@en"]!.value)).toEqual(["Hi"]);
    expect(r.revision).toBe("5");
  });

  it("書く直前に版が変わっていたら読み直して当て直す", async () => {
    await ws.setText({ resourceId: "a.pipe", key: "hello", language: "en", value: "Hey" });
    // read() のあと write() の前に誰かが書いたことにする（最初の write だけ版をずらす）。
    const origWrite = memTree.write;
    let first = true;
    memTree.write = async (res, data, ctx, opts) => {
      if (first) {
        first = false;
        const cur = store.get(res.id)!;
        store.set(res.id, { data: enc.encode(dec.decode(cur.data).replace("Bye", "Bye!")), rev: cur.rev + 1 });
      }
      return origWrite.call(memTree, res, data, ctx, opts);
    };
    try {
      expect(await ws.save({ resourceId: "a.pipe" })).toEqual({ saved: 1, conflicts: [] });
    } finally {
      memTree.write = origWrite;
    }
    expect(dec.decode(store.get("a.pipe")!.data)).toBe("# comment line\nhello=こんにちは|Hey\nbye=さようなら|Bye!\n");
  });

  it("版の競合以外の書き込みの失敗はやり直さず、メッセージのまま失敗にし、ドラフトを残す", async () => {
    await ws.setText({ resourceId: "a.pipe", key: "hello", language: "en", value: "Hey" });
    const origWrite = memTree.write;
    let calls = 0;
    memTree.write = async () => {
      calls++;
      throw new Error("認証に失敗しました（HTTP 401）");
    };
    try {
      const err = await ws.save({ resourceId: "a.pipe" }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "failed" });
      expect((err as Error).message).toContain("認証に失敗しました（HTTP 401）");
    } finally {
      memTree.write = origWrite;
    }
    expect(calls).toBe(1);
    expect((await ws.tree())[0]!.unsaved).toBe(1);
    expect(await ws.save({ resourceId: "a.pipe" })).toEqual({ saved: 1, conflicts: [] });
  });

  it("版の競合が続いたら上限回数で conflict にする", async () => {
    await ws.setText({ resourceId: "a.pipe", key: "hello", language: "en", value: "Hey" });
    const origWrite = memTree.write;
    let calls = 0;
    memTree.write = async (res) => {
      calls++;
      throw new RevisionConflictError(res.id);
    };
    try {
      await expect(ws.save({ resourceId: "a.pipe" })).rejects.toMatchObject({ code: "conflict" });
    } finally {
      memTree.write = origWrite;
    }
    expect(calls).toBe(3);
    expect((await ws.tree())[0]!.unsaved).toBe(1);
  });

  it("rows を続けて呼んでも、間隔の間は TreeProvider の revision を呼ばない", async () => {
    const origRevision = memTree.revision!;
    let revisions = 0;
    memTree.revision = async (res, ctx) => {
      revisions++;
      return origRevision.call(memTree, res, ctx);
    };
    try {
      const slow = await tp.open({ revisionCheckIntervalMs: 60_000 });
      // 最初の読み込みは revision → read（このツリーには readWithRevision がない）。
      await slow.rows({ resourceId: "a.pipe", languages: ["en"], offset: 0, limit: 10 });
      expect(revisions).toBe(1);
      revisions = 0;
      for (let i = 0; i < 5; i++) await slow.rows({ resourceId: "a.pipe", languages: ["en"], offset: 0, limit: 10 });
      await slow.rowDetail({ resourceId: "a.pipe", key: "hello" });
      expect(revisions).toBe(0);
      // save は必ず読み直す（版は読み込みと一緒に取る）。
      await slow.setText({ resourceId: "a.pipe", key: "bye", language: "en", value: "Ciao" });
      await slow.save({ resourceId: "a.pipe" });
      expect(dec.decode(store.get("a.pipe")!.data)).toContain("Ciao");
    } finally {
      memTree.revision = origRevision;
    }
  });
});
