import type {
  ColumnDef,
  Entry,
  LanguageDef,
  LanguageId,
  Options,
  Plugin,
  RowReader,
  Severity,
  ValidationIssue,
  Validator,
} from "@loc-studio/sdk";

/** 拡張ポイントの種類。レジストリの検索に使う。 */
export type ExtensionKind =
  | "tree"
  | "format"
  | "syntax"
  | "source"
  | "column"
  | "generator"
  | "action"
  | "validator"
  | "renderer";

/** プラグインがどの層から来たか。 */
export type PluginLayer = "builtin" | "app" | "project" | "local";

export interface PluginOrigin {
  layer: PluginLayer;
  /** 読み込んだファイル、またはフォルダの絶対パス。同梱のものは undefined。 */
  path?: string;
}

export interface LoadedPlugin {
  plugin: Plugin;
  origin: PluginOrigin;
}

export interface PluginLoadError {
  /** 問題のあったファイル、またはフォルダの絶対パス。 */
  path: string;
  layer: PluginLayer;
  message: string;
}

/** プラグインを探すフォルダ。 */
export interface PluginDirSpec {
  /** 絶対パス。存在しなくてもよい（その場合は何も読み込まない）。 */
  dir: string;
  layer: PluginLayer;
}

/** 設定の `validators` を、実装と値に解決したもの。 */
export interface ResolvedValidator {
  validator: Validator;
  options: Options;
  /** 設定で上書きした重さ。 */
  severity?: Severity;
  /** 設定で絞った言語。省略時はバリデータ自身の指定に従う。 */
  languages?: LanguageId[];
  /** 設定で絞った列。省略時はバリデータ自身の指定に従う。 */
  columns?: string[];
}

/** バリデーションの対象になる 1 つのセル。 */
export interface ValidationTarget {
  entry: Entry;
  column: ColumnDef;
  language?: LanguageDef;
  value: string;
  /** 基になる言語の本文。 */
  base?: { language: LanguageDef; value: string };
  row: RowReader;
}

/** 重さが決まった問題。 */
export interface ResolvedIssue extends ValidationIssue {
  severity: Severity;
  validatorId: string;
}

export interface CellValidation {
  target: ValidationTarget;
  issues: ResolvedIssue[];
}
