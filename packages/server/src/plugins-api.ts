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
import { listSettings } from "./settings-api.js";
import { untrustedInfo } from "./trust.js";
import { currentCall } from "./call-context.js";
import { permissionsFor } from "./permissions.js";
import { listRenderers } from "./renderers.js";

function actionInfo(a: Action): ActionInfo {
  const info: ActionInfo = { id: a.id, label: a.label, target: a.target };
  if (a.icon !== undefined) info.icon = a.icon;
  if (a.columns !== undefined) info.columns = a.columns;
  if (a.languages !== undefined) info.languages = a.languages;
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
  warnings.push(...ctx.runtimeWarnings);
  return {
    name: config.name ?? path.basename(project.root),
    root: project.root,
    languages: project.languages,
    columns: ctx.columns(),
    languageSets: config.languageSets ?? {},
    grid: { pinCommon: config.grid?.pinCommon ?? true, maxPinnedRatio: config.grid?.maxPinnedRatio ?? 0.6 },
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
    permissions: permissionsFor(currentCall()),
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
