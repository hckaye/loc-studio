"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionInfo, CellInfo, JobInfo, ProjectInfo, RowInfo, SearchHit, TreeNodeInfo } from "@loc-studio/server";
import { isRpcError, type ClientApi } from "@/lib/client/api";
import { conflictCurrent, type ConflictCurrent } from "@/lib/client/conflict";
import {
  buildLayout,
  cellIdOf,
  columnLabel,
  enumOptions,
  initialPartialPins,
  initialPins,
  optionLabel,
  textColumnOf,
  type GridColumn,
} from "@/lib/client/model";
import { loadPrefs, savePrefs, type GridPrefs } from "@/lib/client/prefs";
import { StudioProvider, useToasts } from "@/components/context";
import { Grid, selectedRowRange, type GridHandle, type Selection } from "@/components/grid/Grid";
import { useRowPages, type RowQuery } from "@/components/grid/useRowPages";
import { ResourceTree } from "@/components/ResourceTree";
import { EMPTY_FILTERS, Toolbar, type ToolbarFilters } from "@/components/Toolbar";
import { EditModal } from "@/components/EditModal";
import { ReviewPanel } from "@/components/ReviewPanel";
import { ConflictDialog } from "@/components/ConflictDialog";
import { DetailPanel } from "@/components/DetailPanel";
import { LanguagePicker } from "@/components/LanguagePicker";
import { SettingsDialog } from "@/components/SettingsDialog";
import { PluginsDialog } from "@/components/PluginsDialog";
import { JobsIndicator, useJobs } from "@/components/Jobs";
import { GenerateDialog, type GenerateRequest } from "@/components/GenerateDialog";
import { Dialog } from "@/components/Dialog";
import { applyTheme } from "@/components/theme";
import { SaveConflictsDialog, type SaveConflict } from "@/components/SaveConflictsDialog";
import { SearchDialog } from "@/components/SearchDialog";
import { PluginTrustDialog } from "@/components/PluginTrustDialog";
import { defaultRendererLoader, RendererProvider, type RendererLoader } from "@/components/grid/renderers";
import { UserMenu } from "@/components/web/UserMenu";
import { canEdit, canRun, ROLE_LABEL } from "@/lib/client/permissions";
import { openExternal } from "@/lib/client/url";

/* メイン画面: 上のバー、左のツリー、右のツールバーと表、下のステータスバー、各種ダイアログ。 */

const POLL_MS = 4000;
const DEFAULT_VISIBLE_MAX = 8;

/** Web モードのログイン中の利用者と、その操作。 */
export interface WebSession {
  user: { name: string; displayName: string; admin: boolean };
  /** password: パスワードを変えられる。proxy: 前段のプロキシが認証する。 */
  authMode: "password" | "proxy";
  onLogout(): void;
  onOpenAdmin?(): void;
}

export interface StudioProps {
  api: ClientApi;
  project: string;
  initialInfo: ProjectInfo;
  onCloseProject?(): void;
  /** Web モードのとき。 */
  web?: WebSession;
  /** 独自描画のモジュールの読み込み（テストで差し替える）。 */
  rendererLoader?: RendererLoader;
  /** 読み直した info が制限された状態（コードの設定が変わった）になったとき。 */
  onRestricted?(): void;
  /** 設定ファイルを信頼して開いた直後。続けて出るコードの確認に、その旨を出す。 */
  trustContinued?: boolean;
  /** 表の画面を出したとき（1 回）。 */
  onReady?(): void;
  /** 値が変わったら、プロジェクトの情報と表を読み直す（制限された状態から戻ったとき）。 */
  resumeToken?: number;
}

function firstResource(nodes: TreeNodeInfo[]): string | undefined {
  for (const n of nodes) {
    if (n.kind === "resource" && n.resource) return n.resource.id;
    const c = n.children && firstResource(n.children);
    if (c) return c;
  }
  return undefined;
}

function findNode(nodes: TreeNodeInfo[], resourceId: string): TreeNodeInfo | undefined {
  for (const n of nodes) {
    if (n.kind === "resource" && n.resource?.id === resourceId) return n;
    const c = n.children && findNode(n.children, resourceId);
    if (c) return c;
  }
  return undefined;
}

function totalUnsaved(nodes: TreeNodeInfo[]): number {
  return nodes.reduce((s, n) => s + (n.kind === "resource" ? n.unsaved ?? 0 : totalUnsaved(n.children ?? [])), 0);
}

type Conflict = { row: RowInfo; gc: GridColumn; mine: unknown; current: ConflictCurrent | undefined };

export function Studio({ api, project, initialInfo, onCloseProject, web, rendererLoader, onRestricted, trustContinued, onReady, resumeToken }: StudioProps) {
  const [info, setInfo] = useState<ProjectInfo>(initialInfo);
  // プラグインの再読み込みなどで、コードの設定を信頼し直す必要が出たら、確認の画面に戻す
  useEffect(() => {
    if (info.restricted) onRestricted?.();
  }, [info.restricted, onRestricted]);
  const mode = web ? ("web" as const) : ("local" as const);
  const studio = useMemo(() => ({ api, project, info, setInfo, mode }), [api, project, info, mode]);
  const loader = useMemo(() => rendererLoader ?? defaultRendererLoader(project), [rendererLoader, project]);
  return (
    <StudioProvider value={studio}>
      <RendererProvider loader={loader} renderers={info.renderers ?? []}>
        <StudioInner
          api={api}
          project={project}
          info={info}
          setInfo={setInfo}
          trustContinued={trustContinued === true}
          {...(onReady ? { onReady } : {})}
          {...(resumeToken !== undefined ? { resumeToken } : {})}
          {...(onCloseProject ? { onCloseProject } : {})}
          {...(web ? { web } : {})}
        />
      </RendererProvider>
    </StudioProvider>
  );
}

function StudioInner({
  api,
  project,
  info,
  setInfo,
  onCloseProject,
  web,
  trustContinued,
  onReady,
  resumeToken,
}: {
  api: ClientApi;
  project: string;
  info: ProjectInfo;
  setInfo(i: ProjectInfo): void;
  onCloseProject?(): void;
  web?: WebSession;
  trustContinued?: boolean;
  onReady?(): void;
  resumeToken?: number;
}) {
  const { push, reportError } = useToasts();
  const langIds = useMemo(() => info.languages.map((l) => l.id), [info.languages]);

  // ---- 画面の状態（プロジェクトごとに覚える）
  const [prefs, setPrefs] = useState<GridPrefs>(() => loadPrefs(project));
  useEffect(() => savePrefs(project, prefs), [project, prefs]);
  const visibleLanguages = useMemo(() => {
    const v = prefs.visibleLanguages?.filter((id) => langIds.includes(id));
    return v && v.length > 0 ? v : langIds.slice(0, DEFAULT_VISIBLE_MAX);
  }, [prefs.visibleLanguages, langIds]);
  const pins = useMemo(() => (prefs.pinnedLanguages ?? initialPins(info)).filter((id) => langIds.includes(id)), [prefs.pinnedLanguages, info, langIds]);
  const partialPins = useMemo(() => prefs.partialPins ?? initialPartialPins(info), [prefs.partialPins, info]);
  const density = prefs.density ?? 1;
  const showDetail = prefs.showDetail ?? false;
  const widths = useMemo(() => prefs.widths ?? {}, [prefs.widths]);
  const [viewportWidth, setViewportWidth] = useState(0);

  const layout = useMemo(
    () => buildLayout({ info, visibleLanguages, pinnedLanguages: pins, partialPins, widths, viewportWidth }),
    [info, visibleLanguages, pins, partialPins, widths, viewportWidth],
  );

  // ---- ツリーとリソース
  const [tree, setTree] = useState<TreeNodeInfo[]>([]);
  const [resourceId, setResourceId] = useState<string | undefined>();
  const [statsToken, setStatsToken] = useState(0);
  const loadTree = useCallback(async () => {
    try {
      const t = await api.tree();
      setTree(t);
      return t;
    } catch (err) {
      reportError(err, "ツリーの読み込み");
      return undefined;
    }
  }, [api, reportError]);
  useEffect(() => {
    void loadTree().then((t) => {
      if (t) setResourceId((cur) => cur ?? firstResource(t));
    });
  }, [loadTree]);

  // テーマ（ローカル設定 ui.theme。info.localSettings に解決済みの値がある）
  const themeSetting = info.localSettings?.["ui.theme"];
  useEffect(() => {
    applyTheme(typeof themeSetting === "string" ? themeSetting : "light");
  }, [themeSetting]);

  // ---- 行
  const [filters, setFilters] = useState<ToolbarFilters>(EMPTY_FILTERS);
  const query: RowQuery | null = useMemo(() => {
    if (!resourceId) return null;
    const vf = Object.entries(filters.values)
      .filter(([cellId, vals]) => vals.length > 0 && (!cellId.includes("@") || visibleLanguages.includes(cellId.split("@")[1]!)))
      .map(([cellId, values]) => ({ cellId, values }));
    return {
      resourceId,
      languages: visibleLanguages,
      ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
      ...(vf.length ? { filters: vf } : {}),
      ...(filters.onlyUntranslated ? { onlyUntranslated: true } : {}),
      ...(filters.onlyIssues ? { onlyIssues: "warning" as const } : {}),
      ...(filters.onlyStale ? { onlyStale: true } : {}),
      ...(filters.onlyUnsaved ? { onlyUnsaved: true } : {}),
    };
  }, [resourceId, visibleLanguages, filters]);
  const onRowsError = useCallback((err: unknown) => reportError(err, "行の読み込み"), [reportError]);
  const rows = useRowPages(api, query, onRowsError);

  const [selection, setSelection] = useState<Selection>({ row: 0, col: 0, anchor: 0 });
  useEffect(() => setSelection({ row: 0, col: 0, anchor: 0 }), [resourceId]);
  const gridRef = useRef<GridHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ---- 他の人の変更（共有 DB）と自分の別ウィンドウの変更を数秒ごとに確かめる
  const seqRef = useRef({ changeSeq: info.changeSeq, localSeq: -1 });
  const [detailToken, setDetailToken] = useState(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const refreshAll = useCallback(() => {
    rowsRef.current.refresh();
    void loadTree();
    setStatsToken((t) => t + 1);
    setDetailToken((t) => t + 1);
  }, [loadTree]);
  // 表の画面を出したことを伝える（作業の途中で制限された状態になったとき、この画面を残すかどうかの判断に使う）
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    onReadyRef.current?.();
  }, []);
  // 制限された状態から戻ったら、プロジェクトの情報と表を読み直す（開いている編集欄はそのまま）
  const resumeRef = useRef(resumeToken);
  useEffect(() => {
    if (resumeRef.current === resumeToken) return;
    resumeRef.current = resumeToken;
    api
      .info()
      .then((i) => {
        setInfo(i);
        if (!web && i.untrustedPlugins > 0 && !i.restricted) setTrustOpen(true);
        refreshAll();
      })
      .catch((err: unknown) => reportError(err, "プロジェクトの読み直し"));
  }, [resumeToken, api, web, refreshAll, reportError]);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      api
        .changes({ since: seqRef.current.changeSeq })
        .then((c) => {
          const prevLocal = seqRef.current.localSeq;
          const changed = c.changed || c.changeSeq !== seqRef.current.changeSeq || (prevLocal >= 0 && c.localSeq !== prevLocal);
          seqRef.current = { changeSeq: c.changeSeq, localSeq: c.localSeq };
          if (changed) refreshAll();
        })
        .catch((err: unknown) => {
          // 接続が切れたときに通知を出し続けないよう、ネットワークの失敗はコンソールだけ
          if (isRpcError(err, "network")) console.warn(err);
          else reportError(err, "変更の確認");
        });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [api, refreshAll, reportError]);

  // ---- ダイアログ
  const [edit, setEdit] = useState<{ rowIndex: number; gc: GridColumn } | null>(null);
  const [review, setReview] = useState<{ rowKey: string; gc: GridColumn; verdict?: string } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [langPicker, setLangPicker] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [generate, setGenerate] = useState<GenerateRequest | null>(null);
  const [saveConflicts, setSaveConflicts] = useState<SaveConflict[] | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  // 信頼していないプラグインがあれば、開いたときに最初に確認する
  // Web モードではプラグインの確認は出さない（置いたのは管理者）
  const [trustOpen, setTrustOpen] = useState(!web && info.untrustedPlugins > 0);
  const anyDialog =
    edit || review || conflict || langPicker || settingsOpen || pluginsOpen || problemsOpen || generate || saveConflicts || searchOpen || confirmDiscardAll || trustOpen;

  const onJobFinished = useCallback(
    (job: JobInfo) => {
      push(job.status === "done" ? "success" : job.status === "failed" ? "error" : "info", `${job.label}: ${job.status === "done" ? "完了" : job.status === "failed" ? `失敗 ${job.error ?? ""}` : "取消"}`);
      refreshAll();
    },
    [push, refreshAll],
  );
  const jobs = useJobs(onJobFinished);

  // ---- 書き込み
  const patchRow = rows.patchRow;
  const patchCells = useCallback(
    (key: string, cells: Record<string, CellInfo>) => {
      patchRow(key, cells);
      setDetailToken((t) => t + 1);
    },
    [patchRow],
  );

  const setCellValue = useCallback(
    async (row: RowInfo, gc: GridColumn, value: unknown, expectedVersion?: number): Promise<CellInfo | undefined> => {
      if (!resourceId) return undefined;
      const version = expectedVersion ?? row.cells[gc.cellId]?.version;
      try {
        const cell = await api.setCell({ resourceId, key: row.key, cellId: gc.cellId, value, ...(version !== undefined ? { expectedVersion: version } : {}) });
        patchCells(row.key, { [gc.cellId]: cell });
        setStatsToken((t) => t + 1);
        return cell;
      } catch (err) {
        if (isRpcError(err, "conflict")) {
          setConflict({ row, gc, mine: value, current: conflictCurrent(err.data) });
          return undefined;
        }
        reportError(err, `${columnLabel(gc.col)} を変更できませんでした`);
        return undefined;
      }
    },
    [api, resourceId, patchCells, reportError],
  );

  const onEnumChoose = useCallback((row: RowInfo, gc: GridColumn, value: string) => void setCellValue(row, gc, value), [setCellValue]);
  const onCommitMeta = useCallback((row: RowInfo, gc: GridColumn, value: unknown) => void setCellValue(row, gc, value), [setCellValue]);
  const onReviewChoose = useCallback((row: RowInfo, gc: GridColumn, verdict: string) => setReview({ rowKey: row.key, gc, verdict }), []);

  const selectedKeys = useCallback(async (): Promise<string[]> => {
    const [lo, hi] = selectedRowRange(selection);
    const keys: string[] = [];
    for (let i = lo; i <= hi; i++) {
      const r = rowsRef.current.getRow(i) ?? (await rowsRef.current.loadRow(i));
      if (r) keys.push(r.key);
    }
    return keys;
  }, [selection]);

  const onGenerate = useCallback(
    (row: RowInfo, gc: GridColumn) => {
      if (!resourceId) return;
      setGenerate({ column: gc.col, resourceId, keys: [row.key], languages: gc.language ? [gc.language] : visibleLanguages, scope: "cell" });
    },
    [resourceId, visibleLanguages],
  );

  /** アクションの結果の open。ファイルはデスクトップ版なら開き、ブラウザではパスを見せてコピーできるようにする。 */
  const openResult = useCallback(
    (open: NonNullable<Awaited<ReturnType<ClientApi["runAction"]>>["open"]>) => {
      if ("url" in open) {
        // http / https だけを開く。ほかの形式は開かずに文字として知らせる
        if (!openExternal(open.url)) push("warning", `開けない形式の URL のため開きませんでした: ${String(open.url).slice(0, 200)}`);
        return;
      }
      const label = `${open.file}${open.line ? `:${open.line}` : ""}`;
      const opener = window.locStudio?.openPath;
      if (opener) {
        Promise.resolve(opener(open.file, open.line)).catch((err: unknown) => reportError(err, `開けませんでした: ${label}`));
        return;
      }
      push("info", `ファイル: ${label}`, {
        label: "パスをコピー",
        run: () => {
          navigator.clipboard
            ?.writeText(open.file)
            .then(() => push("success", "パスをコピーしました"))
            .catch((err: unknown) => reportError(err, "コピーできませんでした"));
        },
      });
    },
    [push, reportError],
  );

  const runAction = useCallback(
    async (action: ActionInfo, keys: string[], gc?: GridColumn) => {
      if (!resourceId) return;
      try {
        const textCol = textColumnOf(info);
        // cell が対象のアクションには cellId が要る。アクション列のボタンはその言語の本文を対象にする。
        const cellId =
          gc && action.target === "cell"
            ? gc.kind === "actions" && gc.language && textCol
              ? cellIdOf(textCol, gc.language)
              : gc.cellId
            : gc && action.target === "column"
              ? gc.cellId
              : undefined;
        const res = await api.runAction({
          actionId: action.id,
          resourceId,
          ...(keys.length ? { keys } : {}),
          ...(cellId ? { cellId } : {}),
          ...(gc?.language ? { language: gc.language } : {}),
        });
        if (res.jobId) {
          jobs.track(res.jobId);
          push("info", `${action.label} をジョブとして始めました`);
        } else {
          push("success", res.message ?? `${action.label}: ${res.patched} 件を更新しました`);
        }
        for (const e of res.errors ?? []) push("warning", e);
        if (res.open) openResult(res.open);
        if (res.patched > 0) refreshAll();
      } catch (err) {
        reportError(err, `${action.label} を実行できませんでした`);
      }
    },
    [api, resourceId, info, jobs, push, refreshAll, reportError, openResult],
  );
  const onRunAction = useCallback((row: RowInfo, gc: GridColumn, action: ActionInfo) => void runAction(action, [row.key], gc), [runAction]);

  const save = useCallback(async () => {
    if (!resourceId) return;
    try {
      const res = await api.save({ resourceId });
      if (res.conflicts.length > 0) {
        push("warning", `${res.saved} 件を保存しました。${res.conflicts.length} 件はリソースが外部で変更されていたため保存していません`);
        setSaveConflicts(res.conflicts);
      } else push("success", res.saved > 0 ? `${res.saved} 件を保存しました` : "保存する変更はありません");
      refreshAll();
    } catch (err) {
      reportError(err, "保存できませんでした");
    }
  }, [api, resourceId, push, refreshAll, reportError]);

  const saveAll = useCallback(async () => {
    try {
      const res = await api.saveAll();
      push(res.conflicts ? "warning" : "success", `${res.resources} 個のリソースに ${res.saved} 件を保存しました${res.conflicts ? `（競合 ${res.conflicts} 件は未保存）` : ""}`);
      if (res.conflictList.length > 0) setSaveConflicts(res.conflictList);
      refreshAll();
    } catch (err) {
      reportError(err, "すべて保存できませんでした");
    }
  }, [api, push, refreshAll, reportError]);

  // ---- 全体のキー操作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "f" && e.shiftKey) {
        e.preventDefault();
        if (!anyDialog) setSearchOpen(true);
        return;
      }
      if (k === "s") {
        e.preventDefault();
        if (edit) {
          // 編集中の本文はまだドラフトになっていないので、確定してから保存してもらう
          push("info", "編集中の本文を確定（Ctrl+Enter）してから保存してください");
          return;
        }
        if (e.shiftKey) void saveAll();
        else void save();
      } else if (k === "f" && !anyDialog) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, saveAll, anyDialog, edit, push]);

  // 絞り込みで行が減ったら、選択を範囲の中に戻す
  useEffect(() => {
    if (!rows.loaded) return;
    setSelection((s) => (s.row < rows.total ? s : { ...s, row: Math.max(0, rows.total - 1), anchor: Math.max(0, rows.total - 1) }));
  }, [rows.total, rows.loaded]);

  // ---- 言語の表示とピン
  const updatePrefs = useCallback((patch: Partial<GridPrefs>) => setPrefs((p) => ({ ...p, ...patch })), []);
  const togglePin = useCallback(
    (lang: string, part?: "pinned" | "rest") => {
      const nextPartial = { ...partialPins };
      delete nextPartial[lang];
      if (part === "rest") {
        // 一部だけ固定していた言語の、残りの列も固定する
        updatePrefs({ pinnedLanguages: pins.includes(lang) ? pins : [...pins, lang], partialPins: nextPartial });
        return;
      }
      updatePrefs({ pinnedLanguages: pins.includes(lang) ? pins.filter((p) => p !== lang) : [...pins, lang], partialPins: nextPartial });
    },
    [pins, partialPins, updatePrefs],
  );
  const hideLanguage = useCallback(
    (lang: string) => {
      if (visibleLanguages.length <= 1) return push("info", "少なくとも 1 つの言語は表示します");
      updatePrefs({ visibleLanguages: visibleLanguages.filter((l) => l !== lang), pinnedLanguages: pins.filter((p) => p !== lang) });
    },
    [visibleLanguages, pins, updatePrefs, push],
  );
  const onResize = useCallback((cellId: string, width: number) => setPrefs((p) => ({ ...p, widths: { ...(p.widths ?? {}), [cellId]: width } })), []);


  // ---- 横断検索の結果へ移る
  const [pendingJump, setPendingJump] = useState<SearchHit | null>(null);
  const jumpTo = useCallback(
    (hit: SearchHit) => {
      if (hit.language && !visibleLanguages.includes(hit.language)) updatePrefs({ visibleLanguages: [...visibleLanguages, hit.language] });
      // 絞り込みがあると行が見つからないことがあるので外す
      setFilters(EMPTY_FILTERS);
      setResourceId(hit.resourceId);
      setPendingJump(hit);
    },
    [visibleLanguages, updatePrefs],
  );
  useEffect(() => {
    const hit = pendingJump;
    if (!hit || resourceId !== hit.resourceId || !rows.loaded || !query) return;
    if (hit.language && !query.languages.includes(hit.language)) return; // 言語の表示が反映されるのを待つ
    setPendingJump(null);
    void (async () => {
      try {
        const d = await api.rowDetail({ resourceId: hit.resourceId, key: hit.key });
        let idx = d.row.index;
        const r = await rowsRef.current.loadRow(idx);
        if (r?.key !== hit.key) idx = rowsRef.current.findIndex(hit.key);
        if (idx < 0) {
          push("warning", `${hit.key} の行が表に見つかりませんでした`);
          return;
        }
        let col = hit.language ? layout.all.findIndex((c) => c.kind === "text" && c.language === hit.language) : -1;
        if (col < 0) col = Math.max(0, layout.all.findIndex((c) => c.kind === "key"));
        setSelection({ row: idx, col, anchor: idx });
        requestAnimationFrame(() => {
          gridRef.current?.scrollToCell(idx, col);
          gridRef.current?.focus();
        });
      } catch (err) {
        reportError(err, "検索結果の行へ移れませんでした");
      }
    })();
  }, [pendingJump, resourceId, rows.loaded, query, layout, api, push, reportError]);

  const resourceNames = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (nodes: TreeNodeInfo[]) =>
      nodes.forEach((n) => {
        if (n.kind === "resource" && n.resource) map.set(n.resource.id, n.resource.path);
        if (n.children) walk(n.children);
      });
    walk(tree);
    return map;
  }, [tree]);

  const reload = useCallback(async () => {
    if (!resourceId) return;
    try {
      await api.reloadResource({ resourceId });
      push("success", "リソースを読み直しました");
      refreshAll();
    } catch (err) {
      reportError(err, "読み直せませんでした");
    }
  }, [api, resourceId, push, refreshAll, reportError]);

  const discardKeys = useCallback(
    async (keys?: string[]) => {
      if (!resourceId) return;
      try {
        const res = await api.discardDrafts({ resourceId, ...(keys ? { keys } : {}) });
        push("success", `未保存の変更を取り消しました（残り ${res.unsaved} 件）`);
        refreshAll();
      } catch (err) {
        reportError(err, "取り消せませんでした");
      }
    },
    [api, resourceId, push, refreshAll, reportError],
  );

  const columnActions = useCallback(
    (gc: GridColumn) =>
      info.actions.filter(
        (a) =>
          a.target === "column" &&
          (!a.columns || a.columns.includes(gc.col.id)) &&
          (!a.languages || gc.language === undefined || a.languages.includes(gc.language)),
      ),
    [info.actions],
  );
  const onColumnAction = useCallback((gc: GridColumn, a: ActionInfo) => void runAction(a, [], gc), [runAction]);
  const fileActions = useMemo(() => info.actions.filter((a) => a.target === "file"), [info.actions]);

  const setWatching = jobs.setWatching;
  const onJobsOpen = useCallback((o: boolean) => setWatching(o ? 1 : 0), [setWatching]);

  // ---- 表示用の値
  const unsavedTotal = totalUnsaved(tree);
  const currentNode = resourceId ? findNode(tree, resourceId) : undefined;
  const currentUnsaved = currentNode?.unsaved ?? 0;
  const selRow = rows.getRow(selection.row);
  const selCol = layout.all[selection.col];
  const [selLo, selHi] = selectedRowRange(selection);
  const multi = selHi > selLo;
  const problemCount = info.warnings.length + info.pluginErrors.length + rows.diagnostics.length;
  const errorCount = info.pluginErrors.length + rows.diagnostics.filter((d) => d.severity === "error").length;
  const textCol = textColumnOf(info);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" title={info.root}>
          <span className="logo" aria-hidden="true">
            ◧
          </span>
          <span className="project-name">{info.name}</span>
        </div>
        {onCloseProject && (
          <button type="button" className="btn small ghost" onClick={onCloseProject}>
            {web ? "プロジェクト一覧" : "別のプロジェクト"}
          </button>
        )}
        {web && info.permissions && (
          <span className="badge" title={info.permissions.languages ? `担当の言語: ${info.permissions.languages.join(", ")}` : "すべての言語"}>
            {ROLE_LABEL[info.permissions.role] ?? info.permissions.role}
            {info.permissions.languages ? `（${info.permissions.languages.join(", ")}）` : ""}
          </span>
        )}
        <span className="tb-grow" />
        {web ? (
          <UserMenu session={web} />
        ) : (
          <span className="user" title={`ユーザー名（${info.user.locked ? "プロジェクト設定で固定" : "ローカル設定で変更できます"}）`}>
            👤 {info.user.name}
          </span>
        )}
        <button type="button" className="btn small topbar-btn" onClick={() => setSearchOpen(true)} title="プロジェクト全体を検索（Ctrl+Shift+F）">
          🔍 横断検索
        </button>
        <button
          type="button"
          className="btn small topbar-btn"
          disabled={unsavedTotal === 0 || !canEdit(info).ok}
          onClick={() => void saveAll()}
          title={canEdit(info).reason ?? "すべて保存（Ctrl+Shift+S）"}
        >
          すべて保存{unsavedTotal > 0 ? `（${unsavedTotal}）` : ""}
        </button>
        <JobsIndicator jobs={jobs.jobs} active={jobs.active} onCancel={(id) => void jobs.cancel(id)} onOpenChange={onJobsOpen} />
        <button type="button" className="btn small topbar-btn" onClick={() => setPluginsOpen(true)}>
          プラグイン{info.pluginErrors.length > 0 && <span className="count-badge err">{info.pluginErrors.length}</span>}
        </button>
        <button type="button" className="icon-btn topbar-btn" aria-label="設定" title="設定" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </header>
      {!web && info.untrustedPlugins > 0 && !trustOpen && (
        <div className="trust-banner" role="status">
          <span>
            ⚠ {info.untrustedPlugins} 個のプラグインを読み込んでいません。それらが提供するバリデータ・列・アクションなどは使えません。
          </span>
          <button type="button" className="btn small" onClick={() => setTrustOpen(true)}>
            確認する
          </button>
        </div>
      )}
      <div className="main">
        <ResourceTree nodes={tree} selected={resourceId} onSelect={setResourceId} statsToken={statsToken} onError={(err) => reportError(err, "進捗の読み込み")} />
        <section className="content" aria-label="表">
          <Toolbar
            columns={info.columns}
            languages={info.languages}
            visibleLanguages={visibleLanguages}
            filters={filters}
            onFilters={setFilters}
            onOpenLanguages={() => setLangPicker(true)}
            density={density}
            onDensity={(d) => updatePrefs({ density: d })}
            unsaved={currentUnsaved}
            onSave={() => void save()}
            showDetail={showDetail}
            onToggleDetail={() => updatePrefs({ showDetail: !showDetail })}
            searchRef={searchRef}
            fileActions={fileActions}
            onFileAction={(a) => void runAction(a, [])}
            onReload={() => void reload()}
            onDiscardAll={() => setConfirmDiscardAll(true)}
            editDisabledReason={canEdit(info).reason}
            runDisabledReason={canRun(info).reason}
          />
          {multi && resourceId && (
            <BulkBar
              editReason={canEdit(info).reason}
              runReason={canRun(info).reason}
              count={selHi - selLo + 1}
              layout={layout.all}
              actions={info.actions.filter((a) => a.target === "row" || a.target === "selection" || a.target === "cell")}
              onSetEnum={async (gc, value) => {
                const keys = await selectedKeys();
                try {
                  const res = await api.setCells({ resourceId, keys, cellId: gc.cellId, value });
                  push(res.blocked.length ? "warning" : "success", `${res.updated} 行の「${columnLabel(gc.col)}」を変更しました${res.blocked.length ? `（${res.blocked.length} 行は問題があるため変更していません）` : ""}`);
                  refreshAll();
                } catch (err) {
                  reportError(err, "一括で変更できませんでした");
                }
              }}
              onAction={async (a) => runAction(a, await selectedKeys(), selCol)}
              onGenerate={async (gc) => setGenerate({ column: gc.col, resourceId, keys: await selectedKeys(), languages: gc.language ? [gc.language] : visibleLanguages, scope: "selection" })}
              onClear={() => setSelection((s) => ({ ...s, anchor: s.row }))}
            />
          )}
          <div className="grid-area">
            {resourceId ? (
              <Grid
                key={resourceId}
                resourceId={resourceId}
                setCellValue={setCellValue}
                ref={gridRef}
                info={info}
                layout={layout}
                rows={rows}
                density={density}
                selection={selection}
                onSelectionChange={setSelection}
                onOpenEditor={(rowIndex, gc) => setEdit({ rowIndex, gc })}
                onEnumChoose={onEnumChoose}
                onReviewChoose={onReviewChoose}
                onCommitMeta={onCommitMeta}
                onGenerate={onGenerate}
                onRunAction={onRunAction}
                onTogglePin={togglePin}
                onHideLanguage={hideLanguage}
                onResize={onResize}
                columnActions={columnActions}
                onColumnAction={onColumnAction}
                onViewportWidth={setViewportWidth}
                emptyMessage={rows.totalAll > 0 ? "条件に合う行がありません" : "このリソースにはエントリがありません"}
              />
            ) : (
              <div className="grid-empty">左のツリーからリソースを選んでください。</div>
            )}
            {showDetail && resourceId && (
              <DetailPanel
                resourceId={resourceId}
                rowKey={selRow?.key}
                reloadToken={detailToken}
                onDiscardRow={(key) => void discardKeys([key])}
                onClose={() => updatePrefs({ showDetail: false })}
                {...(selCol?.language ? { preferLanguage: selCol.language } : {})}
              />
            )}
          </div>
        </section>
      </div>
      <footer className="statusbar" aria-label="ステータス">
        <span>
          {rows.loaded ? (
            <>
              {rows.total.toLocaleString()} 行{rows.total !== rows.totalAll && ` / 全 ${rows.totalAll.toLocaleString()} 行`}
            </>
          ) : (
            "読み込み中…"
          )}
          {rows.loading && <span className="spinner small" aria-label="読み込み中" />}
        </span>
        {multi && <span>{selHi - selLo + 1} 行を選択</span>}
        {selRow && selCol && (
          <span className="status-cell" title={selCol.cellId}>
            <span className="mono">{selRow.key}</span> ・ {selCol.language ? `${info.languages.find((l) => l.id === selCol.language)?.label ?? selCol.language} / ` : ""}
            {selCol.col.label ?? (selCol.kind === "text" ? "本文" : selCol.kind === "key" ? "キー" : selCol.col.id)}
            {selRow.cells[selCol.cellId]?.updatedBy && (
              <span className="muted"> ・ 最終更新 {selRow.cells[selCol.cellId]?.updatedBy}</span>
            )}
          </span>
        )}
        <span className="tb-grow" />
        {layout.autoUnpinned.length > 0 && (
          <span className="badge" title="固定する列が表の幅の上限（grid.maxPinnedRatio）を超えたため、後ろのピンを一時的に外しています。表を広げると戻ります。">
            固定を一時解除: {layout.autoUnpinned.map((id) => info.languages.find((l) => l.id === id)?.label ?? id).join("、")}
          </span>
        )}
        <span title={info.storage.path} className={info.storage.shared ? "badge warn" : "badge"}>
          {info.storage.shared ? "共有 DB" : "ローカル DB"}
        </span>
        <button type="button" className={`btn small ghost${errorCount ? " err" : problemCount ? " warn" : ""}`} onClick={() => setProblemsOpen(true)}>
          {errorCount > 0 ? `エラー ${errorCount}` : ""} {problemCount - errorCount > 0 ? `警告 ${problemCount - errorCount}` : ""}
          {problemCount === 0 ? "問題なし" : ""}
        </button>
      </footer>

      {edit && resourceId && edit.gc.language && (
        <EditModal
          resourceId={resourceId}
          rowIndex={edit.rowIndex}
          total={rows.total}
          language={info.languages.find((l) => l.id === edit.gc.language)!}
          textColumn={edit.gc.col}
          loadRow={rows.loadRow}
          onClose={() => {
            setEdit(null);
            requestAnimationFrame(() => gridRef.current?.focus());
          }}
          onNavigate={(i) => {
            setSelection((s) => ({ ...s, row: i, anchor: i }));
            gridRef.current?.scrollToRow(i);
          }}
          onCellsChanged={(key, cells) => {
            patchCells(key, cells);
            void loadTree();
          }}
          onSetCell={(row, gc, value) => setCellValue(row, gc, value)}
          onOpenReview={(row, gc) => setReview({ rowKey: row.key, gc })}
        />
      )}
      {review && resourceId && (
        <ReviewPanel
          resourceId={resourceId}
          rowKey={review.rowKey}
          gc={review.gc}
          {...(review.verdict ? { initialVerdict: review.verdict } : {})}
          onClose={() => setReview(null)}
          onPosted={(key, cellId, cell) => {
            patchCells(key, { [cellId]: cell });
            setStatsToken((t) => t + 1);
          }}
        />
      )}
      {conflict && (
        <ConflictDialog
          col={conflict.gc.col}
          rowKey={conflict.row.key}
          mine={conflict.mine}
          current={conflict.current}
          onUseCurrent={() => {
            const c = conflict;
            setConflict(null);
            if (c.current) patchCells(c.row.key, { [c.gc.cellId]: { ...c.row.cells[c.gc.cellId], value: c.current.value, ...(c.current.version !== undefined ? { version: c.current.version } : {}) } });
            rows.refresh();
          }}
          onUseMine={() => {
            const c = conflict;
            setConflict(null);
            void setCellValue(c.row, c.gc, c.mine, c.current?.version ?? 0);
          }}
        />
      )}
      {langPicker && (
        <LanguagePicker
          languages={info.languages}
          projectSets={info.languageSets}
          userSets={prefs.languageSets ?? {}}
          visible={visibleLanguages}
          pins={pins}
          onApply={(v, p) => updatePrefs({ visibleLanguages: v, pinnedLanguages: p })}
          onSaveSet={(name, ids) => updatePrefs({ languageSets: { ...(prefs.languageSets ?? {}), [name]: ids } })}
          onDeleteSet={(name) => {
            const next = { ...(prefs.languageSets ?? {}) };
            delete next[name];
            updatePrefs({ languageSets: next });
          }}
          onClose={() => setLangPicker(false)}
        />
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onThemeChange={applyTheme} infrastructure={!web || web.user.admin} />}
      {pluginsOpen && (
        <PluginsDialog
          onClose={() => setPluginsOpen(false)}
          onUntrusted={() => {
            setPluginsOpen(false);
            setTrustOpen(true);
            refreshAll();
          }}
        />
      )}
      {generate && <GenerateDialog req={generate} onClose={() => setGenerate(null)} onStarted={(jobId) => (jobId ? jobs.track(jobId) : refreshAll())} />}
      {saveConflicts && saveConflicts.length > 0 && (
        <SaveConflictsDialog
          resourceId={resourceId ?? saveConflicts[0]!.resourceId ?? ""}
          conflicts={saveConflicts}
          resourceNames={resourceNames}
          onClose={() => setSaveConflicts(null)}
          onChanged={refreshAll}
        />
      )}
      {trustOpen && (
        <PluginTrustDialog
          continued={trustContinued === true}
          onTrusted={(next) => {
            setInfo(next);
            setTrustOpen(next.untrustedPlugins > 0);
            refreshAll();
          }}
          onSkip={() => setTrustOpen(false)}
        />
      )}
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} onJump={jumpTo} resourceNames={resourceNames} />}
      {confirmDiscardAll && resourceId && (
        <Dialog
          title="未保存の変更をすべて取り消しますか？"
          className="small-dialog"
          onClose={() => setConfirmDiscardAll(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDiscardAll(false)}>
                やめる
              </button>
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  setConfirmDiscardAll(false);
                  void discardKeys();
                }}
              >
                すべて取り消す
              </button>
            </>
          }
        >
          <p>
            <span className="mono">{resourceNames.get(resourceId) ?? resourceId}</span> の未保存の変更 {currentUnsaved} 件を取り消します。元に戻せません。
          </p>
        </Dialog>
      )}
      {problemsOpen && (
        <Dialog title="警告とエラー" className="small-dialog wide" onClose={() => setProblemsOpen(false)}>
          {problemCount === 0 && <p className="muted">問題はありません。</p>}
          <ul className="plain-list">
            {info.pluginErrors.map((e, i) => (
              <li key={`p${i}`} className="issue sev-error">
                <span className="sev-badge sev-error">プラグイン</span> <span className="mono small">{e.path}</span>
                <div>{e.message}</div>
              </li>
            ))}
            {info.warnings.map((w, i) => (
              <li key={`w${i}`} className="issue sev-warning">
                <span className="sev-badge sev-warning">設定</span> {w}
              </li>
            ))}
            {rows.diagnostics.map((d, i) => (
              <li key={`d${i}`} className={`issue sev-${d.severity}`}>
                <span className={`sev-badge sev-${d.severity}`}>リソース</span> {d.line !== undefined && <span className="mono small">{d.line} 行目: </span>}
                {d.message}
              </li>
            ))}
          </ul>
        </Dialog>
      )}
      {!textCol && <div className="hint-error pad">本文の列（kind: "text"）が設定にありません。</div>}
    </div>
  );
}

/* 複数行を選んだときの一括操作。 */
function BulkBar({
  editReason,
  runReason,
  count,
  layout,
  actions,
  onSetEnum,
  onAction,
  onGenerate,
  onClear,
}: {
  editReason?: string | undefined;
  runReason?: string | undefined;
  count: number;
  layout: GridColumn[];
  actions: ActionInfo[];
  onSetEnum(gc: GridColumn, value: string): void;
  onAction(a: ActionInfo): void;
  onGenerate(gc: GridColumn): void;
  onClear(): void;
}) {
  const enumCols = layout.filter((c) => c.kind === "enum");
  const genCols = layout.filter((c) => c.kind === "generated");
  const [cellId, setCellId] = useState(enumCols[0]?.cellId ?? "");
  const gc = enumCols.find((c) => c.cellId === cellId) ?? enumCols[0];
  const [value, setValue] = useState("");
  const opts = gc ? enumOptions(gc.col) ?? [] : [];
  const label = (c: GridColumn) => `${c.language ? `${c.language} / ` : ""}${columnLabel(c.col)}`;
  return (
    <div className="bulkbar" role="toolbar" aria-label="選択した行の一括操作">
      <strong>{count} 行を選択中</strong>
      {gc && (
        <>
          <select className="input small" aria-label="一括で変える列" value={gc.cellId} onChange={(e) => (setCellId(e.target.value), setValue(""))}>
            {enumCols.map((c) => (
              <option key={c.cellId} value={c.cellId}>
                {label(c)}
              </option>
            ))}
          </select>
          <select className="input small" aria-label="設定する値" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">値を選ぶ…</option>
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {optionLabel(o)}
              </option>
            ))}
          </select>
          <button type="button" className="btn small" disabled={!value || editReason !== undefined} title={editReason} onClick={() => onSetEnum(gc, value)}>
            一括で設定
          </button>
        </>
      )}
      {actions.length > 0 && (
        <select
          className="input small"
          aria-label="アクションを実行"
          value=""
          disabled={runReason !== undefined}
          title={runReason}
          onChange={(e) => {
            const a = actions.find((x) => x.id === e.target.value);
            if (a) onAction(a);
          }}
        >
          <option value="">アクション…</option>
          {actions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      )}
      {genCols.length > 0 && (
        <select
          className="input small"
          aria-label="生成"
          value=""
          disabled={runReason !== undefined}
          title={runReason}
          onChange={(e) => {
            const c = genCols.find((x) => x.cellId === e.target.value);
            if (c) onGenerate(c);
          }}
        >
          <option value="">生成…</option>
          {genCols.map((c) => (
            <option key={c.cellId} value={c.cellId}>
              {label(c)}
            </option>
          ))}
        </select>
      )}
      <button type="button" className="btn small ghost" onClick={onClear}>
        選択を解除
      </button>
    </div>
  );
}
