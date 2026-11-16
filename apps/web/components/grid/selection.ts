/*
 * 表の選択。選んでいるセルは、いくつかの長方形の範囲の集まりで持つ。
 * - ふつうのクリックと矢印キー: セル 1 つ。
 * - Shift ＋クリック、Shift ＋矢印キー: 起点（anchor / anchorCol）から、そのセルまでの長方形。
 * - Ctrl（macOS は ⌘）＋クリック: いまの範囲を残したまま、そのセルを足す。もう一度押すと、そのセルを外す。
 * 行の操作（削除、一括の変更）は、選んでいるセルのある行が対象になる。
 */

export interface CellRange {
  /** 行の範囲（両端を含む。r0 <= r1）。 */
  r0: number;
  r1: number;
  /** 列の範囲（両端を含む。c0 <= c1）。 */
  c0: number;
  c1: number;
}

export interface Selection {
  /** いまのセル（キー操作の対象）。 */
  row: number;
  col: number;
  /** いまの範囲の起点の行。 */
  anchor: number;
  /** いまの範囲の起点の列。なければ col と同じ（列方向には広げていない）。 */
  anchorCol?: number;
  /** Ctrl で足してきた、いまの範囲より前の範囲。 */
  ranges?: CellRange[];
}

export const singleSelection = (row: number, col: number): Selection => ({ row, col, anchor: row });

/** いまの範囲（起点からいまのセルまで）。 */
export function activeRange(sel: Selection): CellRange {
  const anchorCol = sel.anchorCol ?? sel.col;
  return { r0: Math.min(sel.anchor, sel.row), r1: Math.max(sel.anchor, sel.row), c0: Math.min(anchorCol, sel.col), c1: Math.max(anchorCol, sel.col) };
}

/** 選んでいる範囲のすべて（いまの範囲が最後）。 */
export function allRanges(sel: Selection): CellRange[] {
  return [...(sel.ranges ?? []), activeRange(sel)];
}

const inRange = (g: CellRange, row: number, col: number): boolean => row >= g.r0 && row <= g.r1 && col >= g.c0 && col <= g.c1;
const isSingle = (g: CellRange): boolean => g.r0 === g.r1 && g.c0 === g.c1;

export function isCellSelected(sel: Selection, row: number, col: number): boolean {
  return allRanges(sel).some((g) => inRange(g, row, col));
}

export function isRowSelected(sel: Selection, row: number): boolean {
  return allRanges(sel).some((g) => row >= g.r0 && row <= g.r1);
}

/** 選んでいるセルのある行（行番号の小さい順。重なりは 1 回だけ）。 */
export function selectedRows(sel: Selection): number[] {
  const rows = new Set<number>();
  for (const g of allRanges(sel)) for (let r = g.r0; r <= g.r1; r++) rows.add(r);
  return [...rows].sort((a, b) => a - b);
}

/** 列ごとの、選んでいるセルのある行（列番号 → 行番号の小さい順）。columns を渡すと、その列だけを返す。 */
export function selectedRowsByColumn(sel: Selection, columns?: (col: number) => boolean): Map<number, number[]> {
  const byCol = new Map<number, Set<number>>();
  for (const g of allRanges(sel)) {
    for (let c = g.c0; c <= g.c1; c++) {
      if (columns && !columns(c)) continue;
      const rows = byCol.get(c) ?? new Set<number>();
      for (let r = g.r0; r <= g.r1; r++) rows.add(r);
      byCol.set(c, rows);
    }
  }
  return new Map([...byCol.entries()].sort((a, b) => a[0] - b[0]).map(([c, rows]) => [c, [...rows].sort((a, b) => a - b)]));
}

/** 選んでいるセルの数（重なりは 1 回だけ）。 */
export function selectedCellCount(sel: Selection): number {
  let n = 0;
  for (const rows of selectedRowsByColumn(sel).values()) n += rows.length;
  return n;
}

/** セル（または行番号の欄）を押したあとの選択。 */
export function clickSelection(sel: Selection, row: number, col: number, mods: { shift?: boolean; ctrl?: boolean }): Selection {
  if (mods.shift) {
    // 起点はそのままで、押したセルまでの長方形にする（Ctrl で足してきた範囲は残す）。
    return { row, col, anchor: sel.anchor, anchorCol: sel.anchorCol ?? sel.col, ...(sel.ranges ? { ranges: sel.ranges } : {}) };
  }
  if (mods.ctrl) {
    const active = activeRange(sel);
    const kept = sel.ranges ?? [];
    // 1 つだけ選んだセルをもう一度押したら、外す（選択が空にはならないよう、最後の 1 つは残す）。
    if (isSingle(active) && inRange(active, row, col)) {
      const last = kept[kept.length - 1];
      if (!last) return sel;
      const rest = kept.slice(0, -1);
      return { row: last.r1, col: last.c1, anchor: last.r0, anchorCol: last.c0, ...(rest.length > 0 ? { ranges: rest } : {}) };
    }
    const at = kept.findIndex((g) => isSingle(g) && inRange(g, row, col));
    if (at >= 0) {
      const rest = kept.filter((_, i) => i !== at);
      const { ranges: _dropped, ...current } = sel;
      void _dropped;
      return { ...current, ...(rest.length > 0 ? { ranges: rest } : {}) };
    }
    // いまの範囲を残して、押したセルを足す。
    return { row, col, anchor: row, ranges: [...kept, active] };
  }
  return singleSelection(row, col);
}

/** キー操作でいまのセルを動かしたあとの選択。extend（Shift）なら、起点からの長方形にする。 */
export function moveSelection(sel: Selection, row: number, col: number, extend: boolean): Selection {
  return extend ? clickSelection(sel, row, col, { shift: true }) : singleSelection(row, col);
}

/** 複数のセルや行を選んでいるか。 */
export function isMultiSelection(sel: Selection): boolean {
  const g = activeRange(sel);
  return (sel.ranges?.length ?? 0) > 0 || !isSingle(g);
}

/** いまのセルだけの選択に戻す。 */
export function collapseSelection(sel: Selection): Selection {
  return singleSelection(sel.row, sel.col);
}

/** 行や列が減ったあと、選択を残っている範囲に収める。収まらない範囲は捨てる。 */
export function clampSelection(sel: Selection, rowCount: number, colCount: number): Selection {
  const maxRow = Math.max(0, rowCount - 1);
  const maxCol = Math.max(0, colCount - 1);
  const fits = sel.row <= maxRow && sel.col <= maxCol && sel.anchor <= maxRow && (sel.anchorCol ?? 0) <= maxCol && (sel.ranges ?? []).every((g) => g.r1 <= maxRow && g.c1 <= maxCol);
  if (fits) return sel;
  return singleSelection(Math.min(sel.row, maxRow), Math.min(sel.col, maxCol));
}
