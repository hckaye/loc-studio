// preload.ts にも同じ文字列がある（サンドボックスの preload は自作のモジュールを読み込めないため）。
// 食い違わないように ipc.test.ts で確認する。
export const IPC_PICK_FOLDER = "loc-studio:pick-folder";
export const IPC_OPEN_PATH = "loc-studio:open-path";
