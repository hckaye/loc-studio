import type {
  Generator,
  GeneratorCellContext,
  GeneratorInput,
  GeneratorOutput,
  GeneratorRunContext,
  Options,
} from "@loc-studio/sdk";

const DEFAULT_API_KEY_SECRET = "llm.apiKey";
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TIMEOUT_MS = 60000;
/** エラーに含める応答本文の最大文字数。長い HTML のエラーページなどを避ける。 */
const BODY_PREVIEW_LENGTH = 300;

interface ResolvedOptions {
  endpoint: string;
  model: string;
  to: string;
  instructions?: string;
  apiKeySecret: string;
  temperature: number;
  timeoutMs: number;
}

function requireString(options: Options, name: string): string {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`llm.translate: オプション "${name}" が設定されていません。`);
  }
  return value;
}

function optionalNumber(options: Options, name: string, fallback: number): number {
  const value = options[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolveOptions(options: Options): ResolvedOptions {
  const instructions = options["instructions"];
  const apiKeySecret = options["apiKeySecret"];
  return {
    endpoint: requireString(options, "endpoint"),
    model: requireString(options, "model"),
    to: requireString(options, "to"),
    ...(typeof instructions === "string" && instructions.trim() !== "" ? { instructions } : {}),
    apiKeySecret: typeof apiKeySecret === "string" && apiKeySecret !== "" ? apiKeySecret : DEFAULT_API_KEY_SECRET,
    temperature: optionalNumber(options, "temperature", DEFAULT_TEMPERATURE),
    timeoutMs: optionalNumber(options, "timeoutMs", DEFAULT_TIMEOUT_MS),
  };
}

function buildSystemPrompt(to: string, instructions: string | undefined): string {
  const lines = [
    `ユーザーが送る文章を${to}に翻訳してください。`,
    "{name} のようなプレースホルダーや <b> のようなタグは、一切変更せずそのまま残してください。",
    "翻訳結果だけを出力し、説明や引用符、前置きは付けないでください。",
  ];
  if (instructions) lines.push(instructions);
  return lines.join("\n");
}

function completionsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, "")}/chat/completions`;
}

interface ChatResponse {
  model?: unknown;
  usage?: unknown;
  choices?: { message?: { content?: unknown } }[];
}

async function translateOne(
  input: GeneratorInput,
  opts: ResolvedOptions,
  apiKey: string | undefined,
  ctx: GeneratorRunContext,
): Promise<GeneratorOutput> {
  const url = completionsUrl(opts.endpoint);
  // 呼び出し側の中断とタイムアウトのどちらでも止める。
  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await ctx.host.fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: opts.model,
        temperature: opts.temperature,
        messages: [
          { role: "system", content: buildSystemPrompt(opts.to, opts.instructions) },
          { role: "user", content: input.text },
        ],
      }),
      signal,
    });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    if (timeoutSignal.aborted) {
      throw new Error(`llm.translate: ${url} が ${opts.timeoutMs}ms 以内に応答しませんでした。`);
    }
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`llm.translate: ${url} への接続に失敗しました: ${reason}`);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `llm.translate: ${url} がエラーを返しました (HTTP ${response.status}): ${bodyText.slice(0, BODY_PREVIEW_LENGTH)}`,
    );
  }

  let json: ChatResponse;
  try {
    json = JSON.parse(bodyText) as ChatResponse;
  } catch {
    throw new Error(`llm.translate: ${url} の応答が JSON ではありません: ${bodyText.slice(0, BODY_PREVIEW_LENGTH)}`);
  }
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(`llm.translate: ${url} の応答に翻訳結果 (choices[0].message.content) がありません。`);
  }

  const meta: Record<string, unknown> = {
    model: typeof json.model === "string" && json.model !== "" ? json.model : opts.model,
  };
  if (json.usage !== undefined) meta["usage"] = json.usage;
  return { value: content.trim(), meta };
}

export const llmTranslateGenerator: Generator = {
  id: "llm.translate",
  version: "1",
  batchSize: 8,
  concurrency: 2,
  retries: 2,

  cacheParams(options) {
    // 接続キーは含めない。結果が変わる値だけを鍵にする。
    return {
      endpoint: options["endpoint"],
      model: options["model"],
      to: options["to"],
      instructions: options["instructions"],
      temperature: options["temperature"],
    };
  },

  input(ctx: GeneratorCellContext): GeneratorInput | null {
    if (!ctx.language) return null;
    const text = ctx.row.text(ctx.language.id);
    if (text === undefined || text.trim() === "") return null;
    return { text, language: ctx.language.id };
  },

  async run(inputs, ctx) {
    const opts = resolveOptions(ctx.options);
    const apiKey = ctx.secrets.get(opts.apiKeySecret) || undefined;
    const outputs: GeneratorOutput[] = [];
    // 順序を保ち、サーバーへの負荷を抑えるため 1 件ずつ送る。
    for (const input of inputs) {
      ctx.signal?.throwIfAborted();
      outputs.push(await translateOne(input, opts, apiKey, ctx));
    }
    return outputs;
  },
};
