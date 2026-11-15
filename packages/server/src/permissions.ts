/**
 * 権限（Web モード）。メソッドごとに必要な権限を 1 つの表で決める。役割ごとにできることは、プロジェクトの
 * 役割の定義（同梱の役割に設定の `roles` を重ねたもの）で決まる。
 * 呼び出しに CallContext がないとき（ローカルモード）はすべて許す。
 */
import { DEFAULT_ROLES, roleSeesResource } from "@loc-studio/core";
import type { RoleCapability, RoleDef } from "@loc-studio/sdk";
import { ApiError } from "./api-types.js";
import type { CallContext, Permissions, Role, WorkspaceApi } from "./api-types.js";
import { currentCallState, isSystemWrite } from "./call-context.js";

/**
 * - view: 見る（役割を持つ全員）
 * - edit: 本文の編集と保存、列の値の変更（レビュー列以外）
 * - review: レビューの投稿と転載
 * - run: アクションと生成の実行
 * - structure: 行の追加・削除・キーの変更、リソースの作成
 * - manage: プロジェクト設定の変更、プラグインの再読み込み
 * - self: 自分の設定の変更（全員。ただし Web モードでは user.name と secrets.* は変えられない）
 * - local-only: ローカルモードだけ（Web モードでは誰も呼べない）
 */
export type Capability = "view" | "edit" | "review" | "run" | "structure" | "manage" | "self" | "local-only";

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
  tokens: "view",
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
  editEntries: "structure",
  createResource: "structure",
  setLocalSetting: "self",
  updateProjectSettings: "manage",
  reloadPlugins: "manage",
  trustPlugins: "local-only",
  untrustPlugins: "local-only",
} as const satisfies Record<keyof WorkspaceApi, Capability>;

/** サーバーの管理者の権限。役割の定義にかかわらず、すべてできる。 */
const ADMIN_ROLE: RoleDef = Object.freeze({ label: "管理", can: ["edit", "review", "run", "structure", "manage"] }) as RoleDef;

type Roles = Readonly<Record<string, RoleDef>>;

/** 呼び出した利用者の役割の定義。役割が定義にない（設定から消えた）ときは undefined。 */
export function roleOf(call: CallContext, roles: Roles = DEFAULT_ROLES): RoleDef | undefined {
  if (call.admin) return ADMIN_ROLE;
  return Object.prototype.hasOwnProperty.call(roles, call.role) ? roles[call.role] : undefined;
}

function defCan(def: RoleDef, capability: Capability): boolean {
  if (capability === "local-only") return false;
  if (capability === "view" || capability === "self") return true;
  return def.can.includes(capability);
}

/** 役割 role に capability があるか（役割の定義は roles。省略時は同梱の役割）。 */
export function roleCan(role: Role, capability: Capability, roles: Roles = DEFAULT_ROLES): boolean {
  const def = roleOf({ user: { name: "" }, role }, roles);
  return def !== undefined && defCan(def, capability);
}

const unknownRole = (role: string): ApiError =>
  new ApiError("forbidden", `役割「${role}」は、このプロジェクトの設定にありません。管理者に割り当てを直してもらってください。`);

/** 呼び出しの利用者が、このメソッドを呼べるか確かめる。 */
export function checkMethod(call: CallContext, method: keyof WorkspaceApi, roles: Roles = DEFAULT_ROLES): void {
  const capability = METHOD_CAPABILITIES[method];
  if (capability === "local-only") throw new ApiError("forbidden", `「${method}」は Web モードでは使えません。`);
  const def = roleOf(call, roles);
  if (!def) throw unknownRole(call.role);
  if (!defCan(def, capability)) {
    throw new ApiError("forbidden", `役割「${call.role}」では「${method}」はできません（必要な権限: ${capability}）。`);
  }
}

/** いまの呼び出しの利用者と役割。呼び出しの外（ローカルモード）と、システムの書き込み（フックの変更点）は undefined。 */
function current(): { call: CallContext; def: RoleDef | undefined } | undefined {
  const state = currentCallState();
  if (!state || isSystemWrite()) return undefined;
  return { call: state.call, def: roleOf(state.call, state.roles ?? DEFAULT_ROLES) };
}

/** いまの呼び出しの利用者が、その言語のセルを編集・レビューできるか（言語の制限）。 */
export function languageAllowed(call: CallContext | undefined, language: string | undefined): boolean {
  if (!call || !call.languages || language === undefined) return true;
  return call.languages.includes(language);
}

const WORD = { edit: "編集", review: "レビュー" } as const;

/**
 * 書き込みの直前の確認（アクションの変更点もここを通る）。
 * capability の権限、列の絞り込み（editColumns / reviewColumns）、language スコープのセルなら言語の制限を見る。
 */
export function assertCan(capability: "edit" | "review", language: string | undefined, columnId?: string): void {
  const cur = current();
  if (!cur) return;
  const { call, def } = cur;
  if (!def) throw unknownRole(call.role);
  if (!def.can.includes(capability)) {
    throw new ApiError("forbidden", `役割「${call.role}」では${WORD[capability]}できません。`);
  }
  const columns = capability === "edit" ? def.editColumns : def.reviewColumns;
  if (columnId !== undefined && columns !== undefined && !columns.includes(columnId)) {
    throw new ApiError(
      "forbidden",
      `役割「${call.role}」では列「${columnId}」は${WORD[capability]}できません（${WORD[capability]}できる列: ${columns.join(", ") || "なし"}）。`,
    );
  }
  if (!languageAllowed(call, language)) {
    throw new ApiError("forbidden", `言語「${language}」のセルは${WORD[capability]}できません（割り当てられた言語: ${call.languages!.join(", ")}）。`);
  }
}

/** assertCan の、例外を投げない形（ドラフトの絞り込みなどに使う）。 */
export function can(capability: "edit" | "review", language: string | undefined, columnId?: string): boolean {
  try {
    assertCan(capability, language, columnId);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === "forbidden") return false;
    throw err;
  }
}

/** アクション（kind: "action"、id はアクションの ID）や生成（kind: "generator"、id は生成列の ID）を実行できるか確かめる。 */
export function assertCanRun(kind: "action" | "generator", id: string): void {
  const cur = current();
  if (!cur) return;
  const { call, def } = cur;
  if (!def) throw unknownRole(call.role);
  const what = kind === "action" ? "アクション" : "生成列";
  if (!def.can.includes("run")) throw new ApiError("forbidden", `役割「${call.role}」では${what}を実行できません。`);
  const list = kind === "action" ? def.actions : def.generators;
  if (list !== undefined && !list.includes(id)) {
    throw new ApiError("forbidden", `役割「${call.role}」では${what}「${id}」を実行できません（実行できるもの: ${list.join(", ") || "なし"}）。`);
  }
}

/**
 * 選択肢の roles（その値を選べる役割）に、いまの利用者の役割が入っているか。
 * ローカルモード、サーバーの管理者、システムの書き込みは制限しない。
 */
export function optionRoleAllowed(roles: string[] | undefined): boolean {
  if (roles === undefined) return true;
  const cur = current();
  if (!cur || cur.call.admin) return true;
  return roles.includes(cur.call.role);
}

/** いまの利用者に manage の権限があるか（ローカルモードでは true）。 */
export function canManage(): boolean {
  const cur = current();
  return !cur || (cur.def?.can.includes("manage") ?? false);
}

/** いまの利用者から、このパスのリソースが見えるか（ローカルモードではすべて見える）。 */
export function resourceVisible(resourcePath: string): boolean {
  const cur = current();
  if (!cur) return true;
  return cur.def !== undefined && roleSeesResource(cur.def, resourcePath);
}

/** いまの利用者に、リソースの絞り込み（役割の resources）があるか。 */
export function hasResourceScope(): boolean {
  const cur = current();
  return cur !== undefined && (cur.def === undefined || cur.def.resources !== undefined);
}

const CAPS: readonly RoleCapability[] = ["edit", "review", "run", "structure", "manage"];

export function permissionsFor(call: CallContext | undefined, roles: Roles = DEFAULT_ROLES): Permissions {
  if (!call) return { role: "manager", can: { edit: true, review: true, run: true, structure: true, manage: true }, unrestricted: true };
  const def = roleOf(call, roles);
  const has = Object.fromEntries(CAPS.map((c) => [c, def?.can.includes(c) ?? false])) as Permissions["can"];
  const p: Permissions = { role: call.role, can: has };
  if (call.admin) p.unrestricted = true;
  if (def?.label !== undefined) p.roleLabel = def.label;
  if (call.languages) p.languages = [...call.languages];
  if (def?.editColumns) p.editColumns = [...def.editColumns];
  if (def?.reviewColumns) p.reviewColumns = [...def.reviewColumns];
  if (def?.actions) p.actions = [...def.actions];
  if (def?.generators) p.generators = [...def.generators];
  return p;
}

/** 割り当てに選べる役割の一覧（設定の順。同梱の役割が先）。 */
export function roleList(roles: Roles): { id: string; label: string }[] {
  return Object.entries(roles).map(([id, def]) => ({ id, label: def.label ?? id }));
}
