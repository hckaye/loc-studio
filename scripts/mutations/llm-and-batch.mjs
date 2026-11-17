// 壊し方の一覧: 同梱の LLM のプラグイン（機械翻訳 llm.translate、翻訳の評価 llm.evaluate、プロンプトなどの設定）、
// 条件に合う行だけの生成（generate の filter）、バッチサイズ（生成とアクション）、行をまとめて受け取るアクション（runBatch）、
// コマンドライン（generate の --where / --keys / --batch-size、run の --batch-size）、画面（一括アクションからの生成、
// 範囲をプロジェクト全体に広げる、まとめて送る行数、選択式の生成列の表示、複数行の設定の入力欄）。
// 使い方: node scripts/mutation-check.mjs scripts/mutations/llm-and-batch.mjs
// 実装を直して from の文字列が変わったら、ここも合わせる（合わないものは SKIP と出る）。
const TRANSLATE = "packages/plugin-llm/src/translate.ts";
const EVALUATE = "packages/plugin-llm/src/evaluate.ts";
const CHAT = "packages/plugin-llm/src/chat.ts";
const TRANSLATE_TEST = "packages/plugin-llm/src/translate.test.ts";
const EVALUATE_TEST = "packages/plugin-llm/src/evaluate.test.ts";
const LLM_TEST = "packages/server/src/llm.test.ts";
const GENERATE = "packages/server/src/generate.ts";
const ACTIONS = "packages/server/src/actions.ts";
const ACTION_TEST = "packages/server/src/action-batch.test.ts";
const CLI = "apps/cli/src/batch.ts";
const CLI_TEST = "apps/cli/src/batch.test.ts";
const MATCH = "apps/web/lib/client/match-actions.ts";
const MATCH_TEST = "apps/web/lib/client/match-actions.test.ts";
const MENU = "apps/web/components/MatchActions.tsx";
const MENU_TEST = "apps/web/components/MatchActions.test.tsx";
const DIALOG = "apps/web/components/GenerateDialog.tsx";
const CELLS = "apps/web/components/grid/cells.tsx";
const STUDIO_TEST = "apps/web/components/Studio.test.tsx";
const PANEL = "apps/web/components/PluginSettings.tsx";
const PANEL_TEST = "apps/web/components/plugin-settings.test.tsx";

export default [
  // ---- 機械翻訳（llm.translate）
  {
    name: "訳し先を、options より設定を優先して決める",
    file: TRANSLATE,
    from: 'to: textOption(options["to"]) ?? textOption(settings.get("translateTo")) ?? DEFAULT_TRANSLATE_TO,',
    to: 'to: textOption(settings.get("translateTo")) ?? textOption(options["to"]) ?? DEFAULT_TRANSLATE_TO,',
    tests: `${TRANSLATE_TEST} ${LLM_TEST}`,
  },
  {
    name: "プラグインの設定のプロンプトを使わない",
    file: TRANSLATE,
    from: 'prompt: textOption(options["prompt"]) ?? textOption(settings.get("translatePrompt")) ?? DEFAULT_TRANSLATE_PROMPT,',
    to: 'prompt: textOption(options["prompt"]) ?? DEFAULT_TRANSLATE_PROMPT,',
    tests: `${TRANSLATE_TEST} ${LLM_TEST}`,
  },
  { name: "{to} を、最初の 1 つしか置き換えない", file: TRANSLATE, from: 'r.prompt.split("{to}").join(r.to)', to: 'r.prompt.replace("{to}", r.to)', tests: TRANSLATE_TEST },
  {
    name: "変えたプロンプトを、キャッシュの鍵に入れない",
    file: TRANSLATE,
    from: "        ...(r.prompt !== DEFAULT_TRANSLATE_PROMPT ? { prompt: r.prompt } : {}),\n",
    to: "",
    tests: `${TRANSLATE_TEST} ${LLM_TEST}`,
  },
  {
    name: "既定のプロンプトも、キャッシュの鍵に入れる（前の結果を使えなくなる）",
    file: TRANSLATE,
    from: "        ...(r.prompt !== DEFAULT_TRANSLATE_PROMPT ? { prompt: r.prompt } : {}),\n",
    to: "        prompt: r.prompt,\n",
    tests: TRANSLATE_TEST,
  },
  { name: "複数件でも、1 件の形で送る", file: TRANSLATE, from: "      if (inputs.length === 1) {\n        // 1 件のときは", to: "      if (true) {\n        // 1 件のときは", tests: TRANSLATE_TEST },
  { name: "空の翻訳を、結果として通す", file: TRANSLATE, from: 'if (typeof translation !== "string" || translation.trim() === "") {', to: "if (false) {", tests: TRANSLATE_TEST },
  { name: "機械翻訳の既定のバッチサイズを、1 件ずつでなくする", file: TRANSLATE, from: "    batchSize: 1,\n", to: "    batchSize: 8,\n", tests: `${TRANSLATE_TEST} ${LLM_TEST}` },
  // ---- OpenAI 互換の API の呼び出し
  { name: "API キーを送らない", file: CHAT, from: '  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;\n', to: "", tests: TRANSLATE_TEST },
  { name: "返事に同じ id が 2 回あっても通す", file: CHAT, from: "    if (byId.has(n)) throw new Error(", to: "    if (false) throw new Error(", tests: TRANSLATE_TEST },
  { name: "返事に足りない id があっても通す", file: CHAT, from: "    if (!item) throw new Error(", to: "    if (false) throw new Error(", tests: `${TRANSLATE_TEST} ${EVALUATE_TEST}` },
  { name: "返事が配列でなくても通す", file: CHAT, from: "  if (!Array.isArray(reply)) throw new Error(", to: "  if (false) throw new Error(", tests: TRANSLATE_TEST },
  { name: "返事の前後に付いた文章を除かない", file: CHAT, from: "    if (start >= 0 && end > start) {", to: "    if (false) {", tests: EVALUATE_TEST },
  { name: "endpoint がなくても、そのまま進む", file: CHAT, from: "  if (value === undefined) {\n    throw new Error(", to: "  if (false) {\n    throw new Error(", tests: `${TRANSLATE_TEST} ${EVALUATE_TEST}` },
  // ---- 翻訳の評価（llm.evaluate）
  {
    name: "比べる原文の言語の設定を使わない",
    file: EVALUATE,
    from: 'textOption(ctx.options["source"]) ?? textOption(settings.get("evaluateSource")) ?? ctx.language?.basedOn;',
    to: 'textOption(ctx.options["source"]) ?? ctx.language?.basedOn;',
    tests: `${EVALUATE_TEST} ${LLM_TEST}`,
  },
  {
    name: "比べる原文の言語を、options より設定を優先して決める",
    file: EVALUATE,
    from: 'textOption(ctx.options["source"]) ?? textOption(settings.get("evaluateSource")) ?? ctx.language?.basedOn;',
    to: 'textOption(settings.get("evaluateSource")) ?? textOption(ctx.options["source"]) ?? ctx.language?.basedOn;',
    tests: `${EVALUATE_TEST} ${LLM_TEST}`,
  },
  { name: "原文の言語そのものも評価する", file: EVALUATE, from: "if (sourceLanguage === undefined || sourceLanguage === ctx.language.id) return null;", to: "if (sourceLanguage === undefined) return null;", tests: EVALUATE_TEST },
  {
    name: "原文が空でも評価する",
    file: EVALUATE,
    from: 'if (text === undefined || text.trim() === "" || source === undefined || source.trim() === "") return null;',
    to: 'if (text === undefined || text.trim() === "") return null;',
    tests: EVALUATE_TEST,
  },
  {
    name: "原文を入力に入れない（原文が変わっても「変更あり」にならない）",
    file: EVALUATE,
    from: "return { text, language: ctx.language.id, extra: { source, sourceLanguage } };",
    to: "return { text, language: ctx.language.id };",
    tests: `${EVALUATE_TEST} ${LLM_TEST}`,
  },
  { name: "3 つの値のどれでもない判定を通す", file: EVALUATE, from: "  if (!(VERDICTS as readonly string[]).includes(verdict)) {", to: "  if (false) {", tests: EVALUATE_TEST },
  { name: "判定を大文字にそろえない", file: EVALUATE, from: 'String(obj["verdict"] ?? "").trim().toUpperCase();', to: 'String(obj["verdict"] ?? "").trim();', tests: EVALUATE_TEST },
  { name: "判定の理由を、説明に入れない", file: EVALUATE, from: '  if (typeof reason === "string" && reason.trim() !== "") out.comment = reason.trim();\n', to: "", tests: `${EVALUATE_TEST} ${LLM_TEST}` },
  { name: "評価のプロンプトを、キャッシュの鍵に入れない", file: EVALUATE, from: "        prompt: r.prompt,\n", to: "", tests: EVALUATE_TEST },
  { name: "評価の、プラグインの設定のプロンプトを使わない", file: EVALUATE, from: 'textOption(options["prompt"]) ?? textOption(settings.get("evaluatePrompt")) ?? DEFAULT_EVALUATE_PROMPT,', to: 'textOption(options["prompt"]) ?? DEFAULT_EVALUATE_PROMPT,', tests: `${EVALUATE_TEST} ${LLM_TEST}` },
  { name: "評価の既定のバッチサイズを、1 件ずつでなくする", file: EVALUATE, from: "    batchSize: 1,\n", to: "    batchSize: 8,\n", tests: `${EVALUATE_TEST} ${LLM_TEST}` },
  // ---- 同梱のプラグインの設定と、設定の宣言
  {
    name: "同梱のプラグインの関数に、設定ファイルの値を渡さない",
    file: "packages/core/src/project.ts",
    from: "made.plugin = builtin({ settings: createSettingsReader(() => (made.plugin ? [made.plugin] : undefined), settingsValues) });",
    to: "made.plugin = builtin({ settings: createSettingsReader(() => (made.plugin ? [made.plugin] : undefined), () => ({})) });",
    tests: `packages/core/src/project.test.ts ${LLM_TEST}`,
  },
  { name: "multiline を、文字以外の項目にも通す", file: "packages/core/src/plugin-settings.ts", from: '      else if (raw.type !== "string") problems.push(', to: "      else if (false) problems.push(", tests: "packages/core/src/plugin-settings.test.ts" },
  { name: "multiline が true / false でなくても通す", file: "packages/core/src/plugin-settings.ts", from: '      if (typeof raw.multiline !== "boolean") problems.push(', to: "      if (false) problems.push(", tests: "packages/core/src/plugin-settings.test.ts" },
  { name: "multiline を、設定の一覧に出さない", file: "packages/server/src/plugin-settings-api.ts", from: "      if (def.multiline === true) item.multiline = true;\n", to: "", tests: LLM_TEST },
  {
    name: "runBatch が関数でないアクションを読み込む",
    file: "packages/core/src/plugin-loader.ts",
    from: '      if (kind === "action" && obj.runBatch !== undefined && typeof obj.runBatch !== "function") {',
    to: "      if (false) {",
    tests: "packages/core/src/plugin-loader.test.ts",
  },
  // ---- 生成: 条件に合う行、バッチサイズ、説明
  {
    name: "生成の filter を無視する（すべての行を生成する）",
    file: GENERATE,
    from: "const entriesOf = async (doc: DocState): Promise<EntryData[]> => (filter ? matchEntries(ctx, doc, filter) : doc.entries);",
    to: "const entriesOf = async (doc: DocState): Promise<EntryData[]> => doc.entries;",
    tests: `${LLM_TEST} ${CLI_TEST}`,
  },
  { name: "行を名指しする範囲と filter の併用を通す", file: GENERATE, from: '    if (params.scope === "cell" || params.scope === "selection") {\n      throw new ApiError("invalid", `filter', to: '    if (false) {\n      throw new ApiError("invalid", `filter', tests: LLM_TEST },
  { name: "指定したバッチサイズを使わない", file: GENERATE, from: "const batchSize = batchSizeOf(params.batchSize) ?? Math.max(", to: "const batchSize = (batchSizeOf(params.batchSize), undefined) ?? Math.max(", tests: `${LLM_TEST} ${CLI_TEST}` },
  { name: "生成器が値に添えた説明を、キャッシュに残さない", file: GENERATE, from: '        if (typeof out.comment === "string" && out.comment !== "") value.comment = out.comment;\n', to: "", tests: LLM_TEST },
  { name: "生成器が値に添えた説明を、セルに出さない", file: "packages/server/src/cells.ts", from: "          if (g?.comment !== undefined) cell.comment = g.comment;\n", to: "", tests: LLM_TEST },
  { name: "バッチサイズの上限を見ない", file: "packages/server/src/batch-size.ts", from: " || value > MAX_BATCH_SIZE) {", to: ") {", tests: `${LLM_TEST} ${ACTION_TEST}` },
  { name: "整数でないバッチサイズを通す", file: "packages/server/src/batch-size.ts", from: "!Number.isInteger(value) || ", to: "", tests: `${LLM_TEST} ${ACTION_TEST}` },
  { name: "0 以下のバッチサイズを通す", file: "packages/server/src/batch-size.ts", from: " || value < 1 || ", to: " || ", tests: `${LLM_TEST} ${ACTION_TEST}` },
  // ---- アクション: 行をまとめて呼ぶ
  { name: "行をまとめて受け取れないアクションの batchSize を通す", file: ACTIONS, from: '    if (typeof action.runBatch !== "function") {', to: "    if (false) {", tests: ACTION_TEST },
  { name: "対象を 1 回で受け取るアクションの batchSize を通す", file: ACTIONS, from: '    if (action.target !== "cell" && action.target !== "row") {\n      throw new ApiError("invalid", `アクション "${action.id}"（target: ${action.target}）は、対象の行をまとめて', to: '    if (false) {\n      throw new ApiError("invalid", `アクション "${action.id}"（target: ${action.target}）は、対象の行をまとめて', tests: ACTION_TEST },
  { name: "batchSize が 2 以上でも、行ごとに run を呼ぶ", file: ACTIONS, from: "    if (batchSize > 1) {\n      const target = {", to: "    if (false) {\n      const target = {", tests: ACTION_TEST },
  { name: "when が false の行も、まとまりに入れる", file: ACTIONS, from: "    if (wanted) pending.push({ data, actx });", to: "    pending.push({ data, actx });", tests: ACTION_TEST },
  { name: "行を batchSize ごとに分けない", file: ACTIONS, from: "    const chunk = pending.slice(i, i + batchSize);", to: "    const chunk = pending.slice(i);", tests: ACTION_TEST },
  { name: "ジョブで、失敗したまとまりの行を数えない", file: ACTIONS, from: "      job.info.failed += chunk.length;\n      out.errors.push(`${range}: ${errorText(err)}`);", to: "      out.errors.push(`${range}: ${errorText(err)}`);", tests: ACTION_TEST },
  { name: "ジョブで、飛ばした行を数えない", file: ACTIONS, from: "    else if (job) job.info.skipped++;\n", to: "", tests: ACTION_TEST },
  { name: "ジョブでないとき、まとまりの失敗を例外にしない", file: ACTIONS, from: "      if (!job) throw new ApiError(\"failed\", `アクション「${action.label}」が失敗しました（${range}）: ${errorText(err)}`);\n      job.info.failed += chunk.length;", to: "      if (!job) continue;\n      job.info.failed += chunk.length;", tests: ACTION_TEST },
  {
    name: "対象を 1 回で受け取るアクションにも、まとめられる印を付ける",
    file: "packages/server/src/plugins-api.ts",
    from: '  if ((a.target === "cell" || a.target === "row") && typeof a.runBatch === "function") info.batch = true;',
    to: '  if (typeof a.runBatch === "function") info.batch = true;',
    tests: ACTION_TEST,
  },
  // ---- コマンドライン
  { name: "generate に --batch-size を渡さない", file: CLI, from: "    ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),\n  };", to: "  };", tests: CLI_TEST },
  {
    name: "generate に --where を渡さない",
    file: CLI,
    from: "    ...(opts.where !== undefined ? { filter: { where: opts.where, languages: opts.languages ?? info.languages.map((l) => l.id) } } : {}),\n",
    to: "",
    tests: CLI_TEST,
  },
  { name: "generate で --keys を使わない", file: CLI, from: "    if (opts.keys) {\n      scopes = [];", to: "    if (false) {\n      scopes = [];", tests: CLI_TEST },
  { name: "generate で --where と --keys の併用を通す", file: CLI, from: '  if (opts.where !== undefined && opts.keys) throw new UsageError("--where と --keys は、どちらか一方だけを指定してください。");\n  const lang = {', to: "  const lang = {", tests: CLI_TEST },
  { name: "run に --batch-size を渡さない", file: CLI, from: "              ...(opts.batchSize !== undefined && opts.batchSize > 1 ? { batchSize: opts.batchSize } : {}),\n", to: "", tests: CLI_TEST },
  { name: "行をまとめて受け取れないアクションの --batch-size を、コマンドラインで断らない", file: CLI, from: "  if (opts.batchSize !== undefined && opts.batchSize > 1 && !action.batch) {", to: "  if (false) {", tests: CLI_TEST },
  { name: "--batch-size の 0 を通す", file: "apps/cli/src/args.ts", from: "    if (!Number.isInteger(n) || n < 1) throw new UsageError(`--batch-size", to: "    if (!Number.isInteger(n)) throw new UsageError(`--batch-size", tests: CLI_TEST },
  // ---- 画面: 一括アクションからの生成
  {
    name: "生成の選択肢を、その列のない言語にも出す",
    file: MATCH,
    from: "      if (!columnAppliesTo(column, l)) continue;\n      const cellId = cellIdOf(column, l);\n      out.push({ id: `generate",
    to: "      const cellId = cellIdOf(column, l);\n      out.push({ id: `generate",
    tests: MATCH_TEST,
  },
  { name: "生成に、条件（filter）を渡さない", file: MATCH, from: "        resourceId: target.resourceId,\n        filter,\n        ...(choice.language !== undefined ? { languages: [choice.language] } : {}),", to: "        resourceId: target.resourceId,\n        ...(choice.language !== undefined ? { languages: [choice.language] } : {}),", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "生成に、言語を渡さない", file: MATCH, from: "        ...(choice.language !== undefined ? { languages: [choice.language] } : {}),\n", to: "", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "まとめて送る行数を、サーバーに渡さない", file: MATCH, from: "  const batch = opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {};", to: "  const batch = {};", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "キャッシュ済みの数を足し上げない", file: MATCH, from: "      state.cached += res.cached;\n", to: "", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "生成の対象の数を足し上げない", file: MATCH, from: "      state.rows += res.total;\n", to: "", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "行をまとめて受け取れないアクションも、まとめられることにする", file: MATCH, from: "isGenerateChoice(choice) || choice.action.batch === true;", to: "true;", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "誤ったバッチサイズでも、実行のボタンを押せる", file: MENU, from: "disabled={!ready || ready.rows === 0 || batchProblem !== undefined}", to: "disabled={!ready || ready.rows === 0}", tests: MENU_TEST },
  { name: "バッチサイズの上限を、画面で確かめない", file: MENU, from: " || batchValue < 1 || batchValue > MAX_BATCH_SIZE) ? `1 以上", to: " || batchValue < 1) ? `1 以上", tests: MENU_TEST },
  { name: "範囲の選択を出さない", file: MENU, from: "              {allowProject && (\n                <fieldset", to: "              {false && (\n                <fieldset", tests: MENU_TEST },
  { name: "プロジェクト全体を選んでも、このリソースだけに実行する", file: MENU, from: '  const ready = wide ? (project?.state === "ready" ? project : null) : { targets, rows };', to: "  const ready = { targets, rows };", tests: MENU_TEST },
  { name: "プロジェクト全体で、合う行のないリソースにも実行する", file: MENU, from: "r.resources.filter((x) => x.matched > 0).map(", to: "r.resources.map(", tests: MENU_TEST },
  { name: "プロジェクト全体の行数を数えるとき、条件を渡さない", file: MENU, from: "      .query({ ...filter, languages, limit: 0 })", to: "      .query({ languages, limit: 0 })", tests: MENU_TEST },
  {
    name: "生成の権限（その列を生成できる役割か）を見ない",
    file: MENU,
    from: "const allowed = isGenerateChoice(c) ? canGenerate(info, c.column.id) : canRunAction(info, c.action.id);",
    to: "const allowed = canRunAction(info, isGenerateChoice(c) ? c.column.id : c.action.id);",
    tests: MENU_TEST,
  },
  { name: "このリソースに合う行がないと、範囲を広げられても押せない", file: MENU, from: 'rows === 0 && !allowProject ? "条件に合う行がありません"', to: 'rows === 0 ? "条件に合う行がありません"', tests: MENU_TEST },
  { name: "生成の選択肢を、メニューに出さない", file: MENU, from: "          {generations.map(item)}\n", to: "", tests: MENU_TEST },
  // ---- 画面: 生成の確認の窓、生成列のセル、設定の入力欄
  { name: "書き換えたバッチサイズを、生成に渡さない", file: DIALOG, from: "    ...(!dryRun && batchValue !== undefined ? { batchSize: batchValue } : {}),\n", to: "", tests: STUDIO_TEST },
  { name: "生成器の既定のバッチサイズを、入力欄に入れない", file: DIALOG, from: "        setBatchText((cur) => cur ?? String(c.batchSize));\n", to: "", tests: STUDIO_TEST },
  { name: "誤ったバッチサイズでも、生成を始められる", file: DIALOG, from: "counts.toRun === 0 || batchProblem !== undefined} title={run.reason}", to: "counts.toRun === 0} title={run.reason}", tests: STUDIO_TEST },
  { name: "選択式の生成列を、色つきの札で出さない", file: CELLS, from: "          ) : option ? (\n            <span className={`gen-${state}`}>", to: "          ) : false ? (\n            <span className={`gen-${state}`}>", tests: STUDIO_TEST },
  { name: "生成器が添えた説明を、セルに出さない", file: CELLS, from: '          {note !== undefined && (\n            <span className="review-note" title={note}>', to: '          {false && (\n            <span className="review-note" title={note}>', tests: STUDIO_TEST },
  { name: "本文が変わった生成結果に「変更あり」と出さない", file: CELLS, from: 'state === "stale" ? "変更あり" : "未生成";\n      const title =', to: 'state === "stale" ? "最新" : "未生成";\n      const title =', tests: STUDIO_TEST },
  { name: "複数行の項目を、1 行の入力欄で出す", file: PANEL, from: "                ) : item.multiline ? (", to: "                ) : false ? (", tests: PANEL_TEST },
  { name: "「既定の文章を入力欄に入れる」が、何も入れない", file: PANEL, from: "onClick={() => set(String(item.default))}", to: "onClick={() => undefined}", tests: PANEL_TEST },
];
