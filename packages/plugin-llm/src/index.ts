import type { Plugin, PluginSetupContext } from "@loc-studio/sdk";
import { createEvaluateGenerator, DEFAULT_EVALUATE_PROMPT, EVALUATE_ID } from "./evaluate.js";
import { createTranslateGenerator, DEFAULT_TRANSLATE_PROMPT, DEFAULT_TRANSLATE_TO, TRANSLATE_ID } from "./translate.js";

export * from "./chat.js";
export * from "./evaluate.js";
export * from "./translate.js";

export const LLM_PLUGIN_NAME = "@loc-studio/plugin-llm";

/**
 * LLM（OpenAI 互換の API）を使う同梱のプラグイン。
 * - 生成器 llm.translate: 本文を別の言語に翻訳する。
 * - 生成器 llm.evaluate: 訳文を原文と比べて、OK / WARNING / NG で判定する。
 * - 列 llm.translation / llm.evaluation: 上の生成器を使う生成列（設定の columns に use で足せる）。
 * プロンプトなどは、設定（settings）で宣言し、設定の画面の「プラグインの設定」で変えられる。
 * 接続先（endpoint、model）は、プロジェクト設定の generators の options に書く（外部につなぐ値なので、信頼の確認の対象）。
 */
export function llmPlugin(setup: PluginSetupContext): Plugin {
  return {
    name: LLM_PLUGIN_NAME,
    version: "0.2.0",
    settings: [
      {
        key: "translateTo",
        label: "機械翻訳: 訳し先の言語",
        description: "プロンプトの {to} に入る、言語の名前です。生成器の options に to があれば、そちらを使います。",
        type: "string",
        default: DEFAULT_TRANSLATE_TO,
      },
      {
        key: "translatePrompt",
        label: "機械翻訳: プロンプト",
        description: "モデルに渡す指示です。{to} は訳し先の言語の名前に置き換わります。変えると、生成済みの結果は「変更あり」になり、生成し直せます。",
        type: "string",
        multiline: true,
        default: DEFAULT_TRANSLATE_PROMPT,
      },
      {
        key: "evaluateSource",
        label: "翻訳の評価: 比べる原文の言語",
        description: "原文として比べる言語の ID です。空なら、評価する言語の「基にする言語」（basedOn）の本文と比べます。",
        type: "string",
      },
      {
        key: "evaluatePrompt",
        label: "翻訳の評価: プロンプト",
        description: "モデルに渡す、判定の基準の指示です。返事の形（OK / WARNING / NG と理由の JSON）の指示は、この後ろに自動で足します。変えると、生成済みの結果は「変更あり」になります。",
        type: "string",
        multiline: true,
        default: DEFAULT_EVALUATE_PROMPT,
      },
    ],
    generators: [createTranslateGenerator(setup.settings), createEvaluateGenerator(setup.settings)],
    columns: [
      { id: "llm.translation", kind: "generated", scope: "language", label: "機械翻訳", generator: TRANSLATE_ID },
      {
        id: "llm.evaluation",
        kind: "generated",
        scope: "language",
        label: "翻訳の評価",
        generator: EVALUATE_ID,
        type: {
          enum: [
            { value: "OK", label: "OK", color: "green" },
            { value: "WARNING", label: "WARNING", color: "amber" },
            { value: "NG", label: "NG", color: "red" },
          ],
        },
      },
    ],
  };
}

export default llmPlugin;
