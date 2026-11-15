# Web モード（複数人・認証・権限）

ローカルモードは、1 人が自分の PC で画面を動かす使い方で、認証はありません。Web モードは、サーバーに置いた 1 つの画面を、複数人がブラウザから使う使い方です。利用者はログインし、プロジェクトごとに割り当てられた役割の範囲で操作します。

この文書の前半（1〜9 章）は、サーバーを用意して運用する管理者向けの手順と仕様です。10 章は、Web の層（`apps/web`）が使うサービス層の API で、実装者向けです。

## 1. 構成

Web モードのサーバーは、画面の本番ビルド（Next.js の standalone 出力）を、起動の仕組み（`npm run start:web`、または standalone の中の `apps/web/launch.mjs`）で `LOC_STUDIO_MODE=web` にして起動した 1 つの Node のプロセスです。HTTPS は扱わないので、前段にリバースプロキシを置きます。

サーバーが使うものは次のとおりです。

| もの | 場所 | 中身 |
| --- | --- | --- |
| データフォルダ | 環境変数 `LOC_STUDIO_USER_DATA_DIR`。なければローカル設定ファイルのフォルダ（Linux は `~/.config/loc-studio`） | 下の 3 つの既定の置き場所 |
| サーバーの設定ファイル | 環境変数 `LOC_STUDIO_SERVER_CONFIG`。なければ `<データフォルダ>/server.json` | 公開するプロジェクト、認証の方式、サーバーの DB の場所 |
| サーバーの DB | 設定 `serverDb`。省略すると、設定ファイルと同じフォルダの `server.db`（SQLite） | アカウント、セッション、プロジェクトごとの権限、利用者ごとの設定、ログインの失敗の記録 |
| ワークスペースのデータ | `<データフォルダ>/workspaces/<プロジェクト ID>/projects/<ハッシュ>/local.db` | プロジェクトごとのその PC の DB。全員で共有するドラフト（未保存の本文） |
| プロジェクトのフォルダ | 設定 `projects[].root` | リソース、プロジェクト設定、プラグイン。共有 DB（既定は `<プロジェクト>/.loc-studio/meta.db`。設定 `storage` で Postgres にもできる） |

サーバーのプロセスは、プロジェクトのフォルダに書き込めることが必要です（保存でリソースを書き換え、共有 DB を作るため）。

## 2. 配置の手順

例として、データフォルダを `/srv/loc/data`、プロジェクトを `/srv/loc/mygame` に置きます。コマンドはリポジトリのルートで実行します。

1. 依存を導入して、画面の本番ビルドを作ります。

   ```sh
   npm install
   npm run build:web     # tsc -b のあと next build（standalone 出力）と静的ファイルのコピー
   ```

2. データフォルダに `server.json` を書きます。キーの説明は [3 章](#3-サーバーの設定ファイル)にあります。

   ```json
   {
     "projects": [
       { "id": "mygame", "name": "MyGame", "root": "/srv/loc/mygame", "env": [] }
     ],
     "allowedHosts": ["loc.example.com"],
     "auth": { "mode": "password", "trustedProxyHops": 1 }
   }
   ```

   `allowedHosts` には、利用者がブラウザで開くホスト名（リバースプロキシの外側の名前）を書きます。サーバーは `Host` がこの一覧にもループバックの名前にもない要求を 421 で断ります。書かないとループバック（`localhost` など）からの要求しか受け付けないので、プロキシを通した要求はすべて断られます（最初の要求を受けたときに、警告が 1 度ログに出ます）。`trustedProxyHops` は前段のプロキシの段数です（6 の手順）。

   プロジェクト設定で `${env:NAME}` を使う場合（共有 DB の場所や接続文字列など）は、その環境変数の名前を `env` に並べます。並べていない名前は、プロジェクト設定からもプラグインからも見えません。

3. 最初の管理者を作ります。コマンドラインの `user add` を使うと、パスワードは標準入力から渡せます（[CLI.md のサーバー管理](CLI.md#サーバー管理)）。

   ```sh
   printf '%s' "$ADMIN_PASSWORD" | node apps/cli/dist/index.js user add alice --admin --password-stdin --data-dir /srv/loc/data
   ```

   ログイン名は英小文字か数字で始めます（[5 章](#5-アカウントとセッション)）。日本語のログイン名は使えません。表示名（`--display-name`）には日本語を使えます。

   代わりに、環境変数 `LOC_STUDIO_ADMIN_USER` と `LOC_STUDIO_ADMIN_PASSWORD` を付けてサーバーを起動しても作れます。この 2 つは、`auth.mode` が `password` で、アカウントが 1 つもないときだけ使われます。サーバーは最初の要求を受けたときにサーバーの DB を開き、そのときに管理者を作ります。そのあと、この 2 つの変数はサーバーのプロセスの環境から消します（プラグインからは読めません）。

4. 設定を確かめます。設定ファイル、サーバーの DB、有効な管理者がいるか（`password` モード）、各プロジェクトをサーバーと同じ条件で開けるか（プラグイン、`env` の許可）を確かめ、問題があれば終了コード 1 です。プロジェクトを実際に開くので、各プロジェクトのフォルダに共有 DB（`.loc-studio/`）が、データフォルダに `workspaces/` ができます。

   ```sh
   node apps/cli/dist/index.js server check --data-dir /srv/loc/data
   ```

5. サーバーを起動します。待ち受けるアドレスは `LOC_STUDIO_HOST`（既定 `127.0.0.1`）で、前段のプロキシからだけ届くよう既定のままにします。環境変数 `HOSTNAME` は見ません。設定ファイルの場所は、`LOC_STUDIO_SERVER_CONFIG`、なければ `LOC_STUDIO_USER_DATA_DIR` の `server.json`、どちらもなければ既定の設定フォルダの `server.json` です。運用では、置き場所がはっきりするよう、どちらかを設定することを勧めます。

   ```sh
   LOC_STUDIO_MODE=web \
   LOC_STUDIO_USER_DATA_DIR=/srv/loc/data \
   PORT=3000 \
   npm run start:web     # node apps/web/scripts/launch.mjs
   ```

   起動の仕組みは、`LOC_STUDIO_MODE` が未設定・`local`・`web` のどれでもないとき、Web モードのサーバーの設定ファイルが読めないか形が正しくないときは、メッセージを出して起動しません。standalone の `server.js` を直接起動しないでください。

6. 前段のリバースプロキシで HTTPS を終端し、`127.0.0.1:3000` へ転送します。サーバーは次のように振る舞うので、プロキシとサーバーの設定をそろえます。

   - サーバーが確かめるホスト名は、`auth.trustedProxyHops` が 0（既定）なら `Host` ヘッダー、1 以上なら `X-Forwarded-Host`（あれば）です。どちらの場合も、その名前が `allowedHosts` にないと 421 です。プロキシが `Host` を書き換える場合は、`X-Forwarded-Host` を付け、`trustedProxyHops` を設定します。
   - API への要求では、`Origin` があれば、そのホストが上で確かめたホスト名（ポートを含む）と同じでなければ 403 です。
   - HTTPS かどうかは、`trustedProxyHops` が 1 以上のときだけ `X-Forwarded-Proto` で判断し、`https` ならセッションのクッキーに `Secure` を付けます。
   - ログインの総当たり対策の接続元のアドレスも、`trustedProxyHops` が 1 以上のときだけ `X-Forwarded-For` から取ります（5 章）。

7. ブラウザで開き、管理者でログインします。利用者のメニューの「管理」で利用者を追加し、「プロジェクトの権限」で役割を割り当てます（[7 章](#7-画面)）。コマンドラインの `user add` と `member set` でも同じことができます。

この手順のうち、手順 2〜5 と 7 の操作（`server check`、`user add`、`member set`、起動、ログイン、管理の口）と、`allowedHosts` の有無による 421、`trustedProxyHops: 1` での `X-Forwarded-Host` / `X-Forwarded-Proto` の扱いは、一時フォルダで `curl` を使って確かめました。実際のリバースプロキシ（nginx など）での動作は確かめていません。

## 3. サーバーの設定ファイル

```json
{
  "projects": [
    { "id": "mygame", "name": "MyGame", "root": "/srv/loc/mygame", "env": ["LOC_PG_URL"] }
  ],
  "auth": {
    "mode": "password",
    "sessionTtlHours": 168,
    "sessionMaxHours": 720,
    "proxyHeader": "x-forwarded-user",
    "admins": [],
    "trustedProxyHops": 0
  },
  "serverDb": { "driver": "sqlite", "path": "/srv/loc/server.db" }
}
```

| キー | 既定 | 意味 |
| --- | --- | --- |
| `projects` | なし（必須） | サーバーが公開するプロジェクトの配列。空の配列でもよい。利用者はこの中から選び、Web モードでは任意のフォルダを開けない |
| `projects[].id` | なし（必須） | 英数字と `. _ -` の 1〜64 文字。重複は不可。URL の `?project=` とコマンドラインの `member` で使う |
| `projects[].name` | `id` | 画面に出す名前 |
| `projects[].root` | なし（必須） | プロジェクトのフォルダ |
| `allowedHosts` | `[]` | 受け付けるホスト名（ポートは見ない）。ループバックの名前はいつも受け付ける。環境変数 `LOC_STUDIO_ALLOWED_HOSTS`（カンマ区切り）の名前も足される |
| `projects[].env` | `[]` | そのプロジェクトの設定の `${env:NAME}` と、プラグインのホストの `env` に見せる環境変数の名前。並べていない名前は見えない |
| `auth.mode` | `"password"` | `"password"`（組み込みのアカウント）か `"proxy"`（前段のプロキシが認証する）。[4 章](#4-認証) |
| `auth.sessionTtlHours` | `168` | セッションの期限。最後に使ってからの時間 |
| `auth.sessionMaxHours` | `720` | セッションの最長の期限。ログインしてからの時間で、使い続けても延びない |
| `auth.proxyHeader` | `"x-forwarded-user"` | `proxy` モードで利用者名を受け取る HTTP ヘッダー。小文字にそろえて扱う |
| `auth.proxySecretHeader`、`auth.proxySecretEnv` | なし | `proxy` モードの合言葉。プロキシが付けるヘッダーの名前と、その値を入れた環境変数の名前。両方書くか、どちらも書かない |
| `auth.admins` | `[]` | `proxy` モードで、アカウントを初めて作るときに管理者にするログイン名。`password` モードでは使わない |
| `auth.trustedProxyHops` | `0` | 前段のプロキシの段数（0〜10）。0 は `X-Forwarded-For`、`X-Forwarded-Host`、`X-Forwarded-Proto` を見ない。N は、接続元のアドレスに `X-Forwarded-For` の右から N 番目を使い、ホスト名と HTTPS の判断に `X-Forwarded-Host` と `X-Forwarded-Proto` を使う |
| `serverDb` | 設定ファイルと同じフォルダの `server.db` | サーバーの DB。`{ "driver": "sqlite", "path" }` か `{ "driver": "postgres", "url", "schema"? }`。プロジェクトの共有 DB（プロジェクト設定の `storage`）とは別のもの |

相対パス（`projects[].root`、`serverDb.path`）は、設定ファイルのフォルダから解決します。`projects[].root`、`serverDb.path`、`serverDb.url` には `${env:NAME}` を書けます。こちらはサーバーの設定なので、`projects[].env` の制限を受けません。Postgres の接続文字列は、パスワードを含むので `${env:NAME}` で渡します。

```json
"serverDb": { "driver": "postgres", "url": "${env:LOC_SERVER_PG_URL}", "schema": "loc_server" }
```

`schema` を省略すると `loc_studio` です。プロジェクトの共有 DB と同じデータベースを使う場合は、スキーマを分けます。

プロジェクト設定の `${env:NAME}`（`storage.path`、`storage.url`）は、`projects[].env` に並べた名前だけを使えます。並べていない名前は「環境変数が設定されていません」の扱いになり、プロジェクトを開けません。プラグインのホストの `env`（`ctx.host.env`）にも、並べた名前だけが入ります。秘密情報（`LOC_STUDIO_SECRET_<名前>`）は、この制限を受けずにサーバーの環境全体から読みます。

設定に問題があると、サーバーはすべての問題を 1 つのエラーにまとめて出します（ファイルのパスと項目つき）。`server check` でも同じ内容が出ます。

## 4. 認証

### password モード

組み込みのアカウント（ログイン名とパスワード）でログインします。ログインすると、セッションのクッキー `loc_studio_session` を受け取ります。プロキシのヘッダー（`auth.proxyHeader`）は見ません。

### proxy モード

前段のリバースプロキシ（社内 SSO など）が認証し、利用者名を `auth.proxyHeader` のヘッダーで渡します。サーバーは要求ごとにこのヘッダーを読みます。ログインの画面、パスワード、ログアウトはありません。ヘッダーのない要求は 401 で、画面には「認証を通ったアドレスから開き直してください」と出ます。

- 初めて来た利用者は、パスワードなしのアカウントとして自動で登録されます。割り当てがなければ、プロジェクトの一覧は空です。
- `auth.admins` は、アカウントを初めて作るときにだけ使います。その名前のアカウントは管理者として作られます。すでにあるアカウントには効かないので、`admins` に名前を足しても、既存のアカウントは管理者になりません（管理の画面か `user set <name> --admin` を使います）。`admins` から名前を外しても管理者のままです。管理者が別の管理者を外した場合は、`admins` に名前が残っていても外れたままです。
- ヘッダーの値は、ログイン名の規則（5 章）に合わせて小文字にそろえます。規則に合わなければ、ログインしていない扱いです。

合言葉を設定しない場合、サーバーは名前のヘッダーを無条件に信用します。サーバーにはプロキシからしか届かないようにし、プロキシは利用者が送ってきた同じ名前のヘッダーを消してから自分の値を入れてください。

合言葉（`auth.proxySecretHeader` と `auth.proxySecretEnv`）を設定すると、サーバーは、`proxySecretHeader` のヘッダーの値が環境変数 `proxySecretEnv` の値と一致する要求だけ、名前のヘッダーを信じます。一致しない要求は、ログインしていない扱いです。`proxySecretEnv` の環境変数がないと、サーバーは開きません（「auth.proxySecretEnv の環境変数 … が設定されていません」）。

## 5. アカウントとセッション

アカウントは、ログイン名（一意）、表示名、パスワードのハッシュ、管理者かどうか、無効かどうかを持ちます。

ログイン名は、Unicode の NFC に正規化し、前後の空白を除き、小文字にそろえてから扱います。そろえたあとの名前は、英小文字か数字で始まり、英小文字、数字、`. _ @ -` だけの 1〜64 文字です（`[a-z0-9][a-z0-9._@-]{0,63}`）。`Alice` と `alice` は同じアカウントです。日本語のログイン名は使えません。表示名には日本語を使えます（128 文字まで）。パスワードは 8〜1024 文字です。

パスワードは scrypt でハッシュにして保存します。形は `scrypt$<N>$<r>$<p>$<塩>$<ハッシュ>` で、既定は N=16384、r=8、p=1、塩 16 バイト、鍵 64 バイトです。比較は一定時間で行います。既定のパラメータより弱いハッシュは、次にログインに成功したときに作り直します。

セッションのトークンは 32 バイトの乱数（base64url）で、クッキー `loc_studio_session` で渡します。クッキーは `HttpOnly`、`SameSite=Lax`、`Path=/` で、`Max-Age` はセッションの期限（`sessionMaxHours` を超えない）です。HTTPS の要求（`trustedProxyHops` が 1 以上なら `X-Forwarded-Proto: https` を含む）では `Secure` も付きます。サーバーの DB には、トークンの SHA-256 だけを保存します。期限は最後に使ってから `sessionTtlHours` で、期限を延ばす書き込みは 1 分に 1 回までです。使い続けても、ログインしてから `sessionMaxHours`（既定 720 時間）で期限が切れます。この延長は、サーバーの DB にある期限についてのものです。クッキーを出すのはログインとパスワードの変更のときだけで、クッキーの `Max-Age` はそのときの値のまま延びません（ブラウザがクッキーを捨てる時点の動作は、確かめていません）。

ログアウトすると、そのセッションが無効になります。次の操作では、その人のセッションがすべて無効になります: 本人のパスワードの変更（変更した画面には新しいセッションが渡されます）、管理者によるパスワードの再設定、利用者の無効化と削除、コマンドラインの `user passwd` と `user logout`。

ログインの失敗は、3 つの組み合わせで数えます。

| 数える単位 | 待たずに失敗できる回数 | 超えたとき |
| --- | --- | --- |
| ログイン名と接続元のアドレスの組 | 5 回 | 5 回目の失敗のあと 30 秒待たせ、以後は失敗のたびに待ち時間を倍にする（最長 1 時間） |
| 接続元のアドレス（名前を問わない） | 20 回 | 10 秒から倍にしていく（最長 1 時間） |
| ログイン名（アドレスを問わない） | 100 回 | 断らず、サーバー側で応答を遅らせるだけ（超えた回数 × 100 ミリ秒、最長 3 秒） |

待たせている間の試行は、正しいパスワードでも `throttled`（HTTP 429。`Retry-After` ヘッダーに残りの秒数、`data.retryAfterMs` に残りのミリ秒）になります。ログインの画面には、やり直せるまでの残りの秒数が出ます。ログイン名だけの単位では断らないので、ほかの人が失敗を重ねても、本人が別のアドレスからログインできなくなることはありません。成功すると、名前とアドレスの組の記録は消え、ほかの 2 つは 1 回分減ります。記録は、最後の失敗から 24 時間で消えます。存在しない名前も同じように数え、同じだけ時間をかけます。本人のパスワードの変更（いまのパスワードの確認）にも、同じ数え方を使います。

接続元のアドレスは、IPv4 ならそのアドレス、IPv6 なら先頭の 64 ビット（/64）でまとめます（IPv4 を IPv6 の形で書いたアドレスは IPv4 として扱います）。IPv6 では 1 つの利用者が多数のアドレスを使えるためです。どのアドレスを接続元とみなすかは、`auth.trustedProxyHops` で決めます。0（既定）では接続そのもののアドレスを使い、`X-Forwarded-For` は見ません。リバースプロキシの後ろでは、全員がプロキシのアドレスから来るように見えるので、プロキシの段数を書きます（1 段なら 1）。誰でも付けられるヘッダーなので、実際の段数より大きい値は書かないでください。

エラーの文言は「名前かパスワードが違います。」の 1 つで、名前があるか、パスワードが設定されているか、無効かどうかは区別しません。パスワードを確かめる計算（scrypt）は、1 つのサーバーのプロセスで同時に 2 つまで、待ちは 32 個までで、それを超えると `throttled` です。そのうち、同じ接続元のアドレスが占められるのは、計算中と待ちを合わせて 2 つまでです。超えた試行は、すぐに `throttled`（`data.reason` が `"address-busy"`）になり、失敗として数えます。1 つのアドレスからログインを大量に送っても、ほかのアドレスからのログインを待たせられないようにするためです。待ち 32 個のうち 8 個は、過去 30 日にそのアドレス（IPv6 は /64）からログインに成功したことがある試行だけが使え、枠が空くとこちらを先に進めます。

`/api/auth/login`、`/api/auth/logout`、`/api/session` 以外の API は、セッションがなければ 401 です。ほかのサイトからの要求の扱いは 10.1 にあります。

## 6. 権限

管理者は、サーバー全体の管理者です。利用者と権限を管理でき、すべてのプロジェクトで manager として扱われます。管理者でない利用者は、プロジェクトごとに役割を 1 つ割り当てられます。割り当てのないプロジェクトは開けず、一覧にも出ません。

役割は、プロジェクトごとに決められます。次の表は、同梱の 4 つの役割です。プロジェクト設定の `roles` で、役割を足したり、同梱の役割を置き換えたりできます。触れる列、実行できるアクション、見えるリソースを役割ごとに絞ることもできます（[CONFIG.md の roles](CONFIG.md#roles)）。

| できること | viewer | translator | reviewer | manager |
| --- | --- | --- | --- | --- |
| 見る（行、履歴、レビュー、検索、検証）と、自分の設定の変更 | ○ | ○ | ○ | ○ |
| 本文の編集と保存、列の値の変更（レビュー列以外） | － | ○ | － | ○ |
| レビューの投稿と転載 | － | － | ○ | ○ |
| アクションと生成の実行 | － | ○ | ○ | ○ |
| 行の追加・削除・キーの変更、リソースの作成 | － | － | － | ○ |
| ほかの人が始めたジョブの取り消し | － | － | － | ○ |
| プロジェクト設定の一部の変更（下記）、プラグインの再読み込み | － | － | － | ○ |
| プロジェクト設定のそのほかの項目の変更 | 管理者だけ | | | |
| 利用者と権限の管理（サーバー全体） | 管理者だけ | | | |

画面では、役割の定義の `label` を表示します（同梱の役割は「閲覧」「翻訳」「レビュー」「管理」）。

割り当てられるのは、そのプロジェクトの役割だけです。プロジェクトにない役割を割り当てようとすると `invalid` で断ります。プロジェクトを開けないとき（設定が壊れているなど）は、同梱の役割だけを割り当てられます。割り当てたあとで役割が設定から消えると、その利用者は、見ることも含めて何もできなくなります（`forbidden`）。

ステータスや判定の値ごとに、選べる役割を決めることもできます（[CONFIG.md の列挙の選択肢](CONFIG.md#列挙enumの選択肢)の `roles`）。

`manage` の権限がある役割（同梱では manager）が変えられるプロジェクト設定の項目は、`name`、`languages`、`columns`、`validators`、`validation`、`languageSets`、`grid`、`editor`、`localSettings` です。`storage`、`pluginDirs`、`tree`、`formats`、`syntaxes`、`sources`、`generators`、`actions`、`hooks`、`review`、`roles` は、サーバーの管理者だけが変えられます。`roles` 以外は、サーバー上で動くコードや、ファイルと DB の場所を決める項目だからです。`roles` は、`manage` の権限がある人が自分の役割の絞り込みを外せないようにするためです。管理者でない人がこれらを含む変更を送ると、変更全体を断ります（`forbidden`、`data.keys` に該当する項目）。設定にない項目は `invalid` です。

割り当てに言語の一覧を付けると、その利用者が編集とレビューをできるのは、その言語のセルだけになります。共通グループ（entry スコープ）の列は、言語の制限を受けません。

- 1 つのセルを扱う操作（本文の編集、列の値の変更、レビューの投稿と転載）は、言語が合わなければ `forbidden` です。複数行の一括変更も、言語が合わなければ全体を断ります。
- 保存、すべて保存、未保存の変更の取り消しは、自分の言語のドラフトだけを扱い、ほかの言語のドラフトはそのまま残します（エラーにしません）。
- アクションが返したセルの変更も同じ規則で確かめ、許されない変更は結果のエラーに入ります（ほかの変更は反映します）。生成は編集ではない（キャッシュ）ので、言語の制限を受けません。

権限はサービス層が確かめます。画面で隠すだけではないので、API を直接呼んでも同じ結果です。

## 7. 画面

ログインすると、開けるプロジェクトの一覧が出ます。各プロジェクトには、自分の役割と担当の言語が出ます。開けるプロジェクトが 1 つだけなら、そのまま開きます。URL に `?project=<id>` を付けても、プロジェクトは開きません（開くのは一覧から選んだときだけです）。

上のバーには、プロジェクト名、「プロジェクト一覧」、役割（担当の言語つき）、利用者のメニューが出ます。利用者のメニューには、表示名、ログイン名、「パスワードの変更」、「管理」（管理者だけ）、「ログアウト」があります。`proxy` モードでは「パスワードの変更」と「ログアウト」は出ません。

役割で許されない操作のボタンや入力は無効になり、マウスを置くと理由（「読み取り専用です」「この言語は担当外です」など）が出ます。プロジェクト設定を変えられるのは manager だけで、一部の項目はサーバーの管理者だけが変えられます（6 章）。設定の画面の「個人設定」タブはその利用者だけの設定です（サーバーの DB に保存します）。

管理の画面には 2 つのタブがあります。

- 「利用者」: 利用者の追加（ログイン名、表示名、初期パスワード、管理者）、パスワードの再設定、有効と無効の切り替え、管理者の切り替え、削除。自分の行の「無効にする」「管理者から外す」「削除」は使えません。削除すると、アカウントと権限の割り当てと個人設定が消えます。履歴やレビューに残った名前は消えません。
- 「プロジェクトの権限」: プロジェクトを選ぶと、割り当ての一覧が出ます。一覧で役割を変え、「言語を選ぶ」で担当の言語を選び（選ばなければすべての言語）、「外す」で割り当てを外します。下の欄で利用者と役割を選んで「割り当てる」と、割り当てが増えます。

同じセルを 2 人が編集した場合の扱いは 8 章にあります。

## 8. ローカルモードとの違い

ユーザー名は、アカウントのログイン名です。設定では変えられません。履歴、レビュー、ドラフト、ジョブには、この名前が残ります。

ローカル設定の代わりに、利用者ごとの設定をサーバーの DB に置きます（テーマ、レビューの転載など）。プロジェクト設定の `localSettings.defaults` と `enforce` は同じように効きます。`user.name` と `secrets.*` は利用者が変えられません。プラグインが読む秘密情報は、サーバーの環境変数 `LOC_STUDIO_SECRET_<名前>` で渡します。

プラグインは、アプリのフォルダ（`LOC_STUDIO_APP_DIR` の `plugins/` と `LOC_STUDIO_PLUGIN_DIRS`）とプロジェクトのプラグインフォルダのものだけを読み込みます。プロジェクトのプラグインフォルダ（`pluginDirs`）は、プロジェクトのフォルダかアプリのフォルダの中にあるものだけを使い、外を指すものは警告を出して読みません。置いたのは管理者なので、プラグインもコードの設定（`loc-studio.config.*`）も、信頼の確認なしで読み込みます。利用者ごとのプラグインフォルダ（local 層）は使いません。独自描画のモジュール（[plugins/renderer.md](plugins/renderer.md)）も、このプラグインのものだけが配られます。

管理者でない利用者に返す値からは、サーバーのパスと接続先を伏せます。`info()` の `root` と `storage.path`、`settings()` の `localFile` と `projectFile` は空になり、`settings()` の `project` からは、基盤の項目（`storage`、`pluginDirs`、`tree`、`formats`、`syntaxes`、`sources`、`generators`、`actions`、`review`）をすべて除きます。生成器の接続先もここに含まれます。画面の設定のダイアログも、管理者でない利用者には保存先とプラグインフォルダの欄を出しません。そのほかの文字列（エラーの文言を含む）の中の既知のパスは、`<project>`（プロジェクトのフォルダ）、`<app>`（アプリのフォルダ）、`<data>`（そのプロジェクトのワークスペースのデータ）、`<settings>`（ワークスペースの `settings.json`）、`<storage>`（共有 DB）、`<server>`（データフォルダとサーバーの DB）に置き換えます。ジョブの失敗、セルと行のエラー、アクションのエラーの文言とエラーの文言の中の接続先（URL、IP アドレス、`ホスト:ポート`、`localhost:ポート` など）は `<接続先>` に置き換えます。生成器の接続先は管理者だけが見られる設定なので、失敗の文言から漏れないようにするためです。ポートもパスもない、ただのホスト名は置き換えません（`localhost` は置き換えます）。サーバーの内部の失敗（`failed`）は、「サーバーで問題が起きました（参照番号: …）」の文言だけを返し、詳しい内容は同じ参照番号を付けてサーバーの標準エラー出力に書きます。管理者には伏せずに返します。

未保存の本文（ドラフト）は、サーバー上の 1 つの作業コピーを全員で共有します。ドラフトには書いた人が残り、表と編集モーダルに「○○さんが編集中」と出ます。画面は 4 秒ごとに変更を確かめ、ほかの人の確定や値の変更があれば表示中の行を読み直します。

同じセルを 2 人が編集した場合、画面は編集を始めたときの値をサーバーに渡します。そのあいだにほかの人がそのセルを確定していたら、サーバーは上書きせず、画面に「ほかの人が先にこのセルを変更しました」のダイアログが出ます。両方の値を見比べて、「相手の変更を使う」か「自分の変更で上書きする」を選びます。ステータスなどの列の値は、ローカルモードと同じく版番号で競合を検出し、「ほかの人が先に変更しました」のダイアログが出ます。

ジョブには開始した人が残ります。ほかの人が始めたジョブを取り消せるのは、`manage` の権限がある役割（同梱では manager）だけです。

1 回の要求で扱える量には上限があります。これはローカルモードでも同じです。

| 対象 | 上限 |
| --- | --- |
| `rows` の `limit` | 2000（大きい値は 2000 に切り詰める） |
| `history` の `limit` | 1000（同上） |
| `rows` の `filters` | 50 個（超えると `invalid`） |
| `stats` の `resourceIds` | 500 個（超えると `invalid`） |
| 実行中・待機中のジョブ | 利用者ごとに 3 つ、プロジェクトごとに 20 個（超えると `throttled`） |

`languages` と `resourceIds` の重複は除きます。レビューの手動の転載（`forwardReview`）は、プロジェクト設定の `review.targets` に書かれたアクションだけを使えます。

Web モードでは、デスクトップ版（Electron）は使いません。環境変数 `LOC_STUDIO_PROJECT` も使いません。

## 9. データの保護、できないこと、確かめていないこと

loc-studio にはバックアップと復元のコマンドはありません。守る対象は、1 章の表のサーバーの設定ファイル、サーバーの DB、ワークスペースのデータ、プロジェクトのフォルダ（共有 DB を含む）です。共有 DB やサーバーの DB を Postgres に置いた場合は、そのデータベースも対象です。`@loc-studio/store` の DB には `backup(toPath)` があります。SQLite ではファイルの写しを作り、Postgres では中身を JSON Lines に書き出します（Postgres の書き出しを読み戻す機能はありません）。どちらもコマンドラインや画面からは呼べません（[packages/store/README.md](../packages/store/README.md)）。

コマンドラインの `user` / `member` / `server check` は、サーバーの DB を直接開きます。SQLite のサーバーの DB では、サーバーの起動中に実行できることを確かめました。

運用で知っておくことは次のとおりです。

- サーバーのディスクにあるプラグインとコードの設定は、確認なしで読み込まれ、サーバーのプロセスの権限で何でもできます。サーバー上のプロジェクトのフォルダやアプリのフォルダに書き込める人は、サーバーでコードを実行できる人です。書き込みの権限は、それを前提に決めてください。
- 伏せる処理は、既知のパス（1 章の場所と共有 DB）と、URL や `ホスト:ポート` の形の接続先を置き換えるだけです。ポートもパスもないホスト名（`localhost` を除く）や、プラグインが返したメッセージの中の別の場所のパスや情報は、そのまま利用者に見えます。
- パスワードの計算の同時数と、ジョブの数の上限は、サーバーのプロセスごとです。複数のプロセスを動かすと、上限もプロセスの数だけ増えます。
- ログインの計算の枠は、1 つのアドレス（IPv6 は /64）が占める数を 2 つに抑えていますが、多数の別々のアドレスから同時に送られると、全体の枠が埋まり、その間のログインは `throttled` になります。待ち 32 個のうち 8 個は、過去 30 日にログインに成功したことのあるアドレスのために取ってあり、空いたときもそちらを先に進めるので、いつも使っている人は締め出されにくくなっています。初めてのアドレスからのログインは、断られることがあります。公開の場所に置くときは、前段のプロキシで接続元ごとの要求の数を制限してください。
- Web の層で起きた失敗のうち、サービス層のエラーとして整えられていないもの（サーバーの DB を開けない、原因つきでプロジェクトを開けない、など）は、ログインの前の要求にも届くので、利用者が管理者かどうかに関係なく、「サーバーで問題が起きました（参照番号 …）」と参照番号だけを返します。詳しい内容（パスや DB のエラー）は、同じ参照番号でサーバーの標準エラー出力に出ます。サービス層のエラーのうち `failed` は、管理者でない利用者にだけ同じように伏せます（8 章）。
- `allowedHosts`（または `LOC_STUDIO_ALLOWED_HOSTS`）を書かないと、プロキシを通した要求はすべて 421 で断られます。
- ページの CSP は `style-src 'unsafe-inline'` を許しています（React の `style` 属性のため）。スクリプトとは別ですが、挿入されたスタイルは効きます。

確かめていないことは次のとおりです。

- 実際のリバースプロキシ（nginx、社内 SSO など）の後ろでの動作。確かめたのは、`curl` で `Host`、`X-Forwarded-Host`、`X-Forwarded-Proto`、`X-Forwarded-For`、`proxy` モードのヘッダーを付けた要求だけです。
- Windows と macOS のサーバーでの動作。
- サーバーの DB とプロジェクトの共有 DB の Postgres は、PostgreSQL 16 でだけ確かめました。

## 10. API（実装者向け）

### 10.1 HTTP の口（`apps/web/app/api`）

| 口 | 内容 |
| --- | --- |
| `GET /api/session` | `{ mode, defaultProject?, recentProjects, desktop }`。Web モードでは `{ mode: "web", recentProjects: [], desktop: false }` |
| `POST /api/auth/login` | `{ name, password }`。成功するとセッションのクッキーと `{ result: { user, expiresAt } }`。`proxy` モードとローカルモードでは使えない |
| `POST /api/auth/logout` | セッションを無効にしてクッキーを消す（`Max-Age=0`） |
| `GET /api/auth/me` | `{ result: { mode, user, admin, authMode, projects: [{ id, name, role, languages? }] } }`。ログインしていなければ 401（`data.authMode` つき）。ローカルモードでは `{ result: { mode: "local" } }` |
| `POST /api/auth/password` | `{ oldPassword, newPassword }`。本人のパスワードを変え、新しいセッションのクッキーを返す |
| `POST /api/admin/<op>` | 管理の操作。`op` は `projects`、`listUsers`、`createUser`、`updateUser`、`setPassword`、`deleteUser`、`listMemberships`、`setMembership`、`removeMembership`。管理者でなければ 403 |
| `POST /api/rpc/<method>` | 本文 `{ project?, params? }`。Web モードでは `project` にサーバーの設定の `id` を渡す。知らないメソッドは本文を読まずに 404 |
| `GET /api/renderer/<id>?project=…&h=…` | 独自描画のモジュール。このプロセスですでに開いたプロジェクトのものだけを返す。`h` がいまのハッシュと同じなら `Cache-Control: private, max-age=31536000, immutable`、違えば `no-store`。開けない利用者、開いていないプロジェクト、知らない id は 404 |
| `POST /api/session/open` | ローカルモードだけ。Web モードでは 403 |

GET でプロジェクトを開く口はありません。ローカルモードでプロジェクトを開くのは、`POST /api/session/open` と RPC（`project` にフォルダのパス）だけです。

API への要求に対して、サーバーは本文を読む前に次の順で確かめます。ページと静的ファイルへの要求で確かめるのは、1 と 2 と、ローカルモードの起動の合言葉だけです。

1. 設定（モードと、Web モードのサーバーの設定）。誤りがあれば 500。
2. ホスト名（`Host`、`trustedProxyHops` が 1 以上なら `X-Forwarded-Host`）。ループバックの名前、`allowedHosts`、`LOC_STUDIO_ALLOWED_HOSTS` のどれでもなければ 421。
3. 認証。ローカルモードは起動の合言葉のクッキー（`loc_studio_local_<ポート>`）、Web モードはセッション（`/api/auth/login`、`/api/auth/logout`、`/api/session`、`/api/auth/me` を除く。`/api/auth/me` はログインしていなければ 401 を返す）。なければ API は 401（ローカルモードのページは「loc-studio を開くには」のページを 401 で返す）。
4. 同じオリジンからの要求か。`Sec-Fetch-Site` があれば `same-origin` でなければ 403、`Origin` があれば 2 のホスト名と同じでなければ 403。どちらのヘッダーもない要求（`curl` などブラウザ以外の道具）は、3 の認証が通っていれば受け付けます（ログインの口は認証なしで受け付けます）。
5. 本文。`Content-Type` が JSON でなければ 415、大きさが上限を超えれば 413、JSON として読めないか、オブジェクトでなければ 400。上限は、ログイン、パスワードの変更、`/api/session/open` が 16 KB、管理の口が 64 KB、RPC が 1 MB（`setText`、`setCells`、`updateProjectSettings` だけは 8 MB）です。

ローカルモードの RPC は、メソッドの失敗も HTTP 200 で `{ error }` を返します（上の 1〜5 で断った場合と、知らないメソッドの 404 を除く）。Web モードの RPC は、失敗を 10.4 の表の HTTP の状態で返します。

`curl` で呼ぶ例です（どちらもこの文書の作成時に実行しました）。ローカルモードでは、起動時に表示された合言葉をクッキーとして送ります。

```sh
T=<起動時に表示された token の値>
curl -s -H "Cookie: loc_studio_local_3000=$T" -H 'Content-Type: application/json' \
  -d '{}' http://127.0.0.1:3000/api/rpc/info
```

Web モードでは、ログインで受け取ったセッションのクッキーを使います。

```sh
curl -s -c jar -H 'Content-Type: application/json' \
  -d '{"name":"alice","password":"…"}' http://127.0.0.1:3000/api/auth/login
curl -s -b jar -H 'Content-Type: application/json' \
  -d '{"project":"mygame"}' http://127.0.0.1:3000/api/rpc/info
```

応答には次のヘッダーが付きます。ページには要求ごとの nonce を使った CSP（`default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`）、API と独自描画のモジュールには `default-src 'none'` で始まる CSP が付きます。どの応答にも `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Resource-Policy: same-origin` が付きます。

### 10.2 ServerRuntime

```ts
openServerRuntime(opts: {
  mode: "local" | "web";
  dataDir: string;                       // ワークスペースのデータ（Web: <dataDir>/workspaces/<projectId>）と server.json の既定の場所
  env?: Record<string, string | undefined>;
  config?: ServerConfig;                 // 省略時（web）は serverConfigPath(env, dataDir) を loadServerConfig で読む
  appDir?: string; sdkPath?: string; extraBuiltins?: Plugin[]; now?: () => Date;
  workspaceOptions?: Partial<WorkspaceOptions>;
}): Promise<ServerRuntime>

interface ServerRuntime {
  readonly mode: "local" | "web";
  readonly config: ServerConfig | undefined;
  readonly auth: AuthService | undefined;            // web だけ
  projects(user?: AuthUser): Promise<{ id: string; name: string; role?: Role; languages?: string[] }[]>;   // web: user が開けるもの
  workspace(projectId: string): Promise<Workspace>;  // web: pluginTrust "always"、localPlugins false、userSettings は AuthService
  handle(req: { projectId: string; method: string; params?: unknown; user?: AuthUser }): Promise<RpcResponse>;
  rendererModule(req: { projectId: string; id: string; user?: AuthUser }): Promise<{ source: string; hash: string; contentType: "text/javascript" } | undefined>;
  readonly admin: AdminApi;
  close(): Promise<void>;
}
```

`handle` は失敗も `{ error: { code, message, data? } }` で返し、例外にしません。Web モードでは、`user` がなければ `unauthorized`、知らないプロジェクトは `not-found`、権限がなければ `forbidden` です。ローカルモードでは `user` を使わず、`projectId` は設定のプロジェクトの id か、プロジェクトのフォルダの絶対パスです。

`rendererModule` は、プロジェクトを開けない利用者と、登録されていない id には `undefined` を返します（Web の層は 404 にします）。

`mode: "web"` で `LOC_STUDIO_ADMIN_USER` と `LOC_STUDIO_ADMIN_PASSWORD` が `env` にあり、`auth.mode` が `password` なら、開くときに `bootstrapAdmin` を呼びます。そのあと、この 2 つを `env` から消します。`auth.proxySecretEnv` があってその変数が `env` にないと、例外にします。Web モードのワークスペースは、`webMode`（`allowedEnv` = `projects[].env`、プラグインフォルダの基準 = プロジェクトとアプリのフォルダ、伏せるパス）を付けて開きます。

```ts
interface AdminApi {      // どれも actor が（いまの DB で）有効な管理者でなければ forbidden。web モードだけ
  listUsers(actor: AuthUser): Promise<AuthUser[]>;
  createUser(actor, input: { name: string; password?: string; displayName?: string; admin?: boolean }): Promise<AuthUser>;
  updateUser(actor, name: string, patch: { displayName?: string; admin?: boolean; disabled?: boolean }): Promise<AuthUser>;  // 自分を外す・無効にするのは invalid
  setPassword(actor, name: string, password: string): Promise<void>;
  deleteUser(actor, name: string): Promise<void>;                                  // 自分は invalid
  listMemberships(actor, projectId?: string): Promise<Membership[]>;
  setMembership(actor, projectId: string, user: string, m: { role: Role; languages?: string[] }): Promise<Membership>;
  removeMembership(actor, projectId: string, user: string): Promise<void>;
}
```

### 10.3 AuthService（`runtime.auth`）

```ts
interface AuthUser { name: string; displayName: string; admin: boolean; disabled: boolean; hasPassword: boolean; createdAt: string; updatedAt: string }
interface Membership { projectId: string; user: string; role: Role; languages?: string[] }

login({ name, password, clientAddress }): Promise<{ token: string; user: AuthUser; expiresAt: string }>   // unauthorized / throttled。proxy モードでは invalid
authenticate(token): Promise<AuthUser | undefined>          // 期限切れ・無効な利用者は undefined。期限を延ばす（sessionMaxHours まで）
authenticateProxyUser(name, { secret? }): Promise<AuthUser | undefined>  // proxy モードだけ。合言葉があれば secret を照合。初めての名前は登録（admins にあれば管理者）。無効なら undefined
logout(token): Promise<void>;  logoutAll(name): Promise<void>
changePassword({ name, oldPassword, newPassword, clientAddress }): Promise<void>   // 本人用。ログインと同じ総当たり対策。いまのパスワードが違えば unauthorized。ほかのセッションも無効
purge(): Promise<{ sessions: number; throttle: number }>   // 期限の切れたセッションと古い失敗の記録を消す
createUser / listUsers / getUser / updateUser / setPassword / deleteUser / bootstrapAdmin({ name, password }): Promise<boolean>
setMembership / removeMembership / listMemberships({ projectId?, user? })
callContextFor(user, projectId): Promise<CallContext | undefined>    // 管理者はどこでも manager で、admin: true
getUserSettings(name) / setUserSettings(name, values) / userSettingsStore(): UserSettingsStore
openAuthService({ db: HostDb, config: AuthConfig, now? }): AuthService   // 単体でも使える
```

アカウントなどは、`HostDb` の名前空間 `auth.*` に置きます。SQLite でも Postgres でも同じです。ログイン名を受け取るメソッドは、5 章の規則で正規化してから扱います。接続元のアドレスの求め方は `packages/server/src/server-config.ts` の `clientAddressFrom(req, trustedProxyHops)` です（`@loc-studio/server` の入口から export しています）。

Web の層の流れは次のとおりです。クッキーのトークンを `auth.authenticate` に渡します（`proxy` モードではヘッダーの名前を `auth.authenticateProxyUser` に渡します）。得た `AuthUser` を `runtime.handle({ projectId, method, params, user })` に渡します。

### 10.4 エラーの code と HTTP の状態

| code | 意味 | HTTP |
| --- | --- | --- |
| `unauthorized` | ログインしていない、ログインの失敗 | 401 |
| `forbidden` | 権限がない、ほかのオリジンからの要求 | 403 |
| `not-found` | メソッド・プロジェクト・リソース・行がない | 404 |
| `throttled` | ログインの失敗が続いた、混んでいる、ジョブが多すぎる（`data.retryAfterMs` があれば `Retry-After` ヘッダーも付く） | 429 |
| `conflict` | 版の競合、同じセルの同時編集（`data` にいまの値） | 409 |
| `blocked` | 本文の問題で止めた、読み取り専用の言語 | 409 |
| `untrusted` | コードの設定を信頼するまで使えない | 409 |
| `invalid` | 引数の誤り | 400 |
| `locked` | DB のロック待ち、固定された設定 | 423 |
| `failed` | そのほか | 500 |

このほかに、Web の層が 413（本文が大きすぎる）、415（JSON でない）、421（許可されていないホスト名）を返します。

`untrusted` は、ローカルモードの制限された状態のワークスペースだけが返します（[SERVER-API.md](SERVER-API.md#制限された状態)）。ローカルモードの RPC はメソッドの失敗を HTTP 200 で返すので、409 になるのは Web モードだけですが、Web モードでは信頼の確認をしないので、実際には出ません。

### 10.5 権限の表（`METHOD_CAPABILITIES`）

役割の列は、同梱の役割の場合です。プロジェクト設定の `roles` で決めた役割は、その `can` で決まります。

| 権限 | viewer | translator | reviewer | manager | メソッド |
| --- | --- | --- | --- | --- | --- |
| view | ○ | ○ | ○ | ○ | info, tree, stats, rows, rowDetail, history, reviews, textVersion, validateText, search, tokens, settings, plugins, jobs, job, changes, validate, reloadResource |
| self | ○ | ○ | ○ | ○ | setLocalSetting（`user.name` と `secrets.*` は forbidden） |
| edit | － | ○ | － | ○ | setText, discardDrafts, save, saveAll, setCell, setCells |
| review | － | － | ○ | ○ | postReview, forwardReview |
| run | － | ○ | ○ | ○ | runAction, generate, cancelJob（ほかの人のジョブは `manage` の権限がある役割だけ） |
| structure | － | － | － | ○ | editEntries, createResource |
| manage | － | － | － | ○ | updateProjectSettings（管理者だけの項目は 6 章）, reloadPlugins |
| local-only | － | － | － | － | trustPlugins, untrustPlugins |

メソッドと権限の対応は `packages/server/src/permissions.ts`、同梱の役割は `packages/core/src/roles.ts` にあります。`WorkspaceApi` にメソッドを足して表に足さないと、型の確認で失敗します。

メソッドを呼べるかに加えて、書き込みの直前に、役割の絞り込み（`editColumns`、`reviewColumns`、`actions`、`generators`）と言語の制限を確かめます。役割の `resources` で見えないリソースは、どのメソッドでも `not-found` です。

### 10.6 サーバーの設定の API

```ts
loadServerConfig(file: string, env?): ServerConfig
parseServerConfig(raw: unknown, { baseDir, env, where? }): ServerConfig
serverConfigPath(env, dataDir): string   // LOC_STUDIO_SERVER_CONFIG → <LOC_STUDIO_USER_DATA_DIR か dataDir>/server.json
interface ServerConfig {
  projects: { id: string; name: string; root: string; env?: string[] }[];
  auth: {
    mode: "password" | "proxy"; sessionTtlHours: number; sessionMaxHours?: number; proxyHeader: string;
    proxySecretHeader?: string; proxySecretEnv?: string; admins: string[]; trustedProxyHops?: number;
  };
  serverDb: { driver: "sqlite"; path: string } | { driver: "postgres"; url: string; schema?: string };
}
```

### 10.7 そのほか

- 利用者ごとの設定は、`info().localSettings`、`settings()`、`setLocalSetting` で、呼び出した利用者のものが出ます（プロジェクトの `enforce` / `defaults` も効きます）。`settings().localFile` は空文字です。
- 同じセルの同時編集: 画面は編集を始めたときの値を `setText` の `baseValue` に渡します。いまの値（ドラフト込み）が `baseValue` とも新しい値とも違えば `conflict`（`data: { value, by? }`）です。
- サーバーの DB への書き込みの記録者名は `"server"` です。プロジェクトの DB の記録は、呼び出した利用者の名前です。
- 伏せる処理は `packages/server/src/redact.ts` の 1 か所で、`dispatch` と `ServerRuntime.handle` が、`call.admin` でない呼び出しに使います。`Workspace.redaction()` が伏せるパスとログの書き先を返します。
