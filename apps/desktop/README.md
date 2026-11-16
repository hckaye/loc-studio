# @loc-studio/desktop

Electron の殻です。Web アプリ（`apps/web`）の standalone ビルドを `127.0.0.1` の空きポートで子プロセスとして起動し、`BrowserWindow` に表示します（ローカルモード）。

配布物は、実行ファイルを起動するだけで動きます。内部サーバーはアプリが自分で起動して、終了時に止めます。別にサーバーを用意する必要はなく、外部には接続しません（プロジェクトの設定やプラグインが、LLM などの外部のサービスを使う場合を除きます）。データは、プロジェクトのフォルダと、その PC の設定フォルダ（SQLite）に置きます。

## 使い始め

- 初めて起動したとき（開くプロジェクトがないとき）は、最初の画面が出ます。「新しいプロジェクトを作る…」で、フォルダと言語を選んでプロジェクトを作るか、既存のプロジェクトのフォルダを開きます（[docs/GETTING-STARTED.md の 5 章](../../docs/GETTING-STARTED.md#5-プロジェクトを一から作る)）。
- 次の起動からは、最後に開いたプロジェクトが開きます。開いていたリソース、絞り込み、並べ替えなども戻ります。
- メニュー「ファイル」には、「新しいプロジェクト…」（Ctrl+N）、「プロジェクトを開く…」（Ctrl+O）、「最近使ったプロジェクト」があります。

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

プロジェクトは、コマンドライン引数、なければ前回開いたプロジェクト（`<userData>/web-session.json`）の順で決めます。どちらもなければ、最初の画面が出ます。

## メニューからの操作

メニューの「新しいプロジェクト…」「プロジェクトを開く…」「最近使ったプロジェクト」と、2 つ目の起動に渡したフォルダは、ページを読み直さずに画面へ伝えます。main は `webContents.send("loc-studio:command", { type: "open", path } | { type: "new" })` で送り、preload の `window.locStudio.onCommand(handler)` が画面（`apps/web/components/App.tsx`）に渡します。画面が受け取る準備をする前に来た操作は、preload が最後の 1 つを覚えておき、準備ができたら渡します。

以前は、選んだフォルダを `?project=` に付けてページを読み直していました。画面は、読み込むたびに起動時のプロジェクトを開くので、起動時にプロジェクトがあると、選んだプロジェクトが開きませんでした。

画面は、プロジェクトを開いた・作ったあとで `window.locStudio.projectsChanged()` を呼び、main が「最近使ったプロジェクト」を作り直します。IPC は、内部サーバーのページからの呼び出しだけを受け付けます。

## 配布物の作成

```
npm run build:web && npm run dist:desktop
```

`scripts/stage-server.mjs` が `apps/web/.next/standalone`（`launch.mjs` と静的ファイルがあること）を `build/server` にコピーし、`node_modules` のシンボリックリンクを実体にします。梱包の最後に、`scripts/after-pack.cjs`（electron-builder の `afterPack`）が `build/server` を配布物の `resources/server` にコピーします。`extraResources` に任せると、electron-builder が `node_modules` のフォルダを落とし、サーバーが起動しない配布物になるためです。コピーのあとで、起動とプラグインの読み込みに要るファイル（`next`、`react`、`jiti`、`@loc-studio/sdk` など）がそろっているかを確かめ、欠けていたら配布物を作らずに失敗します。

サービス層（`@loc-studio/*`）の依存（`acorn`、`acorn-walk`、`pg` と、その先の依存）は、`npm run build:web` の最後に standalone の `node_modules` へ足しています（`apps/web/scripts/copy-static.mjs` と `scripts/standalone-deps.cjs`）。Next の standalone は、画面のコードが import するものしか集めず、サービス層は実行時に Node が読み込むためです。`after-pack.cjs` は、配布物の中だけでこれらの依存を解決できるかを確かめ（上の階層の `node_modules` は見ません）、解決できないものがあれば配布物を作らずに失敗します。

0.2.0 までの配布物には、これらの依存が入っていませんでした。リポジトリの外に置くと、内部サーバーが `Cannot find package 'acorn'` で失敗し、プロジェクトを 1 つも開けません（2026-11-16 に、0.2.0 の zip を展開して確かめました）。リポジトリの中の `release/win-unpacked` を直接起動すると、上の階層の `node_modules` で解決されて動くので、気づきにくい不具合です。

出力先は `apps/desktop/release/` です。対象は Windows（nsis、zip、dir）、macOS（dmg）、Linux（AppImage）です。署名の設定はしていないので、配布物は署名なしです。アプリのアイコンも設定していないので、Electron の既定のアイコンになります。

できた配布物は、次のコマンドで起動して確かめます。展開済みのフォルダ（Windows は `release/win-unpacked`）を、リポジトリの外の一時フォルダに写して起動します（利用者の PC と同じく、リポジトリの `node_modules` が見えない場所で動かすため）。プロジェクトを渡さない初めての起動から新しいプロジェクトを作るところ、メニューの操作、プラグインを後から置いて読み込まれるところまでを見ます。メニューは、メインプロセスにデバッガー（`--inspect`）でつないで、項目の `click` を呼んで動かします。画面を表示できる環境が要ります。

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
- `npx vitest run apps/desktop` が通ります。空きポート、appDir、環境変数の許可リスト、トークンの生成、起動待ち、URL、メニュー（「新しいプロジェクト…」を含む）、トークンの置き換え、watchdog、配布物へのサーバーのコピーと、配布物の中だけで依存を解決できるかの確認（`after-pack.cjs`、`scripts/standalone-deps.cjs`）を調べています。
- このテストには、standalone の `launch.mjs` を実際に起動する結合テストも入っています。合言葉なしの `/api/session` は 401、間違った合言葉も 401、正しい合言葉はクッキーに換わって 303 で URL から消えます。そのクッキーでは 200 です。親の環境の `LOC_STUDIO_MODE=web`、`LOC_STUDIO_HOST=0.0.0.0` は子プロセスに届かず、出力に合言葉は残りません。停止後はポートが閉じます。
- 2026-11-16 に Windows 11（x64）で、`npm run build:web` と `npm run dist:desktop` が通り、インストーラー（`loc-studio Setup 0.3.0.exe`）、zip、展開済みのフォルダ（`win-unpacked`）ができました。`build:web` が、サービス層の依存 15 個（`acorn`、`acorn-walk`、`pg` と、`pg` の先の依存）を standalone に足したことを、出力で確かめました。
- 同じ日に `npm run check:desktop`（42 項目）を実行し、すべて通りました（設定の画面での編集と一括アクションを足して作り直した配布物でも、もう一度通しました。この 2 つの機能そのものは、配布物では操作していません）。展開済みのフォルダを、リポジトリの外の一時フォルダに写して、4 回起動しています。
  - プロジェクトを渡さず、設定フォルダも空の状態で起動すると、最初の画面に「新しいプロジェクトを作る…」が出る。「ファイル」メニューに「新しいプロジェクト…」がある。
  - 作成の画面でフォルダを入れて作ると、フォルダ、設定ファイル、最初のファイル（`key,ja,en` の見出しだけ）ができ、信頼の確認なしで開く。ウィンドウのタイトルにプロジェクトの名前が出る。そのプロジェクトに、行と本文を書ける。
  - メニューの「新しいプロジェクト…」を押すと、開いていたプロジェクトを離れて作成の画面になり、2 つ目のプロジェクトを作って開ける。
  - 作った 2 つのプロジェクトが、メニューの「最近使ったプロジェクト」に新しい順で出る。その項目を押すと、選んだプロジェクトに切り替わる。
  - ウィンドウを閉じるとアプリと内部サーバーが止まり、次の起動では（何も渡さなくても）最後に開いたプロジェクトが開く。
  - プロジェクトを渡して起動すると、内部サーバーが起動し、ウィンドウにページが出て、合言葉が URL から消えている。
  - 開いた直後は設定ファイルの信頼の確認を待ち、信頼するとプロジェクトが開く。
  - プロジェクトのプラグインフォルダの TypeScript のプラグインが読み込まれる。
  - アプリの隣の `plugins` と、個人の設定フォルダの `plugins` を探す対象にしている。アプリの隣の `plugins` は起動時に作ってある。
  - アプリを動かしたまま、アプリの隣の `plugins` に TypeScript のプラグイン（`@loc-studio/sdk` を実行時に import するもの）を置いて再読み込みすると、信頼の確認なしで読み込まれ、設定の「登録されていない」の警告が消え、そのバリデータの指摘が行に出る。
  - 信頼したあとの画面に、プロジェクトのツリーが出る。条件式で、リソースをまたいで行を数えられる。
  - 開いているリソースと絞り込みを変えると、その PC の DB に保存される。個人の設定を、`--user-data-dir` で指定した設定フォルダに書く。
  - もう一度起動すると、内部サーバーは別のポートで動く。信頼の確認はもう出ず、前回開いていたリソースが開き、前回の絞り込み（検索の文字）が戻っている。
- 同じ日に、公開済みの 0.2.0 の zip を展開して同じ確認にかけ、プロジェクトを渡して起動する最初の確認で、内部サーバーが `Cannot find package 'acorn'` で失敗することを確かめました（上の「配布物の作成」）。
- 2026-11-17 に Windows 11（x64）で、0.4.0 の配布物（`loc-studio Setup 0.4.0.exe`、`loc-studio-0.4.0-win.zip`）を `npm run build:web` と `npm run dist:desktop` で作り、`npm run check:desktop`（42 項目）がすべて通りました。インストーラーの実行は、この版でも確かめていません。

コードを読んで確認しただけのことは次のとおりです。

- `launch.mjs` が `server.js` を同じプロセスに読み込むこと。
- `main.ts` のナビゲーション制限、`window.open`、権限、`will-attach-webview` の処理。
- 2 つ目の起動にフォルダを渡すと、動いているウィンドウでそのプロジェクトを開くこと（メニューの「プロジェクトを開く…」と同じ道筋で画面に伝えます）。

## 確認していないこと

- 0.2.0 のときの `check:desktop`（26 項目）が通った理由。そのときも配布物を一時フォルダに写して起動していて、依存が足りない配布物は開けないはずですが、通りました。いま同じ 0.2.0 の配布物で実行すると失敗します。当時、上の階層のどこかに `node_modules` があったのか、ほかの理由かは、特定できていません。
- インストーラー（nsis）の実行。インストール、更新、アンインストールと、そのときにアプリの隣の `plugins` フォルダが残るかは試していません。
- フォルダを選ぶ窓。メニューの「プロジェクトを開く…」と、画面の「フォルダを選ぶ…」は、OS の窓が出るので動かしていません（選んだあとの道筋は、「最近使ったプロジェクト」と同じです）。
- 手での操作。外部リンク、2 つ目の起動、エラーダイアログ、「プラグインフォルダを開く」、キーボードのショートカット（Ctrl+N、Ctrl+O）は動かしていません。`check:desktop` は、ページの中のボタンを押し、ページの中から API を呼び、メニューの項目の `click` を呼んで確かめています。
- 署名。配布物は署名なしです。
- macOS（dmg）と Linux（AppImage）の配布物の作成と起動。
- 親プロセスを強制終了したときに、watchdog が内部サーバーを止めること（配布物では試していません。テストは watchdog のスクリプトを単独で調べています）。
