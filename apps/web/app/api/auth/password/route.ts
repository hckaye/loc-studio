import { clientAddressOf, errorResponse, getRuntime, guard, sessionCookie, toErrorBody } from "@/lib/server/host";
import { LIMITS, readJsonBody } from "@/lib/security/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/password { oldPassword, newPassword } → 自分のパスワードを変える。
 * 変えるとその人のセッションはすべて無効になる（いまのクッキーも）。新しいパスワードでログインし直したクッキーに置き換える。
 */
export async function POST(request: Request): Promise<Response> {
  const g = await guard(request, "state");
  if (!g.ok) return g.response;
  if (!g.web || !g.user) return errorResponse({ code: "not-found", message: "ローカルモードではパスワードはありません。" });
  const body = await readJsonBody(request, LIMITS.auth);
  if (!body.ok) return errorResponse({ code: "invalid", message: body.message }, body.status);
  const oldPassword = body.value["oldPassword"];
  const newPassword = body.value["newPassword"];
  if (typeof oldPassword !== "string" || typeof newPassword !== "string") {
    return errorResponse({ code: "invalid", message: "いまのパスワードと新しいパスワードを入力してください。" });
  }
  try {
    const rt = await getRuntime();
    if (!rt.auth) throw new Error("認証の準備ができていません。");
    if (rt.auth.config.mode !== "password") return errorResponse({ code: "invalid", message: "このサーバーではパスワードを使いません。" });
    const clientAddress = await clientAddressOf(request);
    await rt.auth.changePassword({ name: g.user.name, oldPassword, newPassword, clientAddress });
    const res = await rt.auth.login({ name: g.user.name, password: newPassword, clientAddress });
    return Response.json({ result: null }, { headers: { "Set-Cookie": sessionCookie(request, res.token, res.expiresAt, rt.auth.config.sessionMaxHours), "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(toErrorBody(err));
  }
}
