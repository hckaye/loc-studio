import { describe, expect, it } from "vitest";
import { createEvaluateGenerator, DEFAULT_EVALUATE_PROMPT } from "./index.js";
import { bodyOf, cellOf, failure, headerOf, makeCtx, reply, settingsOf } from "./testing.js";

const baseOptions = { endpoint: "https://litellm.example.internal/v1", model: "gpt-x" };

/** 設定ファイルに値がない状態（evaluateSource は既定なし、プロンプトは宣言の default）。 */
const defaults = { evaluatePrompt: DEFAULT_EVALUATE_PROMPT };
const gen = createEvaluateGenerator(settingsOf(defaults));

const en = { id: "en", basedOn: "ja" };
const texts = { ja: "こんにちは、{name}。", en: "Hello, {name}.", zh: "你好，{name}。" };

describe("llm.evaluate: 形", () => {
  it("既定は 1 件ずつ送る（バッチサイズ 1、並列 2、やり直し 2 回）", () => {
    expect(gen.id).toBe("llm.evaluate");
    expect(gen.version).toBe("1");
    expect([gen.batchSize, gen.concurrency, gen.retries]).toEqual([1, 2, 2]);
  });
});

describe("llm.evaluate: input", () => {
  it("訳文と、基にする言語の原文を入力にする", () => {
    expect(gen.input(cellOf(en, texts))).toEqual({ text: "Hello, {name}.", language: "en", extra: { source: "こんにちは、{name}。", sourceLanguage: "ja" } });
  });

  it("比べる原文の言語は、プラグインの設定で変えられ、options の source が優先される", () => {
    const bySetting = createEvaluateGenerator(settingsOf({ ...defaults, evaluateSource: "zh" }));
    expect(bySetting.input(cellOf(en, texts))?.extra).toEqual({ source: "你好，{name}。", sourceLanguage: "zh" });
    expect(bySetting.input(cellOf(en, texts, { source: "ja" }))?.extra).toEqual({ source: "こんにちは、{name}。", sourceLanguage: "ja" });
    // 基にする言語のない言語でも、設定で原文の言語を決めれば評価する。
    expect(bySetting.input(cellOf({ id: "en" }, texts))?.extra).toEqual({ source: "你好，{name}。", sourceLanguage: "zh" });
  });

  it("原文の言語が決まらない、原文の言語そのもの、原文か訳文が空のセルは null", () => {
    expect(gen.input(cellOf(undefined, texts))).toBeNull();
    expect(gen.input(cellOf({ id: "en" }, texts))).toBeNull();
    expect(gen.input(cellOf({ id: "ja", basedOn: "ja" }, texts))).toBeNull();
    expect(createEvaluateGenerator(settingsOf({ ...defaults, evaluateSource: "ja" })).input(cellOf({ id: "ja" }, texts))).toBeNull();
    expect(gen.input(cellOf(en, { ja: "こんにちは", en: " " }))).toBeNull();
    expect(gen.input(cellOf(en, { ja: "", en: "Hello" }))).toBeNull();
    expect(gen.input(cellOf(en, { en: "Hello" }))).toBeNull();
  });
});

describe("llm.evaluate: cacheParams", () => {
  it("接続キーを含めず、プロンプトを鍵に入れる", () => {
    const params = gen.cacheParams({ ...baseOptions, instructions: "敬語かどうかも見る", temperature: 0.1, apiKeySecret: "my.secret", timeoutMs: 5 });
    expect(params).toEqual({ endpoint: baseOptions.endpoint, model: "gpt-x", prompt: DEFAULT_EVALUATE_PROMPT, instructions: "敬語かどうかも見る", temperature: 0.1 });
    expect(JSON.stringify(params)).not.toContain("my.secret");
  });

  it("プロンプトは options、なければプラグインの設定から決まる", () => {
    const bySetting = createEvaluateGenerator(settingsOf({ evaluatePrompt: "設定の基準" }));
    expect(bySetting.cacheParams(baseOptions)["prompt"]).toBe("設定の基準");
    expect(bySetting.cacheParams({ ...baseOptions, prompt: "options の基準" })["prompt"]).toBe("options の基準");
  });
});

describe("llm.evaluate: run（1 件）", () => {
  const input = { text: "Hello, {name}.", language: "en", extra: { source: "こんにちは、{name}。", sourceLanguage: "ja" } };

  it("原文と訳文を JSON で送り、判定を値、理由を説明として返す", async () => {
    const { ctx, calls } = makeCtx(reply('{"verdict": "OK", "reason": "意味が合っています。"}'), baseOptions, { "llm.apiKey": "sk-secret" });
    const out = await gen.run([input], ctx);
    expect(out).toEqual([{ value: "OK", comment: "意味が合っています。", meta: { model: "gpt-x" } }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://litellm.example.internal/v1/chat/completions");
    expect(headerOf(calls[0], "Authorization")).toBe("Bearer sk-secret");
    const body = bodyOf(calls[0]);
    expect(JSON.parse(body.messages[1]!.content)).toEqual({ source: "こんにちは、{name}。", translation: "Hello, {name}." });
    // system は、判定の基準のプロンプトのあとに、返事の形の指示が続く。
    expect(body.messages[0]?.content.startsWith(`${DEFAULT_EVALUATE_PROMPT}\n`)).toBe(true);
    expect(body.messages[0]?.content).toContain('{"verdict": "OK" か "WARNING" か "NG", "reason": "判定の理由"}');
  });

  it("判定は大文字にそろえ、3 つの値のどれでも受け取る。理由がなければ、説明を付けない", async () => {
    for (const [content, value] of [
      ['{"verdict": "ng", "reason": " 主語が逆です。 "}', "NG"],
      ['```json\n{"verdict": "Warning", "reason": "あいまいです。"}\n```', "WARNING"],
      ['判定は次のとおりです。 {"verdict": "OK"}', "OK"],
    ] as const) {
      const { ctx } = makeCtx(reply(content), baseOptions);
      const [out] = await gen.run([input], ctx);
      expect(out?.value).toBe(value);
      expect(out?.comment).toBe(value === "NG" ? "主語が逆です。" : value === "WARNING" ? "あいまいです。" : undefined);
    }
  });

  it("3 つの値のどれでもない判定、JSON でない返事はエラー", async () => {
    const cases: [string, string][] = [
      ['{"verdict": "GOOD", "reason": "x"}', '判定（verdict）が OK / WARNING / NG のどれでもありません: "GOOD"'],
      ['{"reason": "x"}', "判定（verdict）が OK / WARNING / NG のどれでもありません: null"],
      ["問題ありません", "モデルの返事を JSON として読めませんでした: 問題ありません"],
    ];
    for (const [content, message] of cases) {
      const { ctx } = makeCtx(reply(content), baseOptions);
      expect((await failure(gen.run([input], ctx))).message).toContain(message);
    }
  });

  it("プラグインの設定のプロンプトと、options の instructions を使う", async () => {
    const custom = createEvaluateGenerator(settingsOf({ evaluatePrompt: "敬語が崩れていないかだけを見る。" }));
    const { ctx, calls } = makeCtx(reply('{"verdict": "OK"}'), { ...baseOptions, instructions: "固有名詞は訳さない。" });
    await custom.run([input], ctx);
    const system = bodyOf(calls[0]).messages[0]!.content;
    expect(system.startsWith("敬語が崩れていないかだけを見る。\n固有名詞は訳さない。\n")).toBe(true);
    expect(system).not.toContain("ゲームのローカライズの品質を確かめるレビュアー");
  });

  it("endpoint がないと、その名前と直し方を含むエラー", async () => {
    const { ctx, calls } = makeCtx(reply("x"), { model: "gpt-x" });
    const err = await failure(gen.run([input], ctx));
    expect(err.message).toContain('llm.evaluate: オプション "endpoint" が設定されていません。');
    expect(calls).toHaveLength(0);
  });
});

describe("llm.evaluate: run（まとめて送る）", () => {
  const inputs = [
    { text: "Hello", language: "en", extra: { source: "こんにちは", sourceLanguage: "ja" } },
    { text: "Good night", language: "en", extra: { source: "おはよう", sourceLanguage: "ja" } },
  ];

  it("id を付けた組の配列で 1 回に送り、id ごとの判定を入力の順に返す", async () => {
    const { ctx, calls } = makeCtx(reply('[{"id": 2, "verdict": "NG", "reason": "朝のあいさつが夜になっています。"}, {"id": 1, "verdict": "OK", "reason": ""}]'), baseOptions);
    const out = await gen.run(inputs, ctx);
    expect(out).toEqual([
      { value: "OK", meta: { model: "gpt-x", batch: 2 } },
      { value: "NG", comment: "朝のあいさつが夜になっています。", meta: { model: "gpt-x", batch: 2 } },
    ]);
    expect(calls).toHaveLength(1);
    const body = bodyOf(calls[0]);
    expect(JSON.parse(body.messages[1]!.content)).toEqual([
      { id: 1, source: "こんにちは", translation: "Hello" },
      { id: 2, source: "おはよう", translation: "Good night" },
    ]);
    expect(body.messages[0]?.content).toContain('[{"id": 1, "verdict": "OK" か "WARNING" か "NG", "reason": "判定の理由"}, ...]');
  });

  it("返事に足りない id や、値の合わない判定があると、まとまり全体がエラー", async () => {
    const missing = makeCtx(reply('[{"id": 1, "verdict": "OK"}]'), baseOptions);
    expect((await failure(gen.run(inputs, missing.ctx))).message).toContain("id 2 の結果がありません");
    const bad = makeCtx(reply('[{"id": 1, "verdict": "OK"}, {"id": 2, "verdict": "?"}]'), baseOptions);
    expect((await failure(gen.run(inputs, bad.ctx))).message).toContain('の id 2 の判定（verdict）が OK / WARNING / NG のどれでもありません: "?"');
  });
});
