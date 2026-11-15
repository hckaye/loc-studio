import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RevisionConflictError } from "@loc-studio/sdk";
import type { Change, ColumnSource, Format, Plugin, PluginHost, TreeContext, ProjectConfig, TextSyntax, TextToken, TreeNode, TreeProvider } from "@loc-studio/sdk";
import { combineSyntaxes, DEFAULT_COLUMNS, openProject } from "./project.js";
import { createPluginHost } from "./host.js";
import { createMemoryDb } from "./memory-db.js";

const sdkPath = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));

let tmp: string;
let root: string;
let appDir: string;
let userDataDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-project-"));
  root = path.join(tmp, "proj");
  appDir = path.join(tmp, "app");
  userDataDir = path.join(tmp, "user");
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function put(abs: string, content: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}
const putConfig = (config: Partial<ProjectConfig>) =>
  put(path.join(root, "loc-studio.project.json"), JSON.stringify({ languages: LANGS, ...config }));

const LANGS = [
  { id: "ja", label: "日本語" },
  { id: "en", label: "English", basedOn: "ja" },
];

/** options.dir の直下のファイルを並べるだけのツリー。 */
const fakeTree: TreeProvider = {
  id: "builtin.globTree",
  async list(ctx) {
    const dir = String(ctx.options.dir ?? ".");
    const names = (await readdir(path.join(ctx.projectRoot, dir))).sort();
    const children: TreeNode[] = names.map((name) => {
      const rel = `${dir}/${name}`;
      return { id: rel, name, kind: "resource", resource: { id: rel, path: rel, name } };
    });
    return [{ id: dir, name: dir, kind: "folder", children }];
  },
  async read(resource, ctx) {
    return new Uint8Array(await readFile(path.join(ctx.projectRoot, ...resource.path.split("/"))));
  },
  async write(resource, data, ctx) {
    await writeFile(path.join(ctx.projectRoot, ...resource.path.split("/")), data);
  },
};

/** "key=ja|en" の行を読むフォーマット。 */
const makeLinesFormat = (id: string, ext: string, syntax?: string): Format => ({
  id,
  ...(syntax ? { syntax } : {}),
  match: (r) => r.path.endsWith(ext),
  parse(input, ctx) {
    const text = new TextDecoder().decode(input);
    const entries = text
      .split("\n")
      .filter((l) => l.includes("="))
      .map((line) => {
        const [key = "", rest = ""] = line.split("=");
        const values = rest.split("|");
        const t: Record<string, string> = {};
        ctx.languages.forEach((l, i) => {
          if (values[i] !== undefined) t[l.id] = values[i]!;
        });
        return { key, text: t, meta: { opt: ctx.options.tag } };
      });
    return { entries };
  },
  apply(original, changes, ctx) {
    const lines = new TextDecoder().decode(original).split("\n");
    for (const c of changes) {
      if (c.type !== "set" || c.field.kind !== "text") continue;
      const idx = ctx.languages.findIndex((l) => c.field.kind === "text" && l.id === c.field.language);
      const field = c.field;
      lines.forEach((line, i) => {
        const [key, rest = ""] = line.split("=");
        if (key !== c.key || field.kind !== "text") return;
        const values = rest.split("|");
        values[idx] = String(c.value);
        lines[i] = `${key}=${values.join("|")}`;
      });
    }
    return new TextEncoder().encode(lines.join("\n"));
  },
});

/** 正規表現に合う部分を指定の種類にする記法。 */
const regexSyntax = (id: string, re: RegExp, kind: TextToken["kind"]): TextSyntax => ({
  id,
  tokenize(text) {
    const out: TextToken[] = [];
    let pos = 0;
    for (const m of text.matchAll(new RegExp(re.source, "g"))) {
      const start = m.index ?? 0;
      if (start > pos) out.push({ kind: "text", value: text.slice(pos, start), range: { start: pos, end: start } });
      out.push({ kind, value: m[0], range: { start, end: start + m[0].length } });
      pos = start + m[0].length;
    }
    if (pos < text.length) out.push({ kind: "text", value: text.slice(pos), range: { start: pos, end: text.length } });
    return out;
  },
});

const builtin: Plugin = {
  name: "fake-builtin",
  trees: [fakeTree],
  formats: [makeLinesFormat("lines", ".txt"), makeLinesFormat("kv", ".kv"), makeLinesFormat("tagged", ".tg", "tag")],
  syntaxes: [regexSyntax("brace", /\{[^}]*\}/, "variable"), regexSyntax("tag", /<[^>]*>/, "tag")],
  validators: [{ id: "builtin.v", label: "v", version: "1", validate: () => [] }],
};

const pluginSrc = (body: string) => `export default ${body};`;

async function setupStandard(): Promise<void> {
  await putConfig({
    tree: { use: "builtin.globTree", options: { dir: "data" } },
    formats: [
      { use: "lines", match: "data/special.*", options: { tag: "glob" } },
      { use: "unknown.format" },
      { use: "lines", options: { tag: "match" } },
      { use: "kv" },
    ],
    syntaxes: ["brace", "tag"],
    validators: ["builtin.v", { use: "project.v", severity: "warning", languages: ["en"], options: { n: 1 } }, "nope.v"],
  });
  await put(path.join(root, "data", "a.txt"), "hello=こんにちは|Hello\nbye=さようなら|Bye");
  await put(path.join(root, "data", "special.dat"), "s=特別|Special");
  await put(path.join(root, "data", "z.unknown"), "x");
  // app 層と project 層で同じ id のバリデータを出し、project が勝つことを見る。
  await put(
    path.join(appDir, "plugins", "app.mjs"),
    pluginSrc(`{ name: "app-plugin", validators: [{ id: "project.v", label: "from-app", version: "1", validate: () => [] }] }`),
  );
  await put(
    path.join(root, "loc-studio-plugins", "studio.ts"),
    `import { definePlugin } from "@loc-studio/sdk";
     export default definePlugin({ name: "studio-plugin", validators: [{ id: "project.v", label: "from-project", version: "1", validate: () => [] }] });`,
  );
  await put(path.join(root, "loc-studio-plugins", "broken.mjs"), pluginSrc(`{ name: "broken", validators: [{ id: "b" }] }`));
}

describe("openProject", () => {
  it("一通りの流れ", async () => {
    await setupStandard();
    const project = await openProject(root, { builtins: [builtin], appDir, userDataDir, env: {}, sdkPath });

    expect(project.root).toBe(path.resolve(root));
    expect(project.languages.map((l) => l.id)).toEqual(["ja", "en"]);
    expect(project.language("en")?.basedOn).toBe("ja");
    expect(project.language("xx")).toBeUndefined();
    expect(project.columns()).toEqual(DEFAULT_COLUMNS);
    expect(project.configFromCode).toEqual([]);
    expect(project.pluginDirs.map((d) => d.layer)).toEqual(["app", "project", "local"]);

    // 読み込めないプラグインがあっても開ける。
    expect(project.pluginErrors).toHaveLength(1);
    expect(project.pluginErrors[0]?.path).toContain("broken.mjs");

    // project 層が app 層を上書きする。
    const entry = project.registry.list("validator").find((e) => e.id === "project.v");
    expect(entry?.origin.layer).toBe("project");
    expect(entry?.value.label).toBe("from-project");
    expect(project.warnings.some((w) => w.includes("app-plugin") && w.includes("studio-plugin"))).toBe(true);
    expect(project.warnings.some((w) => w.includes("unknown.format"))).toBe(true);
    expect(project.warnings.some((w) => w.includes("nope.v"))).toBe(true);

    // ツリーとリソース。
    const tree = await project.tree();
    expect(tree[0]?.kind).toBe("folder");
    const resources = await project.resources();
    expect(resources.map((r) => r.path)).toEqual(["data/a.txt", "data/special.dat", "data/z.unknown"]);
    const [a, special, unknown] = resources as [(typeof resources)[0], (typeof resources)[0], (typeof resources)[0]];

    // フォーマットの選択（glob、match、該当なし）。
    expect(project.formatFor(special)).toMatchObject({ options: { tag: "glob" } });
    expect(project.formatFor(special)?.format.id).toBe("lines");
    expect(project.formatFor(a)).toMatchObject({ options: { tag: "match" } });
    expect(project.formatFor(unknown)).toBeUndefined();

    const doc = await project.readDocument(a);
    expect(doc.format.id).toBe("lines");
    expect(doc.document.entries.map((e) => [e.key, e.text.en, e.meta?.opt])).toEqual([
      ["hello", "Hello", "match"],
      ["bye", "Bye", "match"],
    ]);
    await expect(project.readDocument(unknown)).rejects.toThrow("data/z.unknown");

    // 変更の書き戻し。
    const changes: Change[] = [{ type: "set", key: "bye", field: { kind: "text", language: "en" }, value: "Goodbye" }];
    await project.applyChanges(a, changes);
    expect(await readFile(path.join(root, "data", "a.txt"), "utf8")).toBe("hello=こんにちは|Hello\nbye=さようなら|Goodbye");

    // 記法の組み合わせ。
    const tokenize = project.tokenizer();
    const tokens = tokenize("Hi {name}, <b>go</b>!");
    expect(tokens.map((t) => [t.kind, t.value])).toEqual([
      ["text", "Hi "],
      ["variable", "{name}"],
      ["text", ", "],
      ["tag", "<b>"],
      ["text", "go"],
      ["tag", "</b>"],
      ["text", "!"],
    ]);
    // フォーマットが記法を指定していればそれだけを使う。
    const tagged = project.registry.require("format", "tagged");
    expect(project.tokenizer(tagged)("{x}<i>").map((t) => t.kind)).toEqual(["text", "tag"]);

    // バリデータの解決。
    const vs = project.resolveValidators();
    expect(vs.map((v) => v.validator.id)).toEqual(["builtin.v", "project.v"]);
    expect(vs[0]).toEqual({ validator: builtin.validators![0], options: {} });
    expect(vs[1]).toMatchObject({ severity: "warning", languages: ["en"], options: { n: 1 } });
    expect(vs[1]?.validator.label).toBe("from-project");
  });

  it("formats を省略すると登録されたフォーマットの match で選ぶ。validators を省略すると空", async () => {
    await putConfig({ tree: { use: "builtin.globTree", options: { dir: "d" } } });
    await put(path.join(root, "d", "x.kv"), "k=a|b");
    const project = await openProject(root, { builtins: [builtin], env: {}, sdkPath });
    const [res] = await project.resources();
    expect(project.formatFor(res!)?.format.id).toBe("kv");
    expect(project.resolveValidators()).toEqual([]);
    // syntaxes を省略すると登録された記法すべて。
    expect(project.tokenizer()("{a}<b>").map((t) => t.kind)).toEqual(["variable", "tag"]);
  });

  it("tree の既定は builtin.globTree、未登録なら tree() が分かるエラー", async () => {
    await putConfig({});
    const project = await openProject(root, { builtins: [], env: {}, sdkPath });
    expect(project.warnings.some((w) => w.includes("builtin.globTree"))).toBe(true);
    await expect(project.tree()).rejects.toThrow(/builtin\.globTree/);
  });

  it("local 層は plugins.local で全部、plugins.local.<欄> で種類ごとに禁止できる", async () => {
    await put(
      path.join(userDataDir, "plugins", "mine.mjs"),
      pluginSrc(`{ name: "mine", validators: [{ id: "my.v", label: "m", version: "1", validate: () => [] }], syntaxes: [{ id: "my.s", tokenize: () => [] }] }`),
    );
    // 同じものを project 層に置いても禁止されないことも見る。
    await put(path.join(root, "loc-studio-plugins", "proj.mjs"), pluginSrc(`{ name: "proj", syntaxes: [{ id: "proj.s", tokenize: () => [] }] }`));

    await putConfig({ localSettings: { enforce: { "plugins.local": "deny" } } });
    let project = await openProject(root, { builtins: [builtin], userDataDir, env: {}, sdkPath });
    expect(project.registry.get("validator", "my.v")).toBeUndefined();
    expect(project.registry.get("syntax", "my.s")).toBeUndefined();
    expect(project.registry.get("syntax", "proj.s")).toBeDefined();
    expect(project.warnings.filter((w) => w.includes("禁止"))).toHaveLength(2);

    await putConfig({ localSettings: { enforce: { "plugins.local.validators": "deny" } } });
    project = await openProject(root, { builtins: [builtin], userDataDir, env: {}, sdkPath });
    expect(project.registry.get("validator", "my.v")).toBeUndefined();
    expect(project.registry.get("syntax", "my.s")).toBeDefined();
    expect(project.warnings.filter((w) => w.includes("禁止"))).toHaveLength(1);

    await putConfig({});
    project = await openProject(root, { builtins: [builtin], userDataDir, env: {}, sdkPath });
    expect(project.registry.get("validator", "my.v")).toBeDefined();
  });

  it("環境変数のフォルダは app 層として読み、project 層に負ける", async () => {
    await putConfig({});
    const envDir = path.join(tmp, "envplugins");
    await put(path.join(envDir, "e.mjs"), pluginSrc(`{ name: "env", syntaxes: [{ id: "s", tokenize: () => [] }, { id: "envonly", tokenize: () => [] }] }`));
    await put(path.join(root, "loc-studio-plugins", "p.mjs"), pluginSrc(`{ name: "proj", syntaxes: [{ id: "s", tokenize: () => [] }] }`));
    const project = await openProject(root, { env: { LOC_STUDIO_PLUGIN_DIRS: envDir }, sdkPath });
    const list = project.registry.list("syntax");
    expect(list.find((e) => e.id === "s")?.pluginName).toBe("proj");
    expect(list.find((e) => e.id === "envonly")?.origin).toEqual({ layer: "app", path: path.join(envDir, "e.mjs") });
  });

  it("reload で設定とプラグインを読み直す", async () => {
    await putConfig({ name: "v1", columns: [{ id: "key", kind: "key", scope: "entry" }] });
    const pluginFile = path.join(root, "loc-studio-plugins", "p.ts");
    await put(pluginFile, pluginSrc(`{ name: "p", validators: [{ id: "x", label: "old", version: "1", validate: () => [] }] }`));
    const project = await openProject(root, { env: {}, sdkPath });
    expect(project.config.name).toBe("v1");
    expect(project.columns()).toHaveLength(1);
    expect(project.registry.require("validator", "x").label).toBe("old");

    await putConfig({ name: "v2" });
    await writeFile(pluginFile, pluginSrc(`{ name: "p", validators: [{ id: "x", label: "new", version: "2", validate: () => [] }] }`));
    await project.reload();
    expect(project.config.name).toBe("v2");
    expect(project.columns()).toEqual(DEFAULT_COLUMNS);
    expect(project.registry.require("validator", "x").label).toBe("new");

    // 壊れた設定で reload すると例外になり、前の状態が残る。
    await put(path.join(root, "loc-studio.project.json"), "{ broken");
    await expect(project.reload()).rejects.toThrow("loc-studio.project.json");
    expect(project.config.name).toBe("v2");
  });

  it("コードの設定のキーは configFromCode に出る", async () => {
    await putConfig({ name: "json" });
    await put(path.join(root, "loc-studio.config.ts"), `export default { name: "code" };`);
    const project = await openProject(root, { env: {}, sdkPath });
    expect(project.config.name).toBe("code");
    expect(project.configFromCode).toEqual(["name"]);
  });
});

describe("combineSyntaxes", () => {
  const brace = regexSyntax("brace", /\{[^}]*\}/, "variable");
  const tag = regexSyntax("tag", /<[^>]*>/, "tag");

  it("記法がなければ text 1 つ、空文字は空配列", () => {
    expect(combineSyntaxes([])("abc")).toEqual([{ kind: "text", value: "abc", range: { start: 0, end: 3 } }]);
    expect(combineSyntaxes([brace])("")).toEqual([]);
  });

  it("前の記法の text だけを次の記法で分け、途切れなく全体を覆う", () => {
    const text = "<a>{x}</a> y {z}";
    const tokens = combineSyntaxes([tag, brace])(text);
    expect(tokens.map((t) => t.value).join("")).toBe(text);
    let pos = 0;
    for (const t of tokens) {
      expect(t.range.start).toBe(pos);
      expect(text.slice(t.range.start, t.range.end)).toBe(t.value);
      pos = t.range.end;
    }
    expect(pos).toBe(text.length);
    expect(tokens.map((t) => t.kind)).toEqual(["tag", "variable", "tag", "text", "variable"]);
  });

  it("前の記法がタグにした中は次の記法で分けない", () => {
    expect(combineSyntaxes([tag, brace])("<{x}>").map((t) => t.kind)).toEqual(["tag"]);
  });

  it("隙間のある結果は text で埋め、重なる結果は記法の id を含むエラー", () => {
    const sparse: TextSyntax = { id: "sparse", tokenize: () => [{ kind: "control", value: "\\n", range: { start: 2, end: 4 } }] };
    expect(combineSyntaxes([sparse])("ab\\ncd").map((t) => [t.kind, t.value])).toEqual([
      ["text", "ab"],
      ["control", "\\n"],
      ["text", "cd"],
    ]);
    const bad: TextSyntax = {
      id: "bad.syntax",
      tokenize: () => [
        { kind: "text", value: "ab", range: { start: 0, end: 2 } },
        { kind: "text", value: "b", range: { start: 1, end: 2 } },
      ],
    };
    expect(() => combineSyntaxes([bad])("ab")).toThrow("bad.syntax");
  });
});

describe("openProject / ホスト、列、リソースの入出力", () => {
  /** ファイルを使わず、メモリ上のリソースを読み書きするツリー（ネットワークの API の代わり）。 */
  function memoryTree() {
    const files = new Map<string, Uint8Array>([["mem/a.txt", new TextEncoder().encode("hello=こんにちは|Hello")]]);
    const revs = new Map<string, number>([["mem/a.txt", 1]]);
    const contexts: TreeContext[] = [];
    const writes: { path: string; opts: unknown }[] = [];
    const tree: TreeProvider = {
      id: "mem.tree",
      async list(ctx) {
        contexts.push(ctx);
        return [...files.keys()].map((p) => ({ id: p, name: p, kind: "resource" as const, resource: { id: p, path: p, name: p } }));
      },
      async read(resource, ctx) {
        contexts.push(ctx);
        const data = files.get(resource.path);
        if (!data) throw new Error("ない");
        return data;
      },
      async write(resource, data, ctx, opts) {
        contexts.push(ctx);
        writes.push({ path: resource.path, opts });
        const rev = String(revs.get(resource.path) ?? 0);
        if (opts?.expectedRevision !== undefined && opts.expectedRevision !== rev) throw new Error(`版が違います: ${rev}`);
        files.set(resource.path, data);
        revs.set(resource.path, (revs.get(resource.path) ?? 0) + 1);
      },
      async revision(resource, ctx) {
        contexts.push(ctx);
        const r = revs.get(resource.path);
        return r === undefined ? undefined : String(r);
      },
    };
    return { tree, files, contexts, writes };
  }

  const dummySource = (id: string): ColumnSource => ({ id, saveMode: "immediate", load: async () => [], save: async () => [] });

  it("host を省略するとメモリの DB と利用者 unknown。渡せばそれを使い、TreeContext にも入る", async () => {
    const mem = memoryTree();
    await putConfig({ tree: "mem.tree" });
    const plugin: Plugin = { name: "mem", trees: [mem.tree], formats: [makeLinesFormat("lines", ".txt")] };

    const p1 = await openProject(root, { builtins: [plugin], env: { X: "1" }, sdkPath });
    expect(p1.host.user.name).toBe("unknown");
    expect(p1.host.projectRoot).toBe(path.resolve(root));
    expect(p1.host.env).toEqual({ X: "1" });
    await p1.host.db.kv("t").set("a", 1);
    expect(await p1.host.db.kv("t").get("a")).toBe(1);

    let name = "alice";
    const host: PluginHost = createPluginHost({ db: createMemoryDb(), userName: () => name, projectRoot: root, env: {} });
    const p2 = await openProject(root, { builtins: [plugin], env: {}, sdkPath, host });
    expect(p2.host).toBe(host);
    await p2.tree();
    expect(mem.contexts.at(-1)?.host).toBe(host);
    name = "bob";
    expect(p2.host.user.name).toBe("bob");
    await p2.reload();
    expect(p2.host).toBe(host);
  });

  it("リソースの入出力はすべて TreeProvider を通る。expectedRevision を渡す", async () => {
    const mem = memoryTree();
    await putConfig({ tree: "mem.tree" });
    const plugin: Plugin = { name: "mem", trees: [mem.tree], formats: [makeLinesFormat("lines", ".txt")] };
    const project = await openProject(root, { builtins: [plugin], env: {}, sdkPath });
    const [res] = await project.resources();
    expect(res?.path).toBe("mem/a.txt");

    expect(new TextDecoder().decode(await project.readBytes(res!))).toBe("hello=こんにちは|Hello");
    expect(await project.revision(res!)).toBe("1");

    const changes: Change[] = [{ type: "set", key: "hello", field: { kind: "text", language: "en" }, value: "Hi" }];
    await project.applyChanges(res!, changes, { expectedRevision: "1" });
    expect(mem.writes.at(-1)).toEqual({ path: "mem/a.txt", opts: { expectedRevision: "1" } });
    expect(new TextDecoder().decode(mem.files.get("mem/a.txt"))).toBe("hello=こんにちは|Hi");
    await expect(project.applyChanges(res!, changes, { expectedRevision: "1" })).rejects.toThrow("版が違います");

    await project.writeBytes(res!, new TextEncoder().encode("x=1|2"));
    expect(mem.writes.at(-1)?.opts).toBeUndefined();
    expect(await project.revision(res!)).toBe("3");
    await expect(project.readBytes({ id: "nope", path: "nope", name: "nope" })).rejects.toThrow("nope");

    // revision を持たないプロバイダーでは undefined。
    const { revision: _r, ...noRev } = mem.tree;
    const p2 = await openProject(root, { builtins: [{ name: "mem2", trees: [noRev as TreeProvider] }], env: {}, sdkPath });
    expect(await p2.revision(res!)).toBeUndefined();
  });

  it("readWithRevision / readDocument は中身と版を一緒に返す。provider の readWithRevision があればそれだけを使う", async () => {
    const mem = memoryTree();
    await putConfig({ tree: "mem.tree" });
    const plugin: Plugin = { name: "mem", trees: [mem.tree], formats: [makeLinesFormat("lines", ".txt")] };
    const project = await openProject(root, { builtins: [plugin], env: {}, sdkPath });
    const [res] = await project.resources();
    // readWithRevision がないプロバイダーでは revision → read。
    const r1 = await project.readWithRevision(res!);
    expect(new TextDecoder().decode(r1.data)).toBe("hello=こんにちは|Hello");
    expect(r1.revision).toBe("1");
    const d1 = await project.readDocument(res!);
    expect(d1.revision).toBe("1");
    expect(d1.document.entries.map((e) => e.key)).toEqual(["hello"]);

    let reads = 0;
    let revisions = 0;
    let combined = 0;
    const tree: TreeProvider = {
      ...mem.tree,
      async read(r, c) {
        reads++;
        return mem.tree.read(r, c);
      },
      async revision(r, c) {
        revisions++;
        return mem.tree.revision!(r, c);
      },
      async readWithRevision(r) {
        combined++;
        return { data: mem.files.get(r.path)!, revision: "etag-7" };
      },
    };
    const p2 = await openProject(root, { builtins: [{ name: "mem2", trees: [tree], formats: [makeLinesFormat("lines", ".txt")] }], env: {}, sdkPath });
    const d2 = await p2.readDocument(res!);
    expect(d2.revision).toBe("etag-7");
    expect((await p2.readWithRevision(res!)).revision).toBe("etag-7");
    expect({ reads, revisions, combined }).toEqual({ reads: 0, revisions: 0, combined: 2 });
  });

  it("write が投げた RevisionConflictError はそのままの型で届く", async () => {
    const mem = memoryTree();
    await putConfig({ tree: "mem.tree" });
    const tree: TreeProvider = {
      ...mem.tree,
      async write(r) {
        throw new RevisionConflictError(r.id);
      },
    };
    const project = await openProject(root, { builtins: [{ name: "mem", trees: [tree], formats: [makeLinesFormat("lines", ".txt")] }], env: {}, sdkPath });
    const [res] = await project.resources();
    const changes: Change[] = [{ type: "set", key: "hello", field: { kind: "text", language: "en" }, value: "Hi" }];
    await expect(project.applyChanges(res!, changes, { expectedRevision: "1" })).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(project.writeBytes(res!, new Uint8Array([1]), { expectedRevision: "1" })).rejects.toBeInstanceOf(RevisionConflictError);
  });

  it("columns は use を解決し、問題は warnings に入る。columnSource と sourceContext", async () => {
    const plugin: Plugin = {
      name: "cols",
      trees: [fakeTree],
      sources: [dummySource("p.db")],
      columns: [
        { id: "p.status", kind: "meta", scope: "language", source: "p.db", label: "状態" },
        { id: "p.key", kind: "key", scope: "entry" },
      ],
    };
    await putConfig({
      sources: { team: { use: "p.db", options: { namespace: "team" } }, bad: "missing.source" },
      columns: [
        { use: "p.key", id: "key" },
        { id: "text", kind: "text", scope: "language" },
        { use: "p.status", id: "status", source: "team" },
        { use: "p.status", id: "status2" },
        { use: "unknown.column" },
      ],
    });
    const host = createPluginHost({ db: createMemoryDb(), userName: () => "u", projectRoot: root, env: {} });
    const project = await openProject(root, { builtins: [plugin], env: {}, sdkPath, host });
    const columns = project.columns();
    expect(columns.map((c) => c.id)).toEqual(["key", "text", "status", "status2"]);
    expect(columns[2]).toMatchObject({ kind: "meta", label: "状態", source: "team" });
    expect(project.warnings.some((w) => w.includes("unknown.column"))).toBe(true);
    expect(project.warnings.some((w) => w.includes("missing.source"))).toBe(true);

    // 返した配列を書き換えても状態は変わらない。
    columns[0]!.label = "changed";
    expect(project.columns()[0]?.label).toBeUndefined();

    const team = project.columnSource(columns[2]!);
    expect(team).toMatchObject({ name: "team", options: { namespace: "team" } });
    expect(team?.source.id).toBe("p.db");
    expect(project.columnSource(columns[3]!)).toMatchObject({ name: "p.db", options: {} });
    expect(project.columnSource(columns[1]!)).toBeUndefined();
    expect(project.sourceContext(team!)).toEqual({ projectRoot: path.resolve(root), options: { namespace: "team" }, host });
  });
});
