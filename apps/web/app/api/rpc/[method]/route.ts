import { errorResponse, getRuntime, guard, markOpened, resolveProjectId, statusFor, toErrorBody } from "@/lib/server/host";
import { loadServer } from "@/lib/server/runtime";
import { readJsonBody, rpcLimit } from "@/lib/security/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

/**
 * POST /api/rpc/<method>  本文 { project?: string; params?: unknown }
 * 順に: 認証とオリジン（本文を読む前）→ 知らないメソッドは 404（ワークスペースに触らない）→ 本文の大きさと形 → 呼び出し。
 * ローカルモード: 成功も失敗も HTTP 200 で { result } / { error }（画面はどちらも本文の code を見る）。
 * Web モード: 失敗は code に応じた HTTP の状態（401、403、409 untrusted、429 など）。
 * 管理者でない利用者への値とエラーの伏せは、サービス層（runtime.handle / dispatch）が行う。
 */
export async function POST(request: Request, ctx: { params: Promise<{ method: string }> }): Promise<Response> {
  const g = await guard(request, "state");
  if (!g.ok) return g.response;
  const { method } = await ctx.params;
  const { WORKSPACE_METHODS } = await loadServer();
  if (!(WORKSPACE_METHODS as readonly string[]).includes(method)) {
    return errorResponse({ code: "not-found", message: `メソッド "${method.slice(0, 60)}" はありません。` }, 404);
  }
  const body = await readJsonBody(request, rpcLimit(method));
  if (!body.ok) return errorResponse({ code: "invalid", message: body.message }, body.status);
  const { project, params } = body.value as { project?: unknown; params?: unknown };
  if (project !== undefined && project !== null && typeof project !== "string") {
    return errorResponse({ code: "invalid", message: "project は文字列で指定してください。" }, 400);
  }
  try {
    const rt = await getRuntime();
    const projectId = await resolveProjectId(typeof project === "string" ? project : undefined);
    const response = await rt.handle({ projectId, method, params, ...(g.user ? { user: g.user } : {}) });
    if (!("error" in response) || response.error.code !== "not-found") markOpened(projectId);
    if ("error" in response && g.web) return errorResponse(response.error, statusFor(response.error.code));
    return Response.json(response, { headers: noStore });
  } catch (err) {
    const error = toErrorBody(err);
    return g.web ? errorResponse(error) : Response.json({ error }, { headers: noStore });
  }
}
