import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./commands.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const sample = path.join(repoRoot, "examples", "sample-project");
const sdkPath = path.join(repoRoot, "packages", "sdk", "src", "index.ts");

async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await run(args, {
    stdout: (s) => void (stdout += s),
    stderr: (s) => void (stderr += s),
    // 個人の設定やプラグインフォルダがテストに影響しないよう、一時の場所に向ける。
    env: {
      LOC_STUDIO_SDK_PATH: sdkPath,
      LOC_STUDIO_SETTINGS: path.join(os.tmpdir(), "loc-studio-cli-test-none", "settings.json"),
      ...env,
    },
    cwd: repoRoot,
  });
  return { code, stdout, stderr };
}

interface JsonIssue { key: string; language: string | null; code: string; validatorId: string; severity: string }
interface JsonOut {
  resources: { path: string; issues: JsonIssue[] }[];
  summary: { error: number; warning: number; info: number; byCode: Record<string, number>; cellsChecked: number };
}

const validateJson = async (extra: string[] = []) => {
  const r = await cli(["validate", "--project", sample, "--json", ...extra]);
  return { ...r, data: JSON.parse(r.stdout) as JsonOut };
};
const flat = (d: JsonOut) => d.resources.flatMap((r) => r.issues.map((i) => ({ ...i, path: r.path })));

describe("plugins", () => {
  it("サンプルのプラグインと実装を project 層で一覧する", async () => {
    const r = await cli(["plugins", "--project", sample]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mystudio-line-width");
    expect(r.stdout).toContain("studio-pack");
    expect(r.stdout).toContain("mystudio.lineWidth");
    expect(r.stdout).toContain("mystudio.forbiddenChars");
    expect(r.stdout).toMatch(/mystudio\.lineWidth\s+<- mystudio-line-width \[project\]/);
    expect(r.stdout).toMatch(/mystudio\.forbiddenChars\s+<- studio-pack \[project\]/);
  });

  it("--json でも層を返す", async () => {
    const r = await cli(["plugins", "--project", sample, "--json"]);
    const data = JSON.parse(r.stdout) as { plugins: { name: string; layer: string }[] };
    expect(data.plugins.filter((p) => p.layer === "project").map((p) => p.name).sort()).toEqual([
      "mystudio-line-width",
      "studio-pack",
    ]);
  });
});

describe("tree", () => {
  it("2 つの CSV を件数つきで表示する", async () => {
    const r = await cli(["tree", "--project", sample]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("chapter01.csv");
    expect(r.stdout).toContain("ui.csv");
    expect(r.stdout).toMatch(/chapter01\.csv\s+\d+ 件\s+\[builtin\.csv\]/);
  });
});

describe("validate", () => {
  it("期待する問題を報告して終了コード 1", async () => {
    const { code, data } = await validateJson();
    expect(code).toBe(1);
    const issues = flat(data);
    const has = (key: string, language: string, c: string) =>
      issues.some((i) => i.key === key && i.language === language && i.code === c);
    expect(has("CH01_ITEM_001", "zh-Hans", "placeholder-missing")).toBe(true);
    expect(has("CH01_CHOICE_001A", "ko", "tag-unclosed")).toBe(true);
    expect(has("CH01_CHOICE_001B", "ko", "empty")).toBe(true);
    expect(has("CH01_SHOP_001", "ja", "forbidden-char")).toBe(true);
    expect(issues.some((i) => i.code === "line-too-long" && i.validatorId === "mystudio.lineWidth")).toBe(true);
    expect(data.summary.cellsChecked).toBeGreaterThan(0);
  });

  it("テキスト出力に集計がある", async () => {
    const r = await cli(["validate", "--project", sample]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("chapter01.csv");
    expect(r.stdout).toContain("placeholder-missing");
    expect(r.stdout).toContain("検証したセル");
  });

  it("--fail-on never は 0", async () => {
    expect((await cli(["validate", "--project", sample, "--fail-on", "never"])).code).toBe(0);
  });

  it("--languages ja は ja だけ", async () => {
    const { data } = await validateJson(["--languages", "ja"]);
    const issues = flat(data);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.language === "ja")).toBe(true);
  });

  it("--resources で 1 つのファイルに絞る", async () => {
    const { data } = await validateJson(["--resources", "**/ui.csv"]);
    expect(data.resources.map((r) => r.path)).toEqual(["Assets/Text/system/ui.csv"]);
  });

  it("--max-issues は表示だけを減らし、集計は全件", async () => {
    const full = await validateJson();
    const r = await cli(["validate", "--project", sample, "--max-issues", "1"]);
    expect(r.stdout).toContain("表示を省略");
    expect(r.stdout).toContain(`error ${full.data.summary.error} /`);
  });

  it("JSON の形", async () => {
    const { data } = await validateJson();
    expect(Array.isArray(data.resources)).toBe(true);
    const issue = flat(data)[0];
    expect(issue).toBeDefined();
    for (const k of ["key", "language", "columnId", "validatorId", "code", "severity", "message"]) {
      expect(issue).toHaveProperty(k);
    }
    expect(typeof data.summary.byCode).toBe("object");
  });

  it("不正な --fail-on は 2", async () => {
    const r = await cli(["validate", "--project", sample, "--fail-on", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).not.toBe("");
  });
});

describe("whoami / 使い方", () => {
  it("LOC_STUDIO_USER は cli 由来", async () => {
    const r = await cli(["whoami", "--project", sample], { LOC_STUDIO_USER: "tester" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("tester");
    expect(r.stdout).toContain("cli");
  });

  it("--user は環境変数より優先", async () => {
    const r = await cli(["whoami", "--project", sample, "--user", "alice", "--json"], { LOC_STUDIO_USER: "tester" });
    expect(JSON.parse(r.stdout)).toMatchObject({ userName: "alice", source: "cli" });
  });

  it("不明なコマンドと不明なオプションは 2", async () => {
    expect((await cli(["bogus"])).code).toBe(2);
    expect((await cli(["tree", "--nope"])).code).toBe(2);
    expect((await cli(["tree", "--fail-on", "error"])).code).toBe(2);
  });

  it("開けないプロジェクトは 2（スタックトレースなし）", async () => {
    const r = await cli(["tree", "--project", path.join(os.tmpdir(), "loc-studio-no-such-project")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("プロジェクトを開けませんでした");
    expect(r.stderr).not.toContain("    at ");
  });

  it("引数なしと --help は使い方を出して 0", async () => {
    for (const args of [[], ["--help"], ["help"]]) {
      const r = await cli(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("使い方");
    }
  });
});

describe("プラグインフォルダにファイルを置くだけ", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("新しいプラグインと設定の 1 行で、新しいバリデータの問題が出る", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "loc-studio-cli-"));
    const project = path.join(tmp, "project");
    await cp(sample, project, { recursive: true });

    const before = JSON.parse((await cli(["validate", "--project", project, "--json"])).stdout) as JsonOut;
    expect(flat(before).some((i) => i.validatorId === "mystudio.noPeriod")).toBe(false);

    await writeFile(
      path.join(project, "loc-studio-plugins", "no-period.mjs"),
      `export default {
  name: "no-period",
  validators: [{
    id: "mystudio.noPeriod",
    label: "句点の禁止",
    version: "1",
    severity: "warning",
    validate({ value }) {
      return value.includes("。") ? [{ code: "no-period", message: "「。」は使いません" }] : [];
    },
  }],
};
`,
    );
    const configFile = path.join(project, "loc-studio.project.json");
    const config = JSON.parse(await readFile(configFile, "utf8")) as { validators: unknown[] };
    config.validators.push({ use: "mystudio.noPeriod" });
    await writeFile(configFile, JSON.stringify(config, null, 2));

    const after = await cli(["validate", "--project", project, "--json"]);
    const issues = flat(JSON.parse(after.stdout) as JsonOut);
    expect(issues.some((i) => i.validatorId === "mystudio.noPeriod" && i.code === "no-period")).toBe(true);

    const plugins = await cli(["plugins", "--project", project]);
    expect(plugins.stdout).toMatch(/mystudio\.noPeriod\s+<- no-period \[project\]/);
  });
});

describe("読めないリソースがあっても、ほかを処理して終了コード 1", () => {
  let tmp2: string | undefined;
  afterEach(async () => {
    if (tmp2) await rm(tmp2, { recursive: true, force: true });
    tmp2 = undefined;
  });

  const withBroken = async () => {
    tmp2 = await mkdtemp(path.join(os.tmpdir(), "loc-studio-cli-broken-"));
    const project = path.join(tmp2, "project");
    await cp(sample, project, { recursive: true });
    // UTF-8 として不正なバイト列。
    await writeFile(path.join(project, "Assets", "Text", "broken.csv"), Buffer.from([0x49, 0x44, 0x2c, 0xff, 0xfe, 0x0a, 0x80, 0x81]));
    return { project, ud: path.join(tmp2, "ud") };
  };

  it("validate: 読めない行を出し、ほかは検証する（--fail-on never でも 1）", async () => {
    const { project, ud } = await withBroken();
    const r = await cli(["validate", "--project", project, "--user-data-dir", ud, "--fail-on", "never"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/broken\.csv {2}\(読めません: /);
    expect(r.stdout).toContain("placeholder-missing");
    expect(r.stdout).toContain("読めないリソース 1");
    const j = JSON.parse((await cli(["validate", "--project", project, "--user-data-dir", ud, "--json"])).stdout) as {
      resources: { path: string; error?: string; issues: unknown[] }[];
      summary: { unreadable: number };
    };
    expect(j.summary.unreadable).toBe(1);
    expect(j.resources.find((x) => x.path.endsWith("broken.csv"))?.error).toBeTruthy();
    expect(j.resources.find((x) => x.path.endsWith("chapter01.csv"))?.issues.length).toBeGreaterThan(0);
  });

  it("status: 読めない行を出し、ほかは数える", async () => {
    const { project, ud } = await withBroken();
    const r = await cli(["status", "--project", project, "--user-data-dir", ud]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/broken\.csv {2}\(読めません: /);
    expect(r.stdout).toContain("エントリ 8");
    const j = JSON.parse((await cli(["status", "--project", project, "--user-data-dir", ud, "--json"])).stdout) as {
      resources: { path: string; error?: string; entries: number }[];
      unreadable: number;
    };
    expect(j.unreadable).toBe(1);
    expect(j.resources.find((x) => x.path.endsWith("chapter01.csv"))?.entries).toBe(8);
  });
});

describe("whoami と --user-data-dir", () => {
  it("<dir>/settings.json を読み、そのパスを表示する", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "loc-studio-cli-ud-"));
    try {
      await writeFile(path.join(dir, "settings.json"), JSON.stringify({ "user.name": "from-ud" }));
      const r = await cli(["whoami", "--project", sample, "--user-data-dir", dir, "--json"]);
      expect(JSON.parse(r.stdout)).toMatchObject({ userName: "from-ud", source: "local", localSettingsPath: path.join(dir, "settings.json") });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("plugins に llm の実装も出る", () => {
  it("llm.translate が登録されている", async () => {
    const r = await cli(["plugins", "--project", sample]);
    expect(r.stdout).toContain("llm.translate");
    expect(JSON.stringify(JSON.parse((await cli(["plugins", "--project", sample, "--json"])).stdout))).toContain("llm.translate");
  });
});
