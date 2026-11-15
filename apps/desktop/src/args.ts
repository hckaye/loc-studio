import path from "node:path";

/**
 * コマンドラインのプロジェクトのフォルダ。`-` で始まる引数（Chromium のフラグなど）は飛ばし、最初の 1 つを使う。
 * @param args 実行ファイル（と開発時のアプリのパス）を除いた引数
 */
export function parseProjectArg(args: readonly string[], cwd: string): string | undefined {
  const first = args.find((a) => a !== "" && !a.startsWith("-"));
  return first === undefined ? undefined : path.resolve(cwd, first);
}

/** process.argv から実行ファイルの分を除く。開発時（electron .）はアプリのパスも除く。 */
export function userArgs(argv: readonly string[], defaultApp: boolean): string[] {
  return argv.slice(defaultApp ? 2 : 1);
}
