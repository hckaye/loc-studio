/**
 * 設定の確認の画面が出す Postgres の接続先（core の postgresDestination）が、共有 DB のドライバー（pg）が使う
 * pg-connection-string の parse() と同じであることを確かめる。
 */
import { describe, expect, it } from "vitest";
import { parse } from "pg-connection-string";
import { postgresDestination } from "@loc-studio/core";

const URLS = [
  "postgres://user:pw@db.example:5432/loc",
  "postgres://user@db.good.example:5432/loc?host=127.0.0.1&port=9988",
  "postgres:///db?host=evil.example",
  "postgres:///db?host=evil.example&port=1234",
  "postgres://u@good.example/db?hostaddr=10.9.9.9",
  "postgres://u@good.example:6543/db?hostaddr=10.9.9.9&host=other.example",
  "postgres://u@%2Fvar%2Frun%2Fpostgresql/db",
  "postgres://good.example/db?host=/tmp/sock",
  "postgresql://[::1]:5433/db",
  "postgresql://u:p@[2001:db8::7]/db",
  "postgres://u@/db",
  "postgres://u:p@good.example/db?host=a.example&host=b.example",
  "socket:/var/run/pg?db=loc&encoding=utf8",
  "/var/run/postgresql loc",
  "postgres://u@good.example:5432/my db?host=spaced.example",
  "postgres://good.example/db?port=",
];

describe("postgresDestination と pg-connection-string の parse()", () => {
  for (const url of URLS) {
    it(url, () => {
      const ours = postgresDestination(url)!;
      const theirs = parse(url);
      expect(ours.host).toBe(theirs.host ?? "");
      expect(ours.port).toBe(theirs.port ?? "");
    });
  }
});
