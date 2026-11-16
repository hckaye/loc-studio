import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import picomatch from "picomatch";
import { RevisionConflictError } from "@loc-studio/sdk";
import type { ResourceRef, TreeContext, TreeNode, TreeProvider } from "@loc-studio/sdk";

const DEFAULT_INCLUDE = ["**/*.csv", "**/*.tsv"];
const DEFAULT_EXCLUDE = ["**/node_modules/**", "**/.git/**", "**/.loc-studio/**", "loc-studio-plugins/**"];

function stringList(value: unknown, fallback: string[], name: string): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`globTree のオプション ${name} は文字列の配列で指定してください。`);
  }
  return value as string[];
}

function byName(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

/** プロジェクトのルートの外を指すパスは受け付けない（".." などによる抜け出し対策）。 */
function resolveInside(root: string, relPath: string): string {
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, ...relPath.split("/"));
  const rel = path.relative(absRoot, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`プロジェクトのルートの外は扱えません: ${relPath}`);
  }
  return target;
}

async function walk(
  absDir: string,
  relDir: string,
  isIncluded: (p: string) => boolean,
  isExcluded: (p: string) => boolean,
): Promise<TreeNode[]> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`フォルダを読み取れませんでした: ${absDir}（${(e as Error).message}）`);
  }
  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    // シンボリックリンクは辿らない（Dirent は lstat 相当なので isFile/isDirectory が false になる）
    if (entry.isDirectory()) {
      if (isExcluded(rel) || isExcluded(`${rel}/`)) continue;
      const children = await walk(path.join(absDir, entry.name), rel, isIncluded, isExcluded);
      if (children.length > 0) nodes.push({ id: rel, name: entry.name, kind: "folder", children });
    } else if (entry.isFile()) {
      if (isExcluded(rel) || !isIncluded(rel)) continue;
      const resource: ResourceRef = { id: rel, path: rel, name: entry.name };
      nodes.push({ id: rel, name: entry.name, kind: "resource", resource });
    }
  }
  return nodes.sort(byName);
}

/** ファイルの版: 更新時刻（ナノ秒）と大きさ。ファイルがなければ undefined。 */
async function fileRevision(file: string): Promise<string | undefined> {
  try {
    const st = await stat(file, { bigint: true });
    return `${st.mtimeNs.toString(36)}-${st.size.toString(36)}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`ファイルの版を確かめられませんでした: ${file}（${(e as Error).message}）`);
  }
}

/** 中身と版を、同じファイルハンドルから読む（読んでいる途中で置き換えられても取り違えない）。 */
async function readFileWithRevision(file: string): Promise<{ data: Uint8Array; revision: string }> {
  let handle;
  try {
    handle = await open(file, "r");
    const st = await handle.stat({ bigint: true });
    const data = new Uint8Array(await handle.readFile());
    return { data, revision: `${st.mtimeNs.toString(36)}-${st.size.toString(36)}` };
  } catch (e) {
    throw new Error(`ファイルを読み込めませんでした: ${file}（${(e as Error).message}）`);
  } finally {
    await handle?.close();
  }
}

/**
 * フォルダの中の、ツリーの対象になるファイルの一覧（globTree の list と同じ決まり）。
 * プロジェクトを作る前に、そのフォルダにすでにあるファイルを確かめるためにも使う。
 */
export async function listGlobTree(projectRoot: string, options: Record<string, unknown> = {}): Promise<TreeNode[]> {
  const include = stringList(options["include"], DEFAULT_INCLUDE, "include");
  const exclude = stringList(options["exclude"], DEFAULT_EXCLUDE, "exclude");
  const opts = { dot: true };
  const isIncluded = picomatch(include, opts);
  const isExcluded = exclude.length > 0 ? picomatch(exclude, opts) : () => false;
  return walk(path.resolve(projectRoot), "", isIncluded, isExcluded);
}

/** フォルダの中のファイルを読む（globTree の read と同じ決まり。フォルダの外は読まない）。 */
export async function readGlobTreeFile(projectRoot: string, resourcePath: string): Promise<Uint8Array> {
  return (await readFileWithRevision(resolveInside(projectRoot, resourcePath))).data;
}

export const globTree: TreeProvider = {
  id: "builtin.globTree",

  async list(ctx: TreeContext): Promise<TreeNode[]> {
    return listGlobTree(ctx.projectRoot, ctx.options);
  },

  async read(resource: ResourceRef, ctx: TreeContext): Promise<Uint8Array> {
    return readGlobTreeFile(ctx.projectRoot, resource.path);
  },

  async readWithRevision(resource: ResourceRef, ctx: TreeContext): Promise<{ data: Uint8Array; revision?: string }> {
    return readFileWithRevision(resolveInside(ctx.projectRoot, resource.path));
  },

  async revision(resource: ResourceRef, ctx: TreeContext): Promise<string | undefined> {
    return fileRevision(resolveInside(ctx.projectRoot, resource.path));
  },

  async create(resourcePath: string, data: Uint8Array, ctx: TreeContext): Promise<ResourceRef> {
    if (typeof resourcePath !== "string" || resourcePath === "" || resourcePath.includes("\\") || resourcePath.split("/").some((p) => p === "" || p === "." || p === "..")) {
      throw new Error(`リソースの場所は、プロジェクトからの相対パス（区切りは "/"）で指定してください: ${JSON.stringify(resourcePath)}`);
    }
    // ツリーに出ない場所には作らない（作っても一覧に出ず、開けないため）。
    const include = stringList(ctx.options["include"], DEFAULT_INCLUDE, "include");
    const exclude = stringList(ctx.options["exclude"], DEFAULT_EXCLUDE, "exclude");
    const opts = { dot: true };
    if (!picomatch(include, opts)(resourcePath) || (exclude.length > 0 && picomatch(exclude, opts)(resourcePath))) {
      throw new Error(`${resourcePath} は、ツリーの対象（include: ${include.join(", ")}）に入らない場所です。`);
    }
    const file = resolveInside(ctx.projectRoot, resourcePath);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      // "wx": すでにあれば失敗する（上書きしない）。
      await writeFile(file, data, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${resourcePath} はすでにあります。`);
      throw new Error(`ファイルを作れませんでした: ${file}（${(e as Error).message}）`);
    }
    return { id: resourcePath, path: resourcePath, name: path.basename(file) };
  },

  async write(resource: ResourceRef, data: Uint8Array, ctx: TreeContext, opts?: { expectedRevision?: string }): Promise<void> {
    const file = resolveInside(ctx.projectRoot, resource.path);
    const dir = path.dirname(file);
    // 同じフォルダに一時ファイルを作ってから置き換え、途中で失敗しても元のファイルを壊さない
    const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, data);
      // 置き換える直前に版を確かめ、読んだあとで書き換えられていたら書かない。
      if (opts?.expectedRevision !== undefined) {
        const current = await fileRevision(file);
        if (current !== opts.expectedRevision) {
          throw new RevisionConflictError(
            resource.id,
            `ファイル ${file} は読み込んだあとで書き換えられています（読み込んだ版 ${opts.expectedRevision}、いまの版 ${current ?? "なし"}）。`,
          );
        }
      }
      await rename(tmp, file);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      if (e instanceof RevisionConflictError) throw e;
      throw new Error(`ファイルを書き込めませんでした: ${file}（${(e as Error).message}）`);
    }
  },
};
