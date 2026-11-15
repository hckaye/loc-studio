import type { Plugin } from "@loc-studio/sdk";
import { llmTranslateGenerator } from "./translate.js";

export * from "./translate.js";

export const llmPlugin: Plugin = {
  name: "@loc-studio/plugin-llm",
  version: "0.1.0",
  generators: [llmTranslateGenerator],
};

export default llmPlugin;
