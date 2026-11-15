import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToastArea, ToastProvider } from "@/components/context";
import { Studio } from "@/components/Studio";
import { RpcError } from "@/lib/client/api";
import { makeInfo, mockApi } from "@/test/fixtures";

async function renderStudio(over: Parameters<typeof makeInfo>[0] = {}, prepare?: (api: ReturnType<typeof mockApi>["api"]) => void) {
  const info = makeInfo(over);
  const { api } = mockApi(info);
  prepare?.(api);
  const utils = render(
    <ToastProvider>
      <Studio api={api} project="/tmp/test" initialInfo={info} />
      <ToastArea />
    </ToastProvider>,
  );
  await waitFor(() => expect(utils.container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
  return { ...utils, api, info };
}

function cell(container: HTMLElement, row: number, selector: string, nth = 0): HTMLElement {
  const el = container.querySelectorAll<HTMLElement>(`[data-row="${row}"] ${selector}`)[nth];
  if (!el) throw new Error(`セルが見つかりません: row ${row} ${selector}`);
  return el;
}

describe("表", () => {
  it("列の種類ごとにセルを描く", async () => {
    const { container } = await renderStudio();
    expect(cell(container, 0, ".k-key").textContent).toBe("KEY_0");
    expect(cell(container, 0, ".k-text", 0).textContent).toContain("日本語0");
    expect(cell(container, 0, ".k-text", 1).textContent).toContain("English 0");
    // 空の本文、未保存と検証エラーの印
    expect(cell(container, 1, ".k-text", 1).textContent).toContain("未翻訳");
    const marked = cell(container, 2, ".k-text", 1);
    expect(within(marked).getByLabelText("未保存")).toBeTruthy();
    expect(within(marked).getByLabelText("エラー: 1 件").getAttribute("title")).toContain("変数が足りません");
    expect(marked.className).toContain("unsaved");
    // 選択式（ラベル）とレビュー（変更あり）
    expect(within(cell(container, 0, ".k-enum", 0)).getByText("未着手")).toBeTruthy();
    expect(within(cell(container, 0, ".k-enum", 1)).getByText("完了")).toBeTruthy();
    expect(within(cell(container, 0, ".k-review", 1)).getByText("変更あり")).toBeTruthy();
    // 文字と数値、生成列、アクション
    expect(cell(container, 0, ".k-string").textContent).toBe("memo0");
    expect(cell(container, 0, ".k-number").textContent).toBe("10");
    const gen = cell(container, 0, ".k-generated");
    expect(gen.textContent).toContain("back 0");
    expect(within(gen).getByText("古い")).toBeTruthy();
    expect(within(cell(container, 0, ".k-actions")).getByRole("button", { name: "チケット" })).toBeTruthy();
    // 言語グループの見出し
    expect(screen.getByRole("button", { name: "日本語 の固定を外す" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "英語 を左に固定" })).toBeTruthy();
  });

  it("本文のセルのダブルクリックで編集モーダルを開く", async () => {
    const { container, api } = await renderStudio();
    fireEvent.doubleClick(cell(container, 0, ".k-text", 1));
    const dialog = await screen.findByRole("dialog", { name: "本文の編集" });
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: /本文/ }) as HTMLTextAreaElement).value).toBe("English 0"));
    expect(within(dialog).getByText("日本語0")).toBeTruthy(); // 参照（基になる言語）
    expect(api.rowDetail).toHaveBeenCalled();
  });

  it("選択したセルで Enter を押すと編集モーダルを開く", async () => {
    const { container } = await renderStudio();
    fireEvent.mouseDown(cell(container, 1, ".k-text", 0), { button: 0 });
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", { name: "本文の編集" });
    await waitFor(() => expect(within(dialog).getByText("KEY_1")).toBeTruthy());
  });

  it("矢印キーで選択が動き、F2 でも開く", async () => {
    const { container } = await renderStudio();
    fireEvent.mouseDown(cell(container, 0, ".k-text", 0), { button: 0 });
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(cell(container, 1, ".k-text", 0).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(grid, { key: "F2" });
    const dialog = await screen.findByRole("dialog", { name: "本文の編集" });
    await waitFor(() => expect(within(dialog).getByText("KEY_1")).toBeTruthy());
  });
});

describe("選択式のセル", () => {
  it("選ぶとすぐ setCell で保存する（expectedVersion 付き）", async () => {
    const { container, api } = await renderStudio();
    fireEvent.click(within(cell(container, 0, ".k-enum", 0)).getByRole("button"));
    const list = await screen.findByRole("listbox", { name: "状態" });
    fireEvent.click(within(list).getByText("完了"));
    await waitFor(() => expect(api.setCell).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_0", cellId: "status@ja", value: "done", expectedVersion: 3 }));
    await waitFor(() => expect(within(cell(container, 0, ".k-enum", 0)).getByText("完了")).toBeTruthy());
  });

  it("競合したら両方の値を見せ、選んだほうにする", async () => {
    const { container, api } = await renderStudio();
    api.setCell.mockRejectedValueOnce(
      new RpcError("setCell", "conflict", "ほかの人が先に変更したため保存できませんでした（1 件）", { key: "KEY_0", cellId: "status@ja", current: { value: "done", version: 7, updatedBy: "alice" } }),
    );
    fireEvent.click(within(cell(container, 0, ".k-enum", 0)).getByRole("button"));
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("完了"));
    const dialog = await screen.findByRole("dialog", { name: "ほかの人が先に変更しました" });
    expect(within(dialog).getByText("alice", { exact: false })).toBeTruthy();
    expect(within(dialog).getByText("いまの値")).toBeTruthy();
    expect(within(dialog).getByText("あなたの値")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "自分の値で上書き" }));
    });
    await waitFor(() => expect(api.setCell).toHaveBeenLastCalledWith({ resourceId: "res.csv", key: "KEY_0", cellId: "status@ja", value: "done", expectedVersion: 7 }));
  });

  it("レビュー列で判定を選ぶと投稿パネルが開く", async () => {
    const { container } = await renderStudio();
    fireEvent.click(within(cell(container, 0, ".k-review", 0)).getByRole("button"));
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("承認"));
    const dialog = await screen.findByRole("dialog", { name: "レビュー: レビュー" });
    expect((within(dialog).getByRole("radio", { name: /承認/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("文字の列は Enter で確定、Esc で取消", async () => {
    const { container, api } = await renderStudio();
    fireEvent.doubleClick(cell(container, 0, ".k-string"));
    const input = within(cell(container, 0, ".k-string")).getByRole("textbox");
    fireEvent.change(input, { target: { value: "新しいメモ" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.setCell).toHaveBeenCalledWith(expect.objectContaining({ cellId: "note", value: "新しいメモ" })));
    fireEvent.doubleClick(cell(container, 1, ".k-string"));
    const input2 = within(cell(container, 1, ".k-string")).getByRole("textbox");
    fireEvent.change(input2, { target: { value: "x" } });
    fireEvent.keyDown(input2, { key: "Escape" });
    expect(api.setCell).toHaveBeenCalledTimes(1);
  });
});

describe("生成列とアクション列", () => {
  it("アクションのボタンはその行・その言語の本文を対象に runAction を呼ぶ", async () => {
    const { container, api } = await renderStudio();
    fireEvent.click(within(cell(container, 0, ".k-actions")).getByRole("button", { name: "チケット" }));
    await waitFor(() => expect(api.runAction).toHaveBeenCalledWith({ actionId: "ticket", resourceId: "res.csv", keys: ["KEY_0"], cellId: "text@ja", language: "ja" }));
  });

  it("生成のボタンは件数（dryRun）を見せてから始める", async () => {
    const { container, api } = await renderStudio();
    fireEvent.click(within(cell(container, 0, ".k-generated")).getByRole("button", { name: /を生成/ }));
    const dialog = await screen.findByRole("dialog", { name: "生成: 逆翻訳" });
    await waitFor(() => expect(api.generate).toHaveBeenCalledWith({ columnId: "back", scope: "cell", resourceId: "res.csv", keys: ["KEY_0"], languages: ["en"], dryRun: true }));
    const start = await within(dialog).findByRole("button", { name: "1 件を生成" });
    fireEvent.click(start);
    await waitFor(() => expect(api.generate).toHaveBeenLastCalledWith(expect.objectContaining({ dryRun: false })));
  });
});

describe("保存の競合と取り消し", () => {
  it("保存で競合したセルを一覧にし、セルごとにどちらを残すか選べる", async () => {
    const { api } = await renderStudio({}, (a) => {
      a.save.mockResolvedValueOnce({ saved: 0, conflicts: [{ key: "KEY_2", language: "en" }, { key: "KEY_0", language: "ja" }] });
    });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: /保存できなかった変更（2 件）/ });
    await waitFor(() => expect(within(dialog).getAllByText("English 2").length).toBeGreaterThan(0));
    expect(within(dialog).getByText("Saved 2")).toBeTruthy();
    const items = dialog.querySelectorAll<HTMLElement>(".conflict-item");
    // 1 件目: 自分の変更を使う → setText で当て直して保存
    fireEvent.click(within(items[0]!).getByRole("button", { name: "自分の変更を使う" }));
    await waitFor(() => expect(api.setText).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_2", language: "en", value: "English 2" }));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    await within(items[0]!).findByText("自分の変更を保存しました");
    // 2 件目: リソースの値を使う → 保存済みの値で setText（そのセルのドラフトだけ消える）
    fireEvent.click(within(items[1]!).getByRole("button", { name: "リソースの値を使う" }));
    await waitFor(() => expect(api.setText).toHaveBeenLastCalledWith({ resourceId: "res.csv", key: "KEY_0", language: "ja", value: "日本語0" }));
    await within(items[1]!).findByText("リソースの値に戻しました");
    expect(within(dialog).getByText("すべて解決しました。")).toBeTruthy();
  });

  it("未保存の変更をすべて取り消す（確認つき）", async () => {
    const { api } = await renderStudio({}, (a) => {
      a.tree.mockResolvedValue([{ id: "res", name: "res.csv", kind: "resource", resource: { id: "res.csv", path: "res.csv", name: "res.csv" }, unsaved: 2 }]);
    });
    const btn = await screen.findByRole("button", { name: "取り消す" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const dialog = await screen.findByRole("dialog", { name: "未保存の変更をすべて取り消しますか？" });
    expect(api.discardDrafts).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "すべて取り消す" }));
    await waitFor(() => expect(api.discardDrafts).toHaveBeenCalledWith({ resourceId: "res.csv" }));
  });
});

describe("横断検索", () => {
  it("Ctrl+Shift+F で開き、結果を選ぶとそのセルに移る", async () => {
    const { api, container } = await renderStudio({}, (a) => {
      a.search.mockResolvedValue([
        { resourceId: "res.csv", key: "KEY_2", language: "en", snippet: "…English 2…" },
        { resourceId: "res.csv", key: "KEY_1", snippet: "KEY_1" },
      ]);
    });
    fireEvent.keyDown(window, { key: "F", ctrlKey: true, shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "プロジェクト全体を検索" });
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "English" } });
    await waitFor(() => expect(api.search).toHaveBeenCalledWith({ query: "English", limit: 200 }));
    const hit = await within(dialog).findByText("…English 2…");
    fireEvent.click(hit);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "プロジェクト全体を検索" })).toBeNull());
    await waitFor(() => expect(cell(container, 2, ".k-text", 1).getAttribute("aria-selected")).toBe("true"));
  });

  it("上部のボタンからも開ける", async () => {
    await renderStudio();
    fireEvent.click(screen.getByRole("button", { name: /横断検索/ }));
    expect(await screen.findByRole("dialog", { name: "プロジェクト全体を検索" })).toBeTruthy();
  });
});

describe("ファイルと列のアクション", () => {
  const actions = [
    { id: "ticket", label: "チケット", target: "cell" as const },
    { id: "export", label: "書き出し", target: "file" as const },
    { id: "fill", label: "一括入力", target: "column" as const, columns: ["status"] },
  ];

  it("ツールバーのアクションはこのリソースを対象に実行し、open.file はパスをコピーできる通知にする", async () => {
    const { api } = await renderStudio({ actions }, (a) => {
      a.runAction.mockResolvedValue({ patched: 0, open: { file: "/tmp/out/export.csv", line: 3 } });
    });
    fireEvent.click(screen.getByRole("button", { name: "アクション ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "書き出し" }));
    await waitFor(() => expect(api.runAction).toHaveBeenCalledWith({ actionId: "export", resourceId: "res.csv" }));
    expect(await screen.findByText("ファイル: /tmp/out/export.csv:3")).toBeTruthy();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole("button", { name: "パスをコピー" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/tmp/out/export.csv"));
  });

  it("デスクトップ版では open.file を locStudio.openPath で開く", async () => {
    const openPath = vi.fn();
    window.locStudio = { openPath };
    try {
      const { api } = await renderStudio({ actions }, (a) => {
        a.runAction.mockResolvedValue({ patched: 0, open: { file: "/tmp/a.csv", line: 7 } });
      });
      fireEvent.click(screen.getByRole("button", { name: "アクション ▾" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "書き出し" }));
      await waitFor(() => expect(api.runAction).toHaveBeenCalled());
      await waitFor(() => expect(openPath).toHaveBeenCalledWith("/tmp/a.csv", 7));
    } finally {
      delete window.locStudio;
    }
  });

  it("列見出しのメニューから列のアクションを実行する（対象の列だけに出る）", async () => {
    const { api } = await renderStudio({ actions });
    expect(screen.queryByRole("button", { name: "本文 の列のアクション" })).toBeNull();
    const menuBtn = screen.getAllByRole("button", { name: "状態 の列のアクション" })[0]!;
    fireEvent.click(menuBtn);
    fireEvent.click(await screen.findByRole("menuitem", { name: "一括入力" }));
    await waitFor(() => expect(api.runAction).toHaveBeenCalledWith({ actionId: "fill", resourceId: "res.csv", cellId: "status@ja", language: "ja" }));
  });
});

describe("プラグインの信頼", () => {
  const untrusted = [
    { kind: "plugin" as const, path: "/tmp/test/loc-studio-plugins/line-width.ts", layer: "project" as const, hash: "h1", files: ["/tmp/test/loc-studio-plugins/line-width.ts"] },
    { kind: "plugin" as const, path: "/tmp/test/loc-studio-plugins/pack", layer: "project" as const, hash: "h2", files: ["/tmp/test/loc-studio-plugins/pack/plugin.json", "/tmp/test/loc-studio-plugins/pack/index.mjs"] },
  ];
  const prepare = (a: ReturnType<typeof mockApi>["api"]) => {
    a.plugins.mockResolvedValue({ plugins: [], dirs: [], errors: [], warnings: [], untrusted });
  };

  it("信頼していないプラグインがあれば最初に確認し、「信頼して読み込む」で信頼する", async () => {
    const { api } = await renderStudio({ untrustedPlugins: 2 }, prepare);
    const dialog = await screen.findByRole("dialog", { name: "このプロジェクトのプラグインを実行しますか" });
    expect(within(dialog).getByText(/あなたと同じ権限/)).toBeTruthy();
    expect(within(dialog).getByText("/tmp/test/loc-studio-plugins/line-width.ts", { selector: ".trust-head .mono" })).toBeTruthy();
    expect(within(dialog).getByText("/tmp/test/loc-studio-plugins/pack/index.mjs")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "信頼して読み込む" }));
    await waitFor(() => expect(api.trustPlugins).toHaveBeenCalledWith({ items: untrusted.map((u) => ({ path: u.path, hash: u.hash })) }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "このプロジェクトのプラグインを実行しますか" })).toBeNull());
    expect(screen.queryByText(/個のプラグインを読み込んでいません/)).toBeNull();
    await waitFor(() => expect(api.rows.mock.calls.length).toBeGreaterThan(1)); // 表を読み直す
  });

  it("「読み込まずに開く」ではバナーを出し、そこから確認をもう一度開ける", async () => {
    const { api } = await renderStudio({ untrustedPlugins: 2 }, prepare);
    const dialog = await screen.findByRole("dialog", { name: "このプロジェクトのプラグインを実行しますか" });
    fireEvent.click(within(dialog).getByRole("button", { name: "読み込まずに開く" }));
    const banner = await screen.findByText(/2 個のプラグインを読み込んでいません/);
    expect(api.trustPlugins).not.toHaveBeenCalled();
    fireEvent.click(within(banner.closest(".trust-banner") as HTMLElement).getByRole("button", { name: "確認する" }));
    expect(await screen.findByRole("dialog", { name: "このプロジェクトのプラグインを実行しますか" })).toBeTruthy();
  });

  it("信頼していないプラグインがなければ確認を出さない", async () => {
    await renderStudio();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/プラグインを読み込んでいません/)).toBeNull();
  });

  it("プラグインの画面: 信頼を取り消す / 信頼する、再読み込みで未信頼になったら確認を出す", async () => {
    const info = makeInfo();
    const { api } = await renderStudio({}, (a) => {
      a.plugins.mockResolvedValue({
        plugins: [{ name: "mystudio", layer: "project", path: "/tmp/test/loc-studio-plugins/a.ts", provides: { validator: ["x"] } as never }],
        dirs: [],
        errors: [],
        warnings: [],
        untrusted: [untrusted[1]!],
      });
      a.reloadPlugins.mockResolvedValue({ ...info, untrustedPlugins: 1 });
    });
    fireEvent.click(screen.getByRole("button", { name: /^プラグイン/ }));
    const dialog = await screen.findByRole("dialog", { name: "プラグイン" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "信頼を取り消す" }));
    await waitFor(() => expect(api.untrustPlugins).toHaveBeenCalledWith({ paths: ["/tmp/test/loc-studio-plugins/a.ts"] }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "信頼する" }));
    await waitFor(() => expect(api.trustPlugins).toHaveBeenCalledWith({ items: [{ path: untrusted[1]!.path, hash: "h2" }] }));
    fireEvent.click(within(dialog).getByRole("button", { name: "プラグインを再読み込み" }));
    expect(await screen.findByRole("dialog", { name: "このプロジェクトのプラグインを実行しますか" })).toBeTruthy();
  });
});

describe("計算列とすべて保存の競合", () => {
  it("計算列は読み取り専用で値を出し、計算の問題は印と理由で示す", async () => {
    const base = makeInfo();
    const { container } = await renderStudio({
      // 本文の直後に置く（表の横の仮想化で描かれる範囲に入るように）
      columns: [...base.columns.slice(0, 3), { id: "length", kind: "computed", scope: "language", label: "文字数", type: "number" }, ...base.columns.slice(3)],
    });
    const ja = cell(container, 0, ".k-computed", 0);
    expect(ja.textContent).toBe("3");
    expect(within(ja).queryByRole("textbox")).toBeNull();
    fireEvent.doubleClick(ja);
    expect(within(ja).queryByRole("textbox")).toBeNull();
    const en = cell(container, 0, ".k-computed", 1);
    expect(within(en).getByLabelText(/計算できませんでした/).getAttribute("title")).toBe("本文を数えられませんでした");
  });

  it("すべて保存の競合はリソースごとにまとめて一覧にする", async () => {
    await renderStudio({}, (a) => {
      a.saveAll.mockResolvedValueOnce({
        resources: 2,
        saved: 1,
        conflicts: 2,
        conflictList: [
          { resourceId: "res.csv", key: "KEY_2", language: "en" },
          { resourceId: "other.csv", key: "KEY_0", language: "ja" },
        ],
      });
    });
    fireEvent.keyDown(window, { key: "S", ctrlKey: true, shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: /保存できなかった変更（2 件）/ });
    expect(within(dialog).getByText("other.csv")).toBeTruthy();
    expect(dialog.querySelectorAll(".conflict-item")).toHaveLength(2);
  });
});
