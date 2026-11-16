/**
 * init: 新しいプロジェクトを作る。画面の「新しいプロジェクトを作る」と同じ処理（サービス層の createProject）を呼ぶ。
 */
import path from "node:path";
import { localSettingsPath } from "@loc-studio/core";
import { createProject } from "@loc-studio/server";
import type { NewProjectInput } from "@loc-studio/server";
import type { CliOptions } from "./args.js";
import { openWorkspace } from "./batch.js";
import type { CliIO } from "./commands.js";

export async function runInit(opts: CliOptions, io: CliIO): Promise<number> {
  const root = path.resolve(io.cwd, opts.project ?? ".");
  const languages = opts.newLanguages ?? [];
  const source = languages[0]?.id;
  const input: NewProjectInput = {
    root,
    name: opts.name ?? path.basename(root),
    // 最初の言語を原文にして表の固定側に置き、ほかの言語はそこから翻訳する（画面の既定と同じ）。
    languages: languages.map((l, i) => ({ ...l, ...(i === 0 ? { pinned: true } : source !== undefined ? { basedOn: source } : {}) })),
    statusColumn: !opts.noStatus,
    reviewColumn: !opts.noReview,
    whitespaceValidator: !opts.noValidators,
    untranslatedValidator: !opts.noValidators,
  };
  if (opts.keyColumn !== undefined || opts.textColumns !== undefined || opts.encoding !== undefined) {
    input.mapping = {
      ...(opts.keyColumn !== undefined ? { key: opts.keyColumn } : {}),
      ...(opts.textColumns !== undefined ? { text: opts.textColumns } : {}),
      ...(opts.encoding !== undefined ? { encoding: opts.encoding } : {}),
    };
  }
  if (opts.resource !== undefined) input.firstResource = opts.resource;

  // 画面が読むのと同じローカル設定に、いま書いた設定ファイルの確認を記録する（画面で開いたときに、もう一度確認を出さない）。
  const localSettingsFile = opts.userDataDir !== undefined ? path.join(path.resolve(io.cwd, opts.userDataDir), "settings.json") : localSettingsPath(io.env);
  const created = await createProject(input, { localSettingsFile });

  let resource: string | undefined;
  if (created.firstResource !== undefined) {
    const ws = await openWorkspace({ ...opts, project: root }, io);
    try {
      resource = (await ws.createResource({ path: created.firstResource })).resource.path;
    } finally {
      await ws.close();
    }
  }

  if (opts.json) {
    io.stdout(JSON.stringify({ project: created.root, configFile: created.configFile, config: created.config, ...(resource !== undefined ? { resource } : {}) }, null, 2) + "\n");
  } else {
    io.stdout(`プロジェクトを作りました: ${created.root}\n`);
    io.stdout(`  設定ファイル: ${created.configFile}\n`);
    if (resource !== undefined) io.stdout(`  最初のファイル: ${resource}\n`);
    io.stdout(`画面で開くか、loc-studio tree --project "${created.root}" で中身を確かめられます。\n`);
  }
  return 0;
}
