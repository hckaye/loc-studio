import { clientAddressOf, errorResponse, getRuntime, guard, sessionCookie, toErrorBody } from "@/lib/server/host";
import { LIMITS, readJsonBody } from "@/lib/security/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/login { name, password } → セッションのクッキー。パスワードやトークンはログに出さない。 */
export async function POST(request: Request): Promise<Response> {
  const g = await guard(request, "state", { anonymous: true });
  if (!g.ok) return g.response;
  if (!g.web) return errorResponse({ code: "not-found", message: "ローカルモードではログインはありません。" });
  const body = await readJsonBody(request, LIMITS.auth);
  if (!body.ok) return errorResponse({ code: "invalid", message: body.message }, body.status);
  const name = body.value["name"];
  const password = body.value["password"];
  if (typeof name !== "string" || typeof password !== "string") {
    return errorResponse({ code: "invalid", message: "名前とパスワードを入力してください。" });
  }
  try {
    const rt = await getRuntime();
    if (!rt.auth) throw new Error("認証の準備ができていません。");
    if (rt.auth.config.mode !== "password") return errorResponse({ code: "invalid", message: "このサーバーは前段のプロキシで認証します。" });
    const res = await rt.auth.login({ name, password, clientAddress: await clientAddressOf(request) });
    return Response.json(
      { result: { user: res.user, expiresAt: res.expiresAt } },
      { headers: { "Set-Cookie": sessionCookie(request, res.token, res.expiresAt, rt.auth.config.sessionMaxHours), "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(toErrorBody(err));
  }
}
