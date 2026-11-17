import { describe, expect, it } from "vitest";
import llmPluginDefault, { createTranslateGenerator, DEFAULT_TRANSLATE_PROMPT, llmPlugin } from "./index.js";
import { bodyOf, cellOf, failure, headerOf, makeCtx, reply, settingsOf } from "./testing.js";

const baseOptions = {
  endpoint: "https://litellm.example.internal/v1",
  model: "gpt-x",
  to: "日本語",
};

/** 設定ファイルに値がない状態（プラグインの設定は、宣言の default を返す）。 */
const defaults = { translateTo: "日本語", translatePrompt: DEFAULT_TRANSLATE_PROMPT };
const gen = createTranslateGenerator(settingsOf(defaults));

describe("plugin", () => {
  it("生成器 2 つ、列 2 つ、設定 4 つを公開する", () => {
    const plugin = llmPlugin({ settings: settingsOf(defaults) });
    expect(plugin.name).toBe("@loc-studio/plugin-llm");
    expect(plugin.generators?.map((g) => g.id)).toEqual(["llm.translate", "llm.evaluate"]);
    expect(plugin.columns?.map((c) => [c.id, c.kind, c.scope, c.generator])).toEqual([
      ["llm.translation", "generated", "language", "llm.translate"],
      ["llm.evaluation", "generated", "language", "llm.evaluate"],
    ]);
    // 評価の列の選択肢は、判定の 3 つの値（並びは、良い順）。
    expect(plugin.columns?.[1]?.type).toEqual({
      enum: [
        { value: "OK", label: "OK", color: "green" },
        { value: "WARNING", label: "WARNING", color: "amber" },
        { value: "NG", label: "NG", color: "red" },
      ],
    });
    expect(plugin.settings?.map((s) => [s.key, s.type, s.multiline === true])).toEqual([
      ["translateTo", "string", false],
      ["translatePrompt", "string", true],
      ["evaluateSource", "string", false],
      ["evaluatePrompt", "string", true],
    ]);
    expect(plugin.settings?.[0]?.default).toBe("日本語");
    expect(plugin.settings?.[1]?.default).toBe(DEFAULT_TRANSLATE_PROMPT);
    expect(plugin.settings?.[2]?.default).toBeUndefined();
    expect(llmPluginDefault).toBe(llmPlugin);
  });

  it("既定は 1 件ずつ送る（バッチサイズ 1、並列 2、やり直し 2 回）", () => {
    expect(gen.id).toBe("llm.translate");
    expect(gen.version).toBe("1");
    expect([gen.batchSize, gen.concurrency, gen.retries]).toEqual([1, 2, 2]);
  });
});

describe("cacheParams", () => {
  it("接続キーを含めず、既定のプロンプトは鍵に入れない", () => {
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

  it("訳し先は options、なければプラグインの設定から決まり、鍵に入る", () => {
    const { to: _to, ...noTo } = baseOptions;
    expect(gen.cacheParams(noTo)["to"]).toBe("日本語");
    expect(createTranslateGenerator(settingsOf({ ...defaults, translateTo: "英語" })).cacheParams(noTo)["to"]).toBe("英語");
    expect(createTranslateGenerator(settingsOf({ ...defaults, translateTo: "英語" })).cacheParams({ ...noTo, to: "韓国語" })["to"]).toBe("韓国語");
  });

  it("プロンプトを変えると、鍵が変わる（設定でも options でも）", () => {
    const bySetting = createTranslateGenerator(settingsOf({ ...defaults, translatePrompt: "{to}に訳す。" }));
    expect(bySetting.cacheParams(baseOptions)["prompt"]).toBe("{to}に訳す。");
    expect(gen.cacheParams({ ...baseOptions, prompt: "別の指示" })["prompt"]).toBe("別の指示");
    // options のプロンプトが、設定のプロンプトより優先される。
    expect(bySetting.cacheParams({ ...baseOptions, prompt: "別の指示" })["prompt"]).toBe("別の指示");
  });
});

describe("input", () => {
  it("セルの言語の本文を返す", () => {
    expect(gen.input(cellOf({ id: "zh" }, { zh: " 你好 {name}\n" }))).toEqual({ text: " 你好 {name}\n", language: "zh" });
  });
  it("言語なし・空・空白のみは null", () => {
    expect(gen.input(cellOf(undefined, { zh: "x" }))).toBeNull();
    expect(gen.input(cellOf({ id: "zh" }, {}))).toBeNull();
    expect(gen.input(cellOf({ id: "zh" }, { zh: "" }))).toBeNull();
    expect(gen.input(cellOf({ id: "zh" }, { zh: " \n\t　" }))).toBeNull();
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
    const body = bodyOf(calls[0]);
    expect(body.model).toBe("gpt-x");
    expect(body.temperature).toBe(0.2);
    // 既定のプロンプトの {to} を、訳し先に置き換えたものが system になる。
    expect(body.messages).toEqual([
      { role: "system", content: DEFAULT_TRANSLATE_PROMPT.replace("{to}", "日本語") },
      { role: "user", content: "你好 {name}" },
    ]);
    expect(body.messages[0]?.content).toContain("ユーザーが送る文章を日本語に翻訳してください。");
  });

  it("末尾のスラッシュを許し、鍵がなければ Authorization を送らず、温度は既定 0", async () => {
    const { ctx, calls } = makeCtx(reply("x"), { ...baseOptions, endpoint: "https://h.example/v1/" });
    await gen.run([{ text: "a" }], ctx);
    expect(calls[0]?.url).toBe("https://h.example/v1/chat/completions");
    expect(headerOf(calls[0], "Authorization")).toBeUndefined();
    expect(bodyOf(calls[0]).temperature).toBe(0);
  });

  it("apiKeySecret で秘密の名前を変えられ、instructions を system に足す", async () => {
    const { ctx, calls } = makeCtx(reply("x"), { ...baseOptions, apiKeySecret: "other", instructions: "口語で訳すこと" }, { "llm.apiKey": "wrong", other: "right" });
    await gen.run([{ text: "a" }], ctx);
    expect(headerOf(calls[0], "Authorization")).toBe("Bearer right");
    expect(bodyOf(calls[0]).messages[0]?.content).toBe(`${DEFAULT_TRANSLATE_PROMPT.replace("{to}", "日本語")}\n口語で訳すこと`);
  });

  it("プラグインの設定のプロンプトと訳し先を使う（{to} は、すべて置き換える）", async () => {
    const custom = createTranslateGenerator(settingsOf({ translateTo: "英語", translatePrompt: "{to}に訳す。{to}以外の言葉は混ぜない。" }));
    const { to: _to, ...noTo } = baseOptions;
    const { ctx, calls } = makeCtx(reply("x"), noTo);
    await custom.run([{ text: "a" }], ctx);
    expect(bodyOf(calls[0]).messages[0]?.content).toBe("英語に訳す。英語以外の言葉は混ぜない。");
  });

  it("options の prompt と to は、プラグインの設定より優先される", async () => {
    const custom = createTranslateGenerator(settingsOf({ translateTo: "英語", translatePrompt: "設定の指示（{to}）" }));
    const { ctx, calls } = makeCtx(reply("x"), { ...baseOptions, to: "韓国語", prompt: "options の指示（{to}）" });
    await custom.run([{ text: "a" }], ctx);
    expect(bodyOf(calls[0]).messages[0]?.content).toBe("options の指示（韓国語）");
  });
});

describe("run: 出力", () => {
  it("内容を trim し、応答の model と usage を meta に入れる", async () => {
    const usage = { prompt_tokens: 3, completion_tokens: 4 };
    const { ctx } = makeCtx(reply("  訳文\n", { model: "gpt-x-2025", usage }), baseOptions);
    const out = await gen.run([{ text: "a" }], ctx);
    expect(out).toEqual([{ value: "訳文", meta: { model: "gpt-x-2025", usage } }]);
  });

  it("入力が空なら何も送らない", async () => {
    const { ctx, calls } = makeCtx(reply("x"), baseOptions);
    expect(await gen.run([], ctx)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("run: 複数の入力をまとめて送る", () => {
  it("id を付けた JSON の配列で 1 回に送り、id ごとの翻訳を入力の順に返す", async () => {
    const { ctx, calls } = makeCtx(
      // 返事の順が入力と違っても、id で対応づける。コードの囲みも読む。
      reply('```json\n[{"id": 3, "translation": "訳C"}, {"id": 1, "translation": " 訳A "}, {"id": 2, "translation": "訳B"}]\n```'),
      baseOptions,
    );
    const out = await gen.run([{ text: "A" }, { text: "B" }, { text: "C" }], ctx);
    expect(out.map((o) => o.value)).toEqual(["訳A", "訳B", "訳C"]);
    expect(out[0]?.meta).toEqual({ model: "gpt-x", batch: 3 });
    expect(calls).toHaveLength(1);
    const body = bodyOf(calls[0]);
    expect(JSON.parse(body.messages[1]!.content)).toEqual([
      { id: 1, text: "A" },
      { id: 2, text: "B" },
      { id: 3, text: "C" },
    ]);
    // system は、プロンプトのあとに、入出力の形の指示が続く。
    expect(body.messages[0]?.content.startsWith(DEFAULT_TRANSLATE_PROMPT.replace("{to}", "日本語"))).toBe(true);
    expect(body.messages[0]?.content).toContain('[{"id": 1, "translation": "..."}, ...]');
  });

  it("返事に足りない id があると、その id を含むエラー（まとまり全体が失敗）", async () => {
    const { ctx } = makeCtx(reply('[{"id": 1, "translation": "訳A"}]'), baseOptions);
    const err = await failure(gen.run([{ text: "A" }, { text: "B" }], ctx));
    expect(err.message).toContain("id 2 の結果がありません");
    expect(err.message).toContain("2 件をまとめて送りました");
  });

  it("同じ id が 2 回ある、翻訳が空、配列でない、JSON でない返事はエラー", async () => {
    const cases: [string, string][] = [
      ['[{"id": 1, "translation": "a"}, {"id": 1, "translation": "b"}]', "id 1 が 2 回あります"],
      ['[{"id": 1, "translation": "a"}, {"id": 2, "translation": " "}]', "id 2 に翻訳（translation）がありません"],
      ['{"id": 1, "translation": "a"}', "JSON の配列ではありません"],
      ["訳A と 訳B です", "JSON として読めませんでした"],
    ];
    for (const [content, message] of cases) {
      const { ctx } = makeCtx(reply(content), baseOptions);
      expect((await failure(gen.run([{ text: "A" }, { text: "B" }], ctx))).message).toContain(message);
    }
  });
});

describe("run: エラー", () => {
  for (const missing of ["endpoint", "model"]) {
    it(`${missing} がないと、その名前と直し方を含むエラー`, async () => {
      const options: Record<string, unknown> = { ...baseOptions };
      delete options[missing];
      const { ctx, calls } = makeCtx(reply("x"), options);
      const err = await failure(gen.run([{ text: "a" }], ctx));
      expect(err.message).toContain(`llm.translate: オプション "${missing}" が設定されていません。`);
      expect(err.message).toContain("プロジェクト設定の generators");
      expect(calls).toHaveLength(0);
    });
  }

  it("2xx 以外はステータスと本文の先頭 300 文字、鍵は含めない", async () => {
    const body = "E".repeat(500);
    const { ctx } = makeCtx(async () => new Response(body, { status: 429 }), baseOptions, { "llm.apiKey": "sk-secret" });
    const err = await failure(gen.run([{ text: "a" }], ctx));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("429");
    expect(err.message).toContain("E".repeat(300));
    expect(err.message).not.toContain("E".repeat(301));
    expect(err.message).not.toContain("sk-secret");
  });

  it("内容のない応答はエラー（鍵は含めない）", async () => {
    const cases: [string, string][] = [
      [JSON.stringify({ choices: [] }), "応答に結果 (choices[0].message.content) がありません"],
      [JSON.stringify({ choices: [{ message: { content: "  " } }] }), "応答に結果 (choices[0].message.content) がありません"],
      ["not json", "の応答が JSON ではありません: not json"],
    ];
    for (const [raw, message] of cases) {
      const { ctx } = makeCtx(async () => new Response(raw, { status: 200 }), baseOptions, { "llm.apiKey": "sk-secret" });
      const err = await failure(gen.run([{ text: "a" }], ctx));
      expect(err.message).toContain(message);
      expect(err.message).not.toContain("sk-secret");
    }
  });

  it("接続の失敗は原因つきのエラーにする", async () => {
    const { ctx } = makeCtx(
      async () => {
        throw new Error("ECONNREFUSED");
      },
      baseOptions,
      { "llm.apiKey": "sk-secret" },
    );
    const err = await failure(gen.run([{ text: "a" }], ctx));
    expect(err.message).toContain("https://litellm.example.internal/v1/chat/completions への接続に失敗しました: ECONNREFUSED");
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
    await expect(gen.run([{ text: "a" }], ctx)).rejects.toThrow("20ms 以内に応答しませんでした");
  });
});

describe("run: 中断", () => {
  it("signal が中断済みなら送らない", async () => {
    const ac = new AbortController();
    ac.abort(new Error("cancelled"));
    const { ctx, calls } = makeCtx(reply("x"), baseOptions, {}, ac.signal);
    await expect(gen.run([{ text: "a" }], ctx)).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("リクエスト中の中断が fetch に伝わる", async () => {
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
    await expect(gen.run([{ text: "a" }], ctx)).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(1);
  });
});
