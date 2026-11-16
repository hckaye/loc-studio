// 壊し方の一覧: 新しいプロジェクトの作成（フォルダの確認、雛形の設定、設定ファイルの作成、確認済みの記録）、
// 作成の画面と最初の画面の導線、デスクトップ版のメニュー、コマンドラインの init、配布物の依存の確認。
// 使い方: node scripts/mutation-check.mjs scripts/mutations/new-project.mjs
// 実装を直して from の文字列が変わったら、ここも合わせる（合わないものは SKIP と出る）。
//
// 入れていない壊し方:
// - 「絶対パスでないフォルダを断らない」: 壊した実装でテストを走らせると、作業フォルダ（リポジトリのルート）にフォルダと設定ファイルを作ってしまう。
// - 「設定ファイルを上書きできる書き方（wx を外す）」: その前の確認で先に断るので、外から見た結果が変わらない（同時に作られたときの備え）。
const SERVER = "packages/server/src/new-project.test.ts";
const WEB = "apps/web/components/new-project.test.tsx";
const CLI = "apps/cli/src/init.test.ts";
const PACK = "apps/desktop/scripts/after-pack.test.ts";

export default [
  // ---- サービス層: フォルダの確認
  { name: "コードの設定ファイルを、プロジェクトがある印とみなさない", file: "packages/server/src/new-project.ts", from: "  for (const name of [PROJECT_CONFIG_JSON, ...PROJECT_CONFIG_CODE]) {", to: "  for (const name of [PROJECT_CONFIG_JSON]) {", tests: SERVER },
  { name: "フォルダでないものを断らない", file: "packages/server/src/new-project.ts", from: "  if (!info.isDirectory()) throw", to: "  if (false) throw", tests: SERVER },
  { name: "見出しを読むファイルの数を限らない", file: "packages/server/src/new-project.ts", from: "paths.slice(0, MAX_INSPECTED_RESOURCES)", to: "paths", tests: SERVER },
  { name: "TSV をカンマ区切りで読む", file: "packages/server/src/new-project.ts", from: "resourcePath.toLowerCase().endsWith(\".tsv\") ? \"\\t\" : \",\"", to: "\",\"", tests: SERVER },
  { name: "選んだ文字コードで読まない", file: "packages/server/src/new-project.ts", from: "delimiter, resourcePath, encoding);", to: "delimiter, resourcePath);", tests: SERVER },
  { name: "見出しの前の空の行を飛ばさない", file: "packages/builtin/src/csv.ts", from: "  const header = scan(text, delimiter).records.find((r) => !r.blank);\n  return header ?", to: "  const header = scan(text, delimiter).records[0];\n  return header ?", tests: SERVER },
  // ---- サービス層: 入力の確認
  { name: "名前が空でも作る", file: "packages/server/src/new-project.ts", from: "  if (typeof input?.name !== \"string\" || input.name.trim() === \"\") throw", to: "  if (false) throw", tests: SERVER },
  { name: "言語 ID に使える文字を確かめない", file: "packages/server/src/new-project.ts", from: "    if (!LANGUAGE_ID.test(id)) {", to: "    if (false) {", tests: SERVER },
  { name: "any / all を言語 ID に許す", file: "packages/server/src/new-project.ts", from: "    if (RESERVED_LANGUAGE_IDS.has(id.toLowerCase())) throw", to: "    if (false) throw", tests: SERVER },
  { name: "any / all を、大文字小文字を区別して見る", file: "packages/server/src/new-project.ts", from: "RESERVED_LANGUAGE_IDS.has(id.toLowerCase())", to: "RESERVED_LANGUAGE_IDS.has(id)", tests: SERVER },
  { name: "言語 ID の重複を、ここで断らない", file: "packages/server/src/new-project.ts", from: "    if (seen.has(id)) throw", to: "    if (false) throw", tests: SERVER },
  { name: "翻訳元に、その言語自身を許す", file: "packages/server/src/new-project.ts", from: "    if (l.basedOn === l.id) throw", to: "    if (false) throw", tests: SERVER },
  { name: "ない翻訳元を、ここで断らない", file: "packages/server/src/new-project.ts", from: "    if (!seen.has(l.basedOn)) throw", to: "    if (false) throw", tests: SERVER },
  { name: "表示名が空のとき、ID を使わない", file: "packages/server/src/new-project.ts", from: "{ id, label: label === \"\" ? id : label }", to: "{ id, label }", tests: SERVER },
  { name: "同じ列を 2 つの役目に選んでも断らない", file: "packages/server/src/new-project.ts", from: "    if (other !== undefined) throw", to: "    if (false) throw", tests: SERVER },
  { name: "ない言語への列の対応を断らない", file: "packages/server/src/new-project.ts", from: "      if (!ids.has(id)) throw", to: "      if (false) throw", tests: SERVER },
  { name: "最初のファイルの場所に、上の階層を許す", file: "packages/server/src/new-project.ts", from: "p.split(\"/\").some((s) => s === \"\" || s === \".\" || s === \"..\")", to: "false", tests: SERVER },
  { name: "最初のファイルの拡張子を確かめない", file: "packages/server/src/new-project.ts", from: "  if (!/\\.(csv|tsv)$/i.test(p)) throw", to: "  if (false) throw", tests: SERVER },
  // ---- サービス層: 雛形の設定
  { name: "言語 ID と同じ見出しも、設定に書く", file: "packages/server/src/new-project.ts", from: "      if (header !== id) text[id] = header;", to: "      text[id] = header;", tests: SERVER },
  { name: "対応が要らなくても formats を書く", file: "packages/server/src/new-project.ts", from: "  return Object.keys(options).length > 0 ? options : undefined;", to: "  return options;", tests: SERVER },
  { name: "文字コードを設定に書かない", file: "packages/server/src/new-project.ts", from: "  if (encoding !== \"auto\") options.encoding = encoding;\n", to: "", tests: SERVER },
  { name: "TSV のフォーマットを書かない", file: "packages/server/src/new-project.ts", from: "      { use: \"builtin.tsv\", match: \"**/*.tsv\", options },\n", to: "", tests: SERVER },
  { name: "進捗の列を外せない", file: "packages/server/src/new-project.ts", from: "  const status = input.statusColumn !== false;", to: "  const status = true;", tests: SERVER },
  { name: "レビューの列を外せない", file: "packages/server/src/new-project.ts", from: "  const review = input.reviewColumn !== false;", to: "  const review = true;", tests: SERVER },
  { name: "空白の検証を外せない", file: "packages/server/src/new-project.ts", from: "  const whitespace = input.whitespaceValidator !== false;", to: "  const whitespace = true;", tests: SERVER },
  { name: "未翻訳の検証を外せない", file: "packages/server/src/new-project.ts", from: "  const untranslated = input.untranslatedValidator !== false;", to: "  const untranslated = true;", tests: SERVER },
  { name: "検証を両方外しても、空の validators を書く", file: "packages/server/src/new-project.ts", from: "  if (whitespace || untranslated) {", to: "  if (true) {", tests: SERVER },
  { name: "固定の指定を設定に書かない", file: "packages/server/src/new-project.ts", from: "...(l.pinned ? { pinned: true } : {})", to: "...{}", tests: SERVER },
  { name: "翻訳元を設定に書かない", file: "packages/server/src/new-project.ts", from: "...(l.basedOn !== undefined ? { basedOn: l.basedOn } : {})", to: "...{}", tests: SERVER },
  // ---- サービス層: 設定ファイルの作成
  { name: "すでに設定ファイルがあるかを、書く前に確かめない", file: "packages/server/src/new-project.ts", from: "    if (found !== undefined) {", to: "    if (false) {", tests: SERVER },
  { name: "確認済みの記録を書かない", file: "packages/server/src/new-project.ts", from: "      await writeTrustFile(opts.localSettingsFile, root, (forRoot) => {\n        forRoot[candidate.path] = candidate.hash;\n      });\n", to: "", tests: SERVER },
  { name: "最初のファイルの指定を返さない", file: "packages/server/src/new-project.ts", from: "  if (firstResource !== undefined) result.firstResource = firstResource;\n", to: "", tests: SERVER },
  // ---- コマンドライン
  { name: "init: 最初の言語を原文にしない", file: "apps/cli/src/init.ts", from: "...(i === 0 ? { pinned: true } : source !== undefined ? { basedOn: source } : {})", to: "...{}", tests: CLI },
  { name: "init: 最初のファイルを作らない", file: "apps/cli/src/init.ts", from: "      resource = (await ws.createResource({ path: created.firstResource })).resource.path;", to: "      resource = created.firstResource;", tests: CLI },
  { name: "init: 確認済みの記録を書かない", file: "apps/cli/src/init.ts", from: "const created = await createProject(input, { localSettingsFile });", to: "const created = await createProject(input);", tests: CLI },
  { name: "init: --no-status を無視する", file: "apps/cli/src/init.ts", from: "    statusColumn: !opts.noStatus,", to: "    statusColumn: true,", tests: CLI },
  { name: "init: --no-validators で空白の検証を外さない", file: "apps/cli/src/init.ts", from: "    whitespaceValidator: !opts.noValidators,", to: "    whitespaceValidator: true,", tests: CLI },
  { name: "init: --no-validators で未翻訳の検証を外さない", file: "apps/cli/src/init.ts", from: "    untranslatedValidator: !opts.noValidators,", to: "    untranslatedValidator: true,", tests: CLI },
  { name: "init: 名前を省いたとき、フォルダの名前を使わない", file: "apps/cli/src/init.ts", from: "    name: opts.name ?? path.basename(root),", to: "    name: opts.name ?? \"\",", tests: CLI },
  { name: "init: --languages がなくても進む", file: "apps/cli/src/args.ts", from: "    if (values.languages === undefined || list(values.languages).length === 0) {", to: "    if (false) {", tests: CLI },
  { name: "init: --text-columns の形を確かめない", file: "apps/cli/src/args.ts", from: "        if (header === undefined || header === \"\") throw", to: "        if (false) throw", tests: CLI },
  { name: "init のオプションを、ほかのコマンドでも通す", file: "apps/cli/src/args.ts", from: "  init: [\"name\", \"languages\", \"resource\", \"key-column\", \"text-columns\", \"encoding\", \"no-status\", \"no-review\", \"no-validators\"],\n", to: "", tests: CLI },
  // ---- 作成の画面
  { name: "名前を、フォルダの名前で埋めない", file: "apps/web/components/NewProject.tsx", from: "    if (!nameTouched.current) setName(folderName(value));", to: "", tests: WEB },
  { name: "書き換えた名前を、フォルダの名前で上書きする", file: "apps/web/components/NewProject.tsx", from: "    if (!nameTouched.current) setName(folderName(value));", to: "    setName(folderName(value));", tests: WEB },
  { name: "すでにプロジェクトのあるフォルダでも作れる", file: "apps/web/components/NewProject.tsx", from: "inspecting || alreadyProject || ", to: "inspecting || ", tests: WEB },
  { name: "フォルダを確かめられなくても作れる", file: "apps/web/components/NewProject.tsx", from: "|| folderError !== null || problems", to: "|| problems", tests: WEB },
  { name: "誤りがあっても作れる", file: "apps/web/components/NewProject.tsx", from: "folderError !== null || problems.length > 0;", to: "folderError !== null;", tests: WEB },
  { name: "原文を固定側に置かない", file: "apps/web/components/NewProject.tsx", from: "...(isSource ? { pinned: true } : sourceId ? { basedOn: sourceId } : {}),", to: "...(sourceId && !isSource ? { basedOn: sourceId } : {}),", tests: WEB },
  { name: "ほかの言語の翻訳元を送らない", file: "apps/web/components/NewProject.tsx", from: "...(isSource ? { pinned: true } : sourceId ? { basedOn: sourceId } : {}),", to: "...(isSource ? { pinned: true } : {}),", tests: WEB },
  { name: "先頭の列がキーでも、キーの列を送る", file: "apps/web/components/NewProject.tsx", from: "...(reference && key !== \"\" && key !== headers[0] ? { key } : {}),", to: "...(reference && key !== \"\" ? { key } : {}),", tests: WEB },
  { name: "言語 ID と同じ見出しを、最初から選ばない", file: "apps/web/components/NewProject.tsx", from: "    return guessHeader(l.id, headers);", to: "    return \"\";", tests: WEB },
  { name: "見出しの大文字小文字を区別して選ぶ", file: "apps/web/components/NewProject.tsx", from: "headers.find((h) => h.trim().toLowerCase() === lower) ?? \"\"", to: "headers.find((h) => h.trim() === id.trim()) ?? \"\"", tests: WEB },
  { name: "選び直した文字コードで確かめ直さない", file: "apps/web/components/NewProject.tsx", from: "postJson(\"/api/session/inspect\", { path: trimmedPath, encoding },", to: "postJson(\"/api/session/inspect\", { path: trimmedPath, encoding: \"auto\" },", tests: WEB },
  { name: "文字コードを、作成のときに送らない", file: "apps/web/components/NewProject.tsx", from: "        ...(encoding !== \"auto\" ? { encoding } : {}),\n", to: "", tests: WEB },
  { name: "同じ列を 2 つに選んでも知らせない", file: "apps/web/components/NewProject.tsx", from: "      if (other !== undefined) {", to: "      if (false) {", tests: WEB },
  { name: "最初のファイルを外せない", file: "apps/web/components/NewProject.tsx", from: "    } else if (makeFirst) {", to: "    } else {", tests: WEB },
  { name: "すでにあるファイルがあっても、最初のファイルを送る", file: "apps/web/components/NewProject.tsx", from: "    if (hasFiles) {\n      const text", to: "    if (false) {\n      const text", tests: WEB },
  { name: "空白の検証のチェックを送らない", file: "apps/web/components/NewProject.tsx", from: "      whitespaceValidator,\n", to: "      whitespaceValidator: true,\n", tests: WEB },
  { name: "未翻訳の検証のチェックを送らない", file: "apps/web/components/NewProject.tsx", from: "      untranslatedValidator,\n", to: "      untranslatedValidator: true,\n", tests: WEB },
  { name: "空白の検証のチェックで、未翻訳の検証を切り替える", file: "apps/web/components/NewProject.tsx", from: "onChange={(e) => setWhitespaceValidator(e.target.checked)}", to: "onChange={(e) => setUntranslatedValidator(e.target.checked)}", tests: WEB },
  { name: "未翻訳の検証のチェックで、空白の検証を切り替える", file: "apps/web/components/NewProject.tsx", from: "onChange={(e) => setUntranslatedValidator(e.target.checked)}", to: "onChange={(e) => setWhitespaceValidator(e.target.checked)}", tests: WEB },
  { name: "言語が 1 つでも外せる", file: "apps/web/components/NewProject.tsx", from: "disabled={languages.length <= 1}", to: "disabled={false}", tests: WEB },
  { name: "作成に失敗しても、理由を出さない", file: "apps/web/components/NewProject.tsx", from: "      setError(err instanceof Error ? err.message : String(err));\n      setBusy(false);", to: "      setBusy(false);", tests: WEB },
  { name: "作成に失敗したあと、ボタンを戻さない", file: "apps/web/components/NewProject.tsx", from: "      setError(err instanceof Error ? err.message : String(err));\n      setBusy(false);", to: "      setError(err instanceof Error ? err.message : String(err));", tests: WEB },
  // ---- 最初の画面と、アプリの入口
  { name: "プロジェクトでないフォルダに、作る案内を出さない", file: "apps/web/components/App.tsx", from: "        if (folder.configFile === undefined) setCreateOffer(folder.root);\n", to: "", tests: WEB },
  { name: "壊れたプロジェクトにも、作る案内を出す", file: "apps/web/components/App.tsx", from: "        if (folder.configFile === undefined) setCreateOffer(folder.root);", to: "        setCreateOffer(folder.root);", tests: WEB },
  { name: "案内のボタンが、フォルダを渡さない", file: "apps/web/components/OpenProject.tsx", from: "onClick={() => onCreate(createOffer)}", to: "onClick={() => onCreate()}", tests: WEB },
  { name: "作ったプロジェクトを開かない", file: "apps/web/components/App.tsx", from: "          void openLocal(created.project);\n", to: "", tests: WEB },
  { name: "メニューの「開く」を受けない", file: "apps/web/components/App.tsx", from: "        void openLocal(command.path);\n", to: "", tests: WEB },
  { name: "メニューの「新しいプロジェクト」で、作成の画面を出さない", file: "apps/web/components/App.tsx", from: "        setCreating({ path: \"\" });\n", to: "", tests: WEB },
  { name: "メニューの「新しいプロジェクト」で、開いているプロジェクトを閉じない", file: "apps/web/components/App.tsx", from: "      } else if (command.type === \"new\") {\n        setProject(null);\n", to: "      } else if (command.type === \"new\") {\n", tests: WEB },
  { name: "別のプロジェクトを開けなかったとき、いまの画面に知らせない", file: "apps/web/components/App.tsx", from: "      if (projectRef.current) {\n        reportError(err, \"プロジェクトを開けませんでした\");\n        return;\n      }\n", to: "", tests: WEB },
  { name: "開いたあと、メニューを作り直すよう知らせない", file: "apps/web/components/App.tsx", from: "      window.locStudio?.projectsChanged?.();\n", to: "", tests: WEB },
  // ---- 作ったばかりのプロジェクトの画面
  { name: "リソースがないときの案内を出さない", file: "apps/web/components/Studio.tsx", from: "{treeLoaded && firstResource(tree) === undefined", to: "{false", tests: WEB },
  { name: "ツリーを読む前から、リソースがないと案内する", file: "apps/web/components/Studio.tsx", from: "{treeLoaded && firstResource(tree) === undefined", to: "{firstResource(tree) === undefined", tests: WEB },
  { name: "絞り込みで行がないときも、行の足し方を出す", file: "apps/web/components/Studio.tsx", from: "rows.totalAll > 0 ? \"条件に合う行がありません\" : ", to: "", tests: WEB },
  // ---- デスクトップ版のメニュー
  { name: "「新しいプロジェクト…」で、開く操作を呼ぶ", file: "apps/desktop/src/menu.ts", from: "accelerator: \"CommandOrControl+N\", click: () => actions.newProject() }", to: "accelerator: \"CommandOrControl+N\", click: () => actions.openProject() }", tests: "apps/desktop/src/menu.test.ts" },
  { name: "preload が、メニューの操作のチャンネルを聞かない", file: "apps/desktop/src/preload.ts", from: "ipcRenderer.on(\"loc-studio:command\",", to: "ipcRenderer.on(\"loc-studio:cmd\",", tests: "apps/desktop/src/menu.test.ts" },
  // ---- 配布物の依存
  { name: "上の階層の node_modules も見る", file: "scripts/standalone-deps.cjs", from: "    if (dir === top) return undefined;", to: "    if (path.dirname(dir) === dir) return undefined;", tests: PACK },
  { name: "依存の依存を辿らない", file: "scripts/standalone-deps.cjs", from: "      if (found) visit(found);\n      else missing.push", to: "      if (found) {\n      } else missing.push", tests: PACK },
  { name: "optionalDependencies の先を辿らない", file: "scripts/standalone-deps.cjs", from: "    for (const name of Object.keys(pkg.optionalDependencies ?? {})) {\n      const found = resolveWithin(root, pkgDir, name);\n      if (found) visit(found);\n    }\n", to: "", tests: PACK },
  { name: "optionalDependencies がないと、足りないと数える", file: "scripts/standalone-deps.cjs", from: "    for (const name of Object.keys(pkg.dependencies ?? {})) {", to: "    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {", tests: PACK },
  { name: "配布物の依存を確かめない", file: "apps/desktop/scripts/after-pack.cjs", from: "  if (unresolved.length > 0) {", to: "  if (false) {", tests: PACK },
  { name: "リポジトリにない依存を、黙って飛ばす", file: "scripts/standalone-deps.cjs", from: "      if (!source) throw new Error(", to: "      if (!source) return copied;\n      if (false) throw new Error(", tests: PACK },
  { name: "入れ子の node_modules の中を、ほかのパッケージからも見えるようにする", file: "scripts/standalone-deps.cjs", from: "      const candidate = path.join(dir, \"node_modules\", ...name.split(\"/\"));", to: "      const candidate = existsSync(path.join(top, \"node_modules\", \"a\", \"node_modules\", ...name.split(\"/\"))) ? path.join(top, \"node_modules\", \"a\", \"node_modules\", ...name.split(\"/\")) : path.join(dir, \"node_modules\", ...name.split(\"/\"));", tests: PACK },
];
