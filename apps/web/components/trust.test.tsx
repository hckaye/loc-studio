import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/components/App";
import { ToastArea, ToastProvider } from "@/components/context";
import { PluginTrustDialog } from "@/components/PluginTrustDialog";
import { ReviewPanel } from "@/components/ReviewPanel";
import { RpcError } from "@/lib/client/api";
import { gridKind } from "@/lib/client/model";
import { makeInfo, mockApi } from "@/test/fixtures";
import { renderWithStudio } from "@/test/render";

/* 信頼の確認（path と hash、変わったときのやり直し、コードの設定）、制限された状態、URL の形式。 */

const config = { kind: "config" as const, path: "/p/loc-studio.config.ts", layer: "project" as const, hash: "c0ffee1234567890abcdef", files: ["/p/loc-studio.config.ts"] };
const plugin = {
  kind: "plugin" as const,
  path: "/p/loc-studio-plugins/pack",
  layer: "project" as const,
  hash: "beef",
  files: Array.from({ length: 9 }, (_, i) => `/p/loc-studio-plugins/pack/f${i}.mjs`),
};

afterEach(() => vi.unstubAllGlobals());

describe("信頼の確認", () => {
  it("見せた path と hash をそのまま返す。コードの設定はそれと分かる書き方で、長いファイルの一覧は折りたたむ", async () => {
    const info = makeInfo();
    const { api } = mockApi(info);
    api.plugins.mockResolvedValue({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [config, plugin] });
    const onTrusted = vi.fn();
    renderWithStudio(<PluginTrustDialog onTrusted={onTrusted} onSkip={vi.fn()} />, api, info);
    const dialog = await screen.findByRole("dialog", { name: "このプロジェクトのコードを実行しますか" });
    await within(dialog).findByText("/p/loc-studio.config.ts", { selector: ".trust-head .mono" });
    expect(within(dialog).getByText("コードの設定", { selector: ".badge" })).toBeTruthy();
    expect(within(dialog).getByText(/プロジェクトのコードの設定（loc-studio\.config\.\*）です/)).toBeTruthy();
    // 9 ファイルは折りたたむ（details）
    const details = dialog.querySelector("details.trust-files")!;
    expect(details.querySelector("summary")!.textContent).toBe("確認の対象のファイル（9）");
    expect(within(dialog).getByText("ハッシュ: c0ffee1234567890…")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "信頼して読み込む" }));
    await waitFor(() =>
      expect(api.trustPlugins).toHaveBeenCalledWith({
        items: [
          { path: config.path, hash: config.hash },
          { path: plugin.path, hash: plugin.hash },
        ],
      }),
    );
    await waitFor(() => expect(onTrusted).toHaveBeenCalled());
  });

  it("確かめているあいだに中身が変わったら（conflict）一覧を読み直し、もう一度確かめてもらう", async () => {
    const info = makeInfo();
    const { api } = mockApi(info);
    api.plugins
      .mockResolvedValueOnce({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [{ ...plugin, files: [plugin.files[0]!] }] })
      .mockResolvedValueOnce({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [{ ...plugin, hash: "new-hash", files: [plugin.files[0]!] }] });
    api.trustPlugins.mockRejectedValueOnce(new RpcError("trustPlugins", "conflict", "変わりました", { path: plugin.path, hash: "new-hash" }));
    const onTrusted = vi.fn();
    renderWithStudio(<PluginTrustDialog onTrusted={onTrusted} onSkip={vi.fn()} />, api, info);
    const dialog = await screen.findByRole("dialog", { name: "このプロジェクトのプラグインを実行しますか" });
    await within(dialog).findByText(/ハッシュ: beef/);
    fireEvent.click(within(dialog).getByRole("button", { name: "信頼して読み込む" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("ファイルが変わりました"));
    await within(dialog).findByText(/ハッシュ: new-hash/);
    expect(onTrusted).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "信頼して読み込む" }));
    await waitFor(() => expect(api.trustPlugins).toHaveBeenLastCalledWith({ items: [{ path: plugin.path, hash: "new-hash" }] }));
  });
});

describe("設定ファイルの確認", () => {
  const settings = {
    kind: "settings" as const,
    path: "/p/loc-studio.project.json",
    layer: "project" as const,
    hash: "5e771235aaaabbbbcccc",
    files: ["/p/loc-studio.project.json"],
    summary: [
      { label: "保存先", value: "postgres://loc:********@db.example.internal:5432/${env:LOC_DB}" },
      { label: "環境変数", value: "LOC_DB" },
      { label: "生成器 backTranslate", value: "llm.translate（https://llm.example.internal/v1）" },
    ],
  };

  it("設定ファイルだと分かる書き方で要約を省略せずに出し、読み込まずに開く選択肢は出さない", async () => {
    const info = makeInfo({ restricted: true });
    const { api } = mockApi(info);
    api.plugins.mockResolvedValue({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [settings] });
    api.trustPlugins.mockResolvedValue(makeInfo());
    const onTrusted = vi.fn();
    renderWithStudio(<PluginTrustDialog restricted onTrusted={onTrusted} onSkip={vi.fn()} />, api, info);
    const dialog = await screen.findByRole("dialog", { name: "このプロジェクトの設定を信頼しますか" });
    await within(dialog).findByText("設定ファイル", { selector: ".badge" });
    expect(within(dialog).getByText(/データの保存先、読み込むプラグインのフォルダ、接続する外部のサービス、使う環境変数を決めます/)).toBeTruthy();
    // 要約: 接続先を見落とさないよう、値はそのまま全部出す
    const rows = [...dialog.querySelectorAll(".trust-summary-row")].map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd > bdi")!.textContent]);
    expect(rows).toEqual(settings.summary.map((r) => [r.label, r.value]));
    // 設定がないと動かないので「読み込まずに開く」はない（信頼するか、閉じるか）
    expect(within(dialog).queryByRole("button", { name: "読み込まずに開く" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "プロジェクトを閉じる" })).toBeTruthy();
    expect(within(dialog).getByText(/設定ファイルを信頼するまで開けません/)).toBeTruthy();
    expect(within(dialog).queryByText(/実行されるコードが/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "信頼して開く" }));
    await waitFor(() => expect(api.trustPlugins).toHaveBeenCalledWith({ items: [{ path: settings.path, hash: settings.hash }] }));
    await waitFor(() => expect(onTrusted).toHaveBeenCalled());
  });

  it("値を URL として解析した実際の接続先と注意書きを、値とは別に出す。値は bdi で囲む", async () => {
    const info = makeInfo({ restricted: true });
    const { api } = mockApi(info);
    const tricky = {
      ...settings,
      summary: [
        { label: "生成器 mt の options.endpoint", value: "https://good.example@evil.example/v1", host: "evil.example", note: "URL にユーザー名が入っています" },
        { label: "生成器 mt の options.model", value: "x" },
      ],
    };
    api.plugins.mockResolvedValue({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [tricky] } as never);
    renderWithStudio(<PluginTrustDialog restricted onTrusted={vi.fn()} onSkip={vi.fn()} />, api, info);
    const dialog = await screen.findByRole("dialog", { name: "このプロジェクトの設定を信頼しますか" });
    await within(dialog).findByText("設定ファイル", { selector: ".badge" });
    const rows = [...dialog.querySelectorAll(".trust-summary-row")];
    expect(rows[0]!.querySelector(".trust-host")!.textContent).toBe("接続先 evil.example");
    expect(rows[0]!.querySelector(".trust-note")!.textContent).toBe("URL にユーザー名が入っています");
    expect(rows[0]!.querySelector("dd > bdi")!.textContent).toBe("https://good.example@evil.example/v1");
    expect(rows[1]!.querySelector(".trust-host")).toBeNull();
    // 接続先は先頭にもまとめて出す
    expect(dialog.querySelector(".trust-hosts")!.textContent).toBe("この設定で接続する先: evil.example");
  });

  it("設定を信頼してもまだ制限された状態なら、続けてコードの設定を確認する", async () => {
    const info = makeInfo({ restricted: true });
    const { api } = mockApi(info);
    api.plugins
      .mockResolvedValueOnce({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [settings] })
      .mockResolvedValueOnce({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [config] });
    api.trustPlugins.mockResolvedValueOnce(makeInfo({ restricted: true })).mockResolvedValueOnce(makeInfo());
    renderWithStudio(<PluginTrustDialog restricted onTrusted={vi.fn()} onSkip={vi.fn()} />, api, info);
    const first = await screen.findByRole("dialog", { name: "このプロジェクトの設定を信頼しますか" });
    fireEvent.click(await within(first).findByRole("button", { name: "信頼して開く" }));
    const second = await screen.findByRole("dialog", { name: "このプロジェクトのコードを実行しますか" });
    expect(await within(second).findByRole("status")).toHaveProperty("textContent", expect.stringContaining("続けて、このプロジェクトのコードを確認します"));
    await within(second).findByText("/p/loc-studio.config.ts", { selector: ".trust-head .mono" });
    fireEvent.click(within(second).getByRole("button", { name: "信頼して読み込む" }));
    await waitFor(() => expect(api.trustPlugins).toHaveBeenLastCalledWith({ items: [{ path: config.path, hash: config.hash }] }));
  });

  it("制限された状態なのに確認するものがなければ（信頼済みの中身に戻った）、読み直して先へ進む", async () => {
    const info = makeInfo({ restricted: true });
    const { api } = mockApi(info);
    api.plugins.mockResolvedValue({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [] });
    const reopened = makeInfo();
    api.reloadPlugins.mockResolvedValue(reopened);
    const onTrusted = vi.fn();
    renderWithStudio(<PluginTrustDialog restricted onTrusted={onTrusted} onSkip={vi.fn()} />, api, info);
    await waitFor(() => expect(onTrusted).toHaveBeenCalledWith(reopened));
    expect(api.trustPlugins).not.toHaveBeenCalled();
  });

  it("設定とコードの設定が一緒に出たら、まとめて確認する", async () => {
    const info = makeInfo({ restricted: true });
    const { api } = mockApi(info);
    api.plugins.mockResolvedValue({ plugins: [], dirs: [], errors: [], warnings: [], untrusted: [settings, config] });
    renderWithStudio(<PluginTrustDialog restricted onTrusted={vi.fn()} onSkip={vi.fn()} />, api, info);
    const dialog = await screen.findByRole("dialog", { name: "このプロジェクトの設定とコードを信頼しますか" });
    await within(dialog).findByText("設定ファイル", { selector: ".badge" });
    expect(within(dialog).getByText("コードの設定", { selector: ".badge" })).toBeTruthy();
    expect(within(dialog).getByText(/実行されるコードが/).textContent).toContain("1 件");
  });
});

describe("制限された状態（コードの設定を信頼していない）", () => {
  function setup() {
    const info = makeInfo();
    const { api } = mockApi(info);
    let restricted = true;
    const calls: string[] = [];
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url === "/api/session") return json(200, { mode: "local", defaultProject: "/p", recentProjects: [], desktop: false });
      if (url === "/api/session/open") return json(200, { result: { project: "/p", name: "TestGame", recentProjects: ["/p"] } });
      const method = url.split("/").pop()!;
      if (method === "info") return json(200, { result: { ...info, restricted: restricted || undefined } });
      if (method === "plugins") return json(200, { result: { plugins: [], dirs: [], errors: [], warnings: [], untrusted: [config] } });
      if (method === "trustPlugins") {
        restricted = false;
        return json(200, { result: { ...info } });
      }
      if (restricted) return json(200, { error: { code: "untrusted", message: "プロジェクトのコードの設定（loc-studio.config.ts）を信頼するまで、この操作はできません。" } });
      const fn = (api as unknown as Record<string, (p: unknown) => Promise<unknown>>)[method];
      const params = init?.body ? (JSON.parse(String(init.body)) as { params?: unknown }).params : undefined;
      return json(200, { result: fn ? await fn(params) : null });
    });
    vi.stubGlobal("fetch", fetch);
    return { calls, setRestricted: (v: boolean) => (restricted = v) };
  }

  it("確認だけを出し、表もツリーも読まない。信頼したら info を読み直して開く。あとで untrusted になったら確認に戻る", async () => {
    const { calls, setRestricted } = setup();
    const { container } = render(
      <ToastProvider>
        <App />
        <ToastArea />
      </ToastProvider>,
    );
    const dialog = await screen.findByRole("dialog", { name: "このプロジェクトのコードを実行しますか" });
    expect(within(dialog).getByRole("button", { name: "プロジェクトを閉じる" })).toBeTruthy();
    expect(screen.getByText("このプロジェクトは、設定を確認して信頼するまで開けません。")).toBeTruthy();
    expect(calls.some((u) => u.endsWith("/tree") || u.endsWith("/rows"))).toBe(false);
    await within(dialog).findByText("/p/loc-studio.config.ts", { selector: ".trust-head .mono" });
    fireEvent.click(within(dialog).getByRole("button", { name: "信頼して読み込む" }));
    await waitFor(() => expect(container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
    // 設定のファイルがあとで書き換えられた: どの呼び出しでも untrusted なら確認の画面に戻る（生のエラーの通知は出さない）
    setRestricted(true);
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    const again = await screen.findByRole("dialog", { name: "このプロジェクトのコードを実行しますか" });
    expect(screen.queryByText(/この操作はできません/)).toBeNull();
    // 表の画面は消さずに隠す（開いている編集欄の入力を失わないため）。確認の画面には、その旨を出す
    const host = container.querySelector(".studio-host")!;
    expect(host.hasAttribute("hidden")).toBe(true);
    expect(host.hasAttribute("inert")).toBe(true);
    expect(within(again).getByRole("status").textContent).toMatch(/アプリの外で変わりました.*編集中の入力は残っています/);
    // 信頼すると、表の画面に戻って読み直す
    const before = calls.filter((u) => u.endsWith("/tree")).length;
    fireEvent.click(within(again).getByRole("button", { name: "信頼して読み込む" }));
    await waitFor(() => expect(container.querySelector(".studio-host")!.hasAttribute("hidden")).toBe(false));
    await waitFor(() => expect(calls.filter((u) => u.endsWith("/tree")).length).toBeGreaterThan(before));
    expect(screen.queryByRole("dialog", { name: "このプロジェクトのコードを実行しますか" })).toBeNull();
  });

  it("?project= では開かず、入力欄に入れるだけ", async () => {
    window.history.replaceState(null, "", "/?project=%2Fsomewhere%2Fevil");
    const fetch = vi.fn(async (input: string) => {
      if (String(input) === "/api/session") return new Response(JSON.stringify({ mode: "local", recentProjects: [], desktop: false }), { headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ error: { code: "not-found", message: "x" } }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    render(
      <ToastProvider>
        <App />
      </ToastProvider>,
    );
    const input = (await screen.findByLabelText(/プロジェクトのフォルダ/)) as HTMLInputElement;
    expect(input.value).toBe("/somewhere/evil");
    await new Promise((r) => setTimeout(r, 30));
    expect(fetch.mock.calls.map((c) => String(c[0]))).toEqual(["/api/session"]);
    window.history.replaceState(null, "", "/");
  });
});

describe("プラグインから来た URL", () => {
  it("レビューのリンクは http / https だけをリンクにし、ほかは文字として出す", async () => {
    const info = makeInfo();
    const { api } = mockApi(info);
    api.reviews.mockResolvedValue([
      {
        id: "r1",
        cell: { entryKey: "KEY_0", resourceId: "res.csv", columnId: "review", language: "en" },
        columnId: "review",
        verdict: "ok",
        comment: "",
        userName: "a",
        createdAt: "2026-01-01T00:00:00Z",
        stale: false,
        links: [
          { label: "チケット", url: "https://tracker.example/T-1" },
          { label: "悪いリンク", url: "javascript:alert(1)" },
        ],
      },
    ]);
    const col = info.columns.find((c) => c.kind === "review")!;
    renderWithStudio(
      <ReviewPanel resourceId="res.csv" rowKey="KEY_0" gc={{ cellId: "review@en", col, kind: gridKind(col), language: "en", groupId: "lang:en", width: 1 }} onClose={vi.fn()} onPosted={vi.fn()} />,
      api,
      info,
    );
    const good = await screen.findByRole("link", { name: "チケット" });
    expect(good.getAttribute("href")).toBe("https://tracker.example/T-1");
    expect(good.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.queryByRole("link", { name: /悪いリンク/ })).toBeNull();
    expect(screen.getByText("悪いリンク（javascript:alert(1)）")).toBeTruthy();
  });

  it("アクションの結果の URL は http / https だけを noopener,noreferrer で開く", async () => {
    const { Studio } = await import("@/components/Studio");
    const info = makeInfo({ actions: [{ id: "x", label: "外へ", target: "file" }] });
    const { api } = mockApi(info);
    const open = vi.fn();
    vi.stubGlobal("open", open);
    api.runAction.mockResolvedValueOnce({ patched: 0, open: { url: "javascript:alert(1)" } }).mockResolvedValueOnce({ patched: 0, open: { url: "https://ok.example/a" } });
    const { container } = render(
      <ToastProvider>
        <Studio api={api} project="/tmp/test" initialInfo={info} />
        <ToastArea />
      </ToastProvider>,
    );
    await waitFor(() => expect(container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "アクション ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "外へ" }));
    expect(await screen.findByText(/開けない形式の URL のため開きませんでした/)).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "アクション ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "外へ" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://ok.example/a", "_blank", "noopener,noreferrer"));
  });
});
