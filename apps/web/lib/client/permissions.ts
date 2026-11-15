import type { ProjectInfo } from "@loc-studio/server";
import { enumDefault, optionLabel, type ColumnDef, type EnumOption, type GridColumn } from "./model";

/*
 * いまの利用者ができること（info.permissions）から、操作ごとに「できるか」と「できない理由」を決める。
 * 画面で無効にするのは分かりやすさのため。権限の確認そのものはサービス層が行う（forbidden）。
 */

export const REASON_READONLY = "読み取り専用です";
export const REASON_LANGUAGE = "この言語は担当外です";
export const REASON_LANG_READONLY = "この言語は編集できない設定です";
export const REASON_COLUMN = "この列は、あなたの役割では変更できません";

export interface Allowed {
  ok: boolean;
  /** できないときの理由（ツールチップに出す）。 */
  reason?: string;
}

const YES: Allowed = { ok: true };

type Perms = ProjectInfo["permissions"];

function perms(info: ProjectInfo): Perms {
  return info.permissions ?? { role: "manager", can: { edit: true, review: true, run: true, structure: true, manage: true }, unrestricted: true };
}

/** 言語の制限（entry スコープの列は制限を受けない）。 */
export function languageAllowed(info: ProjectInfo, language: string | undefined): boolean {
  const langs = perms(info).languages;
  return language === undefined || !langs || langs.includes(language);
}

/** 役割の列の絞り込み（editColumns / reviewColumns）。書かれていなければ制限なし。 */
function columnAllowed(list: string[] | undefined, columnId: string): boolean {
  return list === undefined || list.includes(columnId);
}

export function canEditCell(info: ProjectInfo, gc: Pick<GridColumn, "kind" | "language" | "col">): Allowed {
  const p = perms(info);
  if (gc.kind === "review") {
    if (!p.can.review) return { ok: false, reason: REASON_READONLY };
    if (!columnAllowed(p.reviewColumns, gc.col.id)) return { ok: false, reason: REASON_COLUMN };
  } else {
    if (!p.can.edit) return { ok: false, reason: REASON_READONLY };
    if (!columnAllowed(p.editColumns, gc.col.id)) return { ok: false, reason: REASON_COLUMN };
  }
  if (!languageAllowed(info, gc.col.scope === "language" ? gc.language : undefined)) return { ok: false, reason: REASON_LANGUAGE };
  if (gc.kind === "text" && gc.language) {
    const lang = info.languages.find((l) => l.id === gc.language);
    if (lang?.editable === false) return { ok: false, reason: REASON_LANG_READONLY };
  }
  return YES;
}

export function canEditText(info: ProjectInfo, language: string): Allowed {
  const p = perms(info);
  if (!p.can.edit) return { ok: false, reason: REASON_READONLY };
  const textCol = info.columns.find((c) => c.kind === "text");
  if (textCol && !columnAllowed(p.editColumns, textCol.id)) return { ok: false, reason: REASON_COLUMN };
  if (!languageAllowed(info, language)) return { ok: false, reason: REASON_LANGUAGE };
  if (info.languages.find((l) => l.id === language)?.editable === false) return { ok: false, reason: REASON_LANG_READONLY };
  return YES;
}

export function canReview(info: ProjectInfo, language: string | undefined, columnId?: string): Allowed {
  if (!perms(info).can.review) return { ok: false, reason: REASON_READONLY };
  if (columnId !== undefined && !columnAllowed(perms(info).reviewColumns, columnId)) return { ok: false, reason: REASON_COLUMN };
  if (!languageAllowed(info, language)) return { ok: false, reason: REASON_LANGUAGE };
  return YES;
}

export const canEdit = (info: ProjectInfo): Allowed => (perms(info).can.edit ? YES : { ok: false, reason: REASON_READONLY });
export const canRun = (info: ProjectInfo): Allowed => (perms(info).can.run ? YES : { ok: false, reason: "アクションと生成を実行する権限がありません" });

/** そのアクションを実行できるか（役割の actions の絞り込みも見る）。 */
export function canRunAction(info: ProjectInfo, actionId: string): Allowed {
  const run = canRun(info);
  if (!run.ok) return run;
  return columnAllowed(perms(info).actions, actionId) ? YES : { ok: false, reason: "このアクションは、あなたの役割では実行できません" };
}

/** その生成列を生成できるか（役割の generators の絞り込みも見る）。 */
export function canGenerate(info: ProjectInfo, columnId: string): Allowed {
  const run = canRun(info);
  if (!run.ok) return run;
  return columnAllowed(perms(info).generators, columnId) ? YES : { ok: false, reason: "この列の生成は、あなたの役割では実行できません" };
}
export const canStructure = (info: ProjectInfo): Allowed =>
  perms(info).can.structure ? YES : { ok: false, reason: "行の追加・削除とリソースの作成は、あなたの役割ではできません" };
export const canManage = (info: ProjectInfo): Allowed => (perms(info).can.manage ? YES : { ok: false, reason: "プロジェクトの管理者だけが変更できます" });

/**
 * 選択肢の遷移の制限（from）と役割の制限（roles）。その値を選べないときは理由を返す。
 * current はセルのいまの値（レビュー列では直前の判定）。値がなければ列の既定値として扱う。
 * 画面で選べなくするのは分かりやすさのため。確認そのものはサービス層が行う（blocked）。
 */
export function optionProblem(info: ProjectInfo, col: ColumnDef, option: EnumOption, current: unknown): string | undefined {
  const p = perms(info);
  const cur = current === undefined || current === null || current === "" ? enumDefault(col) : current;
  if (cur === option.value) return undefined;
  if (option.roles && !p.unrestricted && !option.roles.includes(p.role)) {
    return `「${optionLabel(option)}」にできるのは、役割が ${option.roles.join(" / ")} の利用者だけです`;
  }
  if (option.from && !option.from.includes(String(cur))) {
    const options = typeof col.type === "object" && col.type !== null && "enum" in col.type ? col.type.enum : [];
    const names = option.from.map((v) => optionLabel(options.find((o) => o.value === v) ?? { value: v }));
    return `「${optionLabel(option)}」には、${names.join("、") || "どの値"} からだけ変えられます`;
  }
  return undefined;
}

/** 役割の表示名。プロジェクトを開いたあとは、サービス層が返す名前（役割の定義の label）を使う。 */
export function roleLabel(info: ProjectInfo): string {
  const p = perms(info);
  return p.roleLabel ?? info.roles?.find((r) => r.id === p.role)?.label ?? p.role;
}
