import { describe, expect, it } from "vitest";
import {
  activeRange,
  clampSelection,
  clickSelection,
  collapseSelection,
  isCellSelected,
  isMultiSelection,
  isRowSelected,
  moveSelection,
  selectedCellCount,
  selectedRows,
  selectedRowsByColumn,
  singleSelection,
} from "./selection";

/* 表の選択（長方形の範囲の集まり）。クリックとキー操作のあとの選択と、そこから取り出す行とセル。 */

describe("表の選択", () => {
  it("ふつうのクリックは、そのセルだけを選ぶ（前の範囲は捨てる）", () => {
    const before = clickSelection(clickSelection(singleSelection(0, 0), 3, 2, { shift: true }), 9, 9, { ctrl: true });
    const sel = clickSelection(before, 5, 1, {});
    expect(sel).toEqual({ row: 5, col: 1, anchor: 5 });
    expect(isMultiSelection(sel)).toBe(false);
    expect(selectedRows(sel)).toEqual([5]);
    expect(selectedCellCount(sel)).toBe(1);
  });

  it("Shift ＋クリックは、起点からそのセルまでの長方形を選ぶ（行と列の両方に広がる。逆向きでも同じ）", () => {
    const sel = clickSelection(singleSelection(4, 3), 2, 1, { shift: true });
    expect(activeRange(sel)).toEqual({ r0: 2, r1: 4, c0: 1, c1: 3 });
    // いまのセルは押したセル、起点は最初のセルのまま。
    expect([sel.row, sel.col, sel.anchor, sel.anchorCol]).toEqual([2, 1, 4, 3]);
    expect(selectedRows(sel)).toEqual([2, 3, 4]);
    expect(selectedCellCount(sel)).toBe(9);
    expect(isCellSelected(sel, 3, 2)).toBe(true);
    expect(isCellSelected(sel, 3, 4)).toBe(false);
    expect(isCellSelected(sel, 1, 2)).toBe(false);
    // 続けて Shift で押し直すと、同じ起点からの長方形になる（広げ直せる）。
    expect(activeRange(clickSelection(sel, 6, 3, { shift: true }))).toEqual({ r0: 4, r1: 6, c0: 3, c1: 3 });
  });

  it("Ctrl ＋クリックは、いまの範囲を残してセルを足す。重なったセルは 1 回だけ数える", () => {
    const range = clickSelection(singleSelection(0, 1), 1, 1, { shift: true });
    const sel = clickSelection(clickSelection(range, 5, 2, { ctrl: true }), 1, 1, { ctrl: true });
    expect(isMultiSelection(sel)).toBe(true);
    expect(selectedRows(sel)).toEqual([0, 1, 5]);
    expect([...selectedRowsByColumn(sel).entries()]).toEqual([
      [1, [0, 1]],
      [2, [5]],
    ]);
    // (1, 1) は範囲と、足したセルの両方にあるが、数は 3。
    expect(selectedCellCount(sel)).toBe(3);
    expect(isRowSelected(sel, 5)).toBe(true);
    expect(isRowSelected(sel, 3)).toBe(false);
  });

  it("Ctrl で足したあとに Shift ＋クリックすると、足してきた範囲を残したまま、最後のセルからの長方形になる", () => {
    const sel = clickSelection(clickSelection(singleSelection(0, 0), 5, 1, { ctrl: true }), 7, 2, { shift: true });
    expect(selectedRows(sel)).toEqual([0, 5, 6, 7]);
    expect([...selectedRowsByColumn(sel).entries()]).toEqual([
      [0, [0]],
      [1, [5, 6, 7]],
      [2, [5, 6, 7]],
    ]);
  });

  it("Ctrl で足した 1 つのセルをもう一度 Ctrl ＋クリックすると、そのセルだけが外れる。最後の 1 つは外れない", () => {
    const two = clickSelection(singleSelection(0, 0), 2, 0, { ctrl: true });
    expect(selectedRows(two)).toEqual([0, 2]);
    // いまのセル（最後に足したセル）を外すと、前の範囲がいまの範囲になる。
    const backToFirst = clickSelection(two, 2, 0, { ctrl: true });
    expect(selectedRows(backToFirst)).toEqual([0]);
    expect([backToFirst.row, backToFirst.col]).toEqual([0, 0]);
    expect(isMultiSelection(backToFirst)).toBe(false);
    // 前に足したセルを外しても、いまのセルは残る。
    const dropFirst = clickSelection(two, 0, 0, { ctrl: true });
    expect(selectedRows(dropFirst)).toEqual([2]);
    expect([dropFirst.row, dropFirst.col]).toEqual([2, 0]);
    // 1 つだけ選んでいるセルは、Ctrl ＋クリックしても選んだまま。
    expect(clickSelection(singleSelection(3, 1), 3, 1, { ctrl: true })).toEqual({ row: 3, col: 1, anchor: 3 });
  });

  it("選んでいる列を絞って、列ごとの行を取り出せる", () => {
    const sel = clickSelection(clickSelection(singleSelection(0, 2), 1, 4, { shift: true }), 7, 4, { ctrl: true });
    expect([...selectedRowsByColumn(sel, (c) => c === 4).entries()]).toEqual([[4, [0, 1, 7]]]);
    expect([...selectedRowsByColumn(sel, (c) => c === 9).entries()]).toEqual([]);
  });

  it("キー操作: Shift を押していれば起点からの長方形、押していなければそのセルだけ", () => {
    const start = singleSelection(2, 2);
    expect(activeRange(moveSelection(start, 4, 2, true))).toEqual({ r0: 2, r1: 4, c0: 2, c1: 2 });
    expect(activeRange(moveSelection(moveSelection(start, 4, 2, true), 4, 3, true))).toEqual({ r0: 2, r1: 4, c0: 2, c1: 3 });
    expect(moveSelection(moveSelection(start, 4, 2, true), 5, 2, false)).toEqual({ row: 5, col: 2, anchor: 5 });
  });

  it("選択を解除すると、いまのセルだけになる", () => {
    const sel = clickSelection(clickSelection(singleSelection(0, 0), 3, 3, { shift: true }), 8, 1, { ctrl: true });
    expect(collapseSelection(sel)).toEqual({ row: 8, col: 1, anchor: 8 });
  });

  it("行や列が減って収まらなくなった選択は、残っている範囲の 1 つのセルにする。収まっていれば変えない", () => {
    const sel = clickSelection(singleSelection(2, 1), 9, 3, { shift: true });
    expect(clampSelection(sel, 10, 4)).toBe(sel);
    expect(clampSelection(sel, 5, 4)).toEqual({ row: 4, col: 3, anchor: 4 });
    expect(clampSelection(sel, 10, 2)).toEqual({ row: 9, col: 1, anchor: 9 });
    // 行が 1 つもなくなっても、先頭のセルを指す。
    expect(clampSelection(singleSelection(3, 0), 0, 4)).toEqual({ row: 0, col: 0, anchor: 0 });
  });
});
