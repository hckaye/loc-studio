// 壊し方の一覧: 表の複数選択（Shift / Ctrl）、右クリックのメニュー（値の変更、レビューの一括の投稿、コピーと貼り付け、
// プラグインのアクション、行の操作）、ツールバーの「＋ 行を追加」「行を削除」。
// 使い方: node scripts/mutation-check.mjs scripts/mutations/selection-and-menu.mjs
// 実装を直して from の文字列が変わったら、ここも合わせる（合わないものは SKIP と出る）。
const SELECTION = "apps/web/components/grid/selection.ts";
const SELECTION_TEST = "apps/web/components/grid/selection.test.ts";
const MENU = "apps/web/components/cell-menu.ts";
const MENU_TEST = "apps/web/components/cell-menu.test.tsx";
const GRID = "apps/web/components/grid/Grid.tsx";
const BULK = "apps/web/components/BulkReviewDialog.tsx";
const TOOLBAR = "apps/web/components/Toolbar.tsx";
const STRUCTURE_TEST = "apps/web/components/StructureDialog.test.tsx";

export default [
  // ---- 選択
  { name: "Shift で、列の方向には広げない", file: SELECTION, from: "return { row, col, anchor: sel.anchor, anchorCol: sel.anchorCol ?? sel.col,", to: "return { row, col, anchor: sel.anchor,", tests: `${SELECTION_TEST} ${MENU_TEST}` },
  { name: "Shift で、Ctrl で足してきた範囲を捨てる", file: SELECTION, from: "anchorCol: sel.anchorCol ?? sel.col, ...(sel.ranges ? { ranges: sel.ranges } : {}) };", to: "anchorCol: sel.anchorCol ?? sel.col };", tests: SELECTION_TEST },
  { name: "Ctrl で足すとき、いまの範囲を残さない", file: SELECTION, from: "    return { row, col, anchor: row, ranges: [...kept, active] };", to: "    return { row, col, anchor: row, ranges: kept };", tests: `${SELECTION_TEST} ${MENU_TEST}` },
  { name: "Ctrl でもう一度押しても、外さない", file: SELECTION, from: "    if (isSingle(active) && inRange(active, row, col)) {", to: "    if (false) {", tests: `${SELECTION_TEST} ${MENU_TEST}` },
  { name: "前に足したセルを、Ctrl で外せない", file: SELECTION, from: "    if (at >= 0) {", to: "    if (false) {", tests: SELECTION_TEST },
  { name: "重なったセルを 2 回数える", file: SELECTION, from: "  for (const rows of selectedRowsByColumn(sel).values()) n += rows.length;", to: "  for (const g of allRanges(sel)) n += (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1);", tests: SELECTION_TEST },
  { name: "収まらなくなった選択を、そのままにする", file: SELECTION, from: "  if (fits) return sel;", to: "  return sel;", tests: SELECTION_TEST },
  // ---- 表
  { name: "Ctrl ＋クリックを、ふつうのクリックとして扱う", file: GRID, from: "    const add = !extend && (e.ctrlKey || e.metaKey);", to: "    const add = false;", tests: MENU_TEST },
  { name: "Shift ＋左右の矢印で、範囲を広げない", file: GRID, from: "        moveTo(row, col + 1, e.shiftKey);", to: "        moveTo(row, col + 1, false);", tests: MENU_TEST },
  { name: "選んでいるセルに、印を付けない", file: GRID, from: "        aria-selected={selected}\n", to: "        aria-selected={active}\n", tests: MENU_TEST },
  { name: "選択の中のセルを右クリックしても、そのセルだけの選択にする", file: GRID, from: "    const next = inside ? selection : singleSelection(rowIndex, colIndex);", to: "    const next = singleSelection(rowIndex, colIndex);", tests: MENU_TEST },
  { name: "選択の外のセルを右クリックしても、選択を変えない", file: GRID, from: "    if (!inside) onSelectionChange(next);\n", to: "", tests: MENU_TEST },
  { name: "メニューキーで、メニューを開かない", file: GRID, from: "        if (r) props.onCellMenu({ x: r.left + 12, y: r.bottom - 4, rowIndex: row, colIndex: col, selection });\n", to: "", tests: MENU_TEST },
  // ---- メニューの中身
  { name: "言語をまたいで選んだ同じ列のセルを、対象にしない", file: MENU, from: "  const byCol = selectedRowsByColumn(sel, (c) => columns[c]?.col.id === gc.col.id);", to: "  const byCol = selectedRowsByColumn(sel, (c) => c === request.colIndex);", tests: MENU_TEST },
  { name: "1 つのセルでも、まとめて変える口を使う", file: MENU, from: "        if (cellCount === 1) {\n          const row = await rowAt(request.rowIndex);\n          if (row) await deps.setCellValue(row, gc, option.value);\n          return;\n        }\n", to: "", tests: MENU_TEST },
  { name: "まとめて変えたとき、変えられなかった数を知らせない", file: MENU, from: "          blocked += res.blocked.length;\n", to: "", tests: MENU_TEST },
  { name: "レビューが複数でも、1 つのパネルを開く", file: MENU, from: "  if (gc.kind === \"review\") {\n    if (cellCount === 1) {", to: "  if (gc.kind === \"review\") {\n    if (true) {", tests: MENU_TEST },
  { name: "役割で変えられない列でも、値を変える項目を押せる", file: MENU, from: "disabledReason: edit.reason ?? problem, onSelect: setTo(option) });", to: "disabledReason: problem, onSelect: setTo(option) });", tests: MENU_TEST },
  { name: "貼り付けられない列でも、貼り付けを押せる", file: MENU, from: "  const pasteReason = !PASTE_KINDS.has(gc.kind) || (gc.kind === \"enum\" && gc.col.renderer) ? \"この列には貼り付けられません\" : edit.reason;", to: "  const pasteReason = edit.reason;", tests: MENU_TEST },
  { name: "入れられない値でも、貼り付ける", file: MENU, from: "      if (\"error\" in parsed) return deps.notify(\"error\", parsed.error);\n", to: "      if (\"error\" in parsed) parsed.value = text;\n", tests: MENU_TEST },
  { name: "貼り付けのあと、読み直さない", file: MENU, from: "      if (done > 0) deps.refresh();\n", to: "", tests: MENU_TEST },
  { name: "貼り付ける本文の、末尾の改行を落とさない", file: MENU, from: "  const whole = text.replace(/\\r?\\n$/, \"\");", to: "  const whole = text;", tests: MENU_TEST },
  { name: "選択式に、表示名では貼り付けられない", file: MENU, from: "const found = options.find((o) => o.value === first) ?? options.find((o) => optionLabel(o) === first);", to: "const found = options.find((o) => o.value === first);", tests: MENU_TEST },
  { name: "コピーで、選んでいないセルも入れる", file: MENU, from: "(row && allByCol.get(c)!.includes(r) && columns[c] ? tsvCell(cellCopyText(row, columns[c]!)) : \"\")", to: "(row && columns[c] ? tsvCell(cellCopyText(row, columns[c]!)) : \"\")", tests: MENU_TEST },
  { name: "コピーで、選択式の値をそのまま出す", file: MENU, from: "  return option ? optionLabel(option) : displayValue(cell?.value);\n}\n\n/** タブ区切り", to: "  return displayValue(cell?.value);\n}\n\n/** タブ区切り", tests: MENU_TEST },
  { name: "選択が対象のアクションを、メニューに出さない", file: MENU, from: "    ...info.actions.filter((a) => a.target === \"selection\" && (!a.languages || gc.language === undefined || a.languages.includes(gc.language))),\n", to: "", tests: MENU_TEST },
  { name: "アクションを、選んでいる行ではなく押した行だけに実行する", file: MENU, from: "          await deps.runAction(a, await keysOf(rowIndexes), gc);", to: "          await deps.runAction(a, await keysOf([request.rowIndex]), gc);", tests: MENU_TEST },
  { name: "複数の行でも、キーの変更を出す", file: MENU, from: "  if (rowCount === 1) {\n    items.push({\n      id: \"row-rename\",", to: "  if (true) {\n    items.push({\n      id: \"row-rename\",", tests: MENU_TEST },
  { name: "行の削除が、選んでいる最初の行だけを消す", file: MENU, from: "      const keys = await keysOf(rowIndexes);\n      if (keys.length > 0) deps.structure({ kind: \"remove\", resourceId, keys });", to: "      const keys = await keysOf(rowIndexes.slice(0, 1));\n      if (keys.length > 0) deps.structure({ kind: \"remove\", resourceId, keys });", tests: MENU_TEST },
  { name: "行の追加が、選んでいる最初の行の後ろに足す", file: MENU, from: "      const last = (await keysOf(rowIndexes.slice(-1)))[0];", to: "      const last = (await keysOf(rowIndexes.slice(0, 1)))[0];", tests: MENU_TEST },
  { name: "役割でできない行の操作を、押せる", file: MENU, from: "    label: `行を削除…${rowSuffix}`,\n    danger: true,\n    disabledReason: structure,", to: "    label: `行を削除…${rowSuffix}`,\n    danger: true,", tests: MENU_TEST },
  // ---- レビューの一括の投稿
  { name: "コメントが必須の判定を、コメントなしで投稿できる", file: BULK, from: "verdict !== undefined && (!commentRequired || comment.trim() !== \"\") && !busy", to: "verdict !== undefined && !busy", tests: MENU_TEST },
  { name: "1 件の失敗で、残りの投稿をやめる", file: BULK, from: "        failures.push({ rowKey: t.rowKey, cellId: t.cellId, message: err instanceof Error ? err.message : String(err) });\n", to: "        failures.push({ rowKey: t.rowKey, cellId: t.cellId, message: err instanceof Error ? err.message : String(err) });\n        break;\n", tests: MENU_TEST },
  { name: "失敗があっても、窓を閉じる", file: BULK, from: "    if (failures.length === 0) {\n      push(\"success\",", to: "    if (true) {\n      push(\"success\",", tests: MENU_TEST },
  { name: "投稿できたセルを、表に反映しない", file: BULK, from: "        posted++;\n        onPosted(t.rowKey, t.cellId, {", to: "        posted++;\n        void ({", tests: MENU_TEST },
  // ---- ツールバーの行のボタン
  { name: "行を選んでいなくても、削除を押せる", file: TOOLBAR, from: "disabled={props.structureDisabledReason !== undefined || (props.selectedRows ?? 0) === 0}", to: "disabled={props.structureDisabledReason !== undefined}", tests: STRUCTURE_TEST },
  { name: "削除のボタンに、選んでいる行の数を出さない", file: TOOLBAR, from: "                行を削除{(props.selectedRows ?? 0) > 1 ? `（${props.selectedRows}）` : \"\"}", to: "                行を削除", tests: STRUCTURE_TEST },
  { name: "役割でできなくても、行の追加を押せる", file: TOOLBAR, from: "                disabled={props.structureDisabledReason !== undefined}\n                title={props.structureDisabledReason ?? \"選んでいる行の後ろに", to: "                disabled={false}\n                title={props.structureDisabledReason ?? \"選んでいる行の後ろに", tests: STRUCTURE_TEST },
];
