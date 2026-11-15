import { rememberProject } from "@/lib/server/session";
import { errorResponse, getRuntime, guard, markOpened, resolveProjectId, toErrorBody } from "@/lib/server/host";
import { LIMITS, readJsonBody } from "@/lib/security/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/session/open { project } → 開けることを確かめ、最近の一覧に覚える（ローカルモードだけ。利用者の操作から呼ぶ）。 */
export async function POST(request: Request): Promise<Response> {
  const g = await guard(request, "state");
  if (!g.ok) return g.response;
  if (g.web) return errorResponse({ code: "forbidden", message: "Web モードでは任意のフォルダは開けません。" }, 403);
  const body = await readJsonBody(request, LIMITS.auth);
  if (!body.ok) return errorResponse({ code: "invalid", message: body.message }, body.status);
  const project = body.value["project"];
  if (typeof project !== "string" || project.trim() === "") {
    return errorResponse({ code: "invalid", message: "project にフォルダのパスを指定してください。" }, 400);
  }
  try {
    const root = await resolveProjectId(project);
    const rt = await getRuntime();
    const res = await rt.handle({ projectId: root, method: "info" });
    if ("error" in res) return Response.json({ error: res.error });
    markOpened(root);
    const recentProjects = await rememberProject(root);
    return Response.json({ result: { project: root, name: (res.result as { name: string }).name, recentProjects } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: toErrorBody(err) });
  }
}
