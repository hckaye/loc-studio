// 壊し方の一覧: レビュー列のセル（最新の投稿のコメントと投稿者の表示）、投稿のあとでパネルを閉じること、
// セルのダブルクリック（キーはキーの変更、レビュー列は投稿パネル、選択式はドロップダウン）。
// 使い方: node scripts/mutation-check.mjs scripts/mutations/review-cell.mjs
// 実装を直して from の文字列が変わったら、ここも合わせる（合わないものは SKIP と出る）。
//
// 入れていない壊し方:
// - 「空のコメントも行に入れる」（packages/server/src/cells.ts）: 同梱の列ソースは空のコメントを返さないので、外から見た結果が変わらない。
const SOURCE_TEST = "packages/builtin/src/review-source.test.ts";
const SERVER_TEST = "packages/server/src/reviews.test.ts";
const PANEL_TEST = "apps/web/components/ReviewPanel.test.tsx";
const STUDIO_TEST = "apps/web/components/Studio.test.tsx";
const PANEL = "apps/web/components/ReviewPanel.tsx";
const CELLS = "apps/web/components/grid/cells.tsx";
const GRID = "apps/web/components/grid/Grid.tsx";

export default [
  // ---- 列ソースとサービス層
  { name: "列ソース: 最新の投稿のコメントを返さない", file: "packages/builtin/src/review-source.ts", from: "      if (rec.data.comment !== \"\") value.comment = rec.data.comment;\n", to: "", tests: SOURCE_TEST },
  { name: "列ソース: 空のコメントも返す", file: "packages/builtin/src/review-source.ts", from: "      if (rec.data.comment !== \"\") value.comment = rec.data.comment;\n", to: "      value.comment = rec.data.comment;\n", tests: SOURCE_TEST },
  { name: "サービス層: 列ソースのコメントを行に入れない", file: "packages/server/src/cells.ts", from: "            if (typeof v.comment === \"string\" && v.comment !== \"\") cell.comment = v.comment;\n", to: "", tests: SERVER_TEST },
  // ---- 投稿パネル
  { name: "投稿しても閉じない", file: PANEL, from: "      onClose();\n    } catch (err) {", to: "    } catch (err) {", tests: `${PANEL_TEST} ${STUDIO_TEST}` },
  { name: "投稿に失敗しても閉じる", file: PANEL, from: "      reportError(err, \"投稿できませんでした\");\n      setBusy(false);", to: "      reportError(err, \"投稿できませんでした\");\n      setBusy(false);\n      onClose();", tests: PANEL_TEST },
  { name: "投稿に失敗したあと、ボタンを戻さない", file: PANEL, from: "      reportError(err, \"投稿できませんでした\");\n      setBusy(false);", to: "      reportError(err, \"投稿できませんでした\");", tests: PANEL_TEST },
  { name: "投稿のコメントを表に渡さない", file: PANEL, from: "        ...(res.comment !== \"\" ? { comment: res.comment } : {}),\n", to: "", tests: `${PANEL_TEST} ${STUDIO_TEST}` },
  { name: "空のコメントも表に渡す", file: PANEL, from: "        ...(res.comment !== \"\" ? { comment: res.comment } : {}),\n", to: "        comment: res.comment,\n", tests: PANEL_TEST },
  { name: "投稿者を表に渡さない", file: PANEL, from: "        updatedBy: res.userName,\n", to: "", tests: `${PANEL_TEST} ${STUDIO_TEST}` },
  // ---- 表のセル
  { name: "セルにコメントを出さない", file: CELLS, from: "          {note !== undefined && (", to: "          {false && (", tests: STUDIO_TEST },
  { name: "選択式の列にもコメントを出す", file: CELLS, from: "const note = gc.kind === \"review\" && typeof cell?.comment === \"string\"", to: "const note = typeof cell?.comment === \"string\"", tests: STUDIO_TEST },
  { name: "セルに投稿者を出さない", file: CELLS, from: "{cell?.updatedBy && <span className=\"review-note-by\">{cell.updatedBy}</span>}", to: "", tests: STUDIO_TEST },
  { name: "ツールチップに投稿者を入れない", file: CELLS, from: "title={cell?.updatedBy ? `${cell.updatedBy}: ${note}` : note}", to: "title={note}", tests: STUDIO_TEST },
  // ---- ダブルクリック
  { name: "レビュー列のダブルクリックで、投稿パネルを開かない", file: GRID, from: "      if (row) props.onOpenReview(row, gc);\n", to: "", tests: STUDIO_TEST },
  { name: "レビュー列のダブルクリックで、ドロップダウンを開く", file: GRID, from: "    } else if (gc.kind === \"review\") {", to: "    } else if (false) {", tests: STUDIO_TEST },
  { name: "キーのダブルクリックで、キーの変更を開かない", file: GRID, from: "      if (row) props.onRenameKey?.(row);\n", to: "", tests: STUDIO_TEST },
  { name: "行の構成を変えられない役割でも、キーの変更を開く", file: "apps/web/components/Studio.tsx", from: "      if (!allowed.ok) return push(\"info\", allowed.reason ?? \"キーは変更できません\");\n", to: "", tests: STUDIO_TEST },
  { name: "選択式のダブルクリックで、ドロップダウンを開かない", file: GRID, from: "[aria-expanded='false']\")?.click();", to: "[aria-expanded='false']\");", tests: STUDIO_TEST },
  { name: "選択式のボタンが、ダブルクリックをセルに伝えない", file: "apps/web/components/EnumSelect.tsx", from: "          else openList();\n        }}\n", to: "          else openList();\n        }}\n        onDoubleClick={(e) => e.stopPropagation()}\n", tests: STUDIO_TEST },
];
