import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestProject, trustSettings } from "./testing.js";
import type { TestProject } from "./testing.js";

let tp: TestProject;
beforeEach(async () => {
  tp = await makeTestProject();
  await tp.write(
    "loc-studio-plugins/cells/index.mjs",
    `export default { name: "cells", renderers: [{ id: "cells.bar", module: "web/bar.mjs" }, { id: "cells.css", module: "web/style.css" }, { id: "cells.missing", module: "web/none.js" }] };`,
  );
  await tp.write("loc-studio-plugins/cells/web/bar.mjs", "export default { render(el, ctx) { el.textContent = String(ctx.value); } };\n");
  await tp.write("loc-studio-plugins/cells/web/style.css", "body{}");
  const config = JSON.parse(await tp.read("loc-studio.project.json")) as { columns: unknown[] };
  await tp.patchConfig({
    columns: [...config.columns, { use: "builtin.length", id: "length", display: "progress", renderer: "cells.bar", options: { max: 40 } }],
  });
});
afterEach(async () => {
  await tp.cleanup();
});

describe("独自描画のモジュール", () => {
  it("登録された .js / .mjs だけを返し、ハッシュは中身で変わる。列の display / renderer はそのまま出る", async () => {
    const ws = await tp.open();
    let info = await ws.info();
    expect(info.renderers.map((r) => [r.id, r.pluginName])).toEqual([["cells.bar", "cells"]]);
    expect(info.columns.find((c) => c.id === "length")).toMatchObject({ display: "progress", renderer: "cells.bar", options: { max: 40 } });
    const first = info.renderers[0]!.hash;
    const mod = await ws.rendererModule("cells.bar");
    expect(mod).toEqual({ source: expect.stringContaining("render(el, ctx)"), hash: first, contentType: "text/javascript" });
    expect(await ws.rendererModule("cells.css")).toBeUndefined();
    expect(await ws.rendererModule("cells.missing")).toBeUndefined();
    expect(await ws.rendererModule("nope")).toBeUndefined();
    expect(info.warnings.join("\n")).toContain("cells.css");

    await tp.write("loc-studio-plugins/cells/web/bar.mjs", "export default { render(el) { el.textContent = 'v2'; } };\n");
    expect((await ws.rendererModule("cells.bar"))!.hash).not.toBe(first);
    info = await ws.reloadPlugins();
    expect(info.renderers[0]!.hash).not.toBe(first);
    expect((await ws.rendererModule("cells.bar"))!.source).toContain("v2");
  });

  it("信頼していないプラグインの独自描画は出さない", async () => {
    const ws = await tp.open({ pluginTrust: "prompt" });
    await trustSettings(ws);
    expect((await ws.info()).renderers).toEqual([]);
    expect(await ws.rendererModule("cells.bar")).toBeUndefined();
    const cells = (await ws.plugins()).untrusted.find((u) => u.path === path.join(tp.root, "loc-studio-plugins", "cells"))!;
    await ws.trustPlugins({ items: [{ path: cells.path, hash: cells.hash }] });
    expect((await ws.info()).renderers.map((r) => r.id)).toEqual(["cells.bar"]);
  });
});
