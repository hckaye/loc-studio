import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { findFreePort } from "./ports.js";
import { waitForReady } from "./readiness.js";
import { redactToken } from "./redact.js";

export interface ServerEnvInput {
  port: number;
  appDir: string;
  userDataDir: string;
  /** 起動の合言葉（LOC_STUDIO_LOCAL_TOKEN）。32 バイト以上の乱数を base64url にしたもの */
  token: string;
  /** 既定で開くプロジェクト */
  project?: string;
  /** 親の環境変数（既定は process.env） */
  baseEnv?: NodeJS.ProcessEnv;
  /** Electron 自身の Node で動かすとき true（ELECTRON_RUN_AS_NODE を付ける） */
  runAsNode?: boolean;
}

/** 起動のたびに新しい合言葉を作る（32 バイト、base64url）。 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/*
 * 子プロセスに引き継ぐ環境変数は許可リスト方式。利用者の環境にある LOC_STUDIO_MODE=web や LOC_STUDIO_HOST=0.0.0.0 などが
 * 紛れ込むと、認証や待ち受けの設定が変わってしまう。拒否リストだと、新しい変数が増えたときに漏れる。
 * 名前は大文字にして比べる（Windows は大文字小文字を区別しない）。
 */
const INHERIT_EXACT = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "USERNAME", "USER", "LOGNAME",
  "COMPUTERNAME", "LANG", "LANGUAGE", "TZ", "SHELL", "DISPLAY", "WAYLAND_DISPLAY",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // 利用者が意図して渡す設定（プラグインの場所、ローカル設定、LLM などの秘密）
  "LOC_STUDIO_PLUGIN_DIRS", "LOC_STUDIO_SETTINGS",
]);
const INHERIT_PREFIX = ["LC_", "XDG_", "LOC_STUDIO_SECRET_"];

function inherited(name: string): boolean {
  const n = name.toUpperCase();
  return INHERIT_EXACT.has(n) || INHERIT_PREFIX.some((p) => n.startsWith(p));
}

export function buildServerEnv(input: ServerEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(input.baseEnv ?? process.env)) {
    if (v !== undefined && inherited(k)) env[k] = v;
  }
  Object.assign(env, {
    PORT: String(input.port),
    NODE_ENV: "production",
    // 利用者の環境に関係なくローカルモードにする（launch.mjs は未設定でも local だが、明示する）
    LOC_STUDIO_MODE: "local",
    LOC_STUDIO_LOCAL_TOKEN: input.token,
    LOC_STUDIO_DESKTOP: "1",
    LOC_STUDIO_APP_DIR: input.appDir,
    LOC_STUDIO_USER_DATA_DIR: input.userDataDir,
  });
  if (input.project) env["LOC_STUDIO_PROJECT"] = input.project;
  if (input.runAsNode) env["ELECTRON_RUN_AS_NODE"] = "1";
  return env;
}

export interface ServerCommand {
  command: string;
  args: string[];
}

/** `--require <watchdog> launch.mjs`。launch.mjs は server.js を同じプロセスで読み込むので、子プロセスは 1 つだけ。watchdog は親が消えたらサーバーを終わらせる。 */
export function buildServerCommand(input: { execPath: string; serverEntry: string; watchdog?: string }): ServerCommand {
  const args: string[] = [];
  if (input.watchdog) args.push("--require", input.watchdog);
  args.push(input.serverEntry);
  return { command: input.execPath, args };
}

export interface StartServerOptions {
  /** 起動する Node（Electron なら process.execPath、runAsNode: true） */
  execPath: string;
  runAsNode?: boolean;
  serverEntry: string;
  watchdog?: string;
  appDir: string;
  userDataDir: string;
  project?: string;
  baseEnv?: NodeJS.ProcessEnv;
  port?: number;
  readyTimeoutMs?: number;
  /** 起動後に予期せず終了したときの通知 */
  onUnexpectedExit?: (info: { code: number | null; signal: NodeJS.Signals | null; output: string }) => void;
}

export interface ServerHandle {
  port: number;
  /** 合言葉を含まない URL（以降の画面遷移、プロジェクトを開く URL の基準） */
  url: string;
  /** 最初に開く URL（?token= つき）。ログやタイトルに出さないこと。 */
  startUrl: string;
  /** この起動の合言葉。ファイルやログに残さないこと。 */
  token: string;
  child: ChildProcess;
  /** 直近の標準出力と標準エラー（合言葉は伏せてある） */
  output(): string;
  stop(): Promise<void>;
  /** 同期的に強制終了する（process の exit イベント用） */
  killNow(): void;
}

const MAX_OUTPUT = 16000;

/** server.js を子プロセスで起動し、応答するまで待つ。失敗したら子プロセスを止めて、出力つきで投げる。 */
export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  if (!existsSync(options.serverEntry)) {
    throw new Error(`サーバーの起動ファイル（launch.mjs）が見つかりません: ${options.serverEntry}\n先に Web アプリをビルドしてください（npm run build:web）。`);
  }
  const port = options.port ?? (await findFreePort());
  const token = generateToken();
  const env = buildServerEnv({
    port,
    token,
    appDir: options.appDir,
    userDataDir: options.userDataDir,
    ...(options.project ? { project: options.project } : {}),
    ...(options.baseEnv ? { baseEnv: options.baseEnv } : {}),
    ...(options.runAsNode ? { runAsNode: true } : {}),
  });
  const watchdog = options.watchdog && existsSync(options.watchdog) ? options.watchdog : undefined;
  const { command, args } = buildServerCommand({ execPath: options.execPath, serverEntry: options.serverEntry, ...(watchdog ? { watchdog } : {}) });
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

  let output = "";
  const append = (d: Buffer) => {
    // 境界をまたいだ合言葉も伏せられるよう、つなげた全体に対して置き換える
    output = redactToken((output + d.toString("utf8")).slice(-MAX_OUTPUT), token);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  let exited: string | undefined;
  let stopping = false;
  let ready = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exited = `終了コード ${code ?? "なし"}${signal ? `（シグナル ${signal}）` : ""}`;
      resolve();
      if (ready && !stopping) options.onUnexpectedExit?.({ code, signal, output });
    });
  });
  child.once("error", (err) => {
    exited = `起動できませんでした（${command}）: ${err.message}`;
    output = redactToken(`${output}\n${exited}`, token);
  });

  const handle: ServerHandle = {
    port,
    url: `http://127.0.0.1:${port}`,
    startUrl: `http://127.0.0.1:${port}/?token=${token}`,
    token,
    child,
    output: () => output,
    killNow: () => {
      stopping = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
    async stop() {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin?.destroy();
      child.kill();
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exitPromise;
      clearTimeout(timer);
    },
  };

  try {
    await waitForReady(`${handle.url}/api/session`, {
      timeoutMs: options.readyTimeoutMs ?? 60000,
      // 合言葉のクッキーなしでは 401 が返る。401 は「サーバーは動いている」の意味。
      okStatuses: [401],
      shouldAbort: () => exited,
    });
    ready = true;
    return handle;
  } catch (err) {
    await handle.stop();
    const reason = redactToken(err instanceof Error ? err.message : String(err), token);
    throw new ServerStartError(reason, output, { cause: err });
  }
}

/** 起動に失敗したときのエラー。サーバーの最後の出力を持つ。 */
export class ServerStartError extends Error {
  constructor(
    message: string,
    public readonly output: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ServerStartError";
  }
}
