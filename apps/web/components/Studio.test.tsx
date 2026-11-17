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
    // 生成のあとで本文が変わった結果には、レビューと同じ「変更あり」の印を出す（理由は、ツールチップに出す）。
    expect(within(gen).getByText("変更あり").getAttribute("title")).toBe("生成結果: 変更あり（生成のあとで、元の本文や設定が変わりました。生成し直すと、最新になります）");
    expect(within(cell(container, 1, ".k-generated")).getByText("最新").getAttribute("title")).toBe("生成結果: 最新（いまの本文から生成した結果です）");
    expect(within(cell(container, 0, ".k-actions")).getByRole("button", { name: "チケット" })).toBeTruthy();
    // 言語グループの見出し
    expect(screen.getByRole("button", { name: "日本語 の固定を外す" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "英語 を左に固定" })).toBeTruthy();
  });

  it("本文以外の列のセルにも、検証の問題の印を出す（問題のないセルには出さない）", async () => {
    const { container } = await renderStudio({}, (api) => {
      const orig = api.rows.getMockImplementation()!;
      api.rows.mockImplementation(async (req) => {
        const res = await orig(req);
        const issue = (severity: "error" | "warning", message: string) => ({ validatorId: "v", code: "c", message, severity });
        const rows = res.rows.map((r) =>
          r.key === "KEY_1"
            ? {
                ...r,
                cells: {
                  ...r.cells,
                  maxLen: { ...r.cells["maxLen"]!, issues: [issue("warning", "上限が大きすぎます"), issue("error", "数字ではありません")] },
                  "status@en": { ...r.cells["status@en"]!, issues: [issue("warning", "本文が空のまま完了です")] },
                },
              }
            : r,
        );
        return { ...res, rows };
      });
    });
    // いちばん重い問題の印を出し、ツールチップに全件を並べる。
    const number = within(cell(container, 1, ".k-number")).getByLabelText("エラー: 2 件");
    expect(number.getAttribute("title")).toBe("[警告] 上限が大きすぎます\n[エラー] 数字ではありません");
    expect(within(cell(container, 1, ".k-enum", 1)).getByLabelText("警告: 1 件").getAttribute("title")).toBe("[警告] 本文が空のまま完了です");
    expect(within(cell(container, 1, ".k-enum", 0)).queryByLabelText(/件$/)).toBeNull();
    expect(within(cell(container, 0, ".k-number")).queryByLabelText(/件$/)).toBeNull();
  });

  it("本文のセルのダブルクリックで編集モーダルを開く", async () => {
    const { container, api } = await renderStudio();
    fireEvent.doubleClick(cell(container, 0, ".k-text", 1));
    const dialog = await screen.findByRole("dialog", { name: "本文の編集" });
    await waitFor(() => expect((within(dialog).getByRole("textbox", { name: /本文/ }) as HTMLTextAreaElement).value).toBe("English 0"));
    expect(within(dialog).getByText("日本語0")).toBeTruthy(); // 参照（基になる言語）
    expect(api.rowDetail).toHaveBeenCalled();
  });

  it("キーのセルのダブルクリックで、キーの変更の窓を、その行のキーで開く", async () => {
    const { container, api } = await renderStudio();
    fireEvent.doubleClick(cell(container, 1, ".k-key"));
    const dialog = await screen.findByRole("dialog", { name: "キーを変更" });
    const input = within(dialog).getByRole("textbox", { name: "新しいキー" }) as HTMLInputElement;
    expect(input.value).toBe("KEY_1");
    fireEvent.change(input, { target: { value: "KEY_1_NEW" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "変更する" }));
    await waitFor(() => expect(api.editEntries).toHaveBeenCalledWith({ resourceId: "res.csv", changes: [{ type: "rename", key: "KEY_1", newKey: "KEY_1_NEW" }] }));
  });

  it("行の構成を変えられない役割では、キーのセルをダブルクリックしても窓を開かず、理由を知らせる", async () => {
    const { container } = await renderStudio({ permissions: { role: "translator", can: { edit: true, review: false, run: false, structure: false, manage: false } } });
    fireEvent.doubleClick(cell(container, 1, ".k-key"));
    expect(await screen.findByText("行の追加・削除とリソースの作成は、あなたの役割ではできません")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "キーを変更" })).toBeNull();
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

describe("絞り込み", () => {
  const lastRows = (api: Awaited<ReturnType<typeof renderStudio>>["api"]) => api.rows.mock.calls.at(-1)![0];

  it("「問題あり」は、数える重さを選べる（既定は警告以上）", async () => {
    const { api } = await renderStudio();
    expect(screen.queryByRole("combobox", { name: "問題の重さ" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "問題あり" }));
    await waitFor(() => expect(lastRows(api).onlyIssues).toBe("warning"));
    fireEvent.change(screen.getByRole("combobox", { name: "問題の重さ" }), { target: { value: "error" } });
    await waitFor(() => expect(lastRows(api).onlyIssues).toBe("error"));
    fireEvent.click(screen.getByRole("button", { name: "問題あり" }));
    await waitFor(() => expect(lastRows(api).onlyIssues).toBeUndefined());
  });

  it("文字の列は「含む」で絞り込み、選択式の列は値で絞り込む。空に戻すと条件を外す", async () => {
    const { api } = await renderStudio();
    const toolbar = within(screen.getByRole("toolbar", { name: "表の操作" }));
    fireEvent.click(toolbar.getByRole("button", { name: /^メモ/ }));
    const input = await screen.findByRole("searchbox", { name: "メモ に含む文字" });
    fireEvent.change(input, { target: { value: "  memo1 " } });
    await waitFor(() => expect(lastRows(api).filters).toEqual([{ cellId: "note", contains: "memo1" }]));
    // 選択式の列（状態）の条件と一緒に送る。
    fireEvent.click(toolbar.getByRole("button", { name: /^状態/ }));
    fireEvent.click(within(await screen.findByRole("group", { name: "状態 で絞り込む" })).getAllByRole("checkbox", { name: /完了/ })[0]!);
    await waitFor(() => expect(lastRows(api).filters).toEqual([{ cellId: "status@ja", values: ["done"] }, { cellId: "note", contains: "memo1" }]));
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(lastRows(api).filters).toEqual([{ cellId: "status@ja", values: ["done"] }]));
  });
});

describe("ツールバーのまとまり", () => {
  const groupOf = (name: string) => within(within(screen.getByRole("toolbar", { name: "表の操作" })).getByRole("group", { name }));
  const names = (name: string) => groupOf(name).getAllByRole("button").map((b) => b.textContent!.replace(/\s+/g, " ").trim());

  it("役目ごとにまとまり、見出しが付く（検索、列の値、行の状態、操作、表示、保存）", async () => {
    await renderStudio();
    expect(groupOf("検索と条件").getByRole("searchbox", { name: "検索" })).toBeTruthy();
    expect(names("検索と条件")).toEqual(["このファイル", "全体", "条件 ▾", "★ お気に入り ▾"]);
    // 列の名前だけのボタンは、「列の値で絞り込む」の見出しの下に並ぶ。
    expect(names("列の値で絞り込む")).toEqual(["状態 ▾", "レビュー ▾", "メモ ▾", "上限 ▾"]);
    expect(names("行の状態で絞り込む")).toEqual(["未翻訳のみ", "問題あり", "要確認", "未保存"]);
    expect(names("行とリソースの操作")).toEqual(["＋ 行を追加", "行を削除", "一括アクション ▾", "再読み込み"]);
    expect(names("表示")).toEqual(["列 7 / 7 ▾", "言語 2 / 2", "1 行", "3 行", "5 行", "詳細"]);
    expect(names("保存")).toEqual(["取り消す", "保存"]);
    // 見出しは、画面に文字として出ている。
    const toolbar = screen.getByRole("toolbar", { name: "表の操作" });
    expect([...toolbar.querySelectorAll(".tb-caption")].map((c) => c.textContent)).toEqual(["検索", "列の値で絞り込む", "行の状態で絞り込む", "操作", "表示"]);
    expect(toolbar.querySelector(".tb-label")!.textContent).toBe("行の高さ");
  });

  it("ボタンのツールチップは、何をするボタンかを文で説明する", async () => {
    await renderStudio();
    const title = (group: string, name: RegExp | string) => groupOf(group).getByRole("button", { name }).getAttribute("title");
    expect(title("列の値で絞り込む", /^状態/)).toBe("「状態」の列の値を選んで、行を絞り込む");
    expect(title("列の値で絞り込む", /^メモ/)).toBe("「メモ」の列に含む文字で、行を絞り込む");
    expect(title("行の状態で絞り込む", "未翻訳のみ")).toBe("表示中の言語のどれかの本文が空の行だけを表示する");
    expect(title("行の状態で絞り込む", "問題あり")).toBe("検証で、警告以上の問題が見つかった行だけを表示する");
    expect(title("行の状態で絞り込む", "要確認")).toBe("レビューのあとで対象の値が変わった行と、基の言語の本文が変わった行だけを表示する");
    expect(title("行の状態で絞り込む", "未保存")).toBe("まだ保存していない本文の変更がある行だけを表示する");
    expect(title("行とリソースの操作", "＋ 行を追加")).toBe("選んでいる行の後ろに、新しい行を追加する（行を選んでいなければ、末尾に追加する）");
    expect(title("行とリソースの操作", "行を削除")).toBe("選んでいる 1 行を削除する（確かめてから消します。Ctrl / Shift を押しながら選ぶと、複数の行を選べます）");
    expect(title("表示", "3 行表示")).toBe("1 つの行に、本文を 3 行まで表示する");
    expect(title("表示", "詳細")).toBe("選択した行の、全言語の本文、検証結果、レビューの投稿、変更履歴を右に表示する");
  });

  it("絞り込んでいる間だけ「絞り込みを解除」が出て、効いている数を示す。押すと、検索と条件と状態をまとめて外す", async () => {
    const { api } = await renderStudio();
    const lastRows = () => api.rows.mock.calls.at(-1)![0];
    const clear = () => screen.queryByRole("button", { name: /^絞り込みを解除/ });
    expect(clear()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    fireEvent.click(screen.getByRole("button", { name: "問題あり" }));
    fireEvent.change(screen.getByRole("combobox", { name: "問題の重さ" }), { target: { value: "error" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "検索" }), { target: { value: "save" } });
    await waitFor(() => expect(lastRows()).toMatchObject({ search: "save", onlyUntranslated: true, onlyIssues: "error" }));
    expect(clear()!.textContent).toBe("絞り込みを解除（3）");
    fireEvent.click(clear()!);
    await waitFor(() => expect(clear()).toBeNull());
    await waitFor(() => {
      const req = lastRows();
      expect([req.search, req.onlyUntranslated, req.onlyIssues, req.filters, req.where]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    });
    expect((screen.getByRole("searchbox", { name: "検索" }) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "未翻訳のみ" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "問題あり" }).getAttribute("aria-pressed")).toBe("false");
    // 「問題あり」で数える重さは、選んだまま残る。
    fireEvent.click(screen.getByRole("button", { name: "問題あり" }));
    await waitFor(() => expect(lastRows().onlyIssues).toBe("error"));
  });
});

describe("列の幅のドラッグ", () => {
  const header = (container: HTMLElement, cellId: string) => {
    const el = [...container.querySelectorAll<HTMLElement>(".g-hcell")].find((c) => c.title.endsWith(`（${cellId}）`));
    if (!el) throw new Error(`見出しが見つかりません: ${cellId}`);
    return el;
  };
  const groupHeader = (container: HTMLElement, label: string) => {
    const el = [...container.querySelectorAll<HTMLElement>(".g-group")].find((g) => g.querySelector<HTMLElement>(".g-group-label")?.title.startsWith(label));
    if (!el) throw new Error(`言語の見出しが見つかりません: ${label}`);
    return el;
  };
  const drag = (handle: Element | null, dx: number) => {
    if (!handle) throw new Error("取っ手が見つかりません");
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 500 + dx / 2 });
    fireEvent.mouseMove(window, { clientX: 500 + dx });
    fireEvent.mouseUp(window, { clientX: 500 + dx });
  };
  const savedWidths = (api: Awaited<ReturnType<typeof renderStudio>>["api"]) => (api.setUiState.mock.calls.at(-1)?.[0].state as { widths?: Record<string, number> } | null)?.widths;

  it("列の見出しの右端をドラッグすると、その列の幅が変わり、画面の状態として保存される", async () => {
    const { container, api } = await renderStudio();
    expect(header(container, "key").style.width).toBe("200px");
    drag(header(container, "key").querySelector(".g-resize:not(.g-resize-prev)"), 40);
    expect(header(container, "key").style.width).toBe("240px");
    // 表のセルも同じ幅になり、ほかの列は変わらない。
    expect(cell(container, 0, ".k-key").style.width).toBe("240px");
    expect(header(container, "note").style.width).toBe("130px");
    await waitFor(() => expect(savedWidths(api)).toEqual({ key: 240 }));
  });

  it("境目の右隣の見出しの左端をつかんでも、境目の左の列の幅が変わる（先頭の列の左端には取っ手がない）", async () => {
    const { container } = await renderStudio();
    expect(header(container, "key").querySelector(".g-resize-prev")).toBeNull();
    drag(header(container, "note").querySelector(".g-resize-prev"), -30);
    expect(header(container, "key").style.width).toBe("170px");
    expect(header(container, "note").style.width).toBe("130px");
  });

  it("言語の見出しの境目でも変えられる。変わるのは、境目の左の言語の最後の列", async () => {
    const { container } = await renderStudio();
    // 日本語の最後の列は「操作」（tools@ja）。
    drag(groupHeader(container, "日本語").querySelector(".g-resize:not(.g-resize-prev)"), 20);
    expect(header(container, "tools@ja").style.width).toBe("150px");
    expect(header(container, "text@ja").style.width).toBe("300px");
    // 次の言語の見出しの左端でも同じ列が変わる。
    drag(groupHeader(container, "英語").querySelector(".g-resize-prev"), 10);
    expect(header(container, "tools@ja").style.width).toBe("160px");
    expect(header(container, "text@en").style.width).toBe("300px");
  });

  it("列を本文だけにした言語でも、言語の見出しの境目と、列の見出しの境目の両方で、本文の幅を変えられる", async () => {
    const { container } = await renderStudio();
    // 列の表示で、日本語にある列を本文だけにする（英語には、英語だけの「逆翻訳」が残る）。
    fireEvent.click(screen.getByRole("button", { name: /^表示する列を選ぶ/ }));
    for (const name of [/^状態/, /^レビュー/, /^操作/]) fireEvent.click(within(screen.getByRole("dialog", { name: "表示する列" })).getByRole("checkbox", { name }));
    await waitFor(() => expect(groupHeader(container, "日本語").style.width).toBe("300px"));
    drag(groupHeader(container, "日本語").querySelector(".g-resize:not(.g-resize-prev)"), 50);
    expect(header(container, "text@ja").style.width).toBe("350px");
    expect(groupHeader(container, "日本語").style.width).toBe("350px");
    drag(header(container, "text@ja").querySelector(".g-resize:not(.g-resize-prev)"), 10);
    expect(header(container, "text@ja").style.width).toBe("360px");
    drag(header(container, "text@en").querySelector(".g-resize-prev"), -20);
    expect(header(container, "text@ja").style.width).toBe("340px");
    expect(header(container, "text@en").style.width).toBe("300px");
  });

  it("幅は、下限より狭くならない", async () => {
    const { container } = await renderStudio();
    drag(header(container, "maxLen").querySelector(".g-resize:not(.g-resize-prev)"), -500);
    expect(header(container, "maxLen").style.width).toBe("48px");
  });
});

describe("並べ替え", () => {
  it("列見出しを押すたびに、昇順、降順、解除の順に切り替わり、見出しに向きが出る", async () => {
    const { api } = await renderStudio();
    const last = () => api.rows.mock.calls.at(-1)![0];
    expect(last().sort).toBeUndefined();
    const header = screen.getByRole("columnheader", { name: /メモ/ });
    const button = () => within(header).getByRole("button", { name: /メモ で並べ替え/ });
    expect(header.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(button());
    await waitFor(() => expect(last().sort).toEqual({ cellId: "note", dir: "asc" }));
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(button().textContent).toBe("メモ ▲");
    fireEvent.click(button());
    await waitFor(() => expect(last().sort).toEqual({ cellId: "note", dir: "desc" }));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(button());
    await waitFor(() => expect(last().sort).toBeUndefined());
    expect(header.getAttribute("aria-sort")).toBe("none");
    expect(button().textContent).toBe("メモ");
  });

  it("別の列を押すと、その列の昇順に切り替わる（前の列の印は消える）。アクション列の見出しは押せない", async () => {
    const { api } = await renderStudio();
    const last = () => api.rows.mock.calls.at(-1)![0];
    const note = screen.getByRole("columnheader", { name: /メモ/ });
    const limit = screen.getByRole("columnheader", { name: /上限/ });
    fireEvent.click(within(note).getByRole("button", { name: /で並べ替え/ }));
    fireEvent.click(within(limit).getByRole("button", { name: /で並べ替え/ }));
    await waitFor(() => expect(last().sort).toEqual({ cellId: "maxLen", dir: "asc" }));
    expect(note.getAttribute("aria-sort")).toBe("none");
    expect(limit.getAttribute("aria-sort")).toBe("ascending");
    for (const ops of screen.getAllByRole("columnheader", { name: /操作/ })) {
      expect(within(ops).queryByRole("button", { name: /で並べ替え/ })).toBeNull();
    }
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

  it("選択式のセルのダブルクリックで、ドロップダウンを開く（選ぶと保存する）", async () => {
    const { container, api } = await renderStudio();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.doubleClick(cell(container, 0, ".k-enum", 0));
    const list = await screen.findByRole("listbox", { name: "状態" });
    fireEvent.click(within(list).getByText("完了"));
    await waitFor(() => expect(api.setCell).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_0", cellId: "status@ja", value: "done", expectedVersion: 3 }));
  });

  it("レビュー列のセルのダブルクリックで、判定を選ばずに投稿パネルを開く。投稿すると閉じて、セルに判定とコメントと投稿者が出る", async () => {
    const { container, api } = await renderStudio();
    api.postReview.mockImplementation(async (p: { verdict: string; comment: string }) => ({
      id: "r1",
      cell: { entryKey: "KEY_1", resourceId: "res.csv", columnId: "review", language: "ja" },
      columnId: "review",
      verdict: p.verdict,
      comment: p.comment,
      userName: "tester",
      createdAt: "2026-01-01T00:00:00Z",
      stale: false,
    }));
    const target = () => cell(container, 1, ".k-review", 0);
    expect(target().querySelector(".review-note")).toBeNull();
    fireEvent.doubleClick(target());
    const dialog = await screen.findByRole("dialog", { name: "レビュー: レビュー" });
    expect(within(dialog).getByText("KEY_1")).toBeTruthy();
    // どの判定も選ばれていない（ドロップダウンは開いていない）。
    expect(within(dialog).getAllByRole("radio").map((r) => (r as HTMLInputElement).checked)).toEqual([false, false, false]);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: /差し戻し/ }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /コメント/ }), { target: { value: "訳抜けがあります" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "投稿" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "レビュー: レビュー" })).toBeNull());
    expect(api.postReview).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_1", cellId: "review@ja", verdict: "back", comment: "訳抜けがあります" });
    expect(within(target()).getByRole("button").getAttribute("aria-label")).toBe("レビュー: 差し戻し");
    expect(target().querySelector(".review-note-by")!.textContent).toBe("tester");
    expect(target().querySelector(".review-note-text")!.textContent).toBe("訳抜けがあります");
    // ほかの行と、ほかの言語のセルは変わらない。
    expect(cell(container, 0, ".k-review", 0).querySelector(".review-note")).toBeNull();
    expect(within(cell(container, 1, ".k-review", 1)).getByRole("button").getAttribute("aria-label")).toBe("レビュー: 承認");
  });

  it("判定のチップの上でダブルクリックしても、投稿パネルが開く（チップがダブルクリックを止めない）", async () => {
    const { container } = await renderStudio();
    fireEvent.doubleClick(within(cell(container, 0, ".k-review", 0)).getByRole("button"));
    const dialog = await screen.findByRole("dialog", { name: "レビュー: レビュー" });
    expect(within(dialog).getByText("KEY_0")).toBeTruthy();
  });

  it("レビュー列のセルは、最新の投稿のコメントと投稿者を判定の横に出す（コメントのないセルと、選択式の列には出さない）", async () => {
    const { container } = await renderStudio({}, (api) => {
      const base = api.rows.getMockImplementation()!;
      api.rows.mockImplementation(async (req) => {
        const res = await base(req);
        const rows = res.rows.map((row) =>
          row.key === "KEY_0"
            ? {
                ...row,
                cells: {
                  ...row.cells,
                  "review@ja": { value: "back", updatedBy: "alice", updatedAt: "2026-01-01T00:00:00Z", comment: "語尾を\nそろえてください" },
                  // 投稿者の分からないコメント（列ソースが updatedBy を返さないとき）。
                  "review@en": { value: "back", comment: "typo" },
                  // 選択式の列の値にコメントが付いていても、セルには出さない。
                  "status@ja": { value: "todo", version: 3, updatedBy: "bob", comment: "あとで" },
                },
              }
            : row,
        );
        return { ...res, rows };
      });
    });
    const ja = cell(container, 0, ".k-review", 0).querySelector<HTMLElement>(".review-note")!;
    expect(ja.querySelector(".review-note-by")!.textContent).toBe("alice");
    expect(ja.querySelector(".review-note-text")!.textContent).toBe("語尾を\nそろえてください");
    expect(ja.title).toBe("alice: 語尾を\nそろえてください");
    const en = cell(container, 0, ".k-review", 1).querySelector<HTMLElement>(".review-note")!;
    expect(en.querySelector(".review-note-by")).toBeNull();
    expect(en.textContent).toBe("typo");
    expect(en.title).toBe("typo");
    expect(cell(container, 0, ".k-enum", 0).querySelector(".review-note")).toBeNull();
    // 投稿のないセル（フィクスチャのほかの行）には出さない。
    expect(cell(container, 1, ".k-review", 0).querySelector(".review-note")).toBeNull();
    expect(cell(container, 1, ".k-review", 1).querySelector(".review-note")).toBeNull();
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

  it("日付の列は日付の入力欄で編集し、空にして確定すると値を消す", async () => {
    // フィクスチャの「メモ」の列を、日付の列にして確かめる。
    const columns = makeInfo().columns.map((c) => (c.id === "note" ? { ...c, type: "date" as const } : c));
    // 行の値も日付にする（日付の入力欄は、日付でない値を空として扱う）。
    const { container, api } = await renderStudio({ columns }, (api) => {
      const base = api.rows.getMockImplementation()!;
      api.rows.mockImplementation(async (req) => {
        const res = await base(req);
        return { ...res, rows: res.rows.map((row) => ({ ...row, cells: { ...row.cells, note: { value: "2026-01-02" } } })) };
      });
    });
    fireEvent.doubleClick(cell(container, 0, ".k-string"));
    const input = cell(container, 0, ".k-string").querySelector("input")!;
    expect(input.type).toBe("date");
    expect(input.value).toBe("2026-01-02");
    fireEvent.change(input, { target: { value: "2026-11-15" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.setCell).toHaveBeenCalledWith(expect.objectContaining({ cellId: "note", value: "2026-11-15" })));
    fireEvent.doubleClick(cell(container, 1, ".k-string"));
    const input2 = cell(container, 1, ".k-string").querySelector("input")!;
    fireEvent.change(input2, { target: { value: "" } });
    fireEvent.keyDown(input2, { key: "Enter" });
    await waitFor(() => expect(api.setCell).toHaveBeenLastCalledWith(expect.objectContaining({ cellId: "note", value: null })));
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

  it("生成の確認では、まとめて送る件数に、生成器の既定が入っている。書き換えた数を、生成に渡す", async () => {
    const { container, api } = await renderStudio({}, (api) => {
      api.generate.mockResolvedValue({ total: 9, cached: 1, toRun: 8, batchSize: 4 });
    });
    fireEvent.click(within(cell(container, 0, ".k-generated")).getByRole("button", { name: /を生成/ }));
    const dialog = await screen.findByRole("dialog", { name: "生成: 逆翻訳" });
    const batch = (await within(dialog).findByLabelText("まとめて送る件数（バッチサイズ）")) as HTMLInputElement;
    // 件数を数えたときに返る、生成器の既定。
    await waitFor(() => expect(batch.value).toBe("4"));
    // 誤った値では、理由を出して、始められない。
    fireEvent.change(batch, { target: { value: "0" } });
    expect(within(dialog).getByRole("alert").textContent).toBe("1 以上 1000 以下の整数で入力してください。");
    expect((within(dialog).getByRole("button", { name: "8 件を生成" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(batch, { target: { value: "20" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    const start = within(dialog).getByRole("button", { name: "8 件を生成" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(api.generate).toHaveBeenLastCalledWith({ columnId: "back", scope: "cell", resourceId: "res.csv", keys: ["KEY_0"], languages: ["en"], batchSize: 20, dryRun: false }));
    // 件数を数える呼び出しには、まとめて送る件数を付けない。
    expect(api.generate.mock.calls.filter((c) => c[0].dryRun === true).every((c) => c[0].batchSize === undefined)).toBe(true);
  });

  it("選択式の生成列（判定など）は、選択肢の色と表示名で出し、生成器が添えた説明を横に出す", async () => {
    const base = makeInfo();
    const { container } = await renderStudio(
      {
        // 逆翻訳の列の場所に、評価の列を置く。
        columns: base.columns.map((c) =>
          c.id === "back"
            ? {
                id: "check",
                kind: "generated" as const,
                scope: "language" as const,
                label: "翻訳の評価",
                generator: "eval",
                languages: ["en"],
                type: { enum: [{ value: "OK", label: "問題なし", color: "green" }, { value: "NG", label: "要修正", color: "red" }] },
              }
            : c,
        ),
      },
      (api) => {
        const rows = api.rows.getMockImplementation()!;
        api.rows.mockImplementation(async (req) => {
          const page = await rows(req);
          page.rows.forEach((row, i) => {
            row.cells["check@en"] = i === 0 ? { value: "NG", comment: "主語が逆になっています。", generated: "stale", stale: true } : i === 1 ? { value: "OK", generated: "fresh" } : { value: undefined, generated: "missing" };
          });
          return page;
        });
      },
    );
    const ng = cell(container, 0, ".k-generated");
    expect(ng.querySelector(".chip-label")?.textContent).toBe("要修正");
    expect(within(ng).getByText("主語が逆になっています。").closest(".review-note")?.getAttribute("title")).toBe("主語が逆になっています。");
    expect(within(ng).getByText("変更あり")).toBeTruthy();
    const ok = cell(container, 1, ".k-generated");
    expect(ok.querySelector(".chip-label")?.textContent).toBe("問題なし");
    expect(ok.querySelector(".review-note")).toBeNull();
    expect(within(ok).getByText("最新")).toBeTruthy();
    // 生成していないセルには、値も説明も出さない。
    const none = cell(container, 2, ".k-generated");
    expect(none.querySelector(".chip")).toBeNull();
    expect(within(none).getByText("未生成")).toBeTruthy();
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

describe("検索の範囲（このファイル / 全体）", () => {
  const scope = () => within(screen.getByRole("group", { name: "探す範囲" }));
  const pressed = () => [scope().getByRole("button", { name: "このファイル" }), scope().getByRole("button", { name: "全体" })].map((b) => b.getAttribute("aria-pressed"));
  const searchbox = () => screen.getByRole("searchbox", { name: "検索" }) as HTMLInputElement;

  it("「全体」にすると、表の代わりにプロジェクト全体の検索結果を出し、「このファイル」で表に戻る。検索の文字は、どちらにも同じものが効く", async () => {
    const { api } = await renderStudio();
    // 専用の検索の窓を開くボタンはない（検索欄の範囲の切り替えだけ）。
    expect(screen.queryByRole("button", { name: /横断検索/ })).toBeNull();
    expect(pressed()).toEqual(["true", "false"]);
    expect(searchbox().placeholder).toBe("キーと本文を検索（このファイル）");
    expect(screen.getByRole("grid")).toBeTruthy();

    fireEvent.click(scope().getByRole("button", { name: "全体" }));
    const view = await screen.findByRole("region", { name: "検索結果の表示" });
    expect(within(view).getByText("検索結果の表示（プロジェクト全体）")).toBeTruthy();
    expect(screen.queryByRole("grid")).toBeNull();
    expect(pressed()).toEqual(["false", "true"]);
    expect(searchbox().placeholder).toBe("キーと本文を検索（プロジェクト全体）");
    fireEvent.change(searchbox(), { target: { value: "English" } });
    // プロジェクト全体への問い合わせ（行を返すもの）に、検索の文字が入る。
    await waitFor(() => expect(api.query).toHaveBeenCalledWith(expect.objectContaining({ search: "English", offset: 0, limit: 200 })));

    fireEvent.click(scope().getByRole("button", { name: "このファイル" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "検索結果の表示" })).toBeNull());
    expect(screen.getByRole("grid")).toBeTruthy();
    expect(pressed()).toEqual(["true", "false"]);
    // 表に戻っても、同じ検索の文字で絞り込まれている。
    expect(searchbox().value).toBe("English");
    await waitFor(() => expect(api.rows.mock.calls.at(-1)![0].search).toBe("English"));
    // 専用の検索（search）は呼ばない。
    expect(api.search).not.toHaveBeenCalled();
  });

  it("Ctrl+Shift+F で、範囲を「全体」にして検索欄に入る（窓は開かない）。結果の「表に戻る」で、このファイルの表に戻る", async () => {
    await renderStudio();
    fireEvent.keyDown(window, { key: "F", ctrlKey: true, shiftKey: true });
    const view = await screen.findByRole("region", { name: "検索結果の表示" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pressed()).toEqual(["false", "true"]);
    expect(document.activeElement).toBe(searchbox());
    fireEvent.click(within(view).getByRole("button", { name: "表に戻る" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "検索結果の表示" })).toBeNull());
    expect(pressed()).toEqual(["true", "false"]);
    // Ctrl+F は、範囲を変えずに検索欄に入る。
    searchbox().blur();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(searchbox());
    expect(pressed()).toEqual(["true", "false"]);
  });
});

describe("上のバー", () => {
  it("設定のボタンは、アイコンだけでなく「設定」と文字で出る。押すと設定の画面が開く", async () => {
    await renderStudio();
    const button = screen.getByRole("button", { name: "設定" });
    expect(button.textContent!.replace(/\s+/g, " ").trim()).toBe("⚙ 設定");
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "設定" })).toBeTruthy();
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

describe("ツリーの進捗", () => {
  const stats = [{ resourceId: "res.csv", entries: 3, unsaved: 0, issues: { error: 0, warning: 0, info: 0 }, progress: { review: { ja: { complete: 1, total: 4 }, en: { complete: 3, total: 4 } }, status: { ja: { complete: 4, total: 4 } } } }];
  const progressOf = async (container: HTMLElement) => {
    await waitFor(() => expect(container.querySelector(".tree-progress")).not.toBeNull());
    return container.querySelector<HTMLElement>(".tree-progress")!;
  };

  it("進捗の列（最初のレビュー列）の、全言語の合計と言語ごとの内訳を出す", async () => {
    const { container } = await renderStudio({}, (api) => api.stats.mockResolvedValue(stats));
    const el = await progressOf(container);
    expect(el.getAttribute("aria-label")).toBe("進捗 50%");
    expect(el.title.split("\n")).toEqual(["合計 4 / 8 行（50%）", "日本語: 1 / 4（25%）", "英語: 3 / 4（75%）"]);
  });

  it("文字数・語数で数える設定のときは、数の単位を示す", async () => {
    const grid = { pinCommon: true, maxPinnedRatio: 0.9, progressUnit: "characters" as const };
    const { container } = await renderStudio({ grid }, (api) => api.stats.mockResolvedValue(stats));
    expect((await progressOf(container)).title.split("\n")[0]).toBe("合計 4 / 8 文字（原文）（50%）");
  });

  it("grid.progressColumn で、進捗に使う列を変えられる", async () => {
    const grid = { pinCommon: true, maxPinnedRatio: 0.9, progressUnit: "rows" as const, progressColumn: "status" };
    const { container } = await renderStudio({ grid }, (api) => api.stats.mockResolvedValue(stats));
    expect((await progressOf(container)).getAttribute("aria-label")).toBe("進捗 100%");
  });
});
