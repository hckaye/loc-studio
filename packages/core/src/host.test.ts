import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./memory-db.js";
import { createPluginHost, envSecrets, secretEnvName } from "./host.js";

describe("envSecrets", () => {
  it("extra を先に、なければ環境変数を読む", () => {
    const env = { LOC_STUDIO_SECRET_LLM_APIKEY: "from-env", LOC_STUDIO_SECRET_OTHER_KEY_2: "o" };
    expect(secretEnvName("llm.apiKey")).toBe("LOC_STUDIO_SECRET_LLM_APIKEY");
    expect(envSecrets(env).get("llm.apiKey")).toBe("from-env");
    expect(envSecrets(env, { "llm.apiKey": "from-extra" }).get("llm.apiKey")).toBe("from-extra");
    expect(envSecrets(env).get("other-key.2")).toBe("o");
    expect(envSecrets(env).get("missing")).toBeUndefined();
    expect(envSecrets({ LOC_STUDIO_SECRET_X: "" }, { x: "" }).get("x")).toBeUndefined();
  });
});

describe("createPluginHost", () => {
  it("user.name は読むたびに userName() を呼ぶ", () => {
    let name = "alice";
    const db = createMemoryDb();
    const host = createPluginHost({ db, userName: () => name, projectRoot: "/p", env: { A: "1" } });
    expect(host.user.name).toBe("alice");
    name = "bob";
    expect(host.user.name).toBe("bob");
    expect(host.db).toBe(db);
    expect(host.projectRoot).toBe("/p");
    expect(host.env).toEqual({ A: "1" });
  });

  it("secrets、fetch、log を差し替えられる。secrets の既定は env から読む", async () => {
    const logs: string[] = [];
    const fakeFetch = (async () => new Response("ok")) as typeof fetch;
    const host = createPluginHost({
      db: createMemoryDb(),
      userName: () => "u",
      projectRoot: "/p",
      env: { LOC_STUDIO_SECRET_TOKEN: "t" },
      fetch: fakeFetch,
      log: (m) => logs.push(m),
    });
    expect(host.secrets.get("token")).toBe("t");
    expect(await (await host.fetch("http://example.invalid")).text()).toBe("ok");
    host.log("hello");
    expect(logs).toEqual(["hello"]);

    const custom = createPluginHost({ db: createMemoryDb(), userName: () => "u", projectRoot: "/p", secrets: { get: () => "s" } });
    expect(custom.secrets.get("anything")).toBe("s");
  });
});
