import { errorResponse, guard, toErrorBody } from "@/lib/server/host";
import { loadServer } from "@/lib/server/runtime";
import { LIMITS, readJsonBody } from "@/lib/security/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/session/inspect { path, encoding? } → 新しいプロジェクトを作る前に、フォルダを確かめる
 * （あるか、すでにプロジェクトか、CSV / TSV とその見出し）。ローカルモードだけ。何も書かない。
 */
export async function POST(request: Request): Promise<Response> {
  const g = await guard(request, "state");
  if (!g.ok) return g.response;
  if (g.web) return errorResponse({ code: "forbidden", message: "Web モードでは、サーバーのフォルダは確かめられません。" }, 403);
  const body = await readJsonBody(request, LIMITS.auth);
  if (!body.ok) return errorResponse({ code: "invalid", message: body.message }, body.status);
  try {
    const { inspectProjectFolder } = await loadServer();
    const folder = body.value["path"];
    const encoding = body.value["encoding"];
    const result = await inspectProjectFolder({ root: typeof folder === "string" ? folder : "", ...(typeof encoding === "string" ? { encoding } : {}) });
    return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ error: toErrorBody(err) });
  }
}
