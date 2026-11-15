/* 画面の状態（列の幅、表示する言語、ピン）をプロジェクトごとに localStorage に覚える。使えない環境では覚えないだけ。 */

export interface GridPrefs {
  widths?: Record<string, number>;
  visibleLanguages?: string[];
  pinnedLanguages?: string[];
  /** 一部の列だけ固定する言語（言語 ID → 列 ID）。 */
  partialPins?: Record<string, string[]>;
  density?: 1 | 3 | 5;
  languageSets?: Record<string, string[]>;
  showDetail?: boolean;
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
