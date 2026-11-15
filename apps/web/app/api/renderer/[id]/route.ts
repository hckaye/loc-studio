import { getRuntime, guard, isOpened, resolveProjectId } from "@/lib/server/host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound(): Response {
  return new Response("見つかりません", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * GET /api/renderer/<id>?project=…&h=<hash>  プラグインの独自描画のモジュール（ブラウザが import する）。
 * - 認証（ローカルは起動の合言葉、Web はセッション）と、同じオリジン（Sec-Fetch-Site: same-origin。ないときは認証のクッキー）が必要。
 *   別のサイトの <script> から読み込めない。
 * - この起動ですでに開いたプロジェクトだけ（GET でワークスペースを開いたり、状態を変えたりしない）。
 * - 登録されたファイルだけをサービス層が返す。h がいまのハッシュと同じなら長くキャッシュしてよい。
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const g = await guard(request, "module");
  if (!g.ok) return g.response;
  const { id } = await ctx.params;
  const url = new URL(request.url);
  try {
    const projectId = await resolveProjectId(url.searchParams.get("project") ?? undefined);
    if (!isOpened(projectId)) return notFound();
    const rt = await getRuntime();
    const mod = await rt.rendererModule({ projectId, id, ...(g.user ? { user: g.user } : {}) });
    if (!mod) return notFound();
    const fresh = url.searchParams.get("h") === mod.hash;
    return new Response(mod.source, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": fresh ? "private, max-age=31536000, immutable" : "no-store",
        ETag: `"${mod.hash}"`,
      },
    });
  } catch {
    return notFound();
  }
}
