/**
 * テスト用の Postgres。
 *
 * - 環境変数 LOC_STUDIO_TEST_PG_URL があれば、そのサーバーを使う（テストはスキーマを作って消すだけ）。
 * - なければ、Postgres のプログラム（initdb / pg_ctl。LOC_STUDIO_TEST_PG_BIN で場所を指定できる）を探し、一時フォルダに使い捨てのクラスタを作って起動する。
 *   root では initdb / postgres が動かないため、root のときは OS ユーザー postgres として動かす。
 * - どちらもなければ、理由つきで「使えない」を返す（テストは失敗ではなくスキップする）。
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, promises as fs, readdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type TestPg = { url: string; stop(): Promise<void> } | { url?: undefined; skipReason: string };

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

/** initdb と pg_ctl があるフォルダを探す。 */
function findBinDir(): string | undefined {
  const candidates: string[] = [];
  // 指定されていれば、そのフォルダだけを見る。
  const explicit = process.env.LOC_STUDIO_TEST_PG_BIN;
  if (explicit) candidates.push(explicit);
  else candidates.push(...defaultBinDirs());
  return candidates.find((d) => existsSync(path.join(d, exe("initdb"))) && existsSync(path.join(d, exe("pg_ctl"))));
}

function defaultBinDirs(): string[] {
  const candidates: string[] = [];
  const debianRoot = "/usr/lib/postgresql";
  if (existsSync(debianRoot)) {
    const versions = readdirSync(debianRoot)
      .filter((v) => /^\d+$/.test(v))
      .sort((a, b) => Number(b) - Number(a));
    for (const v of versions) candidates.push(path.join(debianRoot, v, "bin"));
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir) candidates.push(dir);
  return candidates;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function startTestPg(): Promise<TestPg> {
  const fromEnv = process.env.LOC_STUDIO_TEST_PG_URL;
  if (fromEnv) return { url: fromEnv, stop: async () => undefined };

  const bin = findBinDir();
  if (!bin) {
    return {
      skipReason:
        "Postgres のテストを飛ばします: initdb / pg_ctl が見つからず、LOC_STUDIO_TEST_PG_URL も設定されていません",
    };
  }

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  let ids: { uid: number; gid: number } | undefined;
  if (isRoot) {
    try {
      ids = {
        uid: Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim()),
        gid: Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim()),
      };
    } catch {
      return { skipReason: "Postgres のテストを飛ばします: root で動いていますが、OS ユーザー postgres がいません" };
    }
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loc-pg-"));
  const data = path.join(dir, "data");
  const logFile = path.join(dir, "server.log");
  if (ids) await fs.chown(dir, ids.uid, ids.gid);
  const opts = { cwd: dir, ...(ids ?? {}), env: { ...process.env, LC_ALL: "C" } };
  const port = await freePort();
  const stop = async () => {
    await run(path.join(bin, exe("pg_ctl")), ["-D", data, "-m", "immediate", "-w", "stop"], opts).catch(
      () => undefined,
    );
    await fs.rm(dir, { recursive: true, force: true });
  };
  try {
    await run(
      path.join(bin, exe("initdb")),
      ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale", "--no-sync"],
      opts,
    );
    const serverOpts = [
      `-p ${port}`,
      `-c listen_addresses=127.0.0.1`,
      // Windows ではソケットのフォルダを使わない。
      ...(process.platform === "win32" ? [] : [`-k ${dir}`]),
      "-c fsync=off",
      "-c max_connections=200",
    ].join(" ");
    await run(
      path.join(bin, exe("pg_ctl")),
      ["-D", data, "-o", serverOpts, "-l", logFile, "-w", "-t", "60", "start"],
      opts,
    );
  } catch (err) {
    const log = await fs.readFile(logFile, "utf8").catch(() => "");
    await stop();
    throw new Error(
      `テスト用の Postgres を起動できませんでした: ${err instanceof Error ? err.message : String(err)}\n${log}`,
      {
        cause: err,
      },
    );
  }
  return { url: `postgres://postgres@127.0.0.1:${port}/postgres`, stop };
}
