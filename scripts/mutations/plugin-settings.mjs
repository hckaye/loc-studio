// 壊し方の一覧: プラグインの設定（宣言の確認、設定ファイルの読み込み、入口の関数に渡す窓口、サービス層の一覧と保存、
// 信頼の確認、設定の画面）。
// 使い方: node scripts/mutation-check.mjs scripts/mutations/plugin-settings.mjs
// 実装を直して from の文字列が変わったら、ここも合わせる（合わないものは SKIP と出る）。
const CORE = "packages/core/src/plugin-settings.ts";
const CORE_TEST = "packages/core/src/plugin-settings.test.ts";
const LOADER = "packages/core/src/plugin-loader.ts";
const TRUST = "packages/core/src/settings-trust.ts";
const API = "packages/server/src/plugin-settings-api.ts";
const SERVER_TEST = "packages/server/src/plugin-settings.test.ts";
const PANEL = "apps/web/components/PluginSettings.tsx";
const WEB_TEST = "apps/web/components/plugin-settings.test.tsx";

export default [
  // ---- 宣言の確認
  { name: "宣言の key の重複を見ない", file: CORE, from: "    if (seen.has(key)) problems.push(`${label} の key が重複しています。`);\n", to: "", tests: `${CORE_TEST} ${SERVER_TEST}` },
  { name: "選択式の選択肢がなくても通す", file: CORE, from: "      if (!Array.isArray(options) || options.length === 0) {", to: "      if (false) {", tests: `${CORE_TEST} ${SERVER_TEST}` },
  { name: "既定の値の種類を確かめない", file: CORE, from: "    if (raw.default !== undefined) {\n      const problem = settingValueProblem(", to: "    if (false) {\n      const problem = settingValueProblem(", tests: `${CORE_TEST} ${SERVER_TEST}` },
  { name: "宣言の誤ったプラグインを読み込む", file: LOADER, from: "  problems.push(...validateSettingDefs(p.settings));\n", to: "", tests: SERVER_TEST },
  // ---- 値
  { name: "数値でない値（NaN、無限大）を数値として通す", file: CORE, from: "typeof value === \"number\" && Number.isFinite(value) ? undefined : \"数値ではありません。\"", to: "typeof value === \"number\" ? undefined : \"数値ではありません。\"", tests: CORE_TEST },
  { name: "選択肢にない値を通す", file: CORE, from: "typeof value === \"string\" && options.some((o) => o.value === value) ? undefined :", to: "typeof value === \"string\" ? undefined :", tests: `${CORE_TEST} ${SERVER_TEST}` },
  { name: "種類の合わない値を、そのまま使う", file: CORE, from: "      if (problem === undefined) {\n        stored[def.key] = value as PluginSettingValue;", to: "      if (true) {\n        stored[def.key] = value as PluginSettingValue;", tests: `${CORE_TEST} ${SERVER_TEST}` },
  { name: "値のない項目に、既定の値を入れない", file: CORE, from: "    if (def.default !== undefined) values[def.key] = def.default;\n", to: "", tests: `${CORE_TEST} ${SERVER_TEST}` },
  // ---- 設定ファイル
  { name: "ファイル名に使えない文字を、そのまま使う", file: CORE, from: "    return /[A-Za-z0-9._-]/.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, \"0\")}`;", to: "    return ch;", tests: CORE_TEST },
  { name: "先頭の . を、そのまま使う", file: CORE, from: "  return `${safe.startsWith(\".\") ? `%2E${safe.slice(1)}` : safe}.json`;", to: "  return `${safe}.json`;", tests: CORE_TEST },
  { name: "同じ名前のプラグインの設定を、両方使う", file: CORE, from: "    if (seen.has(plugin.name)) {", to: "    if (false) {", tests: CORE_TEST },
  { name: "読めない設定ファイルを、警告にしない", file: CORE, from: "      state.problems.push(`プラグイン \"${plugin.name}\" の設定ファイル ${file} は${errorMessage(err)}", to: "      void (`プラグイン \"${plugin.name}\" の設定ファイル ${file} は${errorMessage(err)}", tests: `${CORE_TEST} ${SERVER_TEST}` },
  // ---- 入口の関数に渡す窓口
  { name: "読み込みの途中でも、値を読めることにする", file: CORE, from: "      if (!list) throw new Error(NOT_READY);\n", to: "      if (!list) return undefined;\n", tests: `${CORE_TEST} ${SERVER_TEST}` },
  { name: "宣言にないキーを、黙って undefined にする", file: CORE, from: "      if (!owner) throw new Error(`設定 \"${key}\" は、", to: "      if (!owner) return undefined;\n      if (false) throw new Error(`設定 \"${key}\" は、", tests: `${CORE_TEST} ${SERVER_TEST}` },
  { name: "入口の関数に、窓口を渡さない", file: LOADER, from: "    exported = await (exported as (setup: PluginSetupContext) => unknown)(setup);", to: "    exported = await (exported as () => unknown)();", tests: SERVER_TEST },
  // ---- 信頼の確認
  { name: "プラグインの設定の中身を、ハッシュに入れない", file: TRUST, from: "  if (settingNames.length > 0) hashed.pluginSettings = Object.fromEntries(settingNames.map((n) => [n, pluginSettings[n]]));\n", to: "", tests: `${CORE_TEST} ${SERVER_TEST}` },
  { name: "プラグインの設定だけの変更を、確認の対象にしない", file: TRUST, from: "  if (Object.keys(infra).length === 0 && env.length === 0 && settingNames.length === 0) return undefined;", to: "  if (Object.keys(infra).length === 0 && env.length === 0) return undefined;", tests: CORE_TEST },
  { name: "確認の画面に、プラグインの設定の値を出さない", file: TRUST, from: "    summary: [...summarizeInfra(json, env), ...summarizePluginSettings(pluginSettings)],", to: "    summary: summarizeInfra(json, env),", tests: `${CORE_TEST} ${SERVER_TEST}` },
  { name: "画面から保存した値を、確認済みにしない", file: API, from: "    if (recordTrust && existsSync(configFile)) {", to: "    if (false) {", tests: SERVER_TEST },
  // ---- サービス層の保存
  { name: "宣言にないキーを保存する", file: API, from: "    if (!def) {\n      throw new ApiError(\"invalid\", `プラグイン \"${name}\" は、設定 \"${key}\" を宣言していません", to: "    if (!def) continue;\n    if (!def) {\n      throw new ApiError(\"invalid\", `プラグイン \"${name}\" は、設定 \"${key}\" を宣言していません", tests: SERVER_TEST },
  { name: "種類の合わない値を保存する", file: API, from: "    if (problem !== undefined) throw new ApiError(\"invalid\", `プラグイン \"${name}\" の設定「${def.label}」", to: "    if (false) throw new ApiError(\"invalid\", `プラグイン \"${name}\" の設定「${def.label}」", tests: SERVER_TEST },
  { name: "null で値を消さない", file: API, from: "      if (value === null || value === undefined) delete next[key];\n      else next[key] = value;", to: "      next[key] = value;", tests: SERVER_TEST },
  { name: "設定ファイルにあった、欄のないキーを消す", file: API, from: "    const next: Record<string, unknown> = { ...current };", to: "    const next: Record<string, unknown> = {};", tests: SERVER_TEST },
  { name: "値がなくなっても、ファイルを残す", file: API, from: "    if (Object.keys(next).length === 0) {", to: "    if (false) {", tests: SERVER_TEST },
  { name: "保存のあと、読み直さない", file: API, from: "    try {\n      await reloadProject(ctx);", to: "    try {\n      void reloadProject;", tests: SERVER_TEST },
  { name: "管理者でない人にも、設定ファイルの場所を返す", file: "packages/server/src/redact.ts", from: "    v = (v as { file?: string }[]).map((p) => ({ ...p, file: \"\" }));\n", to: "", tests: SERVER_TEST },
  { name: "保存を、manage の権限なしで通す", file: "packages/server/src/permissions.ts", from: "  setPluginSettings: \"manage\",", to: "  setPluginSettings: \"view\",", tests: `${SERVER_TEST} packages/server/src/permissions.test.ts` },
  // ---- 設定の画面
  { name: "変えていない項目も送る", file: PANEL, from: "  const changed = plugin.items.filter((i) => drafts[i.key] !== savedDraft(i));", to: "  const changed = plugin.items;", tests: WEB_TEST },
  { name: "空にした欄を、空の文字として送る", file: PANEL, from: "  return { value: text === \"\" ? null : text };", to: "  return { value: text };", tests: WEB_TEST },
  { name: "空にした数値の欄を、0 として送る", file: PANEL, from: "    if (text.trim() === \"\") return { value: null };\n", to: "", tests: WEB_TEST },
  { name: "数値でない文字を、そのまま送る", file: PANEL, from: "    return Number.isFinite(n) ? { value: n } : { error: `「${item.label}」は、数値で入力してください。` };", to: "    return { value: n };", tests: WEB_TEST },
  { name: "権限がなくても、入力できる", file: PANEL, from: "plugin={p} locked={!manage.ok} lockedReason={manage.reason}", to: "plugin={p} locked={false} lockedReason={manage.reason}", tests: WEB_TEST },
  { name: "設定ファイルの問題を出さない", file: PANEL, from: "      {plugin.problems.map((p, i) => (", to: "      {[].map((p, i) => (", tests: WEB_TEST },
  { name: "保存のあと、返ってきた値で欄を作り直さない", file: PANEL, from: "      onSaved(next);\n", to: "", tests: WEB_TEST },
];
