// 壊し方の一覧: ツールバーのまとまりと「絞り込みを解除」、探す範囲の切り替え、設定のボタン、式の候補、列の幅のドラッグ（列の見出し、次の列の左端、言語の見出しの境目）。
// 使い方: node scripts/mutation-check.mjs scripts/mutations/toolbar-and-resize.mjs
// 実装を直して from の文字列が変わったら、ここも合わせる（合わないものは SKIP と出る）。
//
// 入れていない壊し方:
// - 「解除で、検索の文字を親に渡さない」: 検索欄は、入力が止まってから自分で親に伝えるので、少し遅れて同じ結果になる。
const TEST = "apps/web/components/Studio.test.tsx";
const TOOLBAR = "apps/web/components/Toolbar.tsx";
const GRID = "apps/web/components/grid/Grid.tsx";

export default [
  // ---- ツールバー
  { name: "絞り込んでいなくても「絞り込みを解除」を出す", file: TOOLBAR, from: "        {activeCount > 0 && (", to: "        {true && (", tests: TEST },
  { name: "効いている絞り込みの数に、行の状態を数えない", file: TOOLBAR, from: "    [filters.onlyUntranslated, filters.onlyIssues, filters.onlyStale, filters.onlyUnsaved].filter(Boolean).length;", to: "    0;", tests: TEST },
  { name: "効いている絞り込みの数に、検索を数えない", file: TOOLBAR, from: "    (filters.search.trim() !== \"\" ? 1 : 0) +\n", to: "", tests: TEST },
  { name: "解除で、行の状態を外さない", file: TOOLBAR, from: "values: {}, contains: {}, onlyUntranslated: false, onlyIssues: false, onlyStale: false, onlyUnsaved: false });", to: "values: {}, contains: {} });", tests: TEST },
  { name: "解除で、問題の重さも既定に戻す", file: TOOLBAR, from: "values: {}, contains: {}, onlyUntranslated: false,", to: "values: {}, contains: {}, issueLevel: \"warning\", onlyUntranslated: false,", tests: TEST },
  { name: "列の値のボタンに、ツールチップを付けない", file: TOOLBAR, from: " title={`「${columnLabel(col)}」の列の値を選んで、行を絞り込む`}", to: "", tests: TEST },
  { name: "列の値のまとまりを作らない", file: TOOLBAR, from: "          <div className=\"tb-group\" role=\"group\" aria-label=\"列の値で絞り込む\">", to: "          <div className=\"tb-group\">", tests: TEST },
  { name: "行の状態のまとまりに、見出しを出さない", file: TOOLBAR, from: "            行の状態で絞り込む\n", to: "", tests: TEST },
  // ---- 探す範囲（このファイル / 全体）、設定のボタン、式の候補
  { name: "「全体」を押しても、プロジェクト全体の検索結果を出さない", file: "apps/web/components/Studio.tsx", from: "onScope={(scope) => setView(scope === \"project\" ? \"search\" : \"grid\")}", to: "onScope={() => setView(\"grid\")}", tests: `${TEST} apps/web/components/find.test.tsx` },
  { name: "範囲のボタンが、いまの範囲を示さない", file: TOOLBAR, from: "              aria-pressed={props.scope === \"project\"}", to: "              aria-pressed={false}", tests: TEST },
  { name: "検索欄の説明が、範囲で変わらない", file: TOOLBAR, from: "placeholder={props.scope === \"project\" ? \"キーと本文を検索（プロジェクト全体）\" : \"キーと本文を検索（このファイル）\"}", to: "placeholder=\"キーと本文を検索（このファイル）\"", tests: TEST },
  { name: "Ctrl+Shift+F で、範囲を「全体」にしない", file: "apps/web/components/Studio.tsx", from: "          setView(\"search\");\n          searchRef.current?.focus();", to: "          searchRef.current?.focus();", tests: TEST },
  { name: "Ctrl+Shift+F で、検索欄に入らない", file: "apps/web/components/Studio.tsx", from: "          setView(\"search\");\n          searchRef.current?.focus();\n          searchRef.current?.select();", to: "          setView(\"search\");", tests: TEST },
  { name: "設定のボタンに、文字を出さない", file: "apps/web/components/Studio.tsx", from: "<span aria-hidden=\"true\">⚙</span> 設定", to: "<span aria-hidden=\"true\">⚙</span>", tests: TEST },
  { name: "選んだ候補を、一覧の見える位置に出さない", file: "apps/web/components/FindBar.tsx", from: "    listRef.current?.querySelector<HTMLElement>(`#query-suggestion-${active}`)?.scrollIntoView?.({ block: \"nearest\" });\n", to: "", tests: "apps/web/components/find.test.tsx" },
  // ---- 列の幅のドラッグ
  { name: "言語の見出しに、取っ手を置かない", file: GRID, from: "      {lastCol && <span className=\"g-resize\" aria-hidden=\"true\"", to: "      {false && <span className=\"g-resize\" aria-hidden=\"true\"", tests: TEST },
  { name: "境目の左端の取っ手を置かない", file: GRID, from: "    prev ? <span className=\"g-resize g-resize-prev\"", to: "    false ? <span className=\"g-resize g-resize-prev\"", tests: TEST },
  { name: "列の見出しの左端の取っ手が、自分の列の幅を変える", file: GRID, from: "        {prevResizeHandle(effLayout.all[colIndex - 1])}", to: "        {prevResizeHandle(gc)}", tests: TEST },
  { name: "言語の見出しの左端の取っ手が、自分の言語の列の幅を変える", file: GRID, from: "      {prevResizeHandle(prevGroup?.columns[prevGroup.columns.length - 1])}", to: "      {prevResizeHandle(g.columns[g.columns.length - 1])}", tests: TEST },
  { name: "言語の見出しの取っ手が、最初の列の幅を変える", file: GRID, from: "    const lastCol = g.columns[g.columns.length - 1];", to: "    const lastCol = g.columns[0];", tests: TEST },
  { name: "幅の下限を見ない", file: GRID, from: "      w = Math.max(MIN_COL_WIDTH, Math.round(startW + ev.clientX - startX));", to: "      w = Math.round(startW + ev.clientX - startX);", tests: TEST },
  { name: "ドラッグした幅を残さない", file: GRID, from: "      if (w !== startW) props.onResize(gc.cellId, w);\n", to: "", tests: TEST },
];
