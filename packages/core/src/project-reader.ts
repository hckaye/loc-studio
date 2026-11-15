/**
 * プラグインがプロジェクトのリソースと行を読む窓口（PluginHost.project）の実装。
 * リソースは Project（TreeProvider と Format）経由でしか読まないので、リソースが外部の API にあっても同じに動く。
 */
import type { CellRef, ColumnDef, Entry, EntryData, LanguageId, ProjectReader, ResourceRef, RowReader, RowSnapshot } from "@loc-studio/sdk";
import { columnAppliesTo, FILE_SOURCE } from "./columns.js";
import type { ResolvedColumnSource } from "./columns.js";
import type { Project } from "./project.js";

export interface ProjectReaderDeps {
  /** 読む対象のプロジェクト。設定の読み直しに追従するよう、使うたびに呼ぶ。 */
  project: () => Project;
  /** リソースの一覧。省略時は Project.resources()。サービス層は、いまの利用者に見えるものだけを返す実装を渡す。 */
  resources?: () => Promise<ResourceRef[]>;
  /** リソースの行。省略時は Project.readDocument で毎回読む。サービス層は、解析結果のキャッシュを使う実装を渡す。 */
  entries?: (resourceId: string) => Promise<{ resource: ResourceRef; entries: EntryData[] }>;
  /** 未保存の本文（あれば、保存済みの本文の代わりに返す）。 */
  draftText?: (resourceId: string, key: string, language: LanguageId) => string | undefined;
}

const isFileColumn = (column: ColumnDef): boolean => column.kind === "meta" && (column.source === undefined || column.source === FILE_SOURCE);

const enumDefault = (column: ColumnDef): unknown =>
  typeof column.type === "object" && column.type !== null && Array.isArray(column.type.enum) ? column.type.default : undefined;

const valueKey = (entryKey: string, columnId: string, language: LanguageId | undefined): string => `${entryKey}\u0000${columnId}\u0000${language ?? ""}`;

/**
 * プロジェクトにつながっていないホスト用の窓口（列ソースだけを単体で動かすときなど）。
 * 使おうとすると、理由の分かる例外にする（黙って空を返すと、プラグインの不具合に見えてしまうため）。
 */
export function unavailableProjectReader(): ProjectReader {
  const fail = (): never => {
    throw new Error("このホストはプロジェクトにつながっていないため、host.project は使えません（openProject かサービス層が作ったホストで使ってください）。");
  };
  return {
    get languages() {
      return fail();
    },
    get columns() {
      return fail();
    },
    resources: async () => fail(),
    rows: async () => fail(),
  };
}

export function createProjectReader(deps: ProjectReaderDeps): ProjectReader {
  const resources = deps.resources ?? (() => deps.project().resources());
  const readEntries =
    deps.entries ??
    (async (resourceId: string) => {
      const resource = (await resources()).find((r) => r.id === resourceId);
      if (!resource) throw new Error(`リソース "${resourceId}" が見つかりません。`);
      const { document } = await deps.project().readDocument(resource);
      return { resource, entries: document.entries };
    });

  async function rows(resourceId: string, opts: { keys?: string[]; columns?: string[] } = {}): Promise<RowSnapshot[]> {
    const project = deps.project();
    const { resource, entries: all } = await readEntries(resourceId);
    const wanted = opts.keys ? new Set(opts.keys) : undefined;
    const entries = wanted ? all.filter((e) => wanted.has(e.key)) : all;
    const columns = project.columns();
    const byId = new Map(columns.map((c) => [c.id, c]));
    const languages = project.languages.map((l) => l.id);

    // 列ソースの値は、列ソースごとに 1 回の呼び出しでまとめて読む。
    const groups = new Map<string, { resolved: ResolvedColumnSource; refs: CellRef[] }>();
    const loaded = new Set<string>();
    for (const column of columns) {
      if (opts.columns && !opts.columns.includes(column.id)) continue;
      const resolved = project.columnSource(column);
      if (!resolved) continue;
      loaded.add(column.id);
      let g = groups.get(resolved.name);
      if (!g) {
        g = { resolved, refs: [] };
        groups.set(resolved.name, g);
      }
      const langs = column.scope === "entry" ? [undefined] : languages.filter((l) => columnAppliesTo(column, l));
      for (const e of entries) {
        for (const language of langs) {
          const ref: CellRef = { resourceId: resource.id, entryKey: e.key, columnId: column.id };
          if (language !== undefined) ref.language = language;
          g.refs.push(ref);
        }
      }
    }
    const values = new Map<string, unknown>();
    await Promise.all(
      [...groups.values()].map(async ({ resolved, refs }) => {
        if (refs.length === 0) return;
        try {
          for (const v of await resolved.source.load(refs, project.sourceContext(resolved))) values.set(valueKey(v.entryKey, v.columnId, v.language), v.value);
        } catch (err) {
          throw new Error(`列ソース "${resolved.name}" から値を読めませんでした（リソース ${resource.id}）: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );

    const textOf = (data: EntryData, language: LanguageId): string | undefined => deps.draftText?.(resource.id, data.key, language) ?? data.text[language];
    const reader = (data: EntryData): RowReader => ({
      text: (language) => textOf(data, language),
      get(columnId, language) {
        const column = byId.get(columnId);
        if (column?.kind === "text") return language === undefined ? undefined : textOf(data, language);
        if (column?.kind === "key") return data.key;
        // 設定にない ID は、リソースの中の列（フォーマットが meta に入れた値）として引く。
        if (!column || isFileColumn(column)) return language === undefined ? data.meta?.[columnId] : data.languageMeta?.[language]?.[columnId];
        if (!loaded.has(columnId)) return undefined;
        const v = values.get(valueKey(data.key, columnId, column.scope === "language" ? language : undefined));
        return v === undefined ? enumDefault(column) : v;
      },
    });

    return entries.map((data) => {
      const entry: Entry = { key: data.key, resource };
      if (data.stableId !== undefined) entry.stableId = data.stableId;
      if (data.meta !== undefined) entry.meta = data.meta;
      return { entry, row: reader(data) };
    });
  }

  return {
    get languages() {
      return deps.project().languages;
    },
    get columns() {
      return deps.project().columns();
    },
    resources,
    rows,
  };
}
