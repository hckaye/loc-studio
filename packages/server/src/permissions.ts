/**
 * 権限（Web モード）。メソッドごとに必要な権限を 1 つの表で決め、役割ごとにできることを決める。
 * 呼び出しに CallContext がないとき（ローカルモード）はすべて許す。
 */
import { ApiError } from "./api-types.js";
import type { CallContext, Permissions, Role, WorkspaceApi } from "./api-types.js";
import { currentCall } from "./call-context.js";

/**
 * - view: 見る（全員）
 * - edit: 本文の編集と保存、列の値の変更（レビュー列以外）
 * - review: レビューの投稿と転載
 * - run: アクションと生成の実行
 * - manage: プロジェクト設定の変更、プラグインの再読み込み
 * - self: 自分の設定の変更（全員。ただし Web モードでは user.name と secrets.* は変えられない）
 * - local-only: ローカルモードだけ（Web モードでは誰も呼べない）
 */
export type Capability = "view" | "edit" | "review" | "run" | "manage" | "self" | "local-only";

/** メソッドごとに必要な権限。WorkspaceApi にメソッドを足したら、ここに足さないと型の確認で失敗する。 */
export const METHOD_CAPABILITIES = {
  info: "view",
  tree: "view",
  stats: "view",
  rows: "view",
  rowDetail: "view",
  history: "view",
  reviews: "view",
  textVersion: "view",
  validateText: "view",
  search: "view",
  settings: "view",
  plugins: "view",
  jobs: "view",
  job: "view",
  changes: "view",
  validate: "view",
  reloadResource: "view",
  setText: "edit",
  discardDrafts: "edit",
  save: "edit",
  saveAll: "edit",
  setCell: "edit",
  setCells: "edit",
  postReview: "review",
  forwardReview: "review",
  runAction: "run",
  generate: "run",
  cancelJob: "run",
  setLocalSetting: "self",
  updateProjectSettings: "manage",
  reloadPlugins: "manage",
  trustPlugins: "local-only",
  untrustPlugins: "local-only",
} as const satisfies Record<keyof WorkspaceApi, Capability>;

const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  viewer: new Set(["view", "self"]),
  translator: new Set(["view", "self", "edit", "run"]),
  reviewer: new Set(["view", "self", "review", "run"]),
  manager: new Set(["view", "self", "edit", "review", "run", "manage"]),
};

export const ROLES: readonly Role[] = ["viewer", "translator", "reviewer", "manager"];

export function roleCan(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

/** 呼び出しの利用者が、このメソッドを呼べるか確かめる。 */
export function checkMethod(call: CallContext, method: keyof WorkspaceApi): void {
  const capability = METHOD_CAPABILITIES[method];
  if (capability === "local-only") throw new ApiError("forbidden", `「${method}」は Web モードでは使えません。`);
  if (!roleCan(call.role, capability)) {
    throw new ApiError("forbidden", `役割「${call.role}」では「${method}」はできません（必要な権限: ${capability}）。`);
  }
}

/** いまの呼び出しの利用者が、その言語のセルを編集・レビューできるか（言語の制限）。 */
export function languageAllowed(call: CallContext | undefined, language: string | undefined): boolean {
  if (!call || !call.languages || language === undefined) return true;
  return call.languages.includes(language);
}

/**
 * 書き込みの直前の確認（アクションの変更点もここを通る）。
 * capability の権限と、language スコープのセルなら言語の制限を見る。
 */
export function assertCan(capability: "edit" | "review", language: string | undefined): void {
  const call = currentCall();
  if (!call) return;
  if (!roleCan(call.role, capability)) {
    throw new ApiError("forbidden", `役割「${call.role}」では${capability === "edit" ? "編集" : "レビュー"}できません。`);
  }
  if (!languageAllowed(call, language)) {
    throw new ApiError("forbidden", `言語「${language}」のセルは${capability === "edit" ? "編集" : "レビュー"}できません（割り当てられた言語: ${call.languages!.join(", ")}）。`);
  }
}

export function permissionsFor(call: CallContext | undefined): Permissions {
  if (!call) return { role: "manager", can: { edit: true, review: true, run: true, manage: true } };
  const p: Permissions = {
    role: call.role,
    can: {
      edit: roleCan(call.role, "edit"),
      review: roleCan(call.role, "review"),
      run: roleCan(call.role, "run"),
      manage: roleCan(call.role, "manage"),
    },
  };
  if (call.languages) p.languages = [...call.languages];
  return p;
}
