/**
 * llm.translate: その言語の本文を、LLM で別の言語に翻訳する生成器（逆翻訳や機械翻訳の列に使う）。
 * 訳し先とプロンプトは、プラグインの設定（設定の画面の「プラグインの設定」）で変えられ、生成器の options で使う場所ごとに上書きできる。
 */
import type { Generator, GeneratorCellContext, GeneratorInput, GeneratorOutput, Options, PluginSettingsReader } from "@loc-studio/sdk";
import { chat, itemsById, parseJsonReply, resolveChatOptions, textOption } from "./chat.js";

export const TRANSLATE_ID = "llm.translate";

/** 訳し先の言語の名前の既定（プラグインの設定 translateTo の既定）。 */
export const DEFAULT_TRANSLATE_TO = "日本語";

/** プロンプトの既定（プラグインの設定 translatePrompt の既定）。{to} は訳し先の言語の名前に置き換わる。 */
export const DEFAULT_TRANSLATE_PROMPT = [
  "ユーザーが送る文章を{to}に翻訳してください。",
  "{name} のようなプレースホルダーや <b> のようなタグは、一切変更せずそのまま残してください。",
  "翻訳結果だけを出力し、説明や引用符、前置きは付けないでください。",
].join("\n");

/** 複数の文章をまとめて送るときに、プロンプトの後ろに足す、入出力の形の指示。 */
const BATCH_FORMAT = [
  "ユーザーは、複数の文章を JSON の配列（[{\"id\": 1, \"text\": \"...\"}, ...]）で送ります。",
  "それぞれの text を、上の指示に従って翻訳してください。",
  "返事は、JSON の配列（[{\"id\": 1, \"translation\": \"...\"}, ...]）だけにしてください。id は入力と同じ値にし、すべての id を 1 回ずつ含めてください。",
].join("\n");

interface Resolved {
  to: string;
  prompt: string;
  instructions: string | undefined;
}

export function createTranslateGenerator(settings: PluginSettingsReader): Generator {
  /** 訳し先とプロンプト。生成器の options が、プラグインの設定より優先される。 */
  const resolve = (options: Options): Resolved => ({
    to: textOption(options["to"]) ?? textOption(settings.get("translateTo")) ?? DEFAULT_TRANSLATE_TO,
    prompt: textOption(options["prompt"]) ?? textOption(settings.get("translatePrompt")) ?? DEFAULT_TRANSLATE_PROMPT,
    instructions: textOption(options["instructions"]),
  });

  const systemPrompt = (r: Resolved, batch: boolean): string => {
    const lines = [r.prompt.split("{to}").join(r.to)];
    if (r.instructions) lines.push(r.instructions);
    if (batch) lines.push(BATCH_FORMAT);
    return lines.join("\n");
  };

  return {
    id: TRANSLATE_ID,
    version: "1",
    // 1 回の要求に入れる文章の数の既定。実行のときに、生成のバッチサイズで変えられる。
    batchSize: 1,
    concurrency: 2,
    retries: 2,

    cacheParams(options) {
      // 接続キーは含めない。結果が変わる値だけを鍵にする。
      const r = resolve(options);
      return {
        endpoint: options["endpoint"],
        model: options["model"],
        to: r.to,
        instructions: options["instructions"],
        temperature: options["temperature"],
        // 既定のプロンプトのままなら鍵に入れない（プロンプトを設定に出す前の結果を、そのまま使えるように）。
        ...(r.prompt !== DEFAULT_TRANSLATE_PROMPT ? { prompt: r.prompt } : {}),
      };
    },

    input(ctx: GeneratorCellContext): GeneratorInput | null {
      if (!ctx.language) return null;
      const text = ctx.row.text(ctx.language.id);
      if (text === undefined || text.trim() === "") return null;
      return { text, language: ctx.language.id };
    },

    async run(inputs, ctx) {
      const opts = resolveChatOptions(TRANSLATE_ID, ctx.options);
      const r = resolve(ctx.options);
      ctx.signal?.throwIfAborted();
      if (inputs.length === 0) return [];
      if (inputs.length === 1) {
        // 1 件のときは、本文をそのまま送り、返事をそのまま翻訳結果にする。
        const reply = await chat(TRANSLATE_ID, opts, [{ role: "system", content: systemPrompt(r, false) }, { role: "user", content: inputs[0]!.text }], ctx);
        return [{ value: reply.content, meta: reply.meta }];
      }
      // 複数件は、id を付けた JSON の配列で 1 回に送る。
      const user = JSON.stringify(inputs.map((input, i) => ({ id: i + 1, text: input.text })));
      const reply = await chat(TRANSLATE_ID, opts, [{ role: "system", content: systemPrompt(r, true) }, { role: "user", content: user }], ctx);
      const items = itemsById(TRANSLATE_ID, parseJsonReply(TRANSLATE_ID, reply.content), inputs.length);
      return items.map((item, i): GeneratorOutput => {
        const translation = item["translation"];
        if (typeof translation !== "string" || translation.trim() === "") {
          throw new Error(`${TRANSLATE_ID}: モデルの返事の id ${i + 1} に翻訳（translation）がありません（${inputs.length} 件をまとめて送りました）。`);
        }
        return { value: translation.trim(), meta: { ...reply.meta, batch: inputs.length } };
      });
    },
  };
}
