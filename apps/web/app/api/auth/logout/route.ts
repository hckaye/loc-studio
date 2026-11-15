import { clearSessionCookie, errorResponse, getRuntime, guard, sessionToken, toErrorBody } from "@/lib/server/host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout → セッションを無効にしてクッキーを消す。本文は読まない。 */
export async function POST(request: Request): Promise<Response> {
  // 切れたセッションでもクッキーは消せるよう、認証は求めない（オリジンは確かめる）
  const g = await guard(request, "state", { anonymous: true });
  if (!g.ok) return g.response;
  if (!g.web) return errorResponse({ code: "not-found", message: "ローカルモードではログアウトはありません。" });
  try {
    const token = sessionToken(request);
    const rt = await getRuntime();
    if (token) await rt.auth?.logout(token);
    return Response.json({ result: null }, { headers: { "Set-Cookie": clearSessionCookie(request), "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(toErrorBody(err));
  }
}
