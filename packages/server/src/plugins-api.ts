/**
 * プロジェクトの情報とプラグインの一覧。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { EXTENSION_FIELDS, EXTENSION_KINDS, isEnforceable } from "@loc-studio/core";
import type { ExtensionKind } from "@loc-studio/core";
import type { Action } from "@loc-studio/sdk";
import type { ActionInfo, PluginInfo, ProjectInfo } from "./api-types.js";
import type { WsContext } from "./context.js";
import { enumOf } from "./context.js";
import { listSettings } from "./settings-api.js";
import { untrustedInfo } from "./trust.js";
import { currentCall } from "./call-context.js";
import { permissionsFor, roleList } from "./permissions.js";
import { listRenderers } from "./renderers.js";

function actionInfo(a: Action): ActionInfo {
  const info: ActionInfo = { id: a.id, label: a.label, target: a.target };
  if (a.icon !== undefined) info.icon = a.icon;
  if (a.columns !== undefined) info.columns = a.columns;
  if (a.languages !== undefined) info.languages = a.languages;
  if ((a.target === "cell" || a.target === "row") && typeof a.runBatch === "function") info.batch = true;
  return info;
}

export async function info(ctx: WsContext): Promise<ProjectInfo> {
  const project = ctx.project;
  const config = project.config;
  // 独自描画の確認で出る警告も warnings に入るよう、先に求める。
  const renderers = await listRenderers(ctx);
  const user = ctx.userInfo();
  const validators = new Map<string, { id: string; label: string }>();
  for (const rv of project.resolveValidators()) validators.set(rv.validator.id, { id: rv.validator.id, label: rv.validator.label });
  const warnings = [...project.warnings];
  for (const ref of config.actions ?? []) {
    const id = typeof ref === "string" ? ref : ref.use;
    if (!project.registry.get("action", id)) warnings.push(`設定の actions にあるアクション "${id}" は登録されていません。`);
  }
  for (const ref of config.review?.targets ?? []) {
    const id = typeof ref === "string" ? ref : ref.use;
    const a = project.registry.get("action", id);
    if (!a) warnings.push(`設定の review.targets にあるアクション "${id}" は登録されていません。`);
    else if (a.target !== "review") warnings.push(`設定の review.targets にあるアクション "${id}" は target: "review" ではありません。`);
  }
  for (const c of ctx.columns()) {
    if (c.kind === "generated" && !ctx.generatorFor(c)) {
      warnings.push(`生成列 "${c.id}" の生成器 "${c.generator ?? ""}" が見つかりません（設定の generators を確かめてください）。`);
    }
  }
  const ignored = Object.keys(config.localSettings?.enforce ?? {}).filter((k) => !isEnforceable(k));
  if (ignored.length > 0) {
    warnings.push(`設定の localSettings.enforce にある次の項目は固定できないため無視します（秘密情報とプラグインの信頼は各自が決める）: ${ignored.join(", ")}`);
  }
  if (project.untrustedPlugins.length > 0) {
    warnings.push(`信頼の確認を待っているプラグインが ${project.untrustedPlugins.length} 件あり、読み込んでいません。`);
  }
  // 編集画面の設定。プロジェクトにない言語や列は使わずに知らせる。
  const editor = config.editor ?? {};
  const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const referenceLanguages = listOf(editor.referenceLanguages).filter((id) => {
    if (project.language(id)) return true;
    warnings.push(`設定の editor.referenceLanguages にある言語 "${id}" は、プロジェクトにありません。`);
    return false;
  });
  const referenceColumns =
    editor.referenceColumns === undefined
      ? undefined
      : listOf(editor.referenceColumns).filter((id) => {
          if (ctx.column(id)) return true;
          warnings.push(`設定の editor.referenceColumns にある列 "${id}" は、設定の columns にありません。`);
          return false;
        });
  const UNITS = ["codepoints", "utf16", "bytes", "width"] as const;
  let unit: (typeof UNITS)[number] = "codepoints";
  if (editor.count?.unit !== undefined) {
    if ((UNITS as readonly string[]).includes(editor.count.unit)) unit = editor.count.unit;
    else warnings.push(`設定の editor.count.unit は ${UNITS.join(" / ")} のどれかにしてください（"${String(editor.count.unit)}"）。コードポイントで数えます。`);
  }
  // ツリーに進捗を出す列。選択式でない列や、設定にない列は使わない。
  let progressColumn: string | undefined;
  const wantedProgress: unknown = config.grid?.progressColumn;
  if (wantedProgress !== undefined) {
    const column = typeof wantedProgress === "string" ? ctx.column(wantedProgress) : undefined;
    const usable = column !== undefined && enumOf(column) !== undefined && (column.kind === "meta" || column.kind === "review");
    if (usable) progressColumn = column.id;
    else warnings.push(`設定の grid.progressColumn "${String(wantedProgress)}" は、選択式の列（ステータスやレビュー）の ID にしてください。既定の列の進捗を出します。`);
  }
  const wantedUnit: unknown = config.grid?.progressUnit;
  if (wantedUnit !== undefined && wantedUnit !== "rows" && wantedUnit !== "characters" && wantedUnit !== "words") {
    warnings.push(`設定の grid.progressUnit は rows / characters / words のどれかにしてください（"${String(wantedUnit)}"）。行数で数えます。`);
  }
  warnings.push(...ctx.runtimeWarnings);
  return {
    name: config.name ?? path.basename(project.root),
    root: project.root,
    languages: project.languages,
    columns: ctx.columns(),
    languageSets: config.languageSets ?? {},
    grid: { pinCommon: config.grid?.pinCommon ?? true, maxPinnedRatio: config.grid?.maxPinnedRatio ?? 0.6, ...(progressColumn !== undefined ? { progressColumn } : {}), progressUnit: ctx.progressUnit() },
    editor: { referenceLanguages, ...(referenceColumns ? { referenceColumns } : {}), count: { unit, skipTokens: editor.count?.skipTokens === true } },
    user: { name: user.value, source: user.source, locked: user.locked },
    storage: { path: ctx.storagePath, shared: ctx.storageShared },
    actions: ctx.configuredActions().map((a) => actionInfo(a.action)),
    reviewTargets: ctx.reviewTargets().filter((a) => a.action.target === "review").map((a) => actionInfo(a.action)),
    validators: [...validators.values()],
    blockComplete: config.validation?.blockComplete ?? false,
    warnings,
    pluginErrors: project.pluginErrors,
    untrustedPlugins: project.untrustedPlugins.length,
    changeSeq: await ctx.shared.changeSeq(),
    localSettings: Object.fromEntries(listSettings(ctx).map((s) => [s.key, s.value])),
    permissions: permissionsFor(currentCall(), project.roles()),
    roles: roleList(project.roles()),
    renderers,
  };
}

export async function plugins(ctx: WsContext) {
  const project = ctx.project;
  const list: PluginInfo[] = project.registry.plugins().map(({ plugin, origin }) => {
    const provides = {} as Record<ExtensionKind, string[]>;
    for (const kind of EXTENSION_KINDS) {
      const items = plugin[EXTENSION_FIELDS[kind]] as { id: string }[] | undefined;
      provides[kind] = (items ?? []).map((i) => i.id);
    }
    const p: PluginInfo = { name: plugin.name, layer: origin.layer, provides };
    if (plugin.version !== undefined) p.version = plugin.version;
    if (origin.path !== undefined) p.path = origin.path;
    return p;
  });
  return {
    plugins: list,
    // プラグインのフォルダはアプリやプロジェクトの設定の置き場所で、リソースではない。
    dirs: project.pluginDirs.map((d) => ({ dir: d.dir, layer: d.layer, exists: existsSync(d.dir) })),
    errors: project.pluginErrors,
    warnings: project.registry.warnings,
    untrusted: untrustedInfo(project.untrustedPlugins),
  };
}
