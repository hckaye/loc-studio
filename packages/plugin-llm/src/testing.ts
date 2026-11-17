/**
 * テスト用の補助（公開 API ではない。index.ts からは出さない）。
 * 外部の HTTP（host.fetch）だけを差し替え、生成器そのものは本物を動かす。
 */
import type { GeneratorCellContext, GeneratorRunContext, PluginHost, PluginSettingsReader } from "@loc-studio/sdk";

export interface Call {
  url: string;
  init: RequestInit;
}

/** chat/completions の応答の本文。 */
export function okBody(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ choices: [{ message: { content } }], ...extra });
}

export const reply = (content: string, extra?: Record<string, unknown>) => async () => new Response(okBody(content, extra), { status: 200 });

/** 生成器の run に渡す値。fetch の呼び出しを calls に記録する。 */
export function makeCtx(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  options: Record<string, unknown>,
  secrets: Record<string, string> = {},
  signal?: AbortSignal,
): { ctx: GeneratorRunContext; calls: Call[] } {
  const calls: Call[] = [];
  const fakeFetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return fetchImpl(String(url), init);
  }) as unknown as typeof fetch;
  const host = { fetch: fakeFetch } as unknown as PluginHost;
  const ctx: GeneratorRunContext = {
    options,
    secrets: { get: (name) => secrets[name] },
    host,
    ...(signal ? { signal } : {}),
  };
  return { ctx, calls };
}

/** プラグインの設定の値を読む窓口（設定ファイルの値を、そのまま渡す）。 */
export const settingsOf = (values: Record<string, string | number | boolean> = {}): PluginSettingsReader => ({ get: (key) => values[key] });

/** 生成器の input に渡す値（言語と、言語ごとの本文）。 */
export const cellOf = (language: { id: string; basedOn?: string } | undefined, texts: Record<string, string>, options: Record<string, unknown> = {}): GeneratorCellContext =>
  ({
    entry: {},
    column: {},
    ...(language ? { language } : {}),
    row: { text: (id: string) => texts[id], get: () => undefined },
    options,
  }) as unknown as GeneratorCellContext;

export function headerOf(call: Call | undefined, name: string): string | undefined {
  return (call?.init.headers as Record<string, string> | undefined)?.[name];
}

/** 送った要求の本文（JSON）。 */
export const bodyOf = (call: Call | undefined): { model: string; temperature: number; messages: { role: string; content: string }[] } =>
  JSON.parse(String(call?.init.body)) as { model: string; temperature: number; messages: { role: string; content: string }[] };

/** 失敗するはずの呼び出しの例外を受け取る（成功したら、それと分かる例外にする）。 */
export const failure = (p: Promise<unknown>): Promise<Error> => p.then(() => new Error("失敗するはずの呼び出しが成功しました"), (e: unknown) => e as Error);
