import type {
  Action,
  ColumnSource,
  Format,
  Generator,
  Plugin,
  ProjectConfig,
  TextSyntax,
  TreeProvider,
  Validator,
  WorkflowHook,
} from "./types.js";

/**
 * 型の補完を効かせるための関数。値はそのまま返す。
 * プラグインはこれらを使わず、同じ形のオブジェクトをそのまま書き出してもよい。
 */
export const definePlugin = (plugin: Plugin): Plugin => plugin;
export const defineConfig = (config: ProjectConfig): ProjectConfig => config;
export const defineTreeProvider = (tree: TreeProvider): TreeProvider => tree;
export const defineFormat = (format: Format): Format => format;
export const defineTextSyntax = (syntax: TextSyntax): TextSyntax => syntax;
export const defineColumnSource = (source: ColumnSource): ColumnSource => source;
export const defineGenerator = (generator: Generator): Generator => generator;
export const defineAction = (action: Action): Action => action;
export const defineValidator = (validator: Validator): Validator => validator;
export const defineHook = (hook: WorkflowHook): WorkflowHook => hook;

/** セルの版が合わずに保存できなかったことを表す。利用者に両方の値を見せて選ばせる。 */
export class StoreConflictError extends Error {
  readonly conflicts: { cell: import("./types.js").CellRef; current: import("./types.js").CellValue | undefined }[];
  constructor(conflicts: { cell: import("./types.js").CellRef; current: import("./types.js").CellValue | undefined }[]) {
    super(`ほかの人が先に変更したため保存できませんでした（${conflicts.length} 件）`);
    this.name = "StoreConflictError";
    this.conflicts = conflicts;
  }
}

/**
 * リソースが、読んだあとで外部から書き換えられていたことを表す。
 * TreeProvider.write が expectedRevision と合わないときに投げる。
 */
export class RevisionConflictError extends Error {
  readonly resourceId: string;
  constructor(resourceId: string, message?: string) {
    super(message ?? `リソース「${resourceId}」は、読み込んだあとで書き換えられています`);
    this.name = "RevisionConflictError";
    this.resourceId = resourceId;
  }
}
