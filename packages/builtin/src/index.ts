import type { Plugin } from "@loc-studio/sdk";
import { csvFormat, tsvFormat } from "./csv.js";
import { dbSource } from "./db-source.js";
import { builtinColumns } from "./default-columns.js";
import { globTree } from "./glob-tree.js";
import { reviewSource } from "./review-source.js";
import { builtinSyntaxes } from "./syntax.js";
import { builtinValidators } from "./validators.js";

export * from "./csv.js";
export * from "./db-source.js";
export * from "./default-columns.js";
export * from "./glob-tree.js";
export * from "./review-source.js";
export * from "./syntax.js";
export * from "./validators.js";

/**
 * 同梱機能をまとめたプラグイン。
 * スタジオ独自のプラグインと同じ interface の実装で、同じ手順で登録される。
 */
export const builtinPlugin: Plugin = {
  name: "@loc-studio/builtin",
  version: "0.1.0",
  trees: [globTree],
  formats: [csvFormat, tsvFormat],
  syntaxes: builtinSyntaxes,
  validators: builtinValidators,
  sources: [dbSource, reviewSource],
  columns: builtinColumns,
};
