import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastProvider } from "@/components/context";
import { Studio } from "@/components/Studio";
import { DisplayValue, safeCssColor, safeHttpUrl, toTags } from "@/components/grid/display";
import { RenderedCell, RendererProvider, type RendererLoader, type RendererModule } from "@/components/grid/renderers";
import { makeInfo, mockApi } from "@/test/fixtures";

/* 独自描画（偽のモジュール）と同梱の見せ方。 */

function fakeModule() {
  const cleanups: string[] = [];
  const renders: unknown[] = [];
  const mod: RendererModule = {
    render(el, ctx) {
      renders.push(ctx.value);
      el.textContent = `R:${String(ctx.value)}`;
      const v = String(ctx.value);
      return () => cleanups.push(v);
    },
  };
  return { mod, cleanups, renders };
}

const baseCtx = { column: { id: "c" }, entryKey: "K", resourceId: "r", readOnly: true };

describe("独自描画", () => {
  it("読み込んで描き、値が変わる前と消えるときに後片付けを呼ぶ（モジュールはハッシュごとに 1 回）", async () => {
    const { mod, cleanups } = fakeModule();
    const loader = vi.fn<RendererLoader>(async () => mod);
    const ui = (value: unknown) => (
      <RendererProvider loader={loader} renderers={[{ id: "demo", hash: "h1" }]}>
        <RenderedCell rendererId="demo" ctx={{ ...baseCtx, value }} fallback={<span>plain</span>} />
      </RendererProvider>
    );
    const { container, rerender, unmount } = render(ui(1));
    await waitFor(() => expect(container.textContent).toBe("R:1"));
    rerender(ui(2));
    await waitFor(() => expect(container.textContent).toBe("R:2"));
    expect(cleanups).toEqual(["1"]);
    unmount();
    expect(cleanups).toEqual(["1", "2"]);
    expect(loader).toHaveBeenCalledWith("demo", "h1");
  });

  it("render が投げても、読み込めなくても、そのセルだけ値と失敗の印にする", async () => {
    const throwing: RendererLoader = async () => ({
      render() {
        throw new Error("boom");
      },
    });
    const failing: RendererLoader = async () => {
      throw new Error("404");
    };
    const { container } = render(
      <div>
        <RendererProvider loader={throwing} renderers={[{ id: "bad", hash: "h" }]}>
          <span data-testid="a">
            <RenderedCell rendererId="bad" ctx={{ ...baseCtx, value: "v1" }} fallback={<span>v1</span>} />
          </span>
        </RendererProvider>
        <RendererProvider loader={failing} renderers={[{ id: "gone", hash: "h" }]}>
          <span data-testid="b">
            <RenderedCell rendererId="gone" ctx={{ ...baseCtx, value: "v2" }} fallback={<span>v2</span>} />
          </span>
        </RendererProvider>
        <span data-testid="c">ok</span>
      </div>,
    );
    const a = await screen.findByTestId("a");
    await waitFor(() => expect(within(a).getByLabelText(/独自描画の失敗/).getAttribute("title")).toContain("boom"));
    expect(a.textContent).toContain("v1");
    const b = screen.getByTestId("b");
    await waitFor(() => expect(within(b).getByLabelText(/独自描画の失敗/).getAttribute("title")).toContain("404"));
    expect(screen.getByTestId("c").textContent).toBe("ok");
    void container;
  });

  it("表の列で使われ、編集できるセルでは setValue が setCell につながる。スクロールで消えたセルは後片付けする", async () => {
    const cleanups: string[] = [];
    let setValue: ((v: unknown) => Promise<void>) | undefined;
    const loader: RendererLoader = async () => ({
      render(el, ctx) {
        el.textContent = `★${String(ctx.value)}`;
        if (ctx.entryKey === "KEY_0") setValue = ctx.setValue;
        return () => cleanups.push(ctx.entryKey);
      },
    });
    const base = makeInfo();
    const info = makeInfo({
      columns: base.columns.map((c) => (c.id === "note" ? { ...c, renderer: "demo.star" } : c)),
      renderers: [{ id: "demo.star", pluginName: "p", hash: "h" }],
    });
    const { api } = mockApi(info);
    const { container, unmount } = render(
      <ToastProvider>
        <Studio api={api} project="/tmp/test" initialInfo={info} rendererLoader={loader} />
      </ToastProvider>,
    );
    await waitFor(() => expect(container.querySelector('[data-row="0"] .k-string')?.textContent).toBe("★memo0"));
    expect(setValue).toBeTypeOf("function");
    await act(async () => {
      await setValue!("新しい値");
    });
    expect(api.setCell).toHaveBeenCalledWith(expect.objectContaining({ key: "KEY_0", cellId: "note", value: "新しい値" }));
    unmount();
    expect(cleanups).toEqual(expect.arrayContaining(["KEY_0", "KEY_1", "KEY_2"]));
  });

  it("読み取り専用の利用者には setValue を渡さない", async () => {
    let ctxSeen: { readOnly: boolean; setValue?: unknown } | undefined;
    const loader: RendererLoader = async () => ({
      render(el, ctx) {
        ctxSeen = ctx;
        el.textContent = "x";
      },
    });
    const base = makeInfo();
    const info = makeInfo({
      columns: base.columns.map((c) => (c.id === "note" ? { ...c, renderer: "demo.star" } : c)),
      renderers: [{ id: "demo.star", pluginName: "p", hash: "h" }],
      permissions: { role: "viewer", can: { edit: false, review: false, run: false, manage: false } },
    });
    const { api } = mockApi(info);
    render(
      <ToastProvider>
        <Studio api={api} project="/tmp/test" initialInfo={info} rendererLoader={loader} />
      </ToastProvider>,
    );
    await waitFor(() => expect(ctxSeen).toBeDefined());
    expect(ctxSeen!.readOnly).toBe(true);
    expect(ctxSeen!.setValue).toBeUndefined();
  });
});

describe("同梱の見せ方", () => {
  it("link: http / https だけを新しいタブで開けるリンクにする", () => {
    const { container, rerender } = render(<DisplayValue kind="link" value="https://example.com/a?b=1" />);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    rerender(<DisplayValue kind="link" value="javascript:alert(1)" />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("javascript:alert(1)");
    expect(safeHttpUrl("ftp://x")).toBeUndefined();
    expect(safeHttpUrl(" HTTP://ok.example ")).toBe("http://ok.example/");
  });

  it("progress: 0〜1、または 0〜options.max の棒", () => {
    const { container, rerender } = render(<DisplayValue kind="progress" value={0.25} />);
    expect(container.querySelector<HTMLElement>(".fill")!.style.width).toBe("25%");
    rerender(<DisplayValue kind="progress" value={30} options={{ max: 40 }} />);
    expect(container.querySelector<HTMLElement>(".fill")!.style.width).toBe("75%");
    expect(container.textContent).toContain("30/40");
    rerender(<DisplayValue kind="progress" value={9} />);
    expect(container.querySelector<HTMLElement>(".fill")!.style.width).toBe("100%");
  });

  it("color: 安全な書き方だけ色見本にする", () => {
    expect(safeCssColor("#1a63d6")).toBe("#1a63d6");
    expect(safeCssColor("rgb(10, 20, 30)")).toBe("rgb(10, 20, 30)");
    expect(safeCssColor("hsl(200 50% 40% / 0.5)")).toBeDefined();
    expect(safeCssColor("red")).toBe("red");
    for (const bad of ["red;background:url(x)", "url(javascript:1)", "expression(alert(1))", "rgb(1,2,3);x", "var(--x)"]) expect(safeCssColor(bad)).toBeUndefined();
    const { container, rerender } = render(<DisplayValue kind="color" value="#ff0000" />);
    expect(container.querySelector<HTMLElement>(".swatch")!.style.background).toContain("rgb(255, 0, 0)");
    rerender(<DisplayValue kind="color" value="red;background:url(x)" />);
    expect(container.querySelector(".swatch")).toBeNull();
    expect(container.textContent).toBe("red;background:url(x)");
  });

  it("tags: 配列、または区切り文字の文字列を札に分ける", () => {
    expect(toTags(["a", " b "])).toEqual(["a", "b"]);
    expect(toTags("x, y,,z")).toEqual(["x", "y", "z"]);
    expect(toTags("x|y", "|")).toEqual(["x", "y"]);
    const { container } = render(<DisplayValue kind="tags" value="UI|戦闘" options={{ separator: "|" }} />);
    expect([...container.querySelectorAll(".tag")].map((t) => t.textContent)).toEqual(["UI", "戦闘"]);
  });
});

describe("列の幅のキー操作", () => {
  it("見出しの区切りにフォーカスして左右の矢印キーで幅を変える（aria-valuenow が変わる）", async () => {
    const info = makeInfo();
    const { api } = mockApi(info);
    const { container } = render(
      <ToastProvider>
        <Studio api={api} project="/tmp/test" initialInfo={info} />
      </ToastProvider>,
    );
    await waitFor(() => expect(container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
    const sep = screen.getByRole("separator", { name: /^キー の幅/ });
    expect(sep.getAttribute("tabindex")).toBe("0");
    expect(sep.getAttribute("aria-valuenow")).toBe("200");
    sep.focus();
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("separator", { name: /^キー の幅/ }).getAttribute("aria-valuenow")).toBe("216"));
    fireEvent.keyDown(screen.getByRole("separator", { name: /^キー の幅/ }), { key: "ArrowLeft", shiftKey: true });
    await waitFor(() => expect(screen.getByRole("separator", { name: /^キー の幅/ }).getAttribute("aria-valuenow")).toBe("212"));
    fireEvent.keyDown(screen.getByRole("separator", { name: /^キー の幅/ }), { key: "Home" });
    await waitFor(() => expect(screen.getByRole("separator", { name: /^キー の幅/ }).getAttribute("aria-valuenow")).toBe("200"));
    expect((container.querySelector(".g-hcell") as HTMLElement).style.width).toBe("200px");
  });
});
