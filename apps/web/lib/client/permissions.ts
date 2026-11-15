import type { ProjectInfo } from "@loc-studio/server";
import type { GridColumn } from "./model";

/*
 * いまの利用者ができること（info.permissions）から、操作ごとに「できるか」と「できない理由」を決める。
 * 画面で無効にするのは分かりやすさのため。権限の確認そのものはサービス層が行う（forbidden）。
 */

export const REASON_READONLY = "読み取り専用です";
export const REASON_LANGUAGE = "この言語は担当外です";
export const REASON_LANG_READONLY = "この言語は編集できない設定です";

export interface Allowed {
  ok: boolean;
  /** できないときの理由（ツールチップに出す）。 */
  reason?: string;
}

const YES: Allowed = { ok: true };

type Perms = ProjectInfo["permissions"];

function perms(info: ProjectInfo): Perms {
  return info.permissions ?? { role: "manager", can: { edit: true, review: true, run: true, manage: true } };
}

/** 言語の制限（entry スコープの列は制限を受けない）。 */
export function languageAllowed(info: ProjectInfo, language: string | undefined): boolean {
  const langs = perms(info).languages;
  return language === undefined || !langs || langs.includes(language);
}

export function canEditCell(info: ProjectInfo, gc: Pick<GridColumn, "kind" | "language" | "col">): Allowed {
  const p = perms(info);
  if (gc.kind === "review") {
    if (!p.can.review) return { ok: false, reason: REASON_READONLY };
  } else if (!p.can.edit) return { ok: false, reason: REASON_READONLY };
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
  if (!languageAllowed(info, language)) return { ok: false, reason: REASON_LANGUAGE };
  if (info.languages.find((l) => l.id === language)?.editable === false) return { ok: false, reason: REASON_LANG_READONLY };
  return YES;
}

export function canReview(info: ProjectInfo, language: string | undefined): Allowed {
  if (!perms(info).can.review) return { ok: false, reason: REASON_READONLY };
  if (!languageAllowed(info, language)) return { ok: false, reason: REASON_LANGUAGE };
  return YES;
}

export const canEdit = (info: ProjectInfo): Allowed => (perms(info).can.edit ? YES : { ok: false, reason: REASON_READONLY });
export const canRun = (info: ProjectInfo): Allowed => (perms(info).can.run ? YES : { ok: false, reason: "アクションと生成を実行する権限がありません" });
export const canManage = (info: ProjectInfo): Allowed => (perms(info).can.manage ? YES : { ok: false, reason: "プロジェクトの管理者だけが変更できます" });

export const ROLE_LABEL: Record<string, string> = { viewer: "閲覧", translator: "翻訳", reviewer: "レビュー", manager: "管理" };
