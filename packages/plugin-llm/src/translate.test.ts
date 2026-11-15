import { describe, expect, it } from "vitest";
import type { GeneratorCellContext, GeneratorRunContext, PluginHost } from "@loc-studio/sdk";
import llmPluginDefault, { llmPlugin, llmTranslateGenerator as gen } from "./index.js";

interface Call {
  url: string;
  init: RequestInit;
}

function okBody(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ choices: [{ message: { content } }], ...extra });
}

function makeCtx(
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

const baseOptions = {
  endpoint: "https://litellm.example.internal/v1",
  model: "gpt-x",
  to: "日本語",
};
const reply = (content: string, extra?: Record<string, unknown>) => async () =>
  new Response(okBody(content, extra), { status: 200 });

function headerOf(call: Call | undefined, name: string): string | undefined {
  return (call?.init.headers as Record<string, string> | undefined)?.[name];
}

describe("plugin", () => {
  it("生成器を 1 つ公開する", () => {
    expect(llmPlugin.name).toBe("@loc-studio/plugin-llm");
    expect(llmPlugin.generators).toEqual([gen]);
    expect(llmPluginDefault).toBe(llmPlugin);
    expect(gen.id).toBe("llm.translate");
    expect(gen.version).toBe("1");
    expect([gen.batchSize, gen.concurrency, gen.retries]).toEqual([8, 2, 2]);
  });
});

describe("cacheParams", () => {
  it("接続キーを含めない", () => {
    const params = gen.cacheParams({
      ...baseOptions,
      instructions: "丁寧に",
      temperature: 0.3,
      apiKeySecret: "my.secret",
      timeoutMs: 10,
    });
    expect(params).toEqual({
      endpoint: baseOptions.endpoint,
      model: "gpt-x",
      to: "日本語",
      instructions: "丁寧に",
      temperature: 0.3,
    });
    expect(JSON.stringify(params)).not.toContain("my.secret");
  });
});

describe("input", () => {
  const cell = (language: { id: string } | undefined, texts: Record<string, string>): GeneratorCellContext =>
    ({
      entry: {},
      column: {},
      ...(language ? { language } : {}),
      row: { text: (id: string) => texts[id], get: () => undefined },
      options: {},
    }) as unknown as GeneratorCellContext;

  it("セルの言語の本文を返す", () => {
    expect(gen.input(cell({ id: "zh" }, { zh: " 你好 {name}\n" }))).toEqual({ text: " 你好 {name}\n", language: "zh" });
  });
  it("言語なし・空・空白のみは null", () => {
    expect(gen.input(cell(undefined, { zh: "x" }))).toBeNull();
    expect(gen.input(cell({ id: "zh" }, {}))).toBeNull();
    expect(gen.input(cell({ id: "zh" }, { zh: "" }))).toBeNull();
    expect(gen.input(cell({ id: "zh" }, { zh: " \n\t　" }))).toBeNull();
  });
});

describe("run: リクエスト", () => {
  it("URL・メソッド・ヘッダー・本文（鍵あり）", async () => {
    const { ctx, calls } = makeCtx(reply("こんにちは"), { ...baseOptions, temperature: 0.2 }, { "llm.apiKey": "sk-secret" });
    const out = await gen.run([{ text: "你好 {name}", language: "zh" }], ctx);
    expect(out).toEqual([{ value: "こんにちは", meta: { model: "gpt-x" } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://litellm.example.internal/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(headerOf(calls[0], "Authorization")).toBe("Bearer sk-secret");
    expect(headerOf(calls[0], "Content-Type")).toBe("application/json");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe("gpt-x");
    expect(body.temperature).toBe(0.2);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("日本語");
    expect(body.messages[0].content).toContain("{name}");
    expect(body.messages[1]).toEqual({ role: "user", content: "你好 {name}" });
  });

  it("末尾のスラッシュを許し、鍵がなければ Authorization を送らず、温度は既定 0", async () => {
    const { ctx, calls } = makeCtx(reply("x"), { ...baseOptions, endpoint: "https://h.example/v1/" });
    await gen.run([{ text: "a" }], ctx);
    expect(calls[0]?.url).toBe("https://h.example/v1/chat/completions");
    expect(headerOf(calls[0], "Authorization")).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init.body)).temperature).toBe(0);
  });

  it("apiKeySecret で秘密の名前を変えられ、instructions を system に足す", async () => {
    const { ctx, calls } = makeCtx(
      reply("x"),
      { ...baseOptions, apiKeySecret: "other", instructions: "口語で訳すこと" },
      { "llm.apiKey": "wrong", other: "right" },
    );
    await gen.run([{ text: "a" }], ctx);
    expect(headerOf(calls[0], "Authorization")).toBe("Bearer right");
    const system = JSON.parse(String(calls[0]?.init.body)).messages[0].content as string;
    expect(system).toContain("口語で訳すこと");
    expect(system.indexOf("口語で訳すこと")).toBeGreaterThan(system.indexOf("日本語"));
  });
});

describe("run: 出力", () => {
  it("内容を trim し、応答の model と usage を meta に入れる", async () => {
    const usage = { prompt_tokens: 3, completion_tokens: 4 };
    const { ctx } = makeCtx(reply("  訳文\n", { model: "gpt-x-2025", usage }), baseOptions);
    const out = await gen.run([{ text: "a" }], ctx);
    expect(out).toEqual([{ value: "訳文", meta: { model: "gpt-x-2025", usage } }]);
  });

  it("複数の入力は同じ数の出力を順番どおりに返す", async () => {
    let n = 0;
    const { ctx, calls } = makeCtx(async (_u, init) => {
      const text = JSON.parse(String(init.body)).messages[1].content as string;
      n += 1;
      return new Response(okBody(`訳:${text}:${n}`), { status: 200 });
    }, baseOptions);
    const out = await gen.run([{ text: "A" }, { text: "B" }, { text: "C" }], ctx);
    expect(out.map((o) => o.value)).toEqual(["訳:A:1", "訳:B:2", "訳:C:3"]);
    expect(calls).toHaveLength(3);
  });

  it("入力が空なら何も送らない", async () => {
    const { ctx, calls } = makeCtx(reply("x"), baseOptions);
    expect(await gen.run([], ctx)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("run: エラー", () => {
  for (const missing of ["endpoint", "model", "to"]) {
    it(`${missing} がないと、その名前を含むエラー`, async () => {
      const options: Record<string, unknown> = { ...baseOptions };
      delete options[missing];
      const { ctx, calls } = makeCtx(reply("x"), options);
      await expect(gen.run([{ text: "a" }], ctx)).rejects.toThrow(`"${missing}"`);
      expect(calls).toHaveLength(0);
    });
  }

  it("2xx 以外はステータスと本文の先頭 300 文字、鍵は含めない", async () => {
    const body = "E".repeat(500);
    const { ctx } = makeCtx(async () => new Response(body, { status: 429 }), baseOptions, { "llm.apiKey": "sk-secret" });
    const err = await gen.run([{ text: "a" }], ctx).then(() => new Error("失敗するはずの呼び出しが成功しました"), (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("429");
    expect(err.message).toContain("E".repeat(300));
    expect(err.message).not.toContain("E".repeat(301));
    expect(err.message).not.toContain("sk-secret");
  });

  it("内容のない応答はエラー（鍵は含めない）", async () => {
    for (const raw of [JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { content: "  " } }] }), "not json"]) {
      const { ctx } = makeCtx(async () => new Response(raw, { status: 200 }), baseOptions, { "llm.apiKey": "sk-secret" });
      const err = await gen.run([{ text: "a" }], ctx).then(() => new Error("失敗するはずの呼び出しが成功しました"), (e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain("sk-secret");
    }
  });

  it("接続の失敗は原因つきのエラーにする", async () => {
    const { ctx } = makeCtx(async () => {
      throw new Error("ECONNREFUSED");
    }, baseOptions, { "llm.apiKey": "sk-secret" });
    const err = await gen.run([{ text: "a" }], ctx).then(() => new Error("失敗するはずの呼び出しが成功しました"), (e: unknown) => e as Error);
    expect(err.message).toContain("ECONNREFUSED");
    expect(err.message).not.toContain("sk-secret");
  });

  it("タイムアウトで中断される", async () => {
    const { ctx } = makeCtx(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(init.signal?.reason));
        }),
      { ...baseOptions, timeoutMs: 20 },
    );
    await expect(gen.run([{ text: "a" }], ctx)).rejects.toThrow("20ms");
  });
});

describe("run: 中断", () => {
  it("signal が中断済みなら送らない", async () => {
    const ac = new AbortController();
    ac.abort();
    const { ctx, calls } = makeCtx(reply("x"), baseOptions, {}, ac.signal);
    await expect(gen.run([{ text: "a" }], ctx)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("リクエスト中の中断が fetch に伝わり、以降の入力は送らない", async () => {
    const ac = new AbortController();
    const { ctx, calls } = makeCtx(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(init.signal?.reason));
          queueMicrotask(() => ac.abort(new Error("cancelled")));
        }),
      baseOptions,
      {},
      ac.signal,
    );
    await expect(gen.run([{ text: "a" }, { text: "b" }], ctx)).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(1);
  });
});
