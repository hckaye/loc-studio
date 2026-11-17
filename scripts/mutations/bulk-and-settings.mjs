// 壊し方の一覧: 条件に合う行へのアクションの実行（サービス層の runAction の filter、コマンドラインの run --where、
// 画面の「一括アクション」）と、設定の画面でのプロジェクト設定の編集（言語、列、検証、CSV / TSV の列の対応）。
// 使い方: node scripts/mutation-check.mjs scripts/mutations/bulk-and-settings.mjs
// 実装を直して from の文字列が変わったら、ここも合わせる（合わないものは SKIP と出る）。
//
// 入れていない壊し方:
// - 「中止してもジョブを取り消さない」: 壊した実装では、テストのジョブが終わらず、待つ処理が止まらなくなる。
// - 「filter がオブジェクトでない値（文字列など）を、ここで断らない」: null 以外は、あとの言語の確認が同じ invalid で断るので、外から見た結果が変わらない。
const ACTIONS = "packages/server/src/actions.ts";
const JOBS = "packages/server/src/jobs.test.ts";
const SETTINGS = "packages/server/src/settings.test.ts";
const BATCH = "apps/cli/src/batch.ts";
const CLI = "apps/cli/src/batch.test.ts";
const EDIT = "apps/web/lib/client/config-edit.ts";
const EDIT_TEST = "apps/web/lib/client/config-edit.test.ts";
const MATCH = "apps/web/lib/client/match-actions.ts";
const MATCH_TEST = "apps/web/lib/client/match-actions.test.ts";
const MENU = "apps/web/components/MatchActions.tsx";
const MENU_TEST = "apps/web/components/MatchActions.test.tsx";
const EDITORS = "apps/web/components/ProjectConfigEditors.tsx";
const EDITORS_TEST = "apps/web/components/settings-editors.test.tsx";

export default [
  // ---- サービス層: runAction の filter
  { name: "filter が null でも、ここで断らない", file: ACTIONS, from: "    if (typeof params.filter !== \"object\" || params.filter === null) throw", to: "    if (false) throw", tests: JOBS },
  { name: "keys と filter の併用を断らない", file: ACTIONS, from: "    if (keys) throw new ApiError(\"invalid\", \"keys と filter は", to: "    if (false) throw new ApiError(\"invalid\", \"keys と filter は", tests: JOBS },
  { name: "ファイル全体が対象のアクションに filter を許す", file: ACTIONS, from: "    if (action.target !== \"cell\" && action.target !== \"row\" && action.target !== \"selection\") {", to: "    if (false) {", tests: JOBS },
  { name: "filter の条件で絞らない（全行を対象にする）", file: ACTIONS, from: "    matched = await matchEntries(ctx, doc, prepareFilter(ctx, params.filter, requireLanguages(ctx, params.filter.languages)));", to: "    matched = doc.entries;", tests: JOBS },
  { name: "合う行がなくてもアクションを呼ぶ", file: ACTIONS, from: "    if (matched.length === 0) return { patched: 0, matched: 0 };", to: "", tests: JOBS },
  { name: "filter があっても keys が必要と断る", file: ACTIONS, from: "    if (!matched && (!keys || keys.length === 0)) {", to: "    if (!keys || keys.length === 0) {", tests: JOBS },
  { name: "selection に、合う行でなく全行を渡す", file: ACTIONS, from: "  const entries = matched ?? (action.target", to: "  const entries = (action.target", tests: JOBS },
  { name: "合った行の数を返さない（行ごとの実行）", file: ACTIONS, from: "    const out: RunActionResult = { patched: 0 };\n    if (matched) out.matched = rows.length;", to: "    const out: RunActionResult = { patched: 0 };", tests: JOBS },
  { name: "合った行の数を返さない（ジョブ）", file: ACTIONS, from: "        if (errors.length > 0) handle.info.error = errors.slice(0, 5).join(\" / \");\n      });\n      return { patched: 0, jobId: job.id, ...(matched ? { matched: rows.length } : {}) };", to: "        if (errors.length > 0) handle.info.error = errors.slice(0, 5).join(\" / \");\n      });\n      return { patched: 0, jobId: job.id };", tests: JOBS },
  { name: "合った行の数を返さない（1 回だけ呼ぶアクション）", file: ACTIONS, from: "  if (matched) out.matched = matched.length;", to: "", tests: JOBS },
  // ---- サービス層: 設定の画面に出す、登録済みの列と検証
  { name: "登録済みの列を返さない", file: "packages/server/src/settings-api.ts", from: "      columns: ctx.project.registry.list(\"column\").map(", to: "      columns: ctx.project.registry.list(\"column\").slice(0, 0).map(", tests: SETTINGS },
  { name: "登録済みの検証を返さない", file: "packages/server/src/settings-api.ts", from: "      validators: ctx.project.registry.list(\"validator\").map(", to: "      validators: ctx.project.registry.list(\"validator\").slice(0, 0).map(", tests: SETTINGS },
  { name: "登録済みの列の表示名を返さない", file: "packages/server/src/settings-api.ts", from: "...(c.label !== undefined ? { label: c.label } : {}), kind: c.kind", to: "kind: c.kind", tests: SETTINGS },
  // ---- コマンドライン: run --where
  { name: "--where と --keys の併用を断らない", file: BATCH, from: "    if (opts.keys) throw new UsageError(\"--where と --keys は", to: "    if (false) throw new UsageError(\"--where と --keys は", tests: CLI },
  { name: "--where を、ファイル全体が対象のアクションでも、ここで断らない", file: BATCH, from: "    if (action.target === \"file\" || action.target === \"column\") {", to: "    if (false) {", tests: CLI },
  { name: "--where の条件を渡さない", file: BATCH, from: "              ...(filter ? { filter } : {}),\n", to: "", tests: CLI },
  { name: "条件に合う行のないリソースも、結果に出す", file: BATCH, from: "          if (filter && r.matched === 0) continue;\n", to: "", tests: CLI },
  { name: "条件の対象の言語に、--languages を使わない", file: BATCH, from: "languages: opts.languages ?? info.languages.map((l) => l.id) } : undefined;", to: "languages: info.languages.map((l) => l.id) } : undefined;", tests: CLI },
  { name: "合う行がないことを出さない", file: BATCH, from: "    if (filter && results.length === 0) io.stdout(", to: "    if (false) io.stdout(", tests: CLI },
  { name: "条件に合った行の数を、リソースの行に出さない", file: BATCH, from: "r.matched !== undefined ? `条件に合う行 ${r.matched} / ` : \"\"", to: "\"\"", tests: CLI },
  { name: "条件に合った行の数を、セルごとに数え直して足す", file: BATCH, from: "  for (const r of results) if (r.matched !== undefined) matchedByResource.set(r.resource, r.matched);\n  const matched = [...matchedByResource.values()].reduce((n, m) => n + m, 0);", to: "  const matched = results.reduce((n, r) => n + (r.matched ?? 0), 0) + 1;", tests: CLI },
  // ---- 画面の計算: 言語
  { name: "足した言語の ID の文字を確かめない", file: EDIT, from: "    if (!LANGUAGE_ID.test(l.id)) problems.push(", to: "    if (false) problems.push(", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "すでにある言語にも、ID の文字の決まりを当てる", file: EDIT, from: "    if (known.has(l.id)) continue;\n", to: "", tests: EDIT_TEST },
  { name: "any / all を、言語の ID に許す", file: EDIT, from: "    else if (RESERVED_LANGUAGE_IDS.has(l.id.toLowerCase())) problems.push(", to: "    else if (false) problems.push(", tests: EDIT_TEST },
  { name: "言語の ID の重複を知らせない", file: EDIT, from: "    if (seen.has(l.id)) problems.push(", to: "    if (false) problems.push(", tests: EDIT_TEST },
  { name: "基にする言語に、その言語自身を許す", file: EDIT, from: "    if (l.basedOn === l.id) problems.push(", to: "    if (false) problems.push(", tests: EDIT_TEST },
  { name: "基にする言語がなくても知らせない", file: EDIT, from: "    else if (!seen.has(l.basedOn)) problems.push(", to: "    else if (false) problems.push(", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "言語が 1 つもなくても知らせない", file: EDIT, from: "  if (list.length === 0) problems.push(", to: "  if (false) problems.push(", tests: EDIT_TEST },
  { name: "足す言語を、原文の言語に基づけない", file: EDIT, from: ", ...(source ? { basedOn: source.id } : {}) };", to: " };", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "足す言語の表示名が空でも、ID を入れない", file: EDIT, from: "label: label.trim() === \"\" ? id : label.trim()", to: "label: label.trim()", tests: EDIT_TEST },
  // ---- 画面の計算: 列
  { name: "足す列の ID の候補に、使われている ID を出す", file: EDIT, from: "  if (!taken.includes(base)) return base;\n", to: "  return base;\n", tests: EDIT_TEST },
  { name: "レビュー列を足すとき、対象の列を入れない", file: EDIT, from: "    if (text) entry.of = columnIdOf(text);\n", to: "", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "レビュー列でない列にも、対象の列を入れる", file: EDIT, from: "  if (use.kind === \"review\") {", to: "  if (true) {", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "列の ID の重複を知らせない", file: EDIT, from: "    else if (seen.has(id)) problems.push(", to: "    else if (false) problems.push(", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "対象のないレビュー列を知らせない", file: EDIT, from: "    if (typeof of !== \"string\" || !seen.has(of) || of === columnIdOf(e)) {", to: "    if (false) {", tests: EDIT_TEST },
  { name: "キーや本文の列がなくても知らせない", file: EDIT, from: "    if (!entries.some((e) => columnKindOf(e, available) === kind)) problems.push(", to: "    if (false) problems.push(", tests: EDIT_TEST },
  { name: "定義をそのまま書いた列（kind あり）を、登録名で選んだ列とみなす", file: EDIT, from: "  return typeof e.use === \"string\" && e.kind === undefined ? e.use : undefined;", to: "  return typeof e.use === \"string\" ? e.use : undefined;", tests: EDIT_TEST },
  // ---- 画面の計算: 検証
  { name: "重さを外しても、名前だけの書き方に戻さない", file: EDIT, from: "  return Object.keys(next).length === 1 ? next.use : next;", to: "  return next;", tests: EDIT_TEST },
  { name: "重さを外しても severity を残す", file: EDIT, from: "  if (severity === undefined) delete next.severity;\n  else next.severity = severity;", to: "  if (severity !== undefined) next.severity = severity;", tests: EDIT_TEST },
  // ---- 画面の計算: CSV / TSV の列の対応
  { name: "フォーマットごとに違う対応を、最初のものでまとめる", file: EDIT, from: "mappings.some((m) => m === undefined || !sameMapping(m, first))", to: "mappings.some((m) => m === undefined)", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "同梱の CSV / TSV がなくても、編集できることにする", file: EDIT, from: "  if (entries.length === 0) return { reason:", to: "  if (false) return { reason:", tests: EDIT_TEST },
  { name: "文字列でない対応（text の値）を、そのまま読む", file: EDIT, from: "      if (typeof header !== \"string\") return undefined;\n", to: "", tests: EDIT_TEST },
  { name: "言語 ID と同じ見出しも、設定に書く", file: EDIT, from: "    return header !== \"\" && header !== id ? header : undefined;", to: "    return header !== \"\" ? header : undefined;", tests: EDIT_TEST },
  { name: "プロジェクトにない言語の対応を消す", file: EDIT, from: "const next = languageIds.includes(id) ? headerOf(id) : typeof header === \"string\" ? header : undefined;", to: "const next = languageIds.includes(id) ? headerOf(id) : undefined;", tests: EDIT_TEST },
  { name: "対応のほかのオプション（区切り文字など）を消す", file: EDIT, from: "      if (!(k in values)) next[k] = v;\n      else if (values[k] !== undefined) next[k] = values[k];", to: "      if (k in values && values[k] !== undefined) next[k] = values[k];", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "オプションの並びを保たない（対応を後ろに回す）", file: EDIT, from: "      else if (values[k] !== undefined) next[k] = values[k];\n    }\n", to: "    }\n", tests: EDIT_TEST },
  { name: "ほかのフォーマットの項目も書き換える", file: EDIT, from: "    if (!isRecord(f) || !DELIMITED_FORMATS.includes(f.use)) return f;", to: "    if (!isRecord(f)) return f;", tests: EDIT_TEST },
  { name: "formats がなく、対応も既定のままでも、formats を書く", file: EDIT, from: "    if (Object.keys(options).length === 0) return null;\n", to: "", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "空になった options を残す", file: EDIT, from: "    return Object.keys(options).length > 0 ? { ...rest, options } : rest;", to: "    return { ...rest, options };", tests: EDIT_TEST },
  { name: "文字コードが自動でも、設定に書く", file: EDIT, from: "      encoding: mapping.encoding !== \"auto\" ? mapping.encoding : undefined,", to: "      encoding: mapping.encoding,", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "同じ見出しを 2 回使っても知らせない", file: EDIT, from: "    if (other !== undefined) problems.push(", to: "    if (false) problems.push(", tests: `${EDIT_TEST} ${EDITORS_TEST}` },
  { name: "検証の詳細に、名前の文字列を許さない", file: EDIT, from: "  if (allowString && typeof value === \"string\" && value !== \"\") return { value };\n", to: "", tests: EDIT_TEST },
  { name: "詳細の値に、配列を許す", file: EDIT, from: "  if (isRecord(value)) return { value };\n  if (allowString", to: "  if (typeof value === \"object\") return { value };\n  if (allowString", tests: EDIT_TEST },
  // ---- 画面の計算: 条件に合う行へのアクション
  { name: "ファイルや列の全体が対象のアクションも、選択肢に出す", file: MATCH, from: "    } else if (action.target === \"row\" || action.target === \"selection\") {", to: "    } else {", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "アクションの言語の絞り込みを見ない", file: MATCH, from: "    const allowed = (l: string): boolean => !action.languages || action.languages.includes(l);", to: "    const allowed = (_l: string): boolean => true;", tests: MATCH_TEST },
  { name: "列に当てはまらない言語の選択肢も出す", file: MATCH, from: "          if (!allowed(l) || !columnAppliesTo(col, l)) continue;", to: "          if (!allowed(l)) continue;", tests: MATCH_TEST },
  { name: "アクションの columns にない列（本文）を対象にする", file: MATCH, from: "action.columns ? info.columns.filter((c) => action.columns!.includes(c.id)) : text ? [text] : [];", to: "text ? [text] : [];", tests: MATCH_TEST },
  { name: "言語を絞ったアクションに、言語を渡さない", file: MATCH, from: "      else for (const l of languages) if (allowed(l)) out.push({ id: `${action.id}\\u0000@${l}`, action, language: l, label:", to: "      else for (const l of languages) if (allowed(l)) out.push({ id: `${action.id}\\u0000@${l}`, action, label:", tests: MATCH_TEST },
  { name: "条件を渡さずに実行する", file: MATCH, from: "      resourceId: target.resourceId,\n      filter,\n      ...(choice.cellId", to: "      resourceId: target.resourceId,\n      ...(choice.cellId", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "セルを渡さずに実行する", file: MATCH, from: "      ...(choice.cellId !== undefined ? { cellId: choice.cellId } : {}),\n", to: "", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "ジョブの終わりを待たずに、次のリソースへ進む", file: MATCH, from: "        while (running(job)) {", to: "        while (false) {", tests: MATCH_TEST },
  { name: "中止しても、次のリソースへ進む", file: MATCH, from: "    if (opts.stopped?.()) {\n      state.stopped = true;", to: "    if (false) {\n      state.stopped = true;", tests: MATCH_TEST },
  { name: "ジョブの上限で断られても、やり直さない", file: MATCH, from: "          if (!isRpcError(err, \"throttled\") || attempt >= (opts.throttleRetries ?? 60) || opts.stopped?.()) throw err;", to: "          throw err;", tests: MATCH_TEST },
  { name: "ジョブの上限のやり直しに、回数の限りを付けない（上限以外の失敗でもやり直す）", file: MATCH, from: "          if (!isRpcError(err, \"throttled\") || attempt >=", to: "          if (attempt >=", tests: MATCH_TEST },
  { name: "1 つのリソースの失敗で、全体を止める", file: MATCH, from: "    } catch (err) {\n      state.errors.push(`${target.path}: ${errorText(err)}`);\n    }", to: "    } catch (err) {\n      throw err;\n    }", tests: MATCH_TEST },
  { name: "ジョブのエラーの文言を残さない", file: MATCH, from: "        if (job.error) state.errors.push(", to: "        if (false) state.errors.push(", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "ジョブで実行した行を数えない", file: MATCH, from: "        state.jobRows += job.done;\n", to: "", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "ジョブを始めたことを知らせない", file: MATCH, from: "        opts.onJob?.(jobId);\n", to: "", tests: `${MATCH_TEST} ${MENU_TEST}` },
  { name: "反映できなかった変更の理由を残さない", file: MATCH, from: "    for (const e of res.errors ?? []) state.errors.push(`${target.path}: ${e}`);\n", to: "", tests: `${MATCH_TEST} ${MENU_TEST}` },
  // ---- 画面: 一括アクション
  { name: "実行する権限がなくても、押せる", file: MENU, from: "const reason = !allowed.ok ? allowed.reason : rows === 0 && !allowProject ? \"条件に合う行がありません\" : undefined;", to: "const reason = rows === 0 && !allowProject ? \"条件に合う行がありません\" : undefined;", tests: MENU_TEST },
  { name: "条件に合う行がなくても、押せる", file: MENU, from: "const reason = !allowed.ok ? allowed.reason : rows === 0 && !allowProject ? \"条件に合う行がありません\" : undefined;", to: "const reason = !allowed.ok ? allowed.reason : undefined;", tests: MENU_TEST },
  { name: "メニューを押したら、確かめずに実行する", file: MENU, from: "    setBatchText(\"\");\n    setPending(choice);", to: "    setBatchText(\"\");\n    setPending(choice);\n    void start(choice);", tests: MENU_TEST },
  { name: "終わっても、値を読み直させない", file: MENU, from: "    setRun({ ...result, finished: true });\n    onDone();", to: "    setRun({ ...result, finished: true });", tests: MENU_TEST },
  { name: "行が対象のアクションがなくても、ボタンを出す", file: MENU, from: "  if (actions.length === 0 && generations.length === 0) return null;\n", to: "", tests: MENU_TEST },
  { name: "条件の対象の言語（表示中の言語）を渡さない", file: MENU, from: "runOnMatches(api, choice, { ...filter, languages }, ready.targets, {", to: "runOnMatches(api, choice, { ...filter, languages: [] }, ready.targets, {", tests: MENU_TEST },
  { name: "絞り込みがなくても「絞り込みに合う」と出す", file: MENU, from: "  const what = filtering ? \"絞り込みに合う\" : \"すべての\";", to: "  const what = \"絞り込みに合う\";", tests: MENU_TEST },
  { name: "検索結果の表示で、合う行のないリソースにも実行する", file: "apps/web/components/SearchView.tsx", from: "result.resources.filter((r) => r.matched > 0).map((r) => ({ resourceId: r.resourceId, path: r.path }))", to: "result.resources.map((r) => ({ resourceId: r.resourceId, path: r.path }))", tests: MENU_TEST },
  { name: "検索結果の表示の一括アクションのあと、読み直さない", file: "apps/web/components/Studio.tsx", from: "                onChanged={refreshAll}\n", to: "", tests: MENU_TEST },
  { name: "検索結果の表示を開いている間も、表の一括アクションを出す", file: "apps/web/components/Studio.tsx", from: "              resourceId && view === \"grid\" ? (\n                <MatchActions", to: "              resourceId ? (\n                <MatchActions", tests: MENU_TEST },
  { name: "表の一括アクションのあと、表を読み直さない", file: "apps/web/components/Studio.tsx", from: "                  onDone={refreshAll}\n                  onJob={jobs.track}", to: "                  onDone={() => undefined}\n                  onJob={jobs.track}", tests: MENU_TEST },
  { name: "表の一括アクションに、絞り込みを渡さない", file: "apps/web/components/Studio.tsx", from: "                <MatchActions\n                  filter={rowFilter}", to: "                <MatchActions\n                  filter={{}}", tests: MENU_TEST },
  // ---- 画面: 設定の編集
  { name: "コードの設定にある言語を、変えられるようにする", file: "apps/web/components/SettingsDialog.tsx", from: "languages={p.languages ?? []} locked={fromCode(\"languages\")}", to: "languages={p.languages ?? []} locked={false}", tests: EDITORS_TEST },
  { name: "コードの設定にある列を、変えられるようにする", file: "apps/web/components/SettingsDialog.tsx", from: "        locked={fromCode(\"columns\")}", to: "        locked={false}", tests: EDITORS_TEST },
  { name: "コードの設定にある検証を、変えられるようにする", file: "apps/web/components/SettingsDialog.tsx", from: "        locked={fromCode(\"validators\")}", to: "        locked={false}", tests: EDITORS_TEST },
  { name: "コードの設定にある列の対応を、変えられるようにする", file: "apps/web/components/SettingsDialog.tsx", from: "            locked={fromCode(\"formats\")}", to: "            locked={false}", tests: EDITORS_TEST },
  { name: "誤りがあっても、言語を保存できる", file: EDITORS, from: "disabled={busy || problems.length > 0 || same(draft, languages)}", to: "disabled={busy || same(draft, languages)}", tests: EDITORS_TEST },
  { name: "変えていなくても、言語を保存できる", file: EDITORS, from: "disabled={busy || problems.length > 0 || same(draft, languages)}", to: "disabled={busy || problems.length > 0}", tests: EDITORS_TEST },
  { name: "誤りがあっても、列を保存できる", file: EDITORS, from: "disabled={busy || problems.length > 0 || same(draft, initial)}", to: "disabled={busy || same(draft, initial)}", tests: EDITORS_TEST },
  { name: "誤りがあっても、列の対応を保存できる", file: EDITORS, from: "disabled={busy || problems.length > 0 || !dirty}", to: "disabled={busy || !dirty}", tests: EDITORS_TEST },
  { name: "変えていなくても、列の対応を保存できる", file: EDITORS, from: "disabled={busy || problems.length > 0 || !dirty}", to: "disabled={busy || problems.length > 0}", tests: EDITORS_TEST },
  { name: "キーと本文の列を消せる", file: EDITORS, from: "disabled={off || kind === \"key\" || kind === \"text\"}", to: "disabled={off}", tests: EDITORS_TEST },
  { name: "固定を外しても、pinned を残す", file: EDITORS, from: "return e.target.checked ? { ...rest, pinned: true } : rest;", to: "return e.target.checked ? { ...rest, pinned: true } : { ...rest, pinned: false };", tests: EDITORS_TEST },
  { name: "原文にしても、basedOn を残す", file: EDITORS, from: "return e.target.value === \"\" ? rest : { ...rest, basedOn: e.target.value };", to: "return { ...rest, basedOn: e.target.value };", tests: EDITORS_TEST },
  { name: "列の表示名を空にしても、label を残す", file: EDITORS, from: "return (e.target.value === \"\" ? rest : { ...rest, label: e.target.value }) as ColumnEntry;", to: "return { ...rest, label: e.target.value } as ColumnEntry;", tests: EDITORS_TEST },
  { name: "設定に列がないとき、既定の 2 列を出さない", file: EDITORS, from: "  const initial = useMemo(() => columns ?? defaultColumnEntries(), [columns]);", to: "  const initial = useMemo(() => columns ?? [], [columns]);", tests: EDITORS_TEST },
  { name: "詳細の JSON の誤りを、知らせずに捨てる", file: EDITORS, from: "          if (\"error\" in r) return setError(r.error);", to: "          if (\"error\" in r) return;", tests: EDITORS_TEST },
  { name: "まとめて変えられない列の対応でも、欄を出す", file: EDITORS, from: "  if (\"reason\" in read) return <p className=\"muted small\">{read.reason}</p>;\n", to: "", tests: EDITORS_TEST },
  { name: "足す言語の ID の前後の空白を取らない", file: EDITORS, from: "setDraft((d) => [...d, newLanguage(d, newId.trim(), newLabel)]);", to: "setDraft((d) => [...d, newLanguage(d, ` ${newId}`, newLabel)]);", tests: EDITORS_TEST },
];
