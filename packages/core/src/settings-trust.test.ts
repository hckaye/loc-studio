import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectConfig, UntrustedConfigError } from "./config.js";
import { escapeControls, isReservedEnvName, settingsCandidate, withoutReservedEnv } from "./settings-trust.js";

const sdkPath = fileURLToPath(new URL("../../sdk/src/index.ts", import.meta.url));
let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "loc-settings-trust-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});
const cand = (json: Record<string, unknown>) => settingsCandidate("/p/loc-studio.project.json", json, JSON.stringify(json));

describe("設定ファイルの信頼の対象", () => {
  it("基盤の項目も ${env:} もなければ確認は要らない", () => {
    expect(cand({ languages: [{ id: "ja", label: "日本語" }], columns: [] })).toBeUndefined();
    expect(cand({ languages: [], name: "${env:HOME}" })).toBeDefined();
  });

  it("manager の項目を変えてもハッシュは変わらず、基盤の項目や環境変数の名前を変えると変わる", () => {
    const base = { languages: [{ id: "ja", label: "日本語" }], tree: { use: "builtin.globTree" } };
    const h = cand(base)!.hash;
    expect(cand({ ...base, languages: [{ id: "en", label: "English" }], name: "x", columns: [{ use: "builtin.key" }], localSettings: { defaults: {} } })!.hash).toBe(h);
    expect(cand({ ...base, tree: { use: "builtin.globTree", options: { include: ["**"] } } })!.hash).not.toBe(h);
    expect(cand({ ...base, generators: { g: { use: "llm.translate" } } })!.hash).not.toBe(h);
    expect(cand({ ...base, name: "${env:FOO}" })!.hash).not.toBe(h);
    // キーの順は関係ない。
    expect(cand({ tree: { use: "builtin.globTree" }, languages: [{ id: "ja", label: "日本語" }] })!.hash).toBe(h);
  });

  it("秘密情報の名前らしい項目だけに注意書きを付ける（ただの key や hotkey には付けない）", () => {
    const c = cand({
      languages: [],
      formats: [{ use: "builtin.csv", options: { key: "ID", hotkey: "F2", monkey: "x", apiKey: "a", accessKey: "b", api_key: "c", authToken: "d", passwordName: "e" } }],
    })!;
    const noted = (name: string): boolean => c.summary!.some((r) => r.label.endsWith(`options.${name}`) && r.note !== undefined && r.note.includes("秘密情報の名前"));
    for (const name of ["apiKey", "accessKey", "api_key", "authToken", "passwordName"]) expect(noted(name), name).toBe(true);
    for (const name of ["key", "hotkey", "monkey"]) expect(noted(name), name).toBe(false);
  });

  it("要約は展開前の値で、パスワードは伏せ、環境変数の名前と、すべての options を出す", () => {
    const c = cand({
      languages: [],
      storage: { driver: "postgres", url: "postgres://${env:PGUSER}:hunter2@db.example:5432/${env:DB}" },
      pluginDirs: ["../shared-plugins"],
      generators: { back: { use: "llm.translate", options: { endpoint: "https://evil.example/v1", apiKeySecret: "llm.apiKey", model: "m" } } },
      review: { targets: ["tracker.open"] },
    })!;
    const text = JSON.stringify(c.summary);
    expect(text).not.toContain("hunter2");
    expect(c.summary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "共有 DB の url", value: '"postgres://${env:PGUSER}:****@db.example:5432/${env:DB}"', host: "db.example:5432" }),
        { label: "環境変数", value: "DB" },
        { label: "環境変数", value: "PGUSER" },
        { label: "プラグインのフォルダ[0]", value: '"../shared-plugins"' },
        { label: "生成器 back", value: "back → llm.translate" },
        { label: "生成器 back の options.endpoint", value: '"https://evil.example/v1"', host: "evil.example" },
        expect.objectContaining({ label: "生成器 back の options.apiKeySecret", value: '"llm.apiKey"', note: expect.stringContaining("秘密情報の名前") }),
        { label: "生成器 back の options.model", value: '"m"' },
        { label: "レビュー先[0]", value: "tracker.open" },
        expect.objectContaining({ label: "秘密情報" }),
      ]),
    );
  });

  it("予約された環境変数", () => {
    for (const n of ["LOC_STUDIO_LOCAL_TOKEN", "LOC_STUDIO_INTERNAL_SECRET", "LOC_STUDIO_ADMIN_USER", "LOC_STUDIO_ADMIN_PASSWORD", "LOC_STUDIO_SECRET_X"]) expect(isReservedEnvName(n)).toBe(true);
    expect(isReservedEnvName("HOME")).toBe(false);
    expect(withoutReservedEnv({ HOME: "/h", LOC_STUDIO_SECRET_A: "s", LOC_STUDIO_LOCAL_TOKEN: "t" })).toEqual({ HOME: "/h" });
  });
});

describe("loadProjectConfig と設定ファイルの信頼", () => {
  const write = async (name: string, content: string) => {
    await mkdir(tmp, { recursive: true });
    await writeFile(path.join(tmp, name), content);
  };

  it("確認していなければ UntrustedConfigError（信頼したコードの設定も読み込まない）。確認すれば開く", async () => {
    await write("loc-studio.project.json", JSON.stringify({ languages: [{ id: "ja", label: "日本語" }], tree: { use: "builtin.globTree" } }));
    const marker = path.join(tmp, "ran");
    await write("loc-studio.config.mjs", `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport default { name: "C" };\n`);
    const err = await loadProjectConfig(tmp, { sdkPath, trustConfig: (c) => c.kind === "config" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UntrustedConfigError);
    expect((err as UntrustedConfigError).candidates.map((c) => c.kind)).toEqual(["settings"]);
    expect(existsSync(marker)).toBe(false);
    const both = (await loadProjectConfig(tmp, { sdkPath, trustConfig: () => false }).catch((e: unknown) => e)) as UntrustedConfigError;
    expect(both.candidates.map((c) => c.kind)).toEqual(["settings", "config"]);
    const ok = await loadProjectConfig(tmp, { sdkPath, trustConfig: () => true });
    expect(ok.config.name).toBe("C");
  });

  it("予約された環境変数を参照する設定は、どのモードでも誤り", async () => {
    await write("loc-studio.project.json", JSON.stringify({ languages: [{ id: "ja", label: "日本語" }], storage: { driver: "sqlite", path: "${env:LOC_STUDIO_LOCAL_TOKEN}/x.db" } }));
    await expect(loadProjectConfig(tmp)).rejects.toThrow(/LOC_STUDIO_LOCAL_TOKEN/);
    await expect(loadProjectConfig(tmp, { trustConfig: () => true })).rejects.toThrow(/LOC_STUDIO_LOCAL_TOKEN/);
  });
});

describe("要約は何も省かず、本当の接続先を出す（レビュー 3 回目の 2）", () => {
  const rows = (json: Record<string, unknown>) => cand({ languages: [], ...json })!.summary!;
  const find = (json: Record<string, unknown>, label: string) => rows(json).find((r) => r.label === label);

  it("http:/host の形でも接続先を出す（evil6 の再現）", () => {
    const r = find({ generators: { mt: { use: "llm.translate", options: { endpoint: "http:/127.0.0.1:9977/v1" } } } }, "生成器 mt の options.endpoint");
    expect(r).toMatchObject({ host: "127.0.0.1:9977", value: '"http:/127.0.0.1:9977/v1"' });
  });

  it("バックスラッシュの形と、ユーザー情報の形", () => {
    expect(find({ generators: { mt: { use: "x", options: { endpoint: "http:\\\\evil.example\\v1" } } } }, "生成器 mt の options.endpoint")?.host).toBe("evil.example");
    const u = find({ generators: { mt: { use: "x", options: { endpoint: "https://good.example@evil.example/v1" } } } }, "生成器 mt の options.endpoint")!;
    expect(u.host).toBe("evil.example");
    expect(u.note).toContain("ユーザー情報");
  });

  it("環境変数で決まる接続先", () => {
    const r = find({ generators: { mt: { use: "x", options: { endpoint: "${env:HOST}/v1", base: "https://${env:API_HOST}:8443/x" } } } }, "生成器 mt の options.endpoint")!;
    expect(r.note).toContain("環境変数 HOST");
    const b = find({ generators: { mt: { use: "x", options: { base: "https://${env:API_HOST}:8443/x" } } } }, "生成器 mt の options.base")!;
    expect(b.host).toBe("${env:API_HOST}:8443");
  });

  it("書字方向の制御文字は見える形にし、長い値は印を付けて省く（接続先は切らない）", () => {
    expect(escapeControls("abc\u202Edef\u0007")).toBe("abc<U+202E>def<U+0007>");
    const bidi = find({ generators: { "g\u202Ex": { use: "x", options: { endpoint: "https://evil.example/\u202Etxt.exe" } } } }, "生成器 g<U+202E>x の options.endpoint")!;
    expect(bidi.value).toContain("<U+202E>");
    expect(JSON.stringify(rows({ generators: { a: { use: "x\u2066", options: {} } } }))).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    const long = "https://" + "a".repeat(495) + ".example.com/v1" + "x".repeat(300);
    const r = find({ generators: { mt: { use: "x", options: { endpoint: long } } } }, "生成器 mt の options.endpoint")!;
    expect(r.value).toContain("…（残り");
    expect(r.value).toContain(".example.com");
    expect(r.host).toBe("a".repeat(495) + ".example.com");
  });

  it("入れ子の値を a.b[0] の形で出し、40 項目を超えたら数を出すが、URL・パス・環境変数は必ず出す", () => {
    const nested = rows({ generators: { mt: { use: "x", options: { deep: { list: [{ url: "https://hidden.example/x" }] } } } } });
    expect(nested.find((r) => r.label === "生成器 mt の options.deep.list[0].url")?.host).toBe("hidden.example");
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) many[`k${String(i).padStart(2, "0")}`] = i;
    many["zz_endpoint"] = "https://late.example/v1";
    many["zz_dir"] = "/etc/secret";
    const r = rows({ generators: { mt: { use: "x", options: many } } });
    expect(r.filter((x) => x.label.startsWith("生成器 mt の options.k")).length).toBe(40);
    expect(r.find((x) => x.value.includes("ほかに"))?.value).toContain("22 項目");
    expect(r.find((x) => x.label === "生成器 mt の options.zz_endpoint")?.host).toBe("late.example");
    expect(r.find((x) => x.label === "生成器 mt の options.zz_dir")).toBeDefined();
  });

  it("展開した環境変数の値は出さず、以前は出さなかった option の違いもハッシュに入る", () => {
    process.env["LOC_TEST_SUMMARY_SECRET"] = "should-not-appear";
    try {
      const j = { storage: { driver: "sqlite", path: "${env:LOC_TEST_SUMMARY_SECRET}/x.db" } };
      expect(JSON.stringify(rows(j))).not.toContain("should-not-appear");
    } finally {
      delete process.env["LOC_TEST_SUMMARY_SECRET"];
    }
    const a = cand({ languages: [], generators: { g: { use: "x", options: { model: "a" } } } })!.hash;
    const b = cand({ languages: [], generators: { g: { use: "x", options: { model: "b" } } } })!.hash;
    expect(a).not.toBe(b);
  });
});

describe("Postgres の接続先は、ドライバーと同じ決め方で出す（レビュー 4 回目の 2）", () => {
  const rowsFor = (url: string) => cand({ languages: [], storage: { driver: "postgres", url } })!.summary!;
  const main = (url: string) => rowsFor(url).find((r) => r.label === "共有 DB の url")!;

  it("evil7: クエリの host / port が // のあとより優先されることを出す", () => {
    const url = "postgres://${env:MY_SECRET_ENV}@db.good.example:5432/loc?host=127.0.0.1&port=9988";
    const r = main(url);
    expect(r.host).toBe("127.0.0.1:9988");
    expect(r.note).toContain("クエリの host / port");
    const rows = rowsFor(url);
    expect(rows.find((x) => x.label === "共有 DB の url の ?host")?.value).toBe('"127.0.0.1"');
    expect(rows.find((x) => x.label === "共有 DB の url の ?port")?.value).toBe('"9988"');
  });

  it("// のあとにホストがない形、hostaddr、ソケットのフォルダ", () => {
    expect(main("postgres:///db?host=evil.example").host).toBe("evil.example:5432");
    const ha = main("postgres://u@good.example:6543/db?hostaddr=10.9.9.9");
    expect(ha.host).toBe("good.example:6543");
    expect(ha.note).toContain("hostaddr");
    const sock = main("postgres://u@%2Fvar%2Frun%2Fpostgresql/db");
    expect(sock.host).toBe("/var/run/postgresql");
    expect(sock.note).toContain("ソケット");
    expect(main("postgres://good.example/db?host=/tmp/s").host).toBe("/tmp/s");
    expect(main("postgresql://[::1]:5433/db").host).toBe("[::1]:5433");
  });

  it("ファイルを読む・行き先を変えるクエリは必ず行を出す", () => {
    const rows = rowsFor("postgres://good.example/db?sslrootcert=/etc/ca.pem&sslcert=/c&sslkey=/k&options=-c%20x%3D1&service=svc&target_session_attrs=read-write&application_name=a");
    const labels = rows.map((r) => r.label);
    for (const k of ["sslrootcert", "sslcert", "sslkey", "options", "service", "target_session_attrs"]) expect(labels).toContain(`共有 DB の url の ?${k}`);
    expect(labels).not.toContain("共有 DB の url の ?application_name");
    expect(rows.find((r) => r.label === "共有 DB の url の ?sslrootcert")?.note).toContain("ファイル");
  });

  it("Postgres 以外は new URL() のホストのまま", () => {
    const r = cand({ languages: [], generators: { g: { use: "x", options: { endpoint: "https://api.example/v1?host=evil.example" } } } })!.summary!;
    expect(r.find((x) => x.label === "生成器 g の options.endpoint")?.host).toBe("api.example");
  });
});
