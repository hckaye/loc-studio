# @loc-studio/store

`HostDb`（`cells` / `log` / `kv`）の実装です。SQL を書くのはこのパッケージだけです。実装は SQLite と Postgres の 2 つで、どちらも同じ `Store` を返します。

```ts
import { openStore, openPostgresStore } from "@loc-studio/store";

// SQLite（ファイル 1 つ）
const local = await openStore({ path: "/path/to/db.sqlite", userName: () => settings.userName });
// SQLite をネットワーク共有に置いて複数人で使う
const shared = await openStore({ path: "//server/share/loc.sqlite", userName, sharing: { mode: "lockfile" } });
// Postgres
const team = await openPostgresStore({ url: "postgres://user:pass@db:5432/loc", userName, schema: "my_game" });
```

アプリでは、プロジェクトの共有 DB（プロジェクト設定の `storage`。[CONFIG.md](../../docs/CONFIG.md#storage)）と、Web モードのサーバーの DB（`server.json` の `serverDb`。[WEB-MODE.md](../../docs/WEB-MODE.md#3-サーバーの設定ファイル)）を、設定に応じてどちらかで開きます。その PC の DB は常に SQLite です。

## どれを使うか

| 使い方 | 向いている場面 | 制限 |
| --- | --- | --- |
| `openStore`（通常） | 1 台の PC だけで使う DB（その PC の DB、1 人のプロジェクト、1 台のサーバーの Web モード） | 同じファイルをネットワーク越しに複数人で開かない |
| `openStore` + `sharing: { mode: "lockfile" }` | サーバーを立てずに、共有フォルダの 1 ファイルを数人で使う | 書き込みは 1 人ずつ（ロックファイル `<path>.lock`）。WAL を使わない。人数や書き込みが多いと待ちが出る。実際のネットワーク共有では確かめていない |
| `openPostgresStore` | チームで Postgres のサーバーを用意できる。同時の書き込みが多い | サーバーの運用（バックアップ、権限）は別に要る。確かめたのは PostgreSQL 16 だけ |

## Postgres

表は `schema`（既定 `loc_studio`）の中に作り、スキーマがなければ作ります。プロジェクトごとにスキーマを変えれば、1 つのデータベースを複数のプロジェクトで使えます。接続するユーザーには、そのスキーマを作る権限（または作成済みのスキーマへの権限）が要ります。接続プールの接続数は既定 5 です（`maxConnections`）。

開くときにスキーマの版を確かめ、足りない準備の手順を 1 つのトランザクションで当てます。複数のサーバーが同時に起動しても、勧告ロック（`pg_advisory_xact_lock`）で 1 つずつ行います。アプリより新しい版のスキーマは開きません。

値は `text` の列に JSON の文字列のまま置きます（`jsonb` にしません）。`jsonb` はキーの順序や数値の表記を変え、文字列の `\u0000` を受け付けないので、書いた JSON がそのまま戻る SQLite と挙動をそろえるためです。数値は JavaScript の数値の範囲で扱います（SQLite と同じ）。

`set` は、対象の行を決まった順に行ロックしてから版を比べます。まだない行を同時に作った場合やデッドロックは、トランザクションごと自動でやり直します（最大 10 回）。版が合わなければ、SQLite と同じく `StoreConflictError` を投げて何も書きません。

変更番号は、16 行に分けた数の合計です。書き込みは 1 行を 1 増やします。取り消された書き込みでは増えず、コミットと同時に見えます。記録の番号は、追記した順（番号を振った順）に増えます。同時に追記したトランザクションでは、コミットの順と番号の順が入れ替わることがあります。

`backup(toPath)` は書き出しだけで、読み戻す機能はありません。コマンドラインや画面からは呼べません。1 つの REPEATABLE READ のトランザクションで読むので、全体が同じ時点の内容になります。形式は JSON Lines（1 行 1 つの JSON）です。

- 1 行目: `{"type":"header","format":"loc-studio-store-export","formatVersion":1,"schema":…,"schemaVersion":…,"changeSeq":…,"exportedAt":…}`
- セル: `{"type":"cell","ns","resourceId","entryKey","columnId","language","version","updatedAt","updatedBy","basisHash","value"}`（言語なしは `language: ""`）
- 記録: `{"type":"log","ns","seq","id","resourceId","entryKey","columnId","language","at","by","data"}`（セルなしは各項目が `null`）。番号順
- キーと値: `{"type":"kv","ns","key","value"}`

データベース全体を写すには `pg_dump` を使います。

`integrityCheck()` は、スキーマの版、変更番号の行、キーの欠けを確かめるだけです。ストレージの破損は調べません（サーバー側の管理で行います）。

`close()` は、接続プールの終了を始めてすぐに戻ります（終了を待ちません）。

## SQLite

通常は接続を 1 本持ち続けます（WAL、`synchronous=NORMAL`）。

共有モードは、操作ごとに接続を開いて閉じ、`journal_mode=DELETE`、`synchronous=FULL` にします。書き込み（準備とバックアップを含む）は `@loc-studio/core` の `withWriteLock` の中で行います。

`backup(toPath)` はデータベースのファイルの写し（`VACUUM INTO`）を作ります。`integrityCheck()` は `PRAGMA integrity_check` です。

## テスト

```
npx vitest run packages/store
```

`src/testing/store-contract.ts` が契約テストで、SQLite（通常・共有）と Postgres に同じ場合を当てます。Postgres のテストは、次の順にサーバーを決めます。

1. 環境変数 `LOC_STUDIO_TEST_PG_URL` があれば、そのサーバーを使います（テストごとに `t_xxxx` というスキーマを作って消します）。
2. `initdb` / `pg_ctl` が見つかれば（`LOC_STUDIO_TEST_PG_BIN` があれば、そのフォルダだけを見る。なければ `/usr/lib/postgresql/<版>/bin`、`PATH` の順に探す）、一時フォルダに使い捨てのクラスタを作って空いているポートで起動し、終わったら止めて消します。root で動いているときは、OS ユーザー `postgres` として動かします。
3. どちらもなければ、理由を表示して Postgres のテストを飛ばします（失敗にはしません）。

この文書の作成時に、PostgreSQL 16.15 の使い捨てのクラスタで `npx vitest run packages/store packages/server/src/postgres.test.ts` を実行し、すべて通りました。サービス層の `postgres.test.ts` は、プロジェクトの共有 DB とサーバーの DB を Postgres に置く場合を確かめます。
