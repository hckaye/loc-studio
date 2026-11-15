import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cliSettingsFromEnv,
  expandUserTemplate,
  isEnforceable,
  localSettingsPath,
  readLocalSettings,
  resolveSetting,
  resolveSettings,
  resolveUserName,
  writeLocalSettings,
  type SettingSource,
  type SettingsLayers,
} from "./settings.js";

const ORDER: SettingSource[] = ["enforce", "cli", "local", "defaults", "app"];

describe("resolveSetting の優先順位", () => {
  it("全ての層の組み合わせで、最も強い層が勝つ", () => {
    for (let mask = 1; mask < 32; mask++) {
      const layers: SettingsLayers = {};
      ORDER.forEach((s, i) => {
        if (mask & (1 << i)) layers[s] = { "a.b": s };
      });
      const expected = ORDER.find((_, i) => mask & (1 << i))!;
      const r = resolveSetting("a.b", layers)!;
      expect(r.source).toBe(expected);
      expect(r.value).toBe(expected);
      expect(r.locked).toBe(expected === "enforce");
    }
  });

  it("どこにもなければ undefined", () => {
    expect(resolveSetting("x", {})).toBeUndefined();
    expect(resolveSetting("x", { local: { y: 1 } })).toBeUndefined();
  });

  it("undefined の値は無いものとして扱い、false や 0 や空文字は値として扱う", () => {
    expect(resolveSetting("x", { cli: { x: undefined }, local: { x: 1 } })?.source).toBe("local");
    expect(resolveSetting("x", { cli: { x: false }, local: { x: true } })?.value).toBe(false);
    expect(resolveSetting("x", { cli: { x: 0 } })?.value).toBe(0);
    expect(resolveSetting("x", { cli: { x: null }, local: { x: 1 } })?.value).toBeNull();
  });
});

describe("固定できないキー", () => {
  it("isEnforceable", () => {
    expect(isEnforceable("user.name")).toBe(true);
    expect(isEnforceable("secrets.apiKey")).toBe(false);
    expect(isEnforceable("plugins.trust")).toBe(false);
    expect(isEnforceable("plugins.trust.foo")).toBe(false);
    expect(isEnforceable("plugins.trustworthy")).toBe(true);
  });

  it("enforce は無視され、下の層の値が使われる", () => {
    const layers: SettingsLayers = { enforce: { "secrets.k": "evil" }, local: { "secrets.k": "mine" } };
    const r = resolveSetting("secrets.k", layers)!;
    expect(r).toMatchObject({ value: "mine", source: "local", locked: false });
  });

  it("enforce だけにあるなら値なし", () => {
    expect(resolveSetting("plugins.trust", { enforce: { "plugins.trust": true } })).toBeUndefined();
  });

  it("resolveSettings は無視したキーを列挙する", () => {
    const { values, ignoredEnforce } = resolveSettings({
      enforce: { "user.name": "{osUser}", "secrets.a": 1, "plugins.trust.x": true },
      local: { "theme": "dark", "secrets.a": "mine" },
      defaults: { "review.forwardOnPost": true },
    });
    expect(ignoredEnforce.sort()).toEqual(["plugins.trust.x", "secrets.a"]);
    expect(values["user.name"]).toMatchObject({ source: "enforce", locked: true });
    expect(values["theme"]).toMatchObject({ value: "dark", source: "local" });
    expect(values["secrets.a"]).toMatchObject({ value: "mine", source: "local" });
    expect(values["review.forwardOnPost"]).toMatchObject({ source: "defaults" });
    expect(values["plugins.trust.x"]).toBeUndefined();
  });
});

describe("テンプレートとユーザー名", () => {
  const sys = { hostname: "PC-01", osUser: "taro" };

  it("expandUserTemplate", () => {
    expect(expandUserTemplate("{osUser}@{hostname} {osUser}", sys)).toBe("taro@PC-01 taro");
    expect(expandUserTemplate("plain", sys)).toBe("plain");
  });

  it("何もなければ PC 名", () => {
    expect(resolveUserName({}, sys)).toEqual({ key: "user.name", value: "PC-01", source: "app", locked: false });
  });

  it("local の値を使い、テンプレートを展開する", () => {
    expect(resolveUserName({ local: { "user.name": "Hanako" } }, sys)).toMatchObject({ value: "Hanako", source: "local" });
    expect(resolveUserName({ defaults: { "user.name": "{osUser}" } }, sys)).toMatchObject({ value: "taro", source: "defaults" });
  });

  it("enforce のテンプレートは locked", () => {
    expect(resolveUserName({ enforce: { "user.name": "{osUser}" }, local: { "user.name": "x" } }, sys)).toEqual({
      key: "user.name",
      value: "taro",
      source: "enforce",
      locked: true,
    });
  });

  it("空・文字列以外は次の層へ", () => {
    expect(resolveUserName({ cli: { "user.name": "" }, local: { "user.name": 5 }, defaults: { "user.name": "D" } }, sys)).toMatchObject({
      value: "D",
      source: "defaults",
    });
    expect(resolveUserName({ cli: { "user.name": "  " } }, sys).source).toBe("app");
  });

  it("app 層の user.name が PC 名より先に使われる", () => {
    expect(resolveUserName({ app: { "user.name": "App" } }, sys)).toMatchObject({ value: "App", source: "app" });
  });
});

describe("cliSettingsFromEnv", () => {
  it("LOC_STUDIO_USER を user.name に対応づける", () => {
    expect(cliSettingsFromEnv({ LOC_STUDIO_USER: "hana" })).toEqual({ "user.name": "hana" });
    expect(cliSettingsFromEnv({})).toEqual({});
    expect(cliSettingsFromEnv({ LOC_STUDIO_USER: "" })).toEqual({});
  });
});

describe("localSettingsPath", () => {
  it("LOC_STUDIO_SETTINGS が最優先", () => {
    expect(localSettingsPath({ LOC_STUDIO_SETTINGS: "/x/s.json" }, "win32", "C:\\u")).toBe("/x/s.json");
  });
  it("win32", () => {
    expect(localSettingsPath({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32", "C:\\Users\\a")).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\loc-studio\\settings.json",
    );
    expect(localSettingsPath({}, "win32", "C:\\Users\\a")).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\loc-studio\\settings.json",
    );
  });
  it("darwin", () => {
    expect(localSettingsPath({}, "darwin", "/Users/a")).toBe("/Users/a/Library/Application Support/loc-studio/settings.json");
  });
  it("linux", () => {
    expect(localSettingsPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/a")).toBe("/xdg/loc-studio/settings.json");
    expect(localSettingsPath({}, "linux", "/home/a")).toBe("/home/a/.config/loc-studio/settings.json");
  });
});

describe("ローカル設定ファイル", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "settings-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("書いたものを読み戻せ、フォルダも作る。一時ファイルは残らない", async () => {
    const file = path.join(dir, "sub", "settings.json");
    const values = { "user.name": "あ", "review.forwardOnPost": true, n: [1, 2] };
    await writeLocalSettings(file, values);
    await writeLocalSettings(file, values);
    expect(await readLocalSettings(file)).toEqual(values);
    expect(await readdir(path.join(dir, "sub"))).toEqual(["settings.json"]);
  });

  it("ファイルがなければ {}", async () => {
    expect(await readLocalSettings(path.join(dir, "none.json"))).toEqual({});
  });

  it("壊れた JSON と非オブジェクトはパス付きで失敗する", async () => {
    const file = path.join(dir, "bad.json");
    await writeFile(file, "{oops");
    await expect(readLocalSettings(file)).rejects.toThrow(file);
    await writeFile(file, "[1]");
    await expect(readLocalSettings(file)).rejects.toThrow(file);
    await writeFile(file, "null");
    await expect(readLocalSettings(file)).rejects.toThrow(/オブジェクト/);
  });
});
