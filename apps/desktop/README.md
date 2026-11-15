# @loc-studio/desktop

Electron の殻です。Web アプリ（`apps/web`）の standalone ビルドを `127.0.0.1` の空きポートで子プロセスとして起動し、`BrowserWindow` に表示します（ローカルモード）。

## 方式とバージョン

Electron の版は、`apps/desktop/package.json` で 45.3.2 に固定しています（範囲で書くと、electron-builder が版を決められずに止まります）。サーバーは Electron に同梱の Node で動くので、その Node が `node:sqlite` に必要な 22.13 以上である必要があります。Electron 45.3.2 に同梱の Node は 24.22.2 で、`node:sqlite` が読み込めます（配布物の実行ファイルで確かめました）。

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

`scripts/stage-server.mjs` が `apps/web/.next/standalone`（`launch.mjs` と静的ファイルがあること）を `build/server` にコピーし、`node_modules` のシンボリックリンクを実体にします。梱包の最後に、`scripts/after-pack.cjs`（electron-builder の `afterPack`）が `build/server` を配布物の `resources/server` にコピーします。`extraResources` に任せると、electron-builder が `node_modules` のフォルダを落とし、サーバーが起動しない配布物になるためです。コピーのあとで、起動とプラグインの読み込みに要るファイル（`next`、`react`、`jiti`、`@loc-studio/sdk` など）がそろっているかを確かめ、欠けていたら配布物を作らずに失敗します。

出力先は `apps/desktop/release/` です。対象は Windows（nsis、zip、dir）、macOS（dmg）、Linux（AppImage）です。署名の設定はしていないので、配布物は署名なしです。アプリのアイコンも設定していないので、Electron の既定のアイコンになります。

できた配布物は、次のコマンドで起動して確かめます。展開済みのフォルダ（Windows は `release/win-unpacked`）を一時フォルダに写して起動し、プラグインを後から置いて読み込まれることまでを見ます。画面を表示できる環境が要ります。

```
npm run check:desktop
```

## プラグインフォルダ

プラグインは、配布物を作り直さずに足せます。プラグインのファイル（`.ts` のままで構いません）をプラグインフォルダに置き、画面の「プラグイン」の一覧で「再読み込み」を押すと読み込まれます。アプリを起動し直しても読み込みます。置き場所は次の 3 つです（[docs/plugins/loading.md](../../docs/plugins/loading.md)）。

- アプリの隣の `plugins` フォルダ（下の表）。その PC でこのアプリが開くすべてのプロジェクトに効きます。信頼の確認なしで読み込みます。
- プロジェクトの `loc-studio-plugins/`。プロジェクトと一緒に共有できます。初めて読み込むときと、書き換えたあとに、信頼の確認が出ます。
- 個人の設定フォルダの `plugins`。その人の PC だけで使われます。同じく信頼の確認が出ます。

アプリの隣の `plugins` フォルダは、なければ起動時に作ります（作れない場所でも続行します）。「ヘルプ > プラグインフォルダを開く」でも開けます。インストーラーで入れたアプリを更新、アンインストールしたときに、このフォルダの中身が残るかは確かめていません。消えて困るプラグインは、プロジェクトのフォルダか、個人の設定フォルダに置いてください。

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
- `npx vitest run apps/desktop` が通ります。空きポート、appDir、環境変数の許可リスト、トークンの生成、起動待ち、URL、メニュー、トークンの置き換え、watchdog、配布物へのサーバーのコピー（`after-pack.cjs`）を調べています。
- このテストには、standalone の `launch.mjs` を実際に起動する結合テストも入っています。合言葉なしの `/api/session` は 401、間違った合言葉も 401、正しい合言葉はクッキーに換わって 303 で URL から消えます。そのクッキーでは 200 です。親の環境の `LOC_STUDIO_MODE=web`、`LOC_STUDIO_HOST=0.0.0.0` は子プロセスに届かず、出力に合言葉は残りません。停止後はポートが閉じます。
- 2026-11-16 に Windows 11（x64）で、`npm run build:web` と `npm run dist:desktop` が通り、インストーラー（`loc-studio Setup 0.1.0.exe`）、zip、展開済みのフォルダ（`win-unpacked`）ができました。zip の中に `resources/server/node_modules`（`next`、`jiti`、`@loc-studio/sdk`）が入っていることを確かめました。
- 同じ日に `npm run check:desktop`（19 項目）を実行し、すべて通りました。展開済みのフォルダの写しを起動して、次を確かめています。
  - 内部サーバーが起動し、ウィンドウにページが出て、合言葉が URL から消えている。
  - 開いた直後は設定ファイルの信頼の確認を待ち、信頼するとプロジェクトが開く。
  - プロジェクトのプラグインフォルダの TypeScript のプラグインが読み込まれる。
  - アプリの隣の `plugins` と、個人の設定フォルダの `plugins` を探す対象にしている。アプリの隣の `plugins` は起動時に作ってある。
  - アプリを動かしたまま、アプリの隣の `plugins` に TypeScript のプラグイン（`@loc-studio/sdk` を実行時に import するもの）を置いて再読み込みすると、信頼の確認なしで読み込まれ、設定の「登録されていない」の警告が消え、そのバリデータの指摘が行に出る。
  - 信頼したあとの画面に、プロジェクトのツリーが出る。
  - 個人の設定を、`--user-data-dir` で指定した設定フォルダに書く。
  - ウィンドウを閉じるとアプリが終了し、内部サーバーにつながらなくなる。

コードを読んで確認しただけのことは次のとおりです。

- `launch.mjs` が `server.js` を同じプロセスに読み込むこと。
- `main.ts` のナビゲーション制限、`window.open`、権限、`will-attach-webview` の処理。

## 確認していないこと

- インストーラー（nsis）の実行。インストール、更新、アンインストールと、そのときにアプリの隣の `plugins` フォルダが残るかは試していません。
- 手での操作。メニュー、フォルダ選択、外部リンク、2 つ目の起動、エラーダイアログ、「プラグインフォルダを開く」は動かしていません。`check:desktop` は、ページの中から API を呼んで確かめています。
- 署名。配布物は署名なしです。
- macOS（dmg）と Linux（AppImage）の配布物の作成と起動。
- 親プロセスを強制終了したときに、watchdog が内部サーバーを止めること（配布物では試していません。テストは watchdog のスクリプトを単独で調べています）。
