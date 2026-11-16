import { parseArgs } from "node:util";

export const COMMANDS = ["init", "plugins", "tree", "validate", "whoami", "generate", "run", "status", "query", "save", "set", "entry", "resource", "user", "member", "server", "help"] as const;
export type Command = (typeof COMMANDS)[number];

export type FailOn = "error" | "warning" | "info" | "never";

export interface CliOptions {
  command: Command;
  project?: string;
  appDir?: string;
  userDataDir?: string;
  json: boolean;
  languages?: string[];
  resources?: string;
  failOn: FailOn;
  maxIssues: number;
  user?: string;
  /** generate / run / set の位置引数（列 ID、アクション ID、セル ID と値）。 */
  args: string[];
  dryRun: boolean;
  keys?: string[];
  /** set の対象リソース（パスまたは ID）。 */
  resource?: string;
  /** run で cell / column 対象のアクションに使う列の ID。 */
  column?: string;
  /** entry add で、この行の後ろに足す。 */
  after?: string;
  /** entry add で入れる本文（言語 ID → 本文）。 */
  text?: Record<string, string>;
  /** entry / resource / user / member / server のサブコマンド（add、list、check など）。 */
  sub?: string;
  /** サーバー管理: データフォルダと設定ファイル。 */
  dataDir?: string;
  serverConfig?: string;
  displayName?: string;
  /** user add / user set */
  admin: boolean;
  noAdmin: boolean;
  enable: boolean;
  disable: boolean;
  passwordStdin: boolean;
  passwordEnv?: string;
  generate: boolean;
  yes: boolean;
  role?: string;
  /** query: 条件式。 */
  where?: string;
  /** query: 集計の区切り（欄）。 */
  groupBy?: string[];
  /** query: 出力するセル（セルの ID）。 */
  columns?: string[];
  /** query: csv / tsv で書き出す（省略時は、読むための表示）。 */
  format?: "csv" | "tsv";
  /** query: 書き出し先のファイル（省略時は標準出力）。 */
  out?: string;
  /** query: 書き出すファイルの先頭に BOM を付ける。 */
  bom: boolean;
  /** query: 表示する行の数。 */
  limit?: number;
  /** init: プロジェクトの名前。 */
  name?: string;
  /** init: 言語（ID と表示名）。最初の言語が原文。 */
  newLanguages?: { id: string; label?: string }[];
  /** init: すでにある CSV / TSV の、キーの列の見出し。 */
  keyColumn?: string;
  /** init: すでにある CSV / TSV の、言語ごとの本文の列の見出し。 */
  textColumns?: Record<string, string>;
  /** init: すでにある CSV / TSV の文字コード。 */
  encoding?: string;
  /** init: 進捗の列、レビューの列、同梱の検証を付けない。 */
  noStatus: boolean;
  noReview: boolean;
  noValidators: boolean;
}

/** 使い方の誤り。終了コード 2 で、メッセージだけを表示する。 */
export class UsageError extends Error {}

/** コマンドごとに使えるオプション。ほかのコマンドのオプションは誤りとして知らせる。 */
/** コマンドごとの位置引数の数（コマンド名を除く）。 */
const COMMAND_ARITY: Record<Command, { count: number; names: string }> = {
  init: { count: 0, names: "" },
  plugins: { count: 0, names: "" },
  tree: { count: 0, names: "" },
  validate: { count: 0, names: "" },
  whoami: { count: 0, names: "" },
  generate: { count: 1, names: "<columnId>" },
  run: { count: 1, names: "<actionId>" },
  status: { count: 0, names: "" },
  query: { count: 0, names: "" },
  save: { count: 0, names: "" },
  set: { count: 2, names: "<cellId> <value>" },
  entry: { count: 0, names: "" },
  resource: { count: 0, names: "" },
  user: { count: 0, names: "" },
  member: { count: 0, names: "" },
  server: { count: 0, names: "" },
  help: { count: 0, names: "" },
};

/** サブコマンドを持つコマンドの、サブコマンドごとの位置引数の数（サブコマンドを除く）と書式。 */
const SUBCOMMANDS: Partial<Record<Command, Record<string, { count: number; names: string }>>> = {
  entry: {
    add: { count: 1, names: "<key>" },
    remove: { count: 0, names: "" },
    rename: { count: 2, names: "<key> <newKey>" },
  },
  resource: { create: { count: 1, names: "<path>" } },
  user: {
    list: { count: 0, names: "" },
    add: { count: 1, names: "<name>" },
    passwd: { count: 1, names: "<name>" },
    set: { count: 1, names: "<name>" },
    delete: { count: 1, names: "<name>" },
    logout: { count: 1, names: "<name>" },
  },
  member: {
    list: { count: 0, names: "" },
    set: { count: 2, names: "<project> <user>" },
    remove: { count: 2, names: "<project> <user>" },
  },
  server: { check: { count: 0, names: "" } },
};

const ADMIN_COMMON = ["data-dir", "server-config"];

const COMMAND_OPTIONS: Record<string, string[]> = {
  "user list": ADMIN_COMMON,
  "user add": [...ADMIN_COMMON, "display-name", "admin", "password-stdin", "password-env"],
  "user passwd": [...ADMIN_COMMON, "password-stdin", "password-env", "generate"],
  "user set": [...ADMIN_COMMON, "admin", "no-admin", "enable", "disable", "display-name"],
  "user delete": [...ADMIN_COMMON, "yes"],
  "user logout": ADMIN_COMMON,
  "member list": [...ADMIN_COMMON],
  "member set": [...ADMIN_COMMON, "role", "languages"],
  "member remove": ADMIN_COMMON,
  "server check": ADMIN_COMMON,
  init: ["name", "languages", "resource", "key-column", "text-columns", "encoding", "no-status", "no-review", "no-validators"],
  plugins: [],
  tree: [],
  validate: ["languages", "resources", "fail-on", "max-issues"],
  whoami: ["user"],
  generate: ["languages", "resources", "dry-run", "user"],
  run: ["languages", "resources", "keys", "where", "column", "user"],
  status: ["languages", "resources", "user"],
  query: ["languages", "resources", "where", "group-by", "columns", "format", "out", "bom", "limit", "user"],
  save: ["user"],
  set: ["resource", "keys", "user"],
  "entry add": ["resource", "after", "text", "user"],
  "entry remove": ["resource", "keys", "user"],
  "entry rename": ["resource", "user"],
  "resource create": ["user"],
  help: [],
};

export function parseCliArgs(argv: string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        project: { type: "string" },
        "app-dir": { type: "string" },
        "user-data-dir": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
        languages: { type: "string" },
        resources: { type: "string" },
        "fail-on": { type: "string" },
        "max-issues": { type: "string" },
        user: { type: "string" },
        "dry-run": { type: "boolean" },
        keys: { type: "string" },
        resource: { type: "string" },
        column: { type: "string" },
        after: { type: "string" },
        text: { type: "string", multiple: true },
        "data-dir": { type: "string" },
        "server-config": { type: "string" },
        "display-name": { type: "string" },
        admin: { type: "boolean" },
        "no-admin": { type: "boolean" },
        enable: { type: "boolean" },
        disable: { type: "boolean" },
        "password-stdin": { type: "boolean" },
        "password-env": { type: "string" },
        generate: { type: "boolean" },
        yes: { type: "boolean" },
        role: { type: "string" },
        where: { type: "string" },
        "group-by": { type: "string" },
        columns: { type: "string" },
        format: { type: "string" },
        out: { type: "string" },
        bom: { type: "boolean" },
        limit: { type: "string" },
        name: { type: "string" },
        "key-column": { type: "string" },
        "text-columns": { type: "string" },
        encoding: { type: "string" },
        "no-status": { type: "boolean" },
        "no-review": { type: "boolean" },
        "no-validators": { type: "boolean" },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;

  let command: Command;
  let sub: string | undefined;
  if (values.help || positionals.length === 0) {
    command = "help";
  } else {
    const name = positionals[0] as string;
    if (!(COMMANDS as readonly string[]).includes(name)) {
      throw new UsageError(`不明なコマンドです: ${name}`);
    }
    command = name as Command;
    let arity = COMMAND_ARITY[command];
    let rest = positionals.slice(1);
    const subs = SUBCOMMANDS[command];
    if (subs) {
      sub = rest[0];
      if (sub === undefined) throw new UsageError(`${command} コマンドにはサブコマンドが必要です（${Object.keys(subs).join(" / ")}）。`);
      const spec = subs[sub];
      if (!spec) throw new UsageError(`不明なサブコマンドです: ${command} ${sub}（${Object.keys(subs).join(" / ")}）`);
      arity = spec;
      rest = rest.slice(1);
    }
    if (rest.length > arity.count) {
      throw new UsageError(`余計な引数があります: ${rest.slice(arity.count).join(" ")}`);
    }
    if (rest.length < arity.count) {
      throw new UsageError(`${command} コマンドには ${arity.names} が必要です。`);
    }
  }

  if (command !== "help") {
    const key = sub !== undefined ? `${command} ${sub}` : command;
    const allowed = new Set(COMMAND_OPTIONS[key]);
    for (const name of Object.values(COMMAND_OPTIONS).flat()) {
      if ((values as Record<string, unknown>)[name] !== undefined && !allowed.has(name)) {
        throw new UsageError(`オプション --${name} は ${key} コマンドでは使えません。`);
      }
    }
  }

  const failOn = values["fail-on"] ?? "error";
  if (!["error", "warning", "info", "never"].includes(failOn)) {
    throw new UsageError(`--fail-on は error / warning / info / never のどれかを指定してください: ${failOn}`);
  }
  let maxIssues = 200;
  if (values["max-issues"] !== undefined) {
    const n = Number(values["max-issues"]);
    if (!Number.isInteger(n) || n < 0) {
      throw new UsageError(`--max-issues には 0 以上の整数を指定してください: ${values["max-issues"]}`);
    }
    maxIssues = n;
  }

  const options: CliOptions = {
    command,
    json: values.json === true,
    failOn: failOn as FailOn,
    maxIssues,
    args: positionals.slice(sub !== undefined ? 2 : 1),
    dryRun: values["dry-run"] === true,
    admin: values.admin === true,
    noAdmin: values["no-admin"] === true,
    enable: values.enable === true,
    disable: values.disable === true,
    passwordStdin: values["password-stdin"] === true,
    generate: values.generate === true,
    yes: values.yes === true,
    bom: values.bom === true,
    noStatus: values["no-status"] === true,
    noReview: values["no-review"] === true,
    noValidators: values["no-validators"] === true,
  };
  const list = (value: string): string[] => value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (values.where !== undefined) options.where = values.where;
  if (values["group-by"] !== undefined) options.groupBy = list(values["group-by"]);
  if (values.columns !== undefined) options.columns = list(values.columns);
  if (values.format !== undefined) {
    if (values.format !== "csv" && values.format !== "tsv") throw new UsageError(`--format は csv か tsv を指定してください: ${values.format}`);
    options.format = values.format;
  }
  if (values.out !== undefined) options.out = values.out;
  if (values.limit !== undefined) {
    const n = Number(values.limit);
    if (!Number.isInteger(n) || n < 0) throw new UsageError(`--limit には 0 以上の整数を指定してください: ${values.limit}`);
    options.limit = n;
  }
  if ((options.out !== undefined || options.bom) && options.format === undefined) throw new UsageError("--out と --bom は、--format csv か --format tsv と一緒に指定してください。");
  if (options.format !== undefined && options.json) throw new UsageError("--format と --json は同時に指定できません。");
  if (sub !== undefined) options.sub = sub;
  if (values["data-dir"] !== undefined) options.dataDir = values["data-dir"];
  if (values["server-config"] !== undefined) options.serverConfig = values["server-config"];
  if (values["display-name"] !== undefined) options.displayName = values["display-name"];
  if (values["password-env"] !== undefined) options.passwordEnv = values["password-env"];
  if (values.role !== undefined) options.role = values.role;
  const conflict = (a: boolean, b: boolean, an: string, bn: string): void => {
    if (a && b) throw new UsageError(`${an} と ${bn} は同時に指定できません。`);
  };
  conflict(options.admin, options.noAdmin, "--admin", "--no-admin");
  conflict(options.enable, options.disable, "--enable", "--disable");
  if ([options.passwordStdin, options.passwordEnv !== undefined, options.generate].filter(Boolean).length > 1) {
    throw new UsageError("--password-stdin、--password-env、--generate は 1 つだけ指定できます。");
  }
  if (values.keys !== undefined) options.keys = values.keys.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (values.resource !== undefined) options.resource = values.resource;
  if (values.after !== undefined) options.after = values.after;
  if (values.text !== undefined) {
    // --text <言語 ID>=<本文> を、言語ごとに 1 つずつ書く。本文に "=" があってもよい（最初の "=" で分ける）。
    options.text = {};
    for (const item of values.text) {
      const at = item.indexOf("=");
      if (at <= 0) throw new UsageError(`--text は <言語 ID>=<本文> の形で指定してください: ${item}`);
      options.text[item.slice(0, at)] = item.slice(at + 1);
    }
  }
  if (values.column !== undefined) options.column = values.column;
  if (values.project !== undefined) options.project = values.project;
  if (values["app-dir"] !== undefined) options.appDir = values["app-dir"];
  if (values["user-data-dir"] !== undefined) options.userDataDir = values["user-data-dir"];
  if (values.languages !== undefined) {
    options.languages = values.languages.split(",").map((s) => s.trim()).filter((s) => s !== "");
  }
  if (command === "init") {
    // init の --languages は <ID>=<表示名> を並べる（表示名は省ける）。最初の "=" で分ける。
    const pairs = (value: string, what: string): [string, string | undefined][] =>
      list(value).map((item) => {
        const at = item.indexOf("=");
        if (at === 0) throw new UsageError(`${what} は <言語 ID>=<値> の形で指定してください: ${item}`);
        return at < 0 ? [item, undefined] : [item.slice(0, at).trim(), item.slice(at + 1).trim()];
      });
    if (values.languages === undefined || list(values.languages).length === 0) {
      throw new UsageError("init には --languages が必要です（例: --languages ja=日本語,en=English。最初の言語が原文）。");
    }
    options.newLanguages = pairs(values.languages, "--languages").map(([id, label]) => (label !== undefined && label !== "" ? { id, label } : { id }));
    delete options.languages;
    if (values.name !== undefined) options.name = values.name;
    if (values["key-column"] !== undefined) options.keyColumn = values["key-column"];
    if (values["text-columns"] !== undefined) {
      options.textColumns = {};
      for (const [id, header] of pairs(values["text-columns"], "--text-columns")) {
        if (header === undefined || header === "") throw new UsageError(`--text-columns は <言語 ID>=<見出し> の形で指定してください: ${id}`);
        options.textColumns[id] = header;
      }
    }
    if (values.encoding !== undefined) options.encoding = values.encoding;
  }
  if (values.resources !== undefined) options.resources = values.resources;
  if (values.user !== undefined) options.user = values.user;
  return options;
}

/** `**`・`*`・`?` だけを扱う簡易のグロブ。パスの区切りは "/"。 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // 0 個以上のフォルダ
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export const USAGE = `loc-studio — ゲーム向けローカライゼーションテキスト管理ツール（コマンドライン）

使い方:
  loc-studio <コマンド> [オプション]

コマンド:
  init       新しいプロジェクトを作る（設定ファイル loc-studio.project.json を書く）
  plugins    読み込まれたプラグインと、登録された実装、探したフォルダを表示する
  tree       リソースのツリーを、エントリ数とフォーマットつきで表示する
  validate   プロジェクトを検証する（問題があれば終了コード 1）
  whoami     解決されたユーザー名とその出所、ローカル設定のパスを表示する
  generate <columnId>      生成列（逆翻訳など）をプロジェクト全体または一部に実行する（失敗があれば終了コード 1）
  run <actionId>           アクションをリソースに対して実行する（失敗があれば終了コード 1）
  status     リソースごとの件数、未保存、問題、列ごと・言語ごとの進捗を表示する
  query      条件に合う行を、リソースをまたいで数え、集計し、CSV / TSV に書き出す
  save       未保存の本文をすべてリソースに書く（競合があれば終了コード 1）
  set <cellId> <値>        セルの値を複数行へ一括で設定する（例: set textStatus@ko done --resource Assets/Text/chapter01.csv --keys A,B）
  entry <add|remove|rename>  行を足す・消す・キーを変える（すぐリソースに書く）
  resource create <path>   行のない新しいリソースを作る
  user <list|add|passwd|set|delete|logout>   サーバーのアカウントを管理する（Web モード。サーバーのマシンで実行する）
  member <list|set|remove>                   プロジェクトごとの役割を管理する（同上）
  server check   サーバーの設定、DB、プロジェクトのフォルダを確かめる（問題があれば終了コード 1）
  help       この説明を表示する

共通オプション:
  --project <dir>         プロジェクトのフォルダ（既定: カレントディレクトリ）
  --app-dir <dir>         アプリのフォルダ。その中の plugins/ を読む（既定: 環境変数 LOC_STUDIO_APP_DIR）
  --user-data-dir <dir>   個人の設定フォルダ。その中の plugins/ を読む（既定: ローカル設定ファイルのあるフォルダ）
  --json                  機械可読の JSON で出力する
  --help                  この説明を表示する

init のオプション（--project のフォルダに作る。フォルダがなければ作る。すでにプロジェクトのあるフォルダには作らない）:
  --languages <a=名前,b=名前>  言語の ID と表示名（必須。表示名は省ける。最初の言語を原文にして、ほかの言語をそこから翻訳する）
  --name <text>           プロジェクトの名前（既定: フォルダの名前）
  --resource <path>       最初のファイルも作る（例: text/main.csv。キーと言語ごとの列だけの、行のないファイル）
  --key-column <見出し>   すでにある CSV / TSV の、キーの列（既定: 先頭の列）
  --text-columns <a=見出し,b=見出し>  すでにある CSV / TSV の、言語ごとの本文の列（既定: 言語 ID と同じ見出しの列）
  --encoding <名前>       すでにある CSV / TSV の文字コード（auto | utf-8 | utf-16le | utf-16be | shift_jis。既定: auto）
  --no-status / --no-review / --no-validators   進捗の列、レビューの列、同梱の検証（空白、未翻訳）を付けない

validate のオプション:
  --languages <a,b>       検証する言語 ID（カンマ区切り）
  --resources <glob>      検証するリソースのパス（** * ? が使える。例: "**/ui.csv"）
  --fail-on <重さ>        error | warning | info | never（既定: error）。この重さ以上があれば終了コード 1
  --max-issues <n>        表示する問題の数（既定: 200。集計は常に全件）

whoami のオプション:
  --user <name>           ユーザー名を指定する（環境変数 LOC_STUDIO_USER より優先）

generate のオプション:
  --resources <glob>      対象のリソース（指定すると 1 リソースにつき 1 ジョブ。省略時はプロジェクト全体で 1 ジョブ）
  --languages <a,b>       対象の言語 ID
  --dry-run               件数（全体 / キャッシュ済み / 実行する分）だけ表示して終了する（生成器は呼ばない）

run のオプション:
  --resources <glob>      対象のリソース
  --languages <a,b>       対象の言語 ID（cell / column 対象は列 × 言語のセルごとに実行）
  --keys <k1,k2>          対象のキー（cell / row / selection 対象。省略時は全行）
  --where <式>            条件に合う行だけを対象にする（cell / row / selection 対象。式は query と同じ。--keys とは併用できない）
  --column <id>           cell / column 対象のアクションで使う列（省略時はアクションの columns）

query のオプション:
  --where <式>            条件式（例: "textStatus@ko = done and text@ko is empty"。書き方は docs/QUERY.md）。省略時はすべての行
  --resources <glob>      対象のリソース
  --languages <a,b>       対象の言語 ID（式の "@any" / "@all" と、出力する列の言語。省略時はすべての言語）
  --group-by <欄,欄>      集計の区切り（例: textStatus@ko、resource、issues@ko）。値ごとの行数と原文の量を出す
  --limit <n>             表示する行の数（既定: 0。数と集計だけを出す）
  --format <csv|tsv>      条件に合う行（--group-by があれば集計）を、CSV / TSV で出力する
  --columns <a,b>         出力するセルの ID（例: text@ja,text@ko,textStatus@ko。省略時は、対象の言語のすべての列）
  --out <file>            --format の出力先のファイル（省略時は標準出力）
  --bom                   --format の出力の先頭に BOM を付ける（表計算ソフトで開くとき）

set のオプション:
  --resource <path>       対象のリソース（パスまたは ID）。必須
  --keys <k1,k2>          対象のキー。必須

entry のオプション:
  entry add <key> --resource <path> [--after <key>] [--text <言語 ID>=<本文> ...]
                          行を足す。--after を省くと末尾。--text は言語ごとに繰り返せる
  entry remove --resource <path> --keys <k1,k2>
                          行を消す（ステータスなどの記録は残り、同じキーの行を足し直すと戻る）
  entry rename <key> <newKey> --resource <path>
                          キーを変える（ステータス、レビュー、履歴、未保存の編集は新しいキーに引き継ぐ）

サーバー管理（user / member / server check）の共通オプション:
  --data-dir <dir>        サーバーのデータフォルダ（環境変数 LOC_STUDIO_USER_DATA_DIR と同じ意味）
  --server-config <file>  サーバーの設定ファイル（既定: LOC_STUDIO_SERVER_CONFIG、なければ <データフォルダ>/server.json）
  server check は Web サーバーと同じ開き方（環境変数 LOC_STUDIO_APP_DIR のアプリのフォルダを含む）で確かめる。
  サーバーの DB を直接開くので、サーバーのマシンで実行する。管理者の権限で動く。パスワードをコマンドラインの引数で渡すことはできない。

user のオプション:
  user list                                  アカウントの一覧
  user add <name> [--display-name <text>] [--admin] [--password-stdin | --password-env <VAR>]
                                             追加する。パスワードの指定がなければ、乱数で作って 1 回だけ表示する
  user passwd <name> (--password-stdin | --password-env <VAR> | --generate)
                                             パスワードを変える（そのユーザーのセッションは無効になる）
  user set <name> [--admin | --no-admin] [--enable | --disable] [--display-name <text>]
  user delete <name> --yes                   削除する
  user logout <name>                         そのユーザーのセッションをすべて無効にする
  ユーザー名は小文字にそろえる。英数字で始まり、英数字と . _ @ - だけの 1〜64 文字（member のユーザー名も同じ）。
  最後の有効な管理者は、削除・無効化・管理者の解除ができない。

member のオプション:
  member list [--project <id>]               割り当ての一覧（--project はこのコマンドではプロジェクトの ID）
  member set <project> <user> --role <役割の ID> [--languages a,b]
  member remove <project> <user>

generate / run / status / query / save / set は、画面と同じサービス層を通るので、キャッシュと履歴を画面と共有する。
どれも --user <name> で記録に残すユーザー名を指定できる（履歴の by）。値が - で始まるときは -- の後ろに書く。

環境変数:
  LOC_STUDIO_APP_DIR      --app-dir の既定
  LOC_STUDIO_PLUGIN_DIRS  プラグインを探す追加のフォルダ
  LOC_STUDIO_SETTINGS     ローカル設定ファイルのパス
  LOC_STUDIO_USER         ユーザー名
  LOC_STUDIO_SDK_PATH     プラグインが import する SDK の入口（テストなどで使う）
  LOC_STUDIO_DEBUG        設定するとエラー時にスタックトレースも表示する

終了コード: 0 正常 / 1 検証の問題・プラグインの読み込み失敗・生成やアクションの失敗・保存の競合 / 2 使い方の誤り・プロジェクトを開けない・対象が見つからない
`;
