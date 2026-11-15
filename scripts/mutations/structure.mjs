// 壊し方の一覧: 行の追加・削除・キーの変更、リソースの作成。
// 使い方: node scripts/mutation-check.mjs scripts/mutations/structure.mjs
// 実装を直して from の文字列が変わったら、ここも合わせる（合わないものは SKIP と出る）。
export default [
  {"name": "履歴を新しいキーに移さない", "file": "packages/server/src/structure.ts", "from": "      await ctx.shared.log(HISTORY_NS).renameEntry(rid, c.key, c.newKey);\n", "to": "", "tests": "packages/server/src/structure.test.ts"},
  {"name": "ドラフトを新しいキーに移さない", "file": "packages/server/src/structure.ts", "from": "      await ctx.drafts.renameKey(rid, c.key, c.newKey);\n", "to": "", "tests": "packages/server/src/structure.test.ts"},
  {"name": "要再確認の記録を移さない", "file": "packages/server/src/structure.ts", "from": "      await ctx.shared.cells(TEXT_BASIS_NS).renameEntry(rid, c.key, c.newKey);\n", "to": "", "tests": "packages/server/src/structure.test.ts"},
  {"name": "消した行のドラフトを残す", "file": "packages/server/src/structure.ts", "from": "      await ctx.drafts.removeKey(rid, c.key);\n", "to": "", "tests": "packages/server/src/structure.test.ts"},
  {"name": "黙って無視するフォーマットの確認をしない", "file": "packages/server/src/structure.ts", "from": "if (want.length !== got.length || want.some((k, i) => k !== got[i])) {", "to": "if (false) {", "tests": "packages/server/src/structure.test.ts"},
  {"name": "列ソースに同じ名前で何度も知らせる", "file": "packages/server/src/structure.ts", "from": "if (!resolved || told.has(resolved.name)) continue;", "to": "if (!resolved) continue;", "tests": "packages/server/src/structure.test.ts"},
  {"name": "列ソースに知らせない", "file": "packages/server/src/structure.ts", "from": "      await resolved.source.onEntriesChanged(changes, resource, ctx.project.sourceContext(resolved));\n", "to": "", "tests": "packages/server/src/structure.test.ts"},
  {"name": "見えない場所にも作れる", "file": "packages/server/src/structure.ts", "from": "if (!resourceVisible(resourcePath)) throw", "to": "if (false) throw", "tests": "packages/server/src/structure.test.ts"},
  {"name": "すでにあるリソースの確認をしない", "file": "packages/server/src/structure.ts", "from": "if ((await ctx.docs.allResources()).some((r) => r.id === resourcePath || r.path === resourcePath)) {", "to": "if (false) {", "tests": "packages/server/src/structure.test.ts"},
  {"name": "entries.change の before を呼ばない", "file": "packages/server/src/structure.ts", "from": "      await runBefore(ctx, event);\n", "to": "", "tests": "packages/server/src/structure.test.ts"},
  {"name": "作成で resource.write の before を呼ばない", "file": "packages/server/src/structure.ts", "from": "  await runBefore(ctx, { type: \"resource.write\", resource: candidate });\n", "to": "", "tests": "packages/server/src/structure.test.ts"},
  {"name": "上に出るパスを通す", "file": "packages/server/src/structure.ts", "from": "resourcePath.split(\"/\").some((p) => p === \"\" || p === \".\" || p === \"..\")) {\n    throw new ApiError(\"invalid\", `リソースの場所は", "to": "false) {\n    throw new ApiError(\"invalid\", `リソースの場所は", "tests": "packages/server/src/structure.test.ts"},
  {"name": "ツリーの対象外にも作る", "file": "packages/builtin/src/glob-tree.ts", "from": "if (!picomatch(include, opts)(resourcePath) || (exclude.length > 0 && picomatch(exclude, opts)(resourcePath))) {", "to": "if (false) {", "tests": "packages/server/src/structure.test.ts"},
  {"name": "作成で上書きする", "file": "packages/builtin/src/glob-tree.ts", "from": "await writeFile(file, data, { flag: \"wx\" });", "to": "await writeFile(file, data);", "tests": "packages/server/src/structure.test.ts packages/builtin/src/glob-tree.test.ts"},
  {"name": "同梱の列ソースがキーの変更に追従しない", "file": "packages/builtin/src/db-source.ts", "from": "if (change.type === \"rename\") await cells.renameEntry(resource.id, change.key, change.newKey);", "to": "", "tests": "packages/server/src/structure.test.ts"},
];
