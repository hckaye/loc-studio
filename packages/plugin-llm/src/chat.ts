/**
 * OpenAI 互換の API（LiteLLM など）の chat/completions を呼ぶ。同梱の生成器（llm.translate、llm.evaluate）が共通に使う。
 */
import type { GeneratorRunContext, Options } from "@loc-studio/sdk";

const DEFAULT_API_KEY_SECRET = "llm.apiKey";
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 60000;
/** エラーに含める応答本文の最大文字数。長い HTML のエラーページなどを避ける。 */
const BODY_PREVIEW_LENGTH = 300;

export interface ChatOptions {
  endpoint: string;
  model: string;
  apiKeySecret: string;
  temperature: number;
  timeoutMs: number;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatReply {
  /** choices[0].message.content（前後の空白を除いたもの）。 */
  content: string;
  /** 結果に残す情報（応答のモデル名と usage）。 */
  meta: Record<string, unknown>;
}

/** 空でない文字列だけを値として扱う。 */
export const textOption = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

function requireString(id: string, options: Options, name: string): string {
  const value = textOption(options[name]);
  if (value === undefined) {
    throw new Error(
      `${id}: オプション "${name}" が設定されていません。プロジェクト設定の generators に { "<名前>": { "use": "${id}", "options": { "endpoint": "<OpenAI 互換の API の URL>", "model": "<モデル名>" } } } を書き、生成列の generator にその名前を書いてください。`,
    );
  }
  return value;
}

function optionalNumber(options: Options, name: string, fallback: number): number {
  const value = options[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 接続に使う options（endpoint、model、apiKeySecret、temperature、timeoutMs）を読む。endpoint と model は必須。 */
export function resolveChatOptions(id: string, options: Options): ChatOptions {
  return {
    endpoint: requireString(id, options, "endpoint"),
    model: requireString(id, options, "model"),
    apiKeySecret: textOption(options["apiKeySecret"]) ?? DEFAULT_API_KEY_SECRET,
    temperature: optionalNumber(options, "temperature", DEFAULT_TEMPERATURE),
    timeoutMs: optionalNumber(options, "timeoutMs", DEFAULT_TIMEOUT_MS),
  };
}

const completionsUrl = (endpoint: string): string => `${endpoint.replace(/\/+$/, "")}/chat/completions`;

interface ChatResponse {
  model?: unknown;
  usage?: unknown;
  choices?: { message?: { content?: unknown } }[];
}

/** 1 回の要求を送り、応答の本文を返す。失敗は、生成器の ID と接続先を添えた例外にする。 */
export async function chat(id: string, opts: ChatOptions, messages: ChatMessage[], ctx: GeneratorRunContext): Promise<ChatReply> {
  const url = completionsUrl(opts.endpoint);
  // 呼び出し側の中断とタイムアウトのどちらでも止める。
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = ctx.secrets.get(opts.apiKeySecret) || undefined;
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await ctx.host.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: opts.model, temperature: opts.temperature, messages }),
      signal,
    });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    if (timeoutSignal.aborted) {
      throw new Error(`${id}: ${url} が ${opts.timeoutMs}ms 以内に応答しませんでした。`);
    }
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`${id}: ${url} への接続に失敗しました: ${reason}`);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`${id}: ${url} がエラーを返しました (HTTP ${response.status}): ${bodyText.slice(0, BODY_PREVIEW_LENGTH)}`);
  }

  let json: ChatResponse;
  try {
    json = JSON.parse(bodyText) as ChatResponse;
  } catch {
    throw new Error(`${id}: ${url} の応答が JSON ではありません: ${bodyText.slice(0, BODY_PREVIEW_LENGTH)}`);
  }
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(`${id}: ${url} の応答に結果 (choices[0].message.content) がありません。`);
  }

  const meta: Record<string, unknown> = {
    model: typeof json.model === "string" && json.model !== "" ? json.model : opts.model,
  };
  if (json.usage !== undefined) meta["usage"] = json.usage;
  return { content: content.trim(), meta };
}

/**
 * モデルの返事から JSON を読む。コードの囲み（```json ... ```）と、前後に付いた文章は除く。
 * 読めなければ、返事の先頭を添えた例外にする。
 */
export function parseJsonReply(id: string, content: string): unknown {
  let text = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1] ?? "";
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 前後に文章が付いているときは、最初のかっこから最後のかっこまでを読む。
    const start = text.search(/[[{]/);
    const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        // 下の例外にする。
      }
    }
  }
  throw new Error(`${id}: モデルの返事を JSON として読めませんでした: ${content.slice(0, BODY_PREVIEW_LENGTH)}`);
}

/**
 * まとめて送った要求（id 付きの配列）の返事を、id ごとの要素にする。
 * 配列でない、id が足りない、同じ id が 2 回あるときは例外（まとまり全体をやり直す）。
 */
export function itemsById(id: string, reply: unknown, count: number): Record<string, unknown>[] {
  if (!Array.isArray(reply)) throw new Error(`${id}: ${count} 件をまとめて送りましたが、モデルの返事が JSON の配列ではありません。`);
  const byId = new Map<number, Record<string, unknown>>();
  for (const item of reply as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const n = Number((item as Record<string, unknown>)["id"]);
    if (!Number.isInteger(n)) continue;
    if (byId.has(n)) throw new Error(`${id}: モデルの返事に id ${n} が 2 回あります（${count} 件をまとめて送りました）。`);
    byId.set(n, item as Record<string, unknown>);
  }
  const out: Record<string, unknown>[] = [];
  for (let i = 1; i <= count; i++) {
    const item = byId.get(i);
    if (!item) throw new Error(`${id}: モデルの返事に id ${i} の結果がありません（${count} 件をまとめて送りました）。まとめて送る件数を減らすと、安定することがあります。`);
    out.push(item);
  }
  return out;
}
