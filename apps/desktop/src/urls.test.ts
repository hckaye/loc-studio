import { describe, expect, it } from "vitest";
import { buildProjectUrl, isExternalUrl, isLocalUrl } from "./urls";

describe("urls", () => {
  const base = "http://127.0.0.1:4567";
  it("プロジェクトのパスをエンコードして ?project= に付ける", () => {
    expect(buildProjectUrl(base)).toBe("http://127.0.0.1:4567/");
    const url = new URL(buildProjectUrl(base, "C:\\Games\\ゲーム A&B"));
    expect(url.searchParams.get("project")).toBe("C:\\Games\\ゲーム A&B");
    expect(buildProjectUrl(base, "/a b")).toBe("http://127.0.0.1:4567/?project=%2Fa+b");
  });
  it("ローカルサーバーと同じオリジンだけを内部とみなす", () => {
    expect(isLocalUrl("http://127.0.0.1:4567/x?y=1", base)).toBe(true);
    expect(isLocalUrl("http://127.0.0.1:4568/", base)).toBe(false);
    expect(isLocalUrl("http://localhost:4567/", base)).toBe(false);
    expect(isLocalUrl("https://127.0.0.1:4567/", base)).toBe(false);
    expect(isLocalUrl("not a url", base)).toBe(false);
  });
  it("外部で開くのは http / https だけ", () => {
    expect(isExternalUrl("https://example.com")).toBe(true);
    expect(isExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isExternalUrl("javascript:alert(1)")).toBe(false);
  });
});
