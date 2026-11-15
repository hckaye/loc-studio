/**
 * 役割の定義（Web モードの権限）。同梱の 4 つの役割に、設定の `roles` を重ねる。
 * ここは定義を解決するだけで、権限の確認そのものはサービス層が行う。
 */
import picomatch from "picomatch";
import type { ColumnDef, ProjectConfig, RoleCapability, RoleDef } from "@loc-studio/sdk";

export const ROLE_CAPABILITIES: readonly RoleCapability[] = ["edit", "review", "run", "structure", "manage"];

/** 役割の ID に使える文字。サーバーの DB の割り当てにも残る。 */
export const ROLE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** 設定に `roles` がなくても使える役割。設定の同じ ID の定義が置き換える。 */
export const DEFAULT_ROLES: Readonly<Record<string, RoleDef>> = Object.freeze({
  viewer: { label: "閲覧", can: [] },
  translator: { label: "翻訳", can: ["edit", "run"] },
  reviewer: { label: "レビュー", can: ["review", "run"] },
  manager: { label: "管理", can: ["edit", "review", "run", "structure", "manage"] },
});

/** 書き方の誤った定義の代わりに使う役割。何も見えず、何もできない（誤りで権限が広がらないように）。 */
const DENY_ALL: RoleDef = Object.freeze({ can: [], resources: [] }) as RoleDef;

const LIST_FIELDS = ["editColumns", "reviewColumns", "actions", "generators", "resources"] as const;

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x !== "");

/**
 * 設定の `roles` を同梱の役割に重ねる。書き方の誤った定義は「何も見えず何もできない役割」にして警告を出す
 * （誤った定義を無視すると、同梱の同じ ID の広い権限に戻ってしまうため）。
 */
export function resolveRoles(config: ProjectConfig, columns?: ColumnDef[]): { roles: Record<string, RoleDef>; warnings: string[] } {
  const roles: Record<string, RoleDef> = {};
  for (const [id, def] of Object.entries(DEFAULT_ROLES)) roles[id] = { ...def, can: [...def.can] };
  const warnings: string[] = [];
  const raw: unknown = config.roles;
  if (raw === undefined) return { roles, warnings };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push("設定の roles は「役割の ID: 定義」のオブジェクトにしてください。同梱の役割だけを使います。");
    return { roles, warnings };
  }
  const columnIds = columns ? new Set(columns.map((c) => c.id)) : undefined;
  const reviewIds = columns ? new Set(columns.filter((c) => c.kind === "review").map((c) => c.id)) : undefined;
  const generatedIds = columns ? new Set(columns.filter((c) => c.kind === "generated").map((c) => c.id)) : undefined;

  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const where = `設定の roles.${id}`;
    if (!ROLE_ID_RE.test(id)) {
      warnings.push(`${where}: 役割の ID は英数字と . _ - の 1〜64 文字にしてください。この役割は使えません。`);
      continue;
    }
    const problems: string[] = [];
    const v = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
    if (v !== value) problems.push("定義はオブジェクトにしてください");
    if (!Array.isArray(v["can"]) || v["can"].some((c) => !ROLE_CAPABILITIES.includes(c as RoleCapability))) {
      problems.push(`can は ${ROLE_CAPABILITIES.join(" / ")} の配列にしてください`);
    }
    if (v["label"] !== undefined && typeof v["label"] !== "string") problems.push("label は文字列にしてください");
    for (const f of LIST_FIELDS) {
      if (v[f] !== undefined && !isStringList(v[f])) problems.push(`${f} は空でない文字列の配列にしてください`);
    }
    if (problems.length > 0) {
      warnings.push(`${where} の書き方が正しくありません（${problems.join("、")}）。この役割では何も見えず、何もできません。`);
      roles[id] = DENY_ALL;
      continue;
    }
    const def: RoleDef = { can: [...new Set(v["can"] as RoleCapability[])] };
    if (typeof v["label"] === "string" && v["label"] !== "") def.label = v["label"];
    for (const f of LIST_FIELDS) if (v[f] !== undefined) def[f] = [...new Set(v[f] as string[])];
    roles[id] = def;

    // 存在しない列を指していても権限は広がらないが、書き間違いに気づけるよう知らせる。
    const unknown = (list: string[] | undefined, known: Set<string> | undefined, what: string): void => {
      const missing = known ? (list ?? []).filter((x) => !known.has(x)) : [];
      if (missing.length > 0) warnings.push(`${where} の ${what} に、設定の columns にない ID があります: ${missing.join(", ")}`);
    };
    unknown(def.editColumns, columnIds, "editColumns");
    unknown(def.reviewColumns, reviewIds, "reviewColumns（レビュー列の ID）");
    unknown(def.generators, generatedIds, "generators（生成列の ID）");
  }
  return { roles, warnings };
}

const matchers = new WeakMap<RoleDef, (path: string) => boolean>();

/** その役割から、このパスのリソースが見えるか。 */
export function roleSeesResource(def: RoleDef, resourcePath: string): boolean {
  if (def.resources === undefined) return true;
  let m = matchers.get(def);
  if (!m) {
    m = def.resources.length === 0 ? () => false : picomatch(def.resources, { dot: true });
    matchers.set(def, m);
  }
  return m(resourcePath);
}
