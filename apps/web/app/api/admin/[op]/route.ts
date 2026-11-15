import { errorResponse, getRuntime, guard, toErrorBody } from "@/lib/server/host";
import { LIMITS, readJsonBody } from "@/lib/security/body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * POST /api/admin/<op>  利用者と権限の管理（Web モード、管理者だけ）。権限の確認はサービス層の admin が行う。
 * op: projects | listUsers | createUser | updateUser | setPassword | deleteUser | listMemberships | setMembership | removeMembership
 */
export async function POST(request: Request, ctx: { params: Promise<{ op: string }> }): Promise<Response> {
  // 認証とオリジンを、本文を読む前に確かめる
  const g = await guard(request, "state");
  if (!g.ok) return g.response;
  if (!g.web || !g.user) return errorResponse({ code: "not-found", message: "利用者の管理は Web モードだけでできます。" });
  const actor = g.user;
  const { op } = await ctx.params;
  const parsed = await readJsonBody(request, LIMITS.admin);
  if (!parsed.ok) return errorResponse({ code: "invalid", message: parsed.message }, parsed.status);
  const body = parsed.value;
  try {
    const rt = await getRuntime();
    const a = rt.admin;
    let result: unknown;
    switch (op) {
      case "projects":
        await a.listUsers(actor); // 管理者かどうかの確認を兼ねる
        result = (rt.config?.projects ?? []).map((p) => ({ id: p.id, name: p.name }));
        break;
      case "listUsers":
        result = await a.listUsers(actor);
        break;
      case "createUser": {
        const input = (body["input"] ?? {}) as Record<string, unknown>;
        result = await a.createUser(actor, {
          name: str(input["name"]) ?? "",
          ...(str(input["password"]) ? { password: str(input["password"])! } : {}),
          ...(str(input["displayName"]) ? { displayName: str(input["displayName"])! } : {}),
          ...(input["admin"] === true ? { admin: true } : {}),
        });
        break;
      }
      case "updateUser": {
        const patch = (body["patch"] ?? {}) as Record<string, unknown>;
        result = await a.updateUser(actor, str(body["name"]) ?? "", {
          ...(str(patch["displayName"]) !== undefined ? { displayName: str(patch["displayName"])! } : {}),
          ...(typeof patch["admin"] === "boolean" ? { admin: patch["admin"] } : {}),
          ...(typeof patch["disabled"] === "boolean" ? { disabled: patch["disabled"] } : {}),
        });
        break;
      }
      case "setPassword":
        await a.setPassword(actor, str(body["name"]) ?? "", str(body["password"]) ?? "");
        result = null;
        break;
      case "deleteUser":
        await a.deleteUser(actor, str(body["name"]) ?? "");
        result = null;
        break;
      case "listMemberships":
        result = await a.listMemberships(actor, str(body["projectId"]));
        break;
      case "setMembership": {
        const role = str(body["role"]);
        // そのプロジェクトで定義された役割かどうかは、サービス層が確かめる。
        if (role === undefined || role === "") return errorResponse({ code: "invalid", message: "役割（role）を指定してください。" });
        const languages = Array.isArray(body["languages"]) ? (body["languages"] as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
        result = await a.setMembership(actor, str(body["projectId"]) ?? "", str(body["user"]) ?? "", { role, ...(languages && languages.length ? { languages } : {}) });
        break;
      }
      case "removeMembership":
        await a.removeMembership(actor, str(body["projectId"]) ?? "", str(body["user"]) ?? "");
        result = null;
        break;
      default:
        return errorResponse({ code: "not-found", message: `管理の操作 "${op}" はありません。` });
    }
    return Response.json({ result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(toErrorBody(err));
  }
}
