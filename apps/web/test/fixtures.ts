import { vi } from "vitest";
import type { CellInfo, ExportQueryRequest, ProjectInfo, QueryRequest, RowInfo, RowsRequest, WorkspaceApi } from "@loc-studio/server";

type R<K extends keyof WorkspaceApi> = Awaited<ReturnType<WorkspaceApi[K]>>;
import type { ClientApi } from "@/lib/client/api";

/* テスト用のプロジェクトとモックの API。値はテストデータなので、言語 ID やステータスを直接書いてよい。 */

export function makeInfo(over: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    name: "TestGame",
    root: "/tmp/test",
    languages: [
      { id: "ja", label: "日本語", pinned: true },
      { id: "en", label: "英語", basedOn: "ja" },
    ],
    columns: [
      { id: "key", kind: "key", scope: "entry" },
      { id: "note", kind: "meta", scope: "entry", label: "メモ", type: "string" },
      { id: "text", kind: "text", scope: "language" },
      {
        id: "status",
        kind: "meta",
        scope: "language",
        label: "状態",
        type: { enum: [{ value: "todo", label: "未着手", color: "gray" }, { value: "done", label: "完了", color: "green", complete: true }], default: "todo" },
      },
      {
        id: "review",
        kind: "review",
        scope: "language",
        of: "text",
        label: "レビュー",
        type: { enum: [{ value: "none", label: "未レビュー" }, { value: "back", label: "差し戻し", color: "red", requireComment: true }, { value: "ok", label: "承認", color: "green", complete: true }], default: "none" },
      },
      { id: "maxLen", kind: "meta", scope: "entry", label: "上限", type: "number" },
      { id: "back", kind: "generated", scope: "language", label: "逆翻訳", generator: "llm", languages: ["en"] },
      { id: "tools", kind: "actions", scope: "language", label: "操作", actions: ["ticket"] },
    ],
    languageSets: {},
    grid: { pinCommon: true, maxPinnedRatio: 0.9, progressUnit: "rows" },
    editor: { referenceLanguages: [], count: { unit: "codepoints", skipTokens: false } },
    user: { name: "tester", source: "local", locked: false },
    storage: { path: "/tmp/test/.loc-studio/meta.db", shared: false },
    actions: [{ id: "ticket", label: "チケット", target: "cell" }],
    reviewTargets: [],
    validators: [],
    blockComplete: false,
    warnings: [],
    pluginErrors: [],
    changeSeq: 1,
    localSettings: {},
    untrustedPlugins: 0,
    permissions: { role: "manager", can: { edit: true, review: true, run: true, structure: true, manage: true } },
    roles: [
      { id: "viewer", label: "閲覧" },
      { id: "translator", label: "翻訳" },
      { id: "reviewer", label: "レビュー" },
      { id: "manager", label: "管理" },
    ],
    renderers: [],
    ...over,
  };
}

export function makeRow(i: number): RowInfo {
  const cells: Record<string, CellInfo> = {
    key: { value: `KEY_${i}` },
    note: { value: `memo${i}` },
    maxLen: { value: 10 },
    "text@ja": { value: `日本語${i}` },
    "text@en": { value: i === 1 ? "" : `English ${i}`, ...(i === 2 ? { draft: true, saved: "Saved 2", issues: [{ validatorId: "v", code: "c", message: "変数が足りません", severity: "error" as const }] } : {}) },
    "status@ja": { value: "todo", version: 3 },
    "status@en": { value: "done", version: 5 },
    "review@ja": { value: "none" },
    "review@en": { value: "ok", stale: true },
    "back@en": { value: `back ${i}`, generated: i === 0 ? "stale" : "fresh" },
    // 計算列（テストで columns に足したときだけ表に出る）
    "length@ja": { value: 3 + i },
    "length@en": { value: null, error: "本文を数えられませんでした" },
  };
  return { key: `KEY_${i}`, index: i, cells };
}

export function mockApi(info: ProjectInfo, rowCount = 3) {
  const rows = Array.from({ length: rowCount }, (_, i) => makeRow(i));
  const api = {
    info: vi.fn(async () => info),
    tree: vi.fn(async (): Promise<R<"tree">> => [{ id: "res", name: "res.csv", kind: "resource", resource: { id: "res.csv", path: "res.csv", name: "res.csv" } }]),
    stats: vi.fn(async (): Promise<R<"stats">> => []),
    rows: vi.fn(async (req: RowsRequest) => ({ total: rows.length, totalAll: rows.length, rows: rows.slice(req.offset, req.offset + req.limit), diagnostics: [] })),
    rowDetail: vi.fn(async ({ key }: { key: string }) => ({ row: rows.find((r) => r.key === key)!, languages: info.languages.map((l) => l.id) })),
    history: vi.fn(async () => []),
    reviews: vi.fn(async (): Promise<R<"reviews">> => []),
    textVersion: vi.fn(async () => ({})),
    validateText: vi.fn(async (_p: { value: string }) => [] as import("@loc-studio/server").IssueInfo[]),
    settings: vi.fn(async () => ({ local: [], localFile: "/tmp/settings.json", project: { languages: info.languages }, projectFromCode: [], projectFile: "/tmp/test/loc-studio.project.json", available: { columns: [], validators: [] } })),
    plugins: vi.fn(async (): Promise<R<"plugins">> => ({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [] })),
    pluginSettings: vi.fn(async (): Promise<R<"pluginSettings">> => []),
    setPluginSettings: vi.fn(async (_params: Parameters<WorkspaceApi["setPluginSettings"]>[0]): Promise<R<"setPluginSettings">> => []),
    trustPlugins: vi.fn(async (): Promise<ProjectInfo> => ({ ...info, untrustedPlugins: 0 })),
    untrustPlugins: vi.fn(async (): Promise<ProjectInfo> => info),
    validate: vi.fn(),
    jobs: vi.fn(async () => []),
    job: vi.fn(),
    changes: vi.fn(async () => ({ changeSeq: 1, changed: false, localSeq: 0 })),
    setText: vi.fn(async ({ value }: { value: string }) => ({ cell: { value, draft: true, issues: [] }, unsaved: 1 })),
    discardDrafts: vi.fn(async () => ({ unsaved: 0 })),
    save: vi.fn(async (): Promise<R<"save">> => ({ saved: 1, conflicts: [] })),
    saveAll: vi.fn(async (): Promise<R<"saveAll">> => ({ resources: 1, saved: 1, conflicts: 0, conflictList: [] })),
    setCell: vi.fn(async ({ value }: { value: unknown }) => ({ value, version: 6 })),
    setCells: vi.fn(async (_params: Parameters<WorkspaceApi["setCells"]>[0]): Promise<R<"setCells">> => ({ updated: 0, blocked: [] })),
    postReview: vi.fn(async (_params: Parameters<WorkspaceApi["postReview"]>[0]): Promise<R<"postReview">> => {
      throw new Error("postReview のモックに、テストで使う戻り値を入れてください。");
    }),
    forwardReview: vi.fn(),
    runAction: vi.fn(async (_params: Parameters<WorkspaceApi["runAction"]>[0]): Promise<R<"runAction">> => ({ patched: 0 })),
    generate: vi.fn(async () => ({ total: 1, cached: 0, toRun: 1 })),
    cancelJob: vi.fn(),
    editEntries: vi.fn(async (): Promise<R<"editEntries">> => ({ entries: rowCount })),
    createResource: vi.fn(async ({ path }: { path: string }): Promise<R<"createResource">> => ({ resource: { id: path, path, name: path.split("/").pop()! } })),
    setLocalSetting: vi.fn(async () => []),
    updateProjectSettings: vi.fn(async (_params: { patch: Record<string, unknown> }) => info),
    reloadPlugins: vi.fn(async () => info),
    reloadResource: vi.fn(),
    search: vi.fn(async (): Promise<R<"search">> => []),
    query: vi.fn(async (_req: QueryRequest): Promise<R<"query">> => ({ matched: { rows: 0, characters: 0, words: 0 }, totalRows: 0, resources: [], unreadable: [], rows: [] })),
    exportQuery: vi.fn(async (_req: ExportQueryRequest): Promise<R<"exportQuery">> => ({ text: "", rows: 0, truncated: false })),
    uiState: vi.fn(async (): Promise<R<"uiState">> => ({ state: null })),
    setUiState: vi.fn(async (_params: { state: Record<string, unknown> | null }): Promise<R<"setUiState">> => ({ saved: true })),
    // {name} の形を変数として分ける、簡単な記法。
    tokens: vi.fn(async ({ texts }: { texts: string[] }): Promise<R<"tokens">> =>
      texts.map((text) => {
        const out: R<"tokens">[number] = [];
        let pos = 0;
        for (const m of text.matchAll(/\{[^}]*\}/g)) {
          if (m.index > pos) out.push({ kind: "text", value: text.slice(pos, m.index), range: { start: pos, end: m.index } });
          out.push({ kind: "variable", value: m[0], range: { start: m.index, end: m.index + m[0].length } });
          pos = m.index + m[0].length;
        }
        if (pos < text.length) out.push({ kind: "text", value: text.slice(pos), range: { start: pos, end: text.length } });
        return out;
      }),
    ),
  };
  // モックの形がサービス層（WorkspaceApi）とずれたら、ここで型のエラーになる（メソッドの過不足と、戻り値の形）。
  // 中身のない vi.fn() は、テストが自分で戻り値を決めるメソッド。
  api satisfies { [K in keyof WorkspaceApi]: (...args: never[]) => Promise<R<K>> };
  const _noExtra: Exclude<keyof typeof api, keyof WorkspaceApi> extends never ? true : never = true;
  void _noExtra;
  return { api: api as unknown as ClientApi & typeof api, rows };
}
