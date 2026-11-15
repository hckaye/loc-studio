export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** 要求ごとの待ち時間 */
  requestTimeoutMs?: number;
  /** true を返したらすぐ諦める（サーバーのプロセスが終了したときなど） */
  shouldAbort?: () => string | undefined;
  /** 成功とみなす 2xx 以外のステータス（401 など） */
  okStatuses?: readonly number[];
  fetchImpl?: typeof fetch;
}

/** url が 2xx を返すまで繰り返し確認する。失敗したら最後の原因を含めて投げる。 */
export async function waitForReady(url: string, options: WaitOptions = {}): Promise<void> {
  const { timeoutMs = 60000, intervalMs = 250, requestTimeoutMs = 3000, shouldAbort, okStatuses = [], fetchImpl = fetch } = options;
  const deadline = Date.now() + timeoutMs;
  let last = "応答なし";
  for (;;) {
    const abort = shouldAbort?.();
    if (abort !== undefined) throw new Error(`サーバーが起動前に終了しました: ${abort}`);
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs), cache: "no-store" });
      await res.body?.cancel();
      if (res.ok || okStatuses.includes(res.status)) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) throw new Error(`サーバーが ${Math.round(timeoutMs / 1000)} 秒以内に応答しませんでした（${url}）: ${last}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
