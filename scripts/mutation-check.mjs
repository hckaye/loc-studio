#!/usr/bin/env node
/*
 * 実装を 1 か所ずつ壊してテストを走らせ、テストが落ちるか（壊れたことに気づけるか）を確かめる。
 * テストを足したり書き直したりしたあと、「このテストは本当に退行を見つけるか」を確かめるのに使う。
 *
 * 使い方（リポジトリのルートで）:
 *   node scripts/mutation-check.mjs <spec.mjs>
 *
 * spec.mjs は、壊し方の一覧を既定の書き出しにする:
 *   export default [
 *     {
 *       name: "役割の絞り込みを確かめない",          // 何を壊すか
 *       file: "packages/server/src/permissions.ts",   // 壊すファイル
 *       from: "if (!columns.includes(columnId)) {",    // 元の文字列（ファイルの中にちょうど 1 回あること）
 *       to: "if (false) {",                            // 壊した文字列
 *       tests: "packages/server/src/permissions.test.ts", // 走らせるテスト（vitest に渡す。空白区切りで複数）
 *     },
 *   ];
 *
 * 結果:
 *   killed    … テストが落ちた（壊れたことに気づけた）
 *   SURVIVED  … テストが通ってしまった（その振る舞いを確かめるテストがない、または弱い）
 * 生き残りがあれば終了コード 1。壊した変更は、結果にかかわらず必ず元に戻す。
 *
 * 生き残ったときは、テストを足す。ただし「壊しても外から見た振る舞いが変わらない」変更（同じ結果になる別の書き方）は
 * 生き残って当然なので、壊し方のほうを見直す。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const specPath = process.argv[2];
if (!specPath) {
  console.error("使い方: node scripts/mutation-check.mjs <spec.mjs>");
  process.exit(2);
}
const mutations = (await import(pathToFileURL(path.resolve(specPath)).href)).default;
if (!Array.isArray(mutations)) {
  console.error("spec の既定の書き出しは、壊し方の配列にしてください。");
  process.exit(2);
}

const survived = [];
for (const m of mutations) {
  const original = readFileSync(m.file, "utf8");
  const count = original.split(m.from).length - 1;
  if (count !== 1) {
    console.log(`SKIP      ${m.name}  （元の文字列が ${count} 回。ちょうど 1 回にしてください）`);
    survived.push(`${m.name}（適用できず）`);
    continue;
  }
  let result;
  writeFileSync(m.file, original.replace(m.from, m.to));
  try {
    result = spawnSync(`npx vitest run ${m.tests}`, { shell: true, encoding: "utf8" });
  } finally {
    writeFileSync(m.file, original);
  }
  if (result.status === 0) {
    console.log(`SURVIVED  ${m.name}  （テストが通ってしまった）`);
    survived.push(m.name);
  } else {
    const failed = (result.stdout ?? "").split("\n").filter((l) => l.includes("×"));
    console.log(`killed    ${m.name}  （落ちたテスト ${failed.length} 件）`);
  }
}
console.log(`\n生き残った変異: ${survived.length === 0 ? "なし" : survived.join("、")}`);
process.exit(survived.length === 0 ? 0 : 1);
