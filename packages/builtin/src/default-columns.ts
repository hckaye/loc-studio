import type { ColumnDef } from "@loc-studio/sdk";

/*
 * 同梱プラグインが登録する列の定義。プロジェクトは `{ "use": "builtin.textStatus", ... }` で選び、
 * 必要なところ（type の選択肢、label、source など）を設定で上書きする。
 * ここの選択肢や表示名はこのプラグインの既定値であり、アプリの固定値ではない。
 *
 * ここでの id は「登録の id」。use で選んで id を書かなければ、列の id もこの登録の id になる。
 * 列の id は設定（review の of など）や DB の記録に残るので、プロジェクトでは
 * `{ "use": "builtin.textStatus", "id": "textStatus" }` のように短い id を付けるのが普通。
 */

/** キーの列。 */
export const keyColumn: ColumnDef = { id: "builtin.key", kind: "key", scope: "entry" };

/** 本文の列（値はリソースにあり、フォーマット経由で読み書きする）。 */
export const textColumn: ColumnDef = { id: "builtin.text", kind: "text", scope: "language" };

/** 本文の進捗ステータス。値はホストの DB に置く（builtin.db）。値を付けた時点の本文の版を残す。 */
export const textStatusColumn: ColumnDef = {
  id: "builtin.textStatus",
  kind: "meta",
  scope: "language",
  source: "builtin.db",
  label: "テキスト",
  type: {
    enum: [
      { value: "todo", label: "未着手", color: "gray" },
      { value: "wip", label: "作業中", color: "amber" },
      { value: "done", label: "確定", color: "ink", complete: true },
    ],
    default: "todo",
  },
  basis: "text",
};

/**
 * 本文に対するレビュー。値は最新の投稿の判定（builtin.reviews）。
 * of は本文の列の id。本文の列に別の id を付けたプロジェクトは of も上書きする。
 */
export const reviewStatusColumn: ColumnDef = {
  id: "builtin.reviewStatus",
  kind: "review",
  of: "text",
  scope: "language",
  source: "builtin.reviews",
  label: "レビュー",
  type: {
    enum: [
      { value: "none", label: "未レビュー", color: "gray" },
      { value: "doing", label: "レビュー中", color: "blue" },
      { value: "back", label: "差し戻し", color: "red", requireComment: true },
      { value: "ok", label: "承認", color: "green", complete: true },
    ],
    default: "none",
  },
};

/** 本文の文字数（Unicode のコードポイント数）。計算列で、値は保存しない。 */
export const lengthColumn: ColumnDef = {
  id: "builtin.length",
  kind: "computed",
  scope: "language",
  label: "文字数",
  type: "number",
  compute: ({ text }) => ({ value: Array.from(text ?? "").length }),
};

/** 同梱プラグインが登録する列の一覧。 */
export const builtinColumns: ColumnDef[] = [keyColumn, textColumn, textStatusColumn, reviewStatusColumn, lengthColumn];
