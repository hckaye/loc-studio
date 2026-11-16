// preload.ts にも同じ文字列がある（サンドボックスの preload は自作のモジュールを読み込めないため）。
// 食い違わないように ipc.test.ts で確認する。
export const IPC_PICK_FOLDER = "loc-studio:pick-folder";
export const IPC_OPEN_PATH = "loc-studio:open-path";
/** main から画面へ: メニューや 2 つ目の起動からの操作（{ type: "open", path } / { type: "new" }）。 */
export const IPC_COMMAND = "loc-studio:command";
/** 画面から main へ: 最近のプロジェクトの一覧が変わった（メニューを作り直す）。 */
export const IPC_PROJECTS_CHANGED = "loc-studio:projects-changed";
