import path from "node:path";
import type { NewProjectInput } from "@loc-studio/server";
import { rememberProject } from "@/lib/server/session";
import { dataDir, errorResponse, getRuntime, guard, markOpened, toErrorBody } from "@/lib/server/host";
import { loadServer } from "@/lib/server/runtime";
import { LIMITS, readJsonBody } from "@/lib/security/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/session/create { root, name, languages, ... } → 新しいプロジェクトを作って開く（ローカルモードだけ。利用者の操作から呼ぶ）。
 * 設定ファイルを書き、最初のファイルの指定があれば作り、最近の一覧に覚える。すでにプロジェクトのあるフォルダには作らない。
 */
export async function POST(request: Request): Promise<Response> {
  const g = await guard(request, "state");
  if (!g.ok) return g.response;
  if (g.web) return errorResponse({ code: "forbidden", message: "Web モードでは、プロジェクトは作れません（サーバーの管理者が、サーバーの設定に足します）。" }, 403);
  const body = await readJsonBody(request, LIMITS.admin);
  if (!body.ok) return errorResponse({ code: "invalid", message: body.message }, body.status);
  try {
    const { createProject } = await loadServer();
    // 画面のワークスペースが読むのと同じローカル設定に、いま作った設定ファイルの確認を記録する。
    const created = await createProject(body.value as unknown as NewProjectInput, { localSettingsFile: path.join(await dataDir(), "settings.json") });
    const rt = await getRuntime();
    const info = await rt.handle({ projectId: created.root, method: "info" });
    if ("error" in info) return Response.json({ error: info.error });
    const warnings: string[] = [];
    let resource: string | undefined;
    if (created.firstResource !== undefined) {
      const made = await rt.handle({ projectId: created.root, method: "createResource", params: { path: created.firstResource } });
      if ("error" in made) warnings.push(`プロジェクトは作りましたが、最初のファイル ${created.firstResource} は作れませんでした: ${made.error.message}`);
      else resource = created.firstResource;
    }
    markOpened(created.root);
    const recentProjects = await rememberProject(created.root);
    return Response.json(
      { result: { project: created.root, configFile: created.configFile, ...(resource !== undefined ? { resource } : {}), warnings, recentProjects } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json({ error: toErrorBody(err) });
  }
}
