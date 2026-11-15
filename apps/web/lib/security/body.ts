/*
 * 要求の本文を、上限を超えたら読むのをやめながら読む（全部ためてから測らない）。JSON 以外は 415。
 */

export const LIMITS = {
  auth: 16 * 1024,
  admin: 64 * 1024,
  rpc: 1024 * 1024,
  /** 本文を運ぶメソッドだけ大きくする。 */
  rpcText: 8 * 1024 * 1024,
} as const;

/** 大きな本文を受け付ける RPC のメソッド。 */
export const LARGE_RPC_METHODS: ReadonlySet<string> = new Set(["setText", "setCells", "updateProjectSettings"]);

export function rpcLimit(method: string): number {
  return LARGE_RPC_METHODS.has(method) ? LIMITS.rpcText : LIMITS.rpc;
}

export type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 413 | 415; message: string };

export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const base = value.split(";")[0]!.trim().toLowerCase();
  return base === "application/json" || (base.startsWith("application/") && base.endsWith("+json"));
}

export async function readJsonBody(request: Request, limit: number): Promise<BodyResult> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return { ok: false, status: 415, message: "本文は application/json にしてください。" };
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return tooLarge(limit);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        // 残りは読まない
        await reader.cancel().catch(() => {});
        return tooLarge(limit);
      }
      chunks.push(value);
    }
  }
  const text = new TextDecoder("utf-8").decode(concat(chunks, size));
  if (text.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, message: "要求の本文が JSON ではありません。" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, status: 400, message: "要求の本文は JSON のオブジェクトにしてください。" };
  return { ok: true, value: parsed as Record<string, unknown> };
}

function tooLarge(limit: number): BodyResult {
  return { ok: false, status: 413, message: `要求の本文が大きすぎます（上限 ${Math.round(limit / 1024)} KB）。` };
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
