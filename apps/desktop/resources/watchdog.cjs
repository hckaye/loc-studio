// サーバーの子プロセスに --require で差し込む。親（Electron のメイン）が強制終了などで消えると
// 標準入力のパイプが閉じるので、そのときサーバーも終了して、ポートや DB を掴んだまま残らないようにする。
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
