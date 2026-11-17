/**
 * llm.evaluate: その言語の本文（訳文）を、原文と比べて、LLM に OK / WARNING / NG の 3 つで判定させる生成器。
 * 判定は生成列の値になり、理由は値に添える説明（comment）になる。比べる原文の言語とプロンプトは、プラグインの設定で変えられ、
 * 生成器の options で使う場所ごとに上書きできる。
 */
import type { Generator, GeneratorCellContext, GeneratorInput, GeneratorOutput, Options, PluginSettingsReader } from "@loc-studio/sdk";
import { chat, itemsById, parseJsonReply, resolveChatOptions, textOption } from "./chat.js";

export const EVALUATE_ID = "llm.evaluate";

/** 判定の値。OK: 合っている。WARNING: 合っているか怪しい。NG: 合っていない。 */
export const VERDICTS = ["OK", "WARNING", "NG"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** プロンプトの既定（プラグインの設定 evaluatePrompt の既定）。返事の形の指示は、この後ろに足す。 */
export const DEFAULT_EVALUATE_PROMPT = [
  "あなたは、ゲームのローカライズの品質を確かめるレビュアーです。",
  "ユーザーが送る原文（source）と訳文（translation）を比べ、訳文が原文の意味を正しく伝えているかを判定してください。",
  "判定は、次の 3 つのどれかです。",
  "- OK: 意味が正しく伝わっている。",
  "- WARNING: 合っているか怪しい（意味がずれているかもしれない、あいまい、抜けや余分があるかもしれない）。",
  "- NG: 意味が違う、大事な内容が抜けている、訳されていない。",
  "{name} のようなプレースホルダーや <b> のようなタグが、原文と同じだけ訳文に残っているかも確かめてください。",
  "判定の理由は、日本語で、1 文で書いてください。",
].join("\n");

const SINGLE_FORMAT = [
  "ユーザーは、JSON（{\"source\": \"原文\", \"translation\": \"訳文\"}）を送ります。",
  "返事は、JSON（{\"verdict\": \"OK\" か \"WARNING\" か \"NG\", \"reason\": \"判定の理由\"}）だけにしてください。説明や前置きは付けないでください。",
].join("\n");

const BATCH_FORMAT = [
  "ユーザーは、複数の組を JSON の配列（[{\"id\": 1, \"source\": \"原文\", \"translation\": \"訳文\"}, ...]）で送ります。それぞれの組を、別々に判定してください。",
  "返事は、JSON の配列（[{\"id\": 1, \"verdict\": \"OK\" か \"WARNING\" か \"NG\", \"reason\": \"判定の理由\"}, ...]）だけにしてください。id は入力と同じ値にし、すべての id を 1 回ずつ含めてください。",
].join("\n");

interface Resolved {
  prompt: string;
  instructions: string | undefined;
}

/** 返事の 1 件を、生成の結果にする。判定が 3 つのどれでもなければ例外（やり直す）。 */
function toOutput(item: unknown, meta: Record<string, unknown>, where: string): GeneratorOutput {
  const obj = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
  const verdict = String(obj["verdict"] ?? "").trim().toUpperCase();
  if (!(VERDICTS as readonly string[]).includes(verdict)) {
    throw new Error(`${EVALUATE_ID}: モデルの返事${where}の判定（verdict）が ${VERDICTS.join(" / ")} のどれでもありません: ${JSON.stringify(obj["verdict"] ?? null)}`);
  }
  const out: GeneratorOutput = { value: verdict, meta };
  const reason = obj["reason"];
  if (typeof reason === "string" && reason.trim() !== "") out.comment = reason.trim();
  return out;
}

export function createEvaluateGenerator(settings: PluginSettingsReader): Generator {
  /** 比べる原文の言語の ID。options の source、プラグインの設定 evaluateSource、その言語の基にする言語（basedOn）の順。 */
  const sourceOf = (ctx: GeneratorCellContext): string | undefined =>
    textOption(ctx.options["source"]) ?? textOption(settings.get("evaluateSource")) ?? ctx.language?.basedOn;

  const resolve = (options: Options): Resolved => ({
    prompt: textOption(options["prompt"]) ?? textOption(settings.get("evaluatePrompt")) ?? DEFAULT_EVALUATE_PROMPT,
    instructions: textOption(options["instructions"]),
  });

  const systemPrompt = (r: Resolved, batch: boolean): string => {
    const lines = [r.prompt];
    if (r.instructions) lines.push(r.instructions);
    lines.push(batch ? BATCH_FORMAT : SINGLE_FORMAT);
    return lines.join("\n");
  };

  return {
    id: EVALUATE_ID,
    version: "1",
    // 1 回の要求に入れる組の数の既定。実行のときに、生成のバッチサイズで変えられる。
    batchSize: 1,
    concurrency: 2,
    retries: 2,

    cacheParams(options) {
      // 接続キーは含めない。結果が変わる値だけを鍵にする（比べる原文は、入力のほうに入る）。
      const r = resolve(options);
      return {
        endpoint: options["endpoint"],
        model: options["model"],
        prompt: r.prompt,
        instructions: options["instructions"],
        temperature: options["temperature"],
      };
    },

    input(ctx: GeneratorCellContext): GeneratorInput | null {
      if (!ctx.language) return null;
      const sourceLanguage = sourceOf(ctx);
      // 原文の言語が決まらない言語と、原文の言語そのものは、評価しない。
      if (sourceLanguage === undefined || sourceLanguage === ctx.language.id) return null;
      const text = ctx.row.text(ctx.language.id);
      const source = ctx.row.text(sourceLanguage);
      if (text === undefined || text.trim() === "" || source === undefined || source.trim() === "") return null;
      // 原文も入力に入れる。原文か訳文のどちらかが変わると、結果は「変更あり」になる。
      return { text, language: ctx.language.id, extra: { source, sourceLanguage } };
    },

    async run(inputs, ctx) {
      const opts = resolveChatOptions(EVALUATE_ID, ctx.options);
      const r = resolve(ctx.options);
      ctx.signal?.throwIfAborted();
      if (inputs.length === 0) return [];
      const pair = (input: GeneratorInput) => ({ source: String(input.extra?.["source"] ?? ""), translation: input.text });
      if (inputs.length === 1) {
        const reply = await chat(EVALUATE_ID, opts, [{ role: "system", content: systemPrompt(r, false) }, { role: "user", content: JSON.stringify(pair(inputs[0]!)) }], ctx);
        return [toOutput(parseJsonReply(EVALUATE_ID, reply.content), reply.meta, "")];
      }
      const user = JSON.stringify(inputs.map((input, i) => ({ id: i + 1, ...pair(input) })));
      const reply = await chat(EVALUATE_ID, opts, [{ role: "system", content: systemPrompt(r, true) }, { role: "user", content: user }], ctx);
      const items = itemsById(EVALUATE_ID, parseJsonReply(EVALUATE_ID, reply.content), inputs.length);
      return items.map((item, i) => toOutput(item, { ...reply.meta, batch: inputs.length }, `の id ${i + 1} `));
    },
  };
}
