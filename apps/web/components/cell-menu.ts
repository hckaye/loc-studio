import type { ActionInfo, CellInfo, ProjectInfo, RowInfo } from "@loc-studio/server";
import type { BulkReviewTarget } from "@/components/BulkReviewDialog";
import type { ContextMenuItem } from "@/components/ContextMenu";
import type { GenerateRequest } from "@/components/GenerateDialog";
import { actionsForColumn } from "@/components/grid/cells";
import type { CellMenuRequest } from "@/components/grid/Grid";
import { isMultiSelection, selectedRows, selectedRowsByColumn } from "@/components/grid/selection";
import type { RowPages } from "@/components/grid/useRowPages";
import type { StructureRequest } from "@/components/StructureDialog";
import type { ClientApi } from "@/lib/client/api";
import { columnLabel, displayValue, enumOptions, findOption, optionLabel, textValue, type ColumnDef, type EnumOption, type GridColumn } from "@/lib/client/model";
import { canEditCell, canGenerate, canReview, canRunAction, canStructure, optionProblem } from "@/lib/client/permissions";

/*
 * 表のセルの右クリックのメニュー。選んでいるセルと行に対する操作を並べる。
 *
 * - セルへの操作（編集、レビューの投稿、値の変更、貼り付け、生成）の対象は、押したセルと同じ列の、選んでいるセル。
 *   言語ごとの列では、ほかの言語の同じ列のセルを選んでいれば、それも対象になる（2 つの言語のレビューを、まとめて投稿できる）。
 * - 行への操作（追加、キーの変更、削除、アクション）の対象は、選んでいるセルのある行。
 * - まとめて変える項目には、対象の件数を名前に出す。終わったら、変えた数と、変えられなかった数を通知する。
 * 列の ID、言語、選択肢の値は決め打ちしない（列の種類と、列の定義の選択肢から作る）。
 *
 * プラグインは、アクション（Action）でメニューに項目を足す。対象（target）が cell / row / selection のアクションを、
 * プロジェクト設定の actions に置くと、「アクション」のまとまりに並ぶ。アクションの columns / languages と、列の定義の actions で、
 * 出す列と言語を絞れる（列を足すプラグインは、その列のセルだけに出す項目を、列の定義の actions に書ける）。
 */

export interface CellMenuDeps {
  api: ClientApi;
  info: ProjectInfo;
  resourceId: string;
  /** 表に出している列（layout.all）。 */
  columns: GridColumn[];
  rows: Pick<RowPages, "getRow" | "loadRow">;
  visibleLanguages: string[];
  notify(kind: "success" | "info" | "warning" | "error", message: string): void;
  reportError(err: unknown, what: string): void;
  /** 値が変わったあと、表とツリーを読み直す。 */
  refresh(): void;
  /** 列の値を 1 つ変える（競合したら、競合の窓を出す）。変えられたら、変えたあとのセル。 */
  setCellValue(row: RowInfo, gc: GridColumn, value: unknown): Promise<CellInfo | undefined>;
  runAction(action: ActionInfo, keys: string[], gc?: GridColumn): Promise<void> | void;
  editText(rowIndex: number, gc: GridColumn): void;
  openReview(row: RowInfo, gc: GridColumn): void;
  bulkReview(column: ColumnDef, targets: BulkReviewTarget[]): void;
  generate(request: GenerateRequest): void;
  structure(request: StructureRequest): void;
  clearSelection(): void;
}

/** 貼り付けられる種類の列か（本文、文字、数値、選択式）。 */
const PASTE_KINDS = new Set<GridColumn["kind"]>(["text", "string", "number", "enum"]);

/** コピーするときの、セルの文字（選択式は表示名、ほかは値）。 */
export function cellCopyText(row: RowInfo, gc: GridColumn): string {
  if (gc.kind === "key") return row.key;
  const cell = row.cells[gc.cellId];
  if (gc.kind === "text") return textValue(cell);
  const option = findOption(gc.col, cell?.value);
  return option ? optionLabel(option) : displayValue(cell?.value);
}

/** タブ区切りの 1 つの値。タブ、改行、引用符を含む値は、引用符で囲む（表計算ソフトに貼れる形）。 */
const tsvCell = (text: string): string => (/[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);

/** 貼り付ける文字を、その列の値にする。入れられない値なら、理由。 */
export function pastedValue(text: string, gc: GridColumn): { value: unknown } | { error: string } {
  // 表計算ソフトからコピーした 1 つのセルは、末尾に改行が付く。
  const whole = text.replace(/\r?\n$/, "");
  if (gc.kind === "text") return { value: whole };
  // 本文以外の列には、最初の 1 つの値だけを入れる。
  const first = (whole.split(/\r?\n/)[0] ?? "").split("\t")[0] ?? "";
  if (gc.kind === "string") return { value: first };
  if (gc.kind === "number") {
    if (first.trim() === "") return { value: null };
    const n = Number(first);
    return Number.isNaN(n) ? { error: `数値ではないため、貼り付けられません: ${first.slice(0, 40)}` } : { value: n };
  }
  if (gc.kind === "enum") {
    const options = enumOptions(gc.col) ?? [];
    const found = options.find((o) => o.value === first) ?? options.find((o) => optionLabel(o) === first);
    return found ? { value: found.value } : { error: `「${columnLabel(gc.col)}」の選択肢にない値のため、貼り付けられません: ${first.slice(0, 40)}（選択肢: ${options.map(optionLabel).join("、")}）` };
  }
  return { error: "この列には貼り付けられません" };
}

export function buildCellMenu(request: CellMenuRequest, deps: CellMenuDeps): ContextMenuItem[] {
  const { api, info, resourceId, columns, rows } = deps;
  const gc = columns[request.colIndex];
  if (!gc) return [];
  const sel = request.selection;
  const rowIndexes = selectedRows(sel);
  const rowCount = rowIndexes.length;
  const rowSuffix = rowCount > 1 ? `（${rowCount} 行）` : "";

  // 押したセルと同じ列の、選んでいるセル（列番号 → 行番号）。行番号の欄から開いたときなど、押したセルが入っていなければ足す。
  const byCol = selectedRowsByColumn(sel, (c) => columns[c]?.col.id === gc.col.id);
  if (!byCol.get(request.colIndex)?.includes(request.rowIndex)) byCol.set(request.colIndex, [...(byCol.get(request.colIndex) ?? []), request.rowIndex].sort((a, b) => a - b));
  const targets = [...byCol.entries()].map(([c, list]) => ({ gc: columns[c]!, rows: list }));
  const cellCount = targets.reduce((n, t) => n + t.rows.length, 0);
  const cellSuffix = cellCount > 1 ? `（${cellCount} 件）` : "";

  const rowAt = async (index: number): Promise<RowInfo | undefined> => rows.getRow(index) ?? (await rows.loadRow(index));
  const keysOf = async (indexes: number[]): Promise<string[]> => {
    const keys: string[] = [];
    for (const i of indexes) {
      const row = await rowAt(i);
      if (row) keys.push(row.key);
    }
    return keys;
  };
  /** 項目の処理を、失敗を通知に出す形で包む。 */
  const guarded = (what: string, run: () => Promise<void>) => () => {
    run().catch((err: unknown) => deps.reportError(err, what));
  };

  const items: ContextMenuItem[] = [];
  const clickedRow = rows.getRow(request.rowIndex);
  const edit = canEditCell(info, gc);

  // ---- セルを開く操作（1 つだけ選んでいるとき）
  if (cellCount === 1 && gc.kind === "text") {
    items.push({ id: "edit-text", label: "本文を編集…", hint: "Enter", disabledReason: edit.reason, onSelect: () => deps.editText(request.rowIndex, gc) });
  }
  if (gc.kind === "review") {
    if (cellCount === 1) {
      items.push({
        id: "review",
        label: "レビューを投稿…",
        onSelect: guarded("レビューを開けませんでした", async () => {
          const row = await rowAt(request.rowIndex);
          if (row) deps.openReview(row, gc);
        }),
      });
    } else {
      // 投稿できる言語のセルが 1 つもなければ、理由を出して押せなくする（一部だけできないときは、投稿のあとで理由を出す）。
      const allowed = targets.filter((t) => canReview(info, t.gc.col.scope === "language" ? t.gc.language : undefined, t.gc.col.id).ok);
      const reason = allowed.length === 0 ? canReview(info, gc.col.scope === "language" ? gc.language : undefined, gc.col.id).reason : undefined;
      items.push({
        id: "bulk-review",
        label: `レビューを一括で投稿…${cellSuffix}`,
        disabledReason: reason,
        onSelect: guarded("レビューを開けませんでした", async () => {
          const list: BulkReviewTarget[] = [];
          for (const t of targets) for (const key of await keysOf(t.rows)) list.push({ rowKey: key, cellId: t.gc.cellId, language: t.gc.language });
          deps.bulkReview(gc.col, list);
        }),
      });
    }
  }

  // ---- 選択式の列の値を変える
  if (gc.kind === "enum" && !gc.col.renderer) {
    const options = enumOptions(gc.col) ?? [];
    items.push({ kind: "header", id: "enum-head", label: `「${columnLabel(gc.col)}」を変える${cellSuffix}` });
    const setTo = (option: EnumOption) =>
      guarded(`${columnLabel(gc.col)} を変更できませんでした`, async () => {
        if (cellCount === 1) {
          const row = await rowAt(request.rowIndex);
          if (row) await deps.setCellValue(row, gc, option.value);
          return;
        }
        let updated = 0;
        let blocked = 0;
        for (const t of targets) {
          if (!canEditCell(info, t.gc).ok) {
            blocked += t.rows.length;
            continue;
          }
          const res = await api.setCells({ resourceId, keys: await keysOf(t.rows), cellId: t.gc.cellId, value: option.value });
          updated += res.updated;
          blocked += res.blocked.length;
        }
        deps.notify(blocked > 0 ? "warning" : "success", `${updated} 件の「${columnLabel(gc.col)}」を「${optionLabel(option)}」にしました${blocked > 0 ? `（${blocked} 件は変更していません）` : ""}`);
        deps.refresh();
      });
    for (const option of options) {
      // 1 つだけのときは、いまの値から選べない選択肢を、理由つきで押せなくする（まとめて変えるときは、サービス層がセルごとに確かめる）。
      const problem = cellCount === 1 && clickedRow ? optionProblem(info, gc.col, option, clickedRow.cells[gc.cellId]?.value) : undefined;
      items.push({ id: `enum:${option.value}`, label: `「${optionLabel(option)}」にする`, disabledReason: edit.reason ?? problem, onSelect: setTo(option) });
    }
  }

  // ---- コピーと貼り付け
  if (items.length > 0) items.push({ kind: "separator", id: "sep-clipboard" });
  const allByCol = selectedRowsByColumn(sel);
  const copyCols = [...allByCol.keys()];
  const copyCount = [...allByCol.values()].reduce((n, list) => n + list.length, 0);
  items.push({
    id: "copy",
    label: `コピー${copyCount > 1 ? `（${copyCount} セル）` : ""}`,
    onSelect: guarded("コピーできませんでした", async () => {
      if (!navigator.clipboard?.writeText) throw new Error("このブラウザでは、クリップボードに書けません。");
      let text: string;
      if (copyCount <= 1) {
        const row = await rowAt(request.rowIndex);
        text = row ? cellCopyText(row, gc) : "";
      } else {
        // 選んでいるセルを、行と列の形のまま、タブ区切りにする（選んでいないセルは空）。
        const lines: string[] = [];
        for (const r of rowIndexes) {
          const row = await rowAt(r);
          lines.push(copyCols.map((c) => (row && allByCol.get(c)!.includes(r) && columns[c] ? tsvCell(cellCopyText(row, columns[c]!)) : "")).join("\t"));
        }
        text = lines.join("\n");
      }
      await navigator.clipboard.writeText(text);
      deps.notify("success", copyCount > 1 ? `${copyCount} セルをコピーしました（表計算ソフトに貼り付けられます）` : "コピーしました");
    }),
  });
  const pasteReason = !PASTE_KINDS.has(gc.kind) || (gc.kind === "enum" && gc.col.renderer) ? "この列には貼り付けられません" : edit.reason;
  items.push({
    id: "paste",
    label: `貼り付け${cellSuffix}`,
    disabledReason: pasteReason,
    onSelect: guarded("貼り付けられませんでした", async () => {
      if (!navigator.clipboard?.readText) throw new Error("このブラウザでは、クリップボードを読めません。");
      const text = await navigator.clipboard.readText();
      const parsed = pastedValue(text, gc);
      if ("error" in parsed) return deps.notify("error", parsed.error);
      let done = 0;
      let failed = 0;
      for (const t of targets) {
        for (const r of t.rows) {
          const row = await rowAt(r);
          if (!row || !canEditCell(info, t.gc).ok) {
            failed++;
            continue;
          }
          if (t.gc.kind === "text") {
            if (t.gc.language === undefined) {
              failed++;
              continue;
            }
            try {
              await api.setText({ resourceId, key: row.key, language: t.gc.language, value: String(parsed.value) });
              done++;
            } catch (err) {
              failed++;
              if (cellCount === 1) throw err;
            }
            continue;
          }
          // 選択式の列は、いまの値から選べない値を入れない。
          if (t.gc.kind === "enum") {
            const option = findOption(t.gc.col, parsed.value);
            if (option && optionProblem(info, t.gc.col, option, row.cells[t.gc.cellId]?.value) !== undefined) {
              failed++;
              continue;
            }
          }
          if ((await deps.setCellValue(row, t.gc, parsed.value)) !== undefined) done++;
          else failed++;
        }
      }
      if (done > 0 || failed > 0) deps.notify(failed > 0 ? "warning" : "success", `${done} 件に貼り付けました${failed > 0 ? `（${failed} 件は貼り付けられませんでした）` : ""}`);
      if (done > 0) deps.refresh();
    }),
  });

  // ---- 生成列
  if (gc.kind === "generated") {
    const languages = [...new Set(targets.map((t) => t.gc.language).filter((l): l is string => l !== undefined))];
    items.push({
      id: "generate",
      label: `生成…${rowSuffix}`,
      disabledReason: canGenerate(info, gc.col.id).reason,
      onSelect: guarded("生成を始められませんでした", async () => {
        deps.generate({ column: gc.col, resourceId, keys: await keysOf(rowIndexes), languages: languages.length > 0 ? languages : deps.visibleLanguages, scope: rowCount > 1 ? "selection" : "cell" });
      }),
    });
  }

  // ---- アクション（プラグインがメニューに項目を足す拡張ポイント）
  // セルと行が対象のアクションは、アクション列のボタンと同じ決まりで選ぶ（アクションの columns / languages、列の定義の actions）。
  // 選択が対象のアクションは、言語が合えば、どの列のセルからでも実行できる。
  const actions = [
    ...actionsForColumn(info, gc),
    ...info.actions.filter((a) => a.target === "selection" && (!a.languages || gc.language === undefined || a.languages.includes(gc.language))),
  ];
  if (actions.length > 0) {
    items.push({ kind: "separator", id: "sep-actions" });
    items.push({ kind: "header", id: "actions-head", label: `アクション${rowSuffix}` });
    for (const a of actions) {
      items.push({
        id: `action:${a.id}`,
        label: a.label,
        disabledReason: canRunAction(info, a.id).reason,
        onSelect: guarded(`${a.label} を実行できませんでした`, async () => {
          await deps.runAction(a, await keysOf(rowIndexes), gc);
        }),
      });
    }
  }

  // ---- 行の操作
  const structure = canStructure(info).reason;
  items.push({ kind: "separator", id: "sep-rows" });
  items.push({
    id: "row-add",
    label: "＋ 行を追加…",
    disabledReason: structure,
    onSelect: guarded("行を追加できませんでした", async () => {
      const last = (await keysOf(rowIndexes.slice(-1)))[0];
      deps.structure({ kind: "add", resourceId, ...(last !== undefined ? { after: last } : {}) });
    }),
  });
  if (rowCount === 1) {
    items.push({
      id: "row-rename",
      label: "キーを変更…",
      disabledReason: structure,
      onSelect: guarded("キーを変更できませんでした", async () => {
        const key = (await keysOf(rowIndexes))[0];
        if (key !== undefined) deps.structure({ kind: "rename", resourceId, key });
      }),
    });
  }
  items.push({
    id: "row-remove",
    label: `行を削除…${rowSuffix}`,
    danger: true,
    disabledReason: structure,
    onSelect: guarded("行を削除できませんでした", async () => {
      const keys = await keysOf(rowIndexes);
      if (keys.length > 0) deps.structure({ kind: "remove", resourceId, keys });
    }),
  });
  if (isMultiSelection(sel)) {
    items.push({ kind: "separator", id: "sep-selection" });
    items.push({ id: "clear-selection", label: "選択を解除", onSelect: deps.clearSelection });
  }
  return items;
}
