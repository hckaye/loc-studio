# @loc-studio/desktop

Electron の殻です。Web アプリ（`apps/web`）の standalone ビルドを `127.0.0.1` の空きポートで子プロセスとして起動し、`BrowserWindow` に表示します（ローカルモード）。

## 方式とバージョン

Electron の版は、`apps/desktop/package.json` で `^45.3.0` を指定しています（導入済みの npm パッケージは 45.3.2）。サーバーは Electron に同梱の Node で動くので、その Node が `node:sqlite` に必要な 22.13 以上である必要があります。同梱の Node の版は、確かめていません（Electron を実行していません）。

サーバーは Electron 自身の Node（`ELECTRON_RUN_AS_NODE=1`）で、`resources/watchdog.cjs` を `--require` して `launch.mjs` を起動します。`launch.mjs` は `server.js` を同じプロセスに読み込むので、子プロセスは 1 つです。親が強制終了すると標準入力が閉じ、watchdog がそのプロセスを終わらせます。

## 起動の合言葉

起動のたびに `crypto.randomBytes(32)` の base64url を作り、`LOC_STUDIO_LOCAL_TOKEN` として子プロセスに渡します。ウィンドウは最初だけ `http://127.0.0.1:<port>/?token=<合言葉>` を開きます。画面側が合言葉を HttpOnly、SameSite=Strict のクッキーに換えて、URL から消します。以降の遷移は合言葉なしの URL です。

起動の待ち合わせは `/api/session` に合言葉なしで要求し、401 を「起動している」とみなします（500 や接続拒否は待ち続けます）。サーバーの出力は、合言葉と `?token=` の値を `[token]` に置き換えてから保持し、エラーダイアログにもその文字列を使います。

子プロセスの環境変数は許可リスト方式です。PATH、HOME、`SystemRoot` などの OS の基本設定、`LC_*`、`XDG_*`、プロキシと証明書の設定、`LOC_STUDIO_PLUGIN_DIRS`、`LOC_STUDIO_SETTINGS`、`LOC_STUDIO_SECRET_*` だけを引き継ぎます。それ以外（`LOC_STUDIO_MODE`、`LOC_STUDIO_HOST`、`LOC_STUDIO_ALLOW_REMOTE_LOCAL`、`LOC_STUDIO_SERVER_CONFIG`、`LOC_STUDIO_ALLOWED_HOSTS`、`LOC_STUDIO_INTERNAL_SECRET`、`LOC_STUDIO_BIND_HOST`、`LOC_STUDIO_ADMIN_*`、`HOSTNAME`、`NODE_OPTIONS` など）は渡しません。そのうえで `LOC_STUDIO_MODE=local`、`PORT`、`LOC_STUDIO_DESKTOP=1`、`LOC_STUDIO_APP_DIR`、`LOC_STUDIO_USER_DATA_DIR`、プロジェクトがあれば `LOC_STUDIO_PROJECT` を設定します。

ウィンドウは `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` です。アプリのオリジン以外への移動（リダイレクトを含む）と `window.open` は拒否し、http と https の外部リンクだけをシステムのブラウザで開きます。`<webview>` の追加と、権限の要求・確認は拒否します。

## 開発

```
npm run build:web      # 先に Web アプリをビルドします（自動では行いません）
npm run build:desktop  # tsc で dist/ に出力します
npm run start:desktop  # electron .（フォルダを引数に渡すと、そのプロジェクトを開きます）
```

プロジェクトは、コマンドライン引数、なければ前回開いたプロジェクト（`<userData>/web-session.json`）の順で決めます。

## 配布物の作成

```
npm run build:web && npm run dist:desktop
```

`scripts/stage-server.mjs` が `apps/web/.next/standalone`（`launch.mjs` と静的ファイルがあること）を `build/server` にコピーし、`node_modules` のシンボリックリンクを実体にします。これが `extraResources` として `resources/server` に入ります。出力先は `apps/desktop/release/` です。対象は Windows（nsis、zip、dir）、macOS（dmg）、Linux（AppImage）です。

## プラグインフォルダ

配布物の隣の `plugins` フォルダです。なければ起動時に作ります（作れない場所でも続行します）。「ヘルプ > プラグインフォルダを開く」でも開けます。再ビルドは要りません。

| OS | 場所 |
| --- | --- |
| Windows | `loc-studio.exe` のあるフォルダの `plugins`（ポータブル版は元の exe のフォルダ） |
| macOS | `loc-studio.app` を置いたフォルダの `plugins`（`.app` の中ではありません） |
| Linux | AppImage 本体のあるフォルダの `plugins` |
| 開発時 | `apps/desktop/plugins` |

設定フォルダ（`userData`）は「ヘルプ > 設定フォルダを開く」で開きます。

## 確認したこと

実行して確認したことは次のとおりです。

- `npx tsc -p apps/desktop` が通ります。
- `npx vitest run apps/desktop` が通ります（9 ファイル、36 件。2026-11-15 にリポジトリのコピーで実行）。空きポート、appDir、環境変数の許可リスト、トークンの生成、起動待ち、URL、メニュー、トークンの置き換え、watchdog を調べています。
- この 36 件には、standalone の `launch.mjs` を実際に起動する結合テストも入っています。合言葉なしの `/api/session` は 401、間違った合言葉も 401、正しい合言葉はクッキーに換わって 303 で URL から消えます。そのクッキーでは 200 です。親の環境の `LOC_STUDIO_MODE=web`、`LOC_STUDIO_HOST=0.0.0.0` は子プロセスに届かず、出力に合言葉は残りません。停止後はポートが閉じます。
- `scripts/stage-server.mjs` が `launch.mjs` を含めてコピーし、シンボリックリンクが残らないことを確認しました。

コードを読んで確認しただけのことは次のとおりです。

- `launch.mjs` が `server.js` を同じプロセスに読み込むこと（orphan が出ない根拠）。
- `main.ts` のナビゲーション制限、`window.open`、権限、`will-attach-webview` の処理。

## 確認していないこと

- Electron の起動。実行ファイルを取得できて画面のある環境で試していません。ウィンドウ、メニュー、IPC、フォルダ選択、外部リンク、単一インスタンス、エラーダイアログは動かしていません。
- Electron の Node（`ELECTRON_RUN_AS_NODE`）での `node:sqlite` の動作。
- electron-builder の実行。各 OS の配布物、`extraResources` に `node_modules` が入ること、署名、配布版での appDir の解決は未確認です。
