import net from "node:net";
import { describe, expect, it } from "vitest";
import { findFreePort } from "./ports";

describe("findFreePort", () => {
  it("実際に bind できる空きポートを返す", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
    });
  });
  it("連続して呼んでも使用中のポートは返さない", async () => {
    const held = net.createServer();
    await new Promise<void>((r) => held.listen(0, "127.0.0.1", () => r()));
    const heldPort = (held.address() as net.AddressInfo).port;
    try {
      for (let i = 0; i < 5; i++) expect(await findFreePort()).not.toBe(heldPort);
    } finally {
      held.close();
    }
  });
});
