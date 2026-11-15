import { isDesktop, readSession } from "@/lib/server/session";
import { defaultProjectRoot, errorResponse, guard, toErrorBody } from "@/lib/server/host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/session → { mode, defaultProject?, recentProjects, desktop }。ローカルモードは起動の合言葉が必要。 */
export async function GET(request: Request): Promise<Response> {
  const g = await guard(request, "read", { anonymous: true });
  if (!g.ok) return g.response;
  try {
    if (g.web) return Response.json({ mode: "web", recentProjects: [], desktop: false }, { headers: { "Cache-Control": "no-store" } });
    const session = await readSession();
    const defaultProject = defaultProjectRoot();
    return Response.json(
      { mode: "local", ...(defaultProject ? { defaultProject } : {}), recentProjects: session.recentProjects, desktop: isDesktop() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(toErrorBody(err));
  }
}
