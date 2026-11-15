"use client";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ActionInfo, ProjectInfo, RowInfo } from "@loc-studio/server";
import { columnLabel, defaultWidth, MIN_COL_WIDTH, type GridColumn, type GridLayout } from "@/lib/client/model";

const MAX_COL_WIDTH = 1200;
import type { RowPages } from "./useRowPages";
import { actionsForColumn, CellContent, draftByOther, type CellHandlers } from "./cells";
import { canEditCell, canRun } from "@/lib/client/permissions";

/*
 * 多言語の表。行と列の両方向を仮想化する。
 * - 固定の列（共通グループとピン留めの言語）は position: sticky で左に留める。
 * - 横スクロールする列は見えている範囲だけ描き、前に空白の要素を置いて位置を合わせる。
 * - 行の高さは固定（表示密度で 1 / 3 / 5 行）。
 */

export const GUTTER_WIDTH = 52;
export const GROUP_HEADER_H = 30;
export const COLUMN_HEADER_H = 28;
export const HEADER_H = GROUP_HEADER_H + COLUMN_HEADER_H;
const LINE_H = 20;

export function rowHeightFor(density: number): number {
  return density * LINE_H + 12;
}

export interface Selection {
  row: number;
  col: number;
  /** 複数行の選択の起点。 */
  anchor: number;
}

export function selectedRowRange(sel: Selection): [number, number] {
  return [Math.min(sel.anchor, sel.row), Math.max(sel.anchor, sel.row)];
}

export interface GridProps extends Omit<CellHandlers, "onCancelEdit"> {
  info: ProjectInfo;
  resourceId?: string;
  layout: GridLayout;
  rows: RowPages;
  density: number;
  selection: Selection;
  onSelectionChange(sel: Selection): void;
  onOpenEditor(rowIndex: number, gc: GridColumn): void;
  onTogglePin(language: string, part?: "pinned" | "rest"): void;
  /** 列が対象のアクション（列見出しのメニュー）。 */
  columnActions?(gc: GridColumn): ActionInfo[];
  onColumnAction?(gc: GridColumn, action: ActionInfo): void;
  onHideLanguage(language: string): void;
  /** いまの並べ替え（なければ、リソースの中の順）。 */
  sort?: { cellId: string; dir: "asc" | "desc" } | undefined;
  /** 列見出しを押した（昇順、降順、解除の順に切り替える）。渡さなければ、見出しは押せない。 */
  onSort?(gc: GridColumn): void;
  onResize(cellId: string, width: number): void;
  onViewportWidth(width: number): void;
  emptyMessage?: string;
}

export interface GridHandle {
  focus(): void;
  scrollToRow(index: number): void;
  /** その行・列が見えるようにスクロールする。 */
  scrollToCell(row: number, col: number): void;
}

export const Grid = forwardRef<GridHandle, GridProps>(function Grid(props, ref) {
  const { info, layout, rows, density, selection, onSelectionChange } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowH = rowHeightFor(density);
  const [editing, setEditing] = useState<{ row: number; cellId: string } | null>(null);
  const [dragWidth, setDragWidth] = useState<{ cellId: string; width: number } | null>(null);

  // 列の幅のドラッグ中は、その列だけ仮の幅で描く
  const effLayout = useMemo(() => {
    if (!dragWidth) return layout;
    const patch = (c: GridColumn) => (c.cellId === dragWidth.cellId ? { ...c, width: dragWidth.width } : c);
    const frozen = layout.frozen.map(patch);
    const scrolling = layout.scrolling.map(patch);
    const groups = layout.groups.map((g) => {
      const cols = g.columns.map(patch);
      return { ...g, columns: cols, width: cols.reduce((s, c) => s + c.width, 0) };
    });
    const fw = frozen.reduce((s, c) => s + c.width, 0);
    return { ...layout, groups, frozen, scrolling, all: [...frozen, ...scrolling], frozenWidth: fw, totalWidth: fw + scrolling.reduce((s, c) => s + c.width, 0) };
  }, [layout, dragWidth]);

  const frozenLefts = useMemo(() => {
    const lefts: number[] = [];
    let x = GUTTER_WIDTH;
    for (const c of effLayout.frozen) {
      lefts.push(x);
      x += c.width;
    }
    return lefts;
  }, [effLayout.frozen]);
  const scrollStart = GUTTER_WIDTH + effLayout.frozenWidth;

  const rowVirtualizer = useVirtualizer({
    count: rows.total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 8,
    paddingStart: HEADER_H,
    scrollPaddingStart: HEADER_H,
    initialRect: { width: 1200, height: 800 },
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: effLayout.scrolling.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => effLayout.scrolling[i]?.width ?? 100,
    overscan: 3,
    paddingStart: scrollStart,
    initialRect: { width: 1200, height: 800 },
  });

  useLayoutEffect(() => {
    rowVirtualizer.measure();
    // 行の高さが変わったら測り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowH]);
  useLayoutEffect(() => {
    colVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effLayout.scrolling, scrollStart]);

  const vRows = rowVirtualizer.getVirtualItems();
  const vCols = colVirtualizer.getVirtualItems();
  const firstRow = vRows[0]?.index ?? 0;
  const lastRow = vRows[vRows.length - 1]?.index ?? 0;

  const ensureRange = rows.ensureRange;
  useEffect(() => {
    ensureRange(firstRow, lastRow);
  }, [ensureRange, firstRow, lastRow, rows.total]);

  // 見えている幅（固定列の上限の計算に使う）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const report = () => props.onViewportWidth(el.clientWidth - GUTTER_WIDTH);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollColumnIntoView = useCallback(
    (colIndex: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const frozenCount = effLayout.frozen.length;
      if (colIndex < frozenCount) return;
      const si = colIndex - frozenCount;
      let left = scrollStart;
      for (let i = 0; i < si; i++) left += effLayout.scrolling[i]!.width;
      const right = left + (effLayout.scrolling[si]?.width ?? 0);
      const viewLeft = el.scrollLeft + scrollStart;
      const viewRight = el.scrollLeft + el.clientWidth;
      if (left < viewLeft) el.scrollLeft = left - scrollStart;
      else if (right > viewRight) el.scrollLeft = right - el.clientWidth;
    },
    [effLayout, scrollStart],
  );

  useImperativeHandle(
    ref,
    () => ({
      focus: () => scrollRef.current?.focus(),
      scrollToRow: (index: number) => rowVirtualizer.scrollToIndex(index, { align: "auto" }),
      scrollToCell: (row: number, col: number) => {
        rowVirtualizer.scrollToIndex(row, { align: "center" });
        scrollColumnIntoView(col);
      },
    }),
    [rowVirtualizer, scrollColumnIntoView],
  );

  const moveTo = (row: number, col: number, extend: boolean) => {
    const r = Math.max(0, Math.min(rows.total - 1, row));
    const c = Math.max(0, Math.min(effLayout.all.length - 1, col));
    onSelectionChange({ row: r, col: c, anchor: extend ? selection.anchor : r });
    rowVirtualizer.scrollToIndex(r, { align: "auto" });
    scrollColumnIntoView(c);
  };

  const cellElement = (row: number, col: number) =>
    scrollRef.current?.querySelector<HTMLElement>(`[data-row="${row}"] [data-col="${col}"]`) ?? null;

  /** Enter / F2: 本文は編集モーダル、選択式はドロップダウン、文字と数値はその場で編集。 */
  const activate = (rowIndex: number, colIndex: number) => {
    const gc = effLayout.all[colIndex];
    const row = rows.getRow(rowIndex);
    if (!gc || !row) return;
    if (gc.kind === "text") props.onOpenEditor(rowIndex, gc);
    else if (gc.kind === "string" || gc.kind === "number") {
      if (canEditCell(info, gc).ok) setEditing({ row: rowIndex, cellId: gc.cellId });
    } else cellElement(rowIndex, colIndex)?.querySelector<HTMLElement>("[data-cell-primary]")?.click();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // セルの中のボタンや入力欄のキーは触らない
    if (rows.total === 0) return;
    const { row, col } = selection;
    const page = Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 400) - HEADER_H) / rowH) - 1);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (e.altKey) return;
        moveTo(row + 1, col, e.shiftKey);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(row - 1, col, e.shiftKey);
        break;
      case "ArrowLeft":
        e.preventDefault();
        moveTo(row, col - 1, false);
        break;
      case "ArrowRight":
        e.preventDefault();
        moveTo(row, col + 1, false);
        break;
      case "PageDown":
        e.preventDefault();
        moveTo(row + page, col, e.shiftKey);
        break;
      case "PageUp":
        e.preventDefault();
        moveTo(row - page, col, e.shiftKey);
        break;
      case "Home":
        e.preventDefault();
        moveTo(e.ctrlKey ? 0 : row, 0, false);
        break;
      case "End":
        e.preventDefault();
        moveTo(e.ctrlKey ? rows.total - 1 : row, effLayout.all.length - 1, false);
        break;
      case "Tab": {
        e.preventDefault();
        const n = effLayout.all.length;
        let r = row;
        let c = col + (e.shiftKey ? -1 : 1);
        if (c >= n) {
          c = 0;
          r = Math.min(rows.total - 1, r + 1);
        } else if (c < 0) {
          c = n - 1;
          r = Math.max(0, r - 1);
        }
        moveTo(r, c, false);
        break;
      }
      case "Enter":
      case "F2":
        if (e.nativeEvent.isComposing || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        activate(row, col);
        break;
      case " ":
        if (effLayout.all[col]?.kind === "boolean") {
          e.preventDefault();
          activate(row, col);
        }
        break;
      default:
        break;
    }
  };

  const onCellMouseDown = (e: React.MouseEvent, rowIndex: number, colIndex: number) => {
    if (e.button !== 0) return;
    // ポータル（ドロップダウンのリスト）からの合成イベントは無視する
    if (!(e.currentTarget as HTMLElement).contains(e.target as Node)) return;
    const extend = e.shiftKey;
    onSelectionChange({ row: rowIndex, col: colIndex, anchor: extend ? selection.anchor : rowIndex });
    if (extend) e.preventDefault();
    // セルの中のボタンを押したときも、表がキー操作を受けられるようにする
    if (!(e.target as HTMLElement).closest("button, input, select, textarea")) {
      requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }));
    }
  };

  const onCellDoubleClick = (rowIndex: number, colIndex: number) => {
    const gc = effLayout.all[colIndex];
    if (!gc) return;
    if (gc.kind === "text") props.onOpenEditor(rowIndex, gc);
    else if ((gc.kind === "string" || gc.kind === "number") && canEditCell(info, gc).ok) setEditing({ row: rowIndex, cellId: gc.cellId });
  };

  const handlers: CellHandlers = useMemo(
    () => ({
      onEnumChoose: props.onEnumChoose,
      onReviewChoose: props.onReviewChoose,
      onCommitMeta: (row: RowInfo, gc: GridColumn, value: unknown) => {
        setEditing(null);
        props.onCommitMeta(row, gc, value);
        requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }));
      },
      onGenerate: props.onGenerate,
      onRunAction: props.onRunAction,
      ...(props.setCellValue ? { setCellValue: props.setCellValue } : {}),
      onCancelEdit: () => {
        setEditing(null);
        requestAnimationFrame(() => scrollRef.current?.focus({ preventScroll: true }));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onEnumChoose, props.onReviewChoose, props.onCommitMeta, props.onGenerate, props.onRunAction, props.setCellValue],
  );

  const actionsByCell = useMemo(() => {
    const map = new Map<string, ActionInfo[]>();
    for (const gc of effLayout.all) if (gc.kind === "actions") map.set(gc.cellId, actionsForColumn(info, gc));
    return map;
  }, [effLayout.all, info]);

  // 列の幅をドラッグで変える
  const startResize = (e: React.MouseEvent, gc: GridColumn) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = gc.width;
    let w = startW;
    const move = (ev: MouseEvent) => {
      w = Math.max(MIN_COL_WIDTH, Math.round(startW + ev.clientX - startX));
      setDragWidth({ cellId: gc.cellId, width: w });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragWidth(null);
      if (w !== startW) props.onResize(gc.cellId, w);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** 列の幅をキーで変える: ←→ で 16px（Shift で 4px）、Home で既定の幅。 */
  const onResizeKey = (e: React.KeyboardEvent, gc: GridColumn) => {
    let next: number | undefined;
    const step = e.shiftKey ? 4 : 16;
    if (e.key === "ArrowLeft") next = gc.width - step;
    else if (e.key === "ArrowRight") next = gc.width + step;
    else if (e.key === "Home") next = defaultWidth(gc.kind);
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    props.onResize(gc.cellId, Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, next)));
  };

  const [selLo, selHi] = selectedRowRange(selection);
  const frozenCount = effLayout.frozen.length;
  const firstVCol = vCols[0];
  const spacer = firstVCol ? firstVCol.start - scrollStart : 0;
  const totalW = GUTTER_WIDTH + effLayout.totalWidth;

  const renderHeaderCell = (gc: GridColumn, colIndex: number, frozenLeft?: number) => {
    const label = gc.col.label ?? (gc.kind === "text" ? "本文" : gc.kind === "key" ? "キー" : columnLabel(gc.col));
    const sorted = props.sort?.cellId === gc.cellId ? props.sort.dir : undefined;
    return (
      <div
        key={gc.cellId}
        role="columnheader"
        className={`g-hcell${frozenLeft !== undefined ? " frozen" : ""}${colIndex === frozenCount - 1 ? " frozen-last" : ""}${selection.col === colIndex ? " col-active" : ""}`}
        style={{ width: gc.width, ...(frozenLeft !== undefined ? { left: frozenLeft } : {}) }}
        title={`${label}（${gc.cellId}）`}
        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
      >
        {props.onSort && gc.kind !== "actions" ? (
          <button
            type="button"
            className="g-hlabel g-hsort"
            aria-label={`${label} で並べ替え（いまは${sorted === "asc" ? "昇順" : sorted === "desc" ? "降順" : "リソースの中の順"}）`}
            onClick={(e) => {
              e.stopPropagation();
              props.onSort!(gc);
            }}
          >
            {label}
            {sorted && <span aria-hidden="true">{sorted === "asc" ? " ▲" : " ▼"}</span>}
          </button>
        ) : (
          <span className="g-hlabel">{label}</span>
        )}
        {props.columnActions && props.onColumnAction && (
          <ColumnMenu gc={gc} label={label} actions={props.columnActions(gc)} onRun={props.onColumnAction} disabledReason={canRun(info).reason} />
        )}
        <span
          className="g-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={`${label} の幅（左右の矢印キーで変える）`}
          aria-valuenow={gc.width}
          aria-valuemin={MIN_COL_WIDTH}
          aria-valuemax={MAX_COL_WIDTH}
          aria-valuetext={`${gc.width} ピクセル`}
          tabIndex={0}
          onMouseDown={(e) => startResize(e, gc)}
          onKeyDown={(e) => onResizeKey(e, gc)}
        />
      </div>
    );
  };

  const renderGroupHeader = (g: GridLayout["groups"][number], style: React.CSSProperties, frozen: boolean, last: boolean) => (
    <div key={g.id} className={`g-group${frozen ? " frozen" : ""}${last ? " frozen-last" : ""}${g.kind === "common" ? " common" : ""}`} style={style}>
      <span className="g-group-label" title={g.language ? `${g.label}（${g.language.id}）` : g.label}>
        {g.label}
        {g.language && <span className="g-group-id">{g.language.id}</span>}
        {g.language?.editable === false && <span className="badge">読取専用</span>}
      </span>
      {g.language && (
        <span className="g-group-tools">
          <button
            type="button"
            className={`icon-btn small${g.pinned ? " on" : ""}${g.pinSuspended ? " suspended" : ""}${g.part === "rest" ? " partial" : ""}`}
            aria-pressed={g.pinned || g.pinSuspended === true}
            aria-label={
              g.part === "rest" ? `${g.label} の全部の列を固定` : g.pinned || g.pinSuspended ? `${g.label} の固定を外す` : `${g.label} を左に固定`
            }
            title={
              g.part === "rest"
                ? "一部の列だけ固定しています。押すとこの言語の全部の列を固定します"
                : g.pinSuspended
                  ? "固定（表の幅が足りないため一時的に解除中）。押すと固定を外します"
                  : g.pinned
                    ? "固定を外す"
                    : "左に固定"
            }
            onClick={() => props.onTogglePin(g.language!.id, g.part)}
          >
            📌
          </button>
          <button
            type="button"
            className="icon-btn small"
            aria-label={`${g.label} を隠す`}
            title="この言語を隠す"
            onClick={() => props.onHideLanguage(g.language!.id)}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );

  // 固定側のグループ見出し
  const frozenGroups = effLayout.groups.filter((g) => g.pinned);
  const scrollGroups = effLayout.groups.filter((g) => !g.pinned);
  let fx = GUTTER_WIDTH;
  const frozenGroupEls = frozenGroups.map((g, i) => {
    const el = renderGroupHeader(g, { width: g.width, left: fx }, true, i === frozenGroups.length - 1);
    fx += g.width;
    return el;
  });
  let sx = 0;
  const scrollGroupEls = scrollGroups.map((g) => {
    const el = renderGroupHeader(g, { width: g.width, left: sx, position: "absolute", top: 0 }, false, false);
    sx += g.width;
    return el;
  });

  const activeCellId = `gc-${selection.row}-${selection.col}`;

  return (
    <div
      ref={scrollRef}
      className="grid-scroll"
      role="grid"
      aria-label="エントリの表"
      aria-rowcount={rows.total + 2}
      aria-colcount={effLayout.all.length + 1}
      aria-multiselectable="true"
      aria-activedescendant={rows.getRow(selection.row) ? activeCellId : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{ ["--row-h" as string]: `${rowH}px`, ["--lines" as string]: density }}
    >
      <div className="grid-inner" style={{ width: totalW, height: rowVirtualizer.getTotalSize() }}>
        <div className="g-header" role="rowgroup" style={{ width: totalW }}>
          <div className="g-header-row groups" role="row" style={{ height: GROUP_HEADER_H }}>
            <div className="g-gutter frozen corner" style={{ left: 0 }} />
            {frozenGroupEls}
            <div className="g-group-track" style={{ width: effLayout.totalWidth - effLayout.frozenWidth }}>
              {scrollGroupEls}
            </div>
          </div>
          <div className="g-header-row" role="row" style={{ height: COLUMN_HEADER_H }}>
            <div className="g-gutter frozen corner" style={{ left: 0 }} role="columnheader" aria-label="行番号">
              #
            </div>
            {effLayout.frozen.map((gc, i) => renderHeaderCell(gc, i, frozenLefts[i]))}
            {spacer > 0 && <div className="g-spacer" style={{ width: spacer }} />}
            {vCols.map((vc) => {
              const gc = effLayout.scrolling[vc.index];
              return gc ? renderHeaderCell(gc, frozenCount + vc.index) : null;
            })}
          </div>
        </div>
        {rows.total === 0 && rows.loaded && <div className="grid-empty">{props.emptyMessage ?? "表示する行がありません"}</div>}
        {vRows.map((vr) => {
          const row = rows.getRow(vr.index);
          const inSel = vr.index >= selLo && vr.index <= selHi;
          return (
            <div
              key={vr.key}
              className={`g-row${inSel ? " row-selected" : ""}${vr.index % 2 ? " odd" : ""}`}
              role="row"
              aria-rowindex={vr.index + 3}
              aria-selected={inSel}
              data-row={vr.index}
              style={{ top: vr.start, height: rowH, width: totalW }}
            >
              <div
                className="g-gutter frozen"
                style={{ left: 0 }}
                role="rowheader"
                onMouseDown={(e) => onCellMouseDown(e, vr.index, selection.col)}
              >
                {vr.index + 1}
              </div>
              {row ? (
                <>
                  {effLayout.frozen.map((gc, i) =>
                    renderCell(row, vr.index, gc, i, frozenLefts[i]),
                  )}
                  {spacer > 0 && <div className="g-spacer" style={{ width: spacer }} />}
                  {vCols.map((vc) => {
                    const gc = effLayout.scrolling[vc.index];
                    return gc ? renderCell(row, vr.index, gc, frozenCount + vc.index) : null;
                  })}
                </>
              ) : (
                <div className="g-loading" style={{ left: GUTTER_WIDTH }}>
                  読み込み中…
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );

  function renderCell(row: RowInfo, rowIndex: number, gc: GridColumn, colIndex: number, frozenLeft?: number) {
    const active = selection.row === rowIndex && selection.col === colIndex;
    const isEditing = editing !== null && editing.row === rowIndex && editing.cellId === gc.cellId;
    const cell = row.cells[gc.cellId];
    const cls = [
      "g-cell",
      `k-${gc.kind}`,
      frozenLeft !== undefined ? "frozen" : "",
      colIndex === frozenCount - 1 ? "frozen-last" : "",
      active ? "active" : "",
      cell?.draft ? "unsaved" : "",
      gc.language && info.languages.find((l) => l.id === gc.language)?.editable === false ? "readonly-lang" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const lang = gc.language ? info.languages.find((l) => l.id === gc.language) : undefined;
    // 編集できない列のセルには理由を、ほかの人が編集中の本文にはその人の名前をツールチップで出す
    const editableKind = gc.kind === "string" || gc.kind === "number" || gc.kind === "enum" || gc.kind === "boolean" || gc.kind === "review" || gc.kind === "text";
    const denied = editableKind ? canEditCell(info, gc) : { ok: true as const, reason: undefined };
    const other = gc.kind === "text" ? draftByOther(cell, info.user.name) : undefined;
    const tip = other ? `${other}さんが編集中` : !denied.ok && gc.kind !== "enum" && gc.kind !== "review" ? denied.reason : undefined;
    return (
      <div
        {...(tip ? { title: tip } : {})}
        key={gc.cellId}
        id={active ? activeCellId : undefined}
        role="gridcell"
        aria-selected={active}
        aria-colindex={colIndex + 2}
        data-col={colIndex}
        className={cls}
        style={{ width: gc.width, ...(frozenLeft !== undefined ? { left: frozenLeft } : {}) }}
        {...(lang?.hint?.dir ? { dir: lang.hint.dir } : {})}
        {...(lang?.hint?.lang ? { lang: lang.hint.lang } : {})}
        onMouseDown={(e) => onCellMouseDown(e, rowIndex, colIndex)}
        onDoubleClick={() => onCellDoubleClick(rowIndex, colIndex)}
      >
        <CellContent info={info} row={row} gc={gc} editing={isEditing} handlers={handlers} actions={actionsByCell.get(gc.cellId) ?? EMPTY} {...(props.resourceId ? { resourceId: props.resourceId } : {})} />
      </div>
    );
  }
});

const EMPTY: ActionInfo[] = [];

/** 列見出しのメニュー（target: "column" のアクション）。アクションがない列には出さない。 */
function ColumnMenu({
  gc,
  label,
  actions,
  onRun,
  disabledReason,
}: {
  gc: GridColumn;
  label: string;
  actions: ActionInfo[];
  onRun(gc: GridColumn, a: ActionInfo): void;
  disabledReason?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    menu.current?.querySelector<HTMLElement>("button")?.focus();
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open]);
  if (actions.length === 0) return null;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="icon-btn small col-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} の列のアクション`}
        title="列のアクション"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => {
          const r = btn.current!.getBoundingClientRect();
          setPos({ left: Math.min(r.left, window.innerWidth - 220), top: r.bottom + 2 });
          setOpen((o) => !o);
        }}
      >
        ⋮
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menu}
            className="menu"
            role="menu"
            aria-label={`${label} の列のアクション`}
            style={{ left: pos.left, top: pos.top }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setOpen(false);
                btn.current?.focus();
              }
            }}
          >
            {actions.map((a) => (
              <button
                key={a.id}
                type="button"
                role="menuitem"
                className="menu-item"
                disabled={disabledReason !== undefined}
                title={disabledReason}
                onClick={() => {
                  setOpen(false);
                  onRun(gc, a);
                }}
              >
                {a.icon && [...a.icon].length <= 2 ? `${a.icon} ` : ""}
                {a.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
