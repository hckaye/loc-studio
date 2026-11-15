import { currentUser, errorResponse, getRuntime, guard, toErrorBody } from "@/lib/server/host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/me → { mode, user, admin, authMode, projects }。ログインしていなければ 401（data.authMode つき）。 */
export async function GET(request: Request): Promise<Response> {
  const g = await guard(request, "read", { anonymous: true });
  if (!g.ok) return g.response;
  if (!g.web) return Response.json({ result: { mode: "local" } }, { headers: { "Cache-Control": "no-store" } });
  try {
    const rt = await getRuntime();
    const user = await currentUser(request);
    if (!user) return errorResponse({ code: "unauthorized", message: "ログインしてください。", data: { authMode: rt.auth?.config.mode ?? "password" } });
    const projects = await rt.projects(user);
    return Response.json(
      { result: { mode: "web", user, admin: user.admin, authMode: rt.auth?.config.mode ?? "password", projects } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(toErrorBody(err));
  }
}
