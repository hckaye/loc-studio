import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RevisionConflictError } from "@loc-studio/sdk";
import type { TreeContext, TreeNode } from "@loc-studio/sdk";
import { globTree } from "./glob-tree.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "globtree-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(rel: string, content = "x"): Promise<void> {
  const file = path.join(root, ...rel.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
const ctx = (options: Record<string, unknown> = {}): TreeContext => ({ projectRoot: root, options });
function flat(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "folder" ? [`${n.id}/`, ...flat(n.children ?? [])] : [n.id]));
}

describe("globTree.list", () => {
  it("階層を作り、フォルダ優先・数値順で並べる", async () => {
    await put("b.csv");
    await put("a10.csv");
    await put("a2.csv");
    await put("zdir/x.tsv");
    await put("adir/sub/y.csv");
    const tree = await globTree.list(ctx());
    expect(tree.map((n) => n.name)).toEqual(["adir", "zdir", "a2.csv", "a10.csv", "b.csv"]);
    const adir = tree[0]!;
    expect(adir.kind).toBe("folder");
    expect(adir.children?.[0]?.id).toBe("adir/sub");
    const leaf = adir.children?.[0]?.children?.[0];
    expect(leaf?.kind).toBe("resource");
    expect(leaf?.resource).toEqual({ id: "adir/sub/y.csv", path: "adir/sub/y.csv", name: "y.csv" });
  });

  it("既定の include / exclude を使う", async () => {
    await put("a.csv");
    await put("a.txt");
    await put("node_modules/p/x.csv");
    await put(".git/x.csv");
    await put(".loc-studio/x.csv");
    await put("loc-studio-plugins/x.csv");
    expect(flat(await globTree.list(ctx()))).toEqual(["a.csv"]);
  });

  it("include / exclude を指定できる", async () => {
    await put("a.json");
    await put("a.csv");
    await put("skip/b.json");
    const tree = await globTree.list(ctx({ include: ["**/*.json"], exclude: ["skip/**"] }));
    expect(flat(tree)).toEqual(["a.json"]);
  });

  it("一致するものがないフォルダは出さない", async () => {
    await put("empty/readme.txt");
    await mkdir(path.join(root, "blank"));
    await put("full/a.csv");
    expect(flat(await globTree.list(ctx()))).toEqual(["full/", "full/a.csv"]);
  });

  it("ルートに一致がなければ空配列", async () => {
    await put("note.txt");
    expect(await globTree.list(ctx())).toEqual([]);
  });

  it("シンボリックリンクは辿らない", async () => {
    await put("real/a.csv");
    try {
      await symlink(path.join(root, "real"), path.join(root, "link"), "dir");
    } catch {
      return; // 権限がない環境ではスキップ
    }
    expect(flat(await globTree.list(ctx()))).toEqual(["real/", "real/a.csv"]);
  });
});

describe("globTree.read / write", () => {
  const ref = { id: "d/a.csv", path: "d/a.csv", name: "a.csv" };

  it("書いたものを読み戻せ、親フォルダも作る", async () => {
    await globTree.write(ref, new TextEncoder().encode("あ,い"), ctx());
    const data = await globTree.read(ref, ctx());
    expect(new TextDecoder().decode(data)).toBe("あ,い");
  });

  it("上書きしても一時ファイルが残らない", async () => {
    await put("d/a.csv", "old");
    await globTree.write(ref, new TextEncoder().encode("new"), ctx());
    expect(await readFile(path.join(root, "d", "a.csv"), "utf8")).toBe("new");
    expect(await readdir(path.join(root, "d"))).toEqual(["a.csv"]);
  });

  it("失敗したら一時ファイルを残さず、元のファイルも壊さない", async () => {
    // 対象がフォルダなので rename が失敗する
    await mkdir(path.join(root, "d", "a.csv"), { recursive: true });
    await expect(globTree.write(ref, new Uint8Array([1]), ctx())).rejects.toThrow(/書き込めませんでした/);
    expect(await readdir(path.join(root, "d"))).toEqual(["a.csv"]);
  });

  it("revision / readWithRevision: 中身と同じ版を返し、書くと版が変わる。ないファイルは undefined", async () => {
    expect(await globTree.revision!(ref, ctx())).toBeUndefined();
    await put("d/a.csv", "one");
    const r1 = await globTree.readWithRevision!(ref, ctx());
    expect(new TextDecoder().decode(r1.data)).toBe("one");
    expect(r1.revision).toBe(await globTree.revision!(ref, ctx()));
    await globTree.write(ref, new TextEncoder().encode("second"), ctx(), { expectedRevision: r1.revision! });
    const r2 = await globTree.revision!(ref, ctx());
    expect(r2).not.toBe(r1.revision);
    expect(await readFile(path.join(root, "d", "a.csv"), "utf8")).toBe("second");
  });

  it("expectedRevision と違えば RevisionConflictError で、書かず、一時ファイルも残さない", async () => {
    await put("d/a.csv", "one");
    const { revision } = await globTree.readWithRevision!(ref, ctx());
    await put("d/a.csv", "changed outside");
    const err = await globTree.write(ref, new TextEncoder().encode("mine"), ctx(), { expectedRevision: revision! }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevisionConflictError);
    expect((err as RevisionConflictError).resourceId).toBe("d/a.csv");
    expect(await readFile(path.join(root, "d", "a.csv"), "utf8")).toBe("changed outside");
    expect(await readdir(path.join(root, "d"))).toEqual(["a.csv"]);
    // 版を渡さなければ従来どおり上書きする。
    await globTree.write(ref, new TextEncoder().encode("mine"), ctx());
    expect(await readFile(path.join(root, "d", "a.csv"), "utf8")).toBe("mine");
  });

  it("ルートの外を指すパスは拒否する", async () => {
    const bad = { id: "x", path: "../evil.csv", name: "evil.csv" };
    await expect(globTree.read(bad, ctx())).rejects.toThrow(/ルートの外/);
    await expect(globTree.write(bad, new Uint8Array([1]), ctx())).rejects.toThrow(/ルートの外/);
    const bad2 = { id: "x", path: "a/../../evil.csv", name: "evil.csv" };
    await expect(globTree.write(bad2, new Uint8Array([1]), ctx())).rejects.toThrow(/ルートの外/);
  });
});
