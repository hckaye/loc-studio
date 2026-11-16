import type { ToolbarFilters } from "@/lib/client/filters";

/*
 * 画面の状態。列の幅や表示する言語のほか、最後に開いていたリソース、絞り込み、並べ替え、スクロールの位置、
 * 隠した列、お気に入りの条件を、プロジェクトごとに覚える。
 * 置き場所は 2 つ。サーバー側（その PC の DB。api.uiState / setUiState）が正で、アプリを起動し直しても残る。
 * localStorage は、サーバーから読めなかったときの控え（デスクトップ版は起動のたびに接続先が変わるので、次の起動では読めない）。
 */

export interface SortState {
  cellId: string;
  dir: "asc" | "desc";
}

/** お気に入りの条件。絞り込みと並べ替えを名前を付けて覚える。columns があれば、列と言語の表示も戻す。 */
export interface Favorite {
  id: string;
  name: string;
  filters: ToolbarFilters;
  sort: SortState | null;
  /** 保存したときに開いていた画面（表か、プロジェクト全体の検索ビュー）。 */
  view: "grid" | "search";
  /** 検索ビューの集計の区切り。 */
  groupBy: string[];
  columns?: { hidden: string[]; languages: string[] };
}

/** ツリーの見え方。 */
export interface TreeViewState {
  /** たたんでいるフォルダ（ノードの ID）。 */
  collapsed: string[];
  /** 名前での絞り込み。 */
  query: string;
  /** 条件に合う行のあるリソースだけを出す。 */
  onlyMatching: boolean;
}

/** 最後の状態（アプリを開き直したときに戻す）。 */
export interface LastState {
  resourceId?: string;
  filters?: ToolbarFilters;
  sort?: SortState | null;
  /** スクロールの位置と、選んでいたセル。resourceId が、開くリソースと同じときだけ戻す。 */
  scroll?: { resourceId: string; top: number; left: number; row: number; col: number };
  view?: "grid" | "search";
  groupBy?: string[];
  tree?: TreeViewState;
}

export interface GridPrefs {
  widths?: Record<string, number>;
  visibleLanguages?: string[];
  pinnedLanguages?: string[];
  /** 一部の列だけ固定する言語（言語 ID → 列 ID）。 */
  partialPins?: Record<string, string[]>;
  density?: 1 | 3 | 5;
  languageSets?: Record<string, string[]>;
  showDetail?: boolean;
  /** 隠した列（列の ID）。 */
  hiddenColumns?: string[];
  /** 列の表示のプリセット（名前 → 隠す列の ID）。 */
  columnSets?: Record<string, string[]>;
  favorites?: Favorite[];
  last?: LastState;
}

function storageKey(project: string): string {
  return `loc-studio:grid:${project}`;
}

export function loadPrefs(project: string): GridPrefs {
  try {
    const raw = window.localStorage.getItem(storageKey(project));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as GridPrefs) : {};
  } catch {
    return {};
  }
}

export function savePrefs(project: string, prefs: GridPrefs): void {
  try {
    window.localStorage.setItem(storageKey(project), JSON.stringify(prefs));
  } catch {
    // 容量超過やプライベートモード: 覚えないだけで動作は続ける
  }
}

/** サーバーから読んだ状態を、画面の状態として使えるか（オブジェクトであること）確かめる。 */
export function prefsFromServer(state: unknown): GridPrefs | undefined {
  return state !== null && typeof state === "object" && !Array.isArray(state) ? (state as GridPrefs) : undefined;
}
