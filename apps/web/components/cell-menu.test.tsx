import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProjectInfo } from "@loc-studio/server";
import { cellCopyText, pastedValue } from "@/components/cell-menu";
import { ToastArea, ToastProvider } from "@/components/context";
import { Studio } from "@/components/Studio";
import { RpcError } from "@/lib/client/api";
import { gridKind, type GridColumn } from "@/lib/client/model";
import { makeInfo, makeRow, mockApi } from "@/test/fixtures";

/*
 * 表の複数選択（Shift / Ctrl）と、右クリックのメニュー。表の画面（Studio）を操作して、選択の見え方、メニューの項目、
 * サービス層に渡る値、終わったあとの通知を確かめる。
 * フィクスチャの列: 共通（キー、メモ、上限）、日本語（本文、状態、レビュー、操作）、英語（本文、状態、レビュー、逆翻訳、操作）。
 */

async function renderStudio(over: Partial<ProjectInfo> = {}, prepare?: (api: ReturnType<typeof mockApi>["api"]) => void) {
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
const press = (el: HTMLElement, mods: { shift?: boolean; ctrl?: boolean } = {}) => fireEvent.mouseDown(el, { button: 0, shiftKey: mods.shift === true, ctrlKey: mods.ctrl === true });
const selected = (el: HTMLElement) => el.getAttribute("aria-selected") === "true";
const openMenu = async (el: HTMLElement) => {
  fireEvent.contextMenu(el, { clientX: 120, clientY: 80 });
  return within(await screen.findByRole("menu", { name: "セルと行の操作" }));
};
const itemNames = (menu: ReturnType<typeof within>) => menu.getAllByRole("menuitem").map((b: HTMLElement) => b.textContent);
const item = (menu: ReturnType<typeof within>, name: RegExp | string) => menu.getByRole("menuitem", { name }) as HTMLButtonElement;

/** クリップボード（プロセスの外との境目）の代わり。書いた文字を覚え、読むときは決めた文字を返す。 */
function stubClipboard(read = "") {
  const state = { written: [] as string[], read };
  const clipboard = {
    writeText: vi.fn(async (text: string) => void state.written.push(text)),
    readText: vi.fn(async () => state.read),
  };
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  return state;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("複数選択", () => {
  it("Shift で起点からの長方形を選び、Ctrl で離れたセルを足す。もう一度 Ctrl で押すと、そのセルだけ外れる", async () => {
    const { container } = await renderStudio();
    press(cell(container, 0, ".k-enum", 0)); // 日本語の状態
    press(cell(container, 1, ".k-enum", 1), { shift: true }); // 英語の状態
    // 2 行 × 日本語の状態から英語の状態までの 5 列（状態、レビュー、操作、英語の本文、英語の状態）。
    expect([cell(container, 0, ".k-enum", 0), cell(container, 1, ".k-enum", 1), cell(container, 0, ".k-review", 0), cell(container, 1, ".k-text", 1)].map(selected)).toEqual([true, true, true, true]);
    expect([cell(container, 2, ".k-enum", 0), cell(container, 0, ".k-text", 0), cell(container, 0, ".k-review", 1)].map(selected)).toEqual([false, false, false]);
    expect(screen.getByText("2 行・10 セルを選択")).toBeTruthy();
    expect(container.querySelector('[data-row="0"]')!.className).toContain("row-selected");
    expect(container.querySelector('[data-row="2"]')!.className).not.toContain("row-selected");

    press(cell(container, 2, ".k-enum", 0), { ctrl: true });
    expect(selected(cell(container, 2, ".k-enum", 0))).toBe(true);
    expect(selected(cell(container, 0, ".k-enum", 0))).toBe(true);
    expect(screen.getByText("3 行・11 セルを選択")).toBeTruthy();
    // 一括操作のバーは、選んでいる行の数を示す。
    expect(within(screen.getByRole("toolbar", { name: "選択した行の一括操作" })).getByText("3 行を選択中")).toBeTruthy();

    press(cell(container, 2, ".k-enum", 0), { ctrl: true });
    expect(selected(cell(container, 2, ".k-enum", 0))).toBe(false);
    expect(screen.getByText("2 行・10 セルを選択")).toBeTruthy();
    // ふつうに押すと、そのセルだけになる。
    press(cell(container, 1, ".k-text", 0));
    expect(selected(cell(container, 0, ".k-enum", 0))).toBe(false);
    expect(screen.queryByText(/セルを選択$/)).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "選択した行の一括操作" })).toBeNull();
  });

  it("Shift ＋矢印キーで、行にも列にも範囲を広げられる", async () => {
    const { container } = await renderStudio();
    press(cell(container, 0, ".k-text", 0));
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    expect([cell(container, 0, ".k-text", 0), cell(container, 1, ".k-text", 0), cell(container, 0, ".k-enum", 0), cell(container, 1, ".k-enum", 0)].map(selected)).toEqual([true, true, true, true]);
    expect(screen.getByText("2 行・4 セルを選択")).toBeTruthy();
    // Shift なしで動くと、範囲は解ける。
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(screen.queryByText(/セルを選択$/)).toBeNull();
  });
});

describe("右クリックのメニュー", () => {
  it("選択の中のセルを押すと選択はそのまま、外のセルを押すとそのセルだけを選んで開く。Esc で閉じる", async () => {
    const { container } = await renderStudio();
    press(cell(container, 0, ".k-enum", 0));
    press(cell(container, 1, ".k-enum", 0), { shift: true });
    const menu = await openMenu(cell(container, 1, ".k-enum", 0));
    expect(menu.getByText("「状態」を変える（2 件）")).toBeTruthy();
    expect([cell(container, 0, ".k-enum", 0), cell(container, 1, ".k-enum", 0)].map(selected)).toEqual([true, true]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    const single = await openMenu(cell(container, 2, ".k-text", 0));
    expect([cell(container, 0, ".k-enum", 0), cell(container, 1, ".k-enum", 0), cell(container, 2, ".k-text", 0)].map(selected)).toEqual([false, false, true]);
    // 本文のセル 1 つのメニュー: 編集、コピーと貼り付け、アクション、行の操作。
    expect(itemNames(single)).toEqual(["本文を編集…Enter", "コピー", "貼り付け", "チケット", "＋ 行を追加…", "キーを変更…", "行を削除…"]);
    fireEvent.click(item(single, /^本文を編集/));
    expect(await screen.findByRole("dialog", { name: "本文の編集" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("メニューキーで、いまのセルのメニューを開く。メニューの外を押すと閉じる", async () => {
    const { container } = await renderStudio();
    press(cell(container, 1, ".k-key"));
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ContextMenu" });
    const menu = within(await screen.findByRole("menu", { name: "セルと行の操作" }));
    expect(itemNames(menu)).toEqual(["コピー", "貼り付け", "チケット", "＋ 行を追加…", "キーを変更…", "行を削除…"]);
    // キーの列には貼り付けられない。
    expect(item(menu, "貼り付け").disabled).toBe(true);
    expect(item(menu, "貼り付け").title).toBe("この列には貼り付けられません");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("選択式の列: 1 つなら版を確かめて変え、複数なら選んだセルをまとめて変える（言語をまたいでいれば、言語ごとに）", async () => {
    const { container, api } = await renderStudio({}, (a) => {
      a.setCells.mockImplementation(async ({ keys }) => ({ updated: keys.length, blocked: [] }));
    });
    // 1 つ: いまの値から変える。
    const single = await openMenu(cell(container, 0, ".k-enum", 0));
    expect(single.getByText("「状態」を変える")).toBeTruthy();
    fireEvent.click(item(single, "「完了」にする"));
    await waitFor(() => expect(api.setCell).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_0", cellId: "status@ja", value: "done", expectedVersion: 3 }));
    expect(api.setCells).not.toHaveBeenCalled();

    // 日本語の状態を 2 行、英語の状態を 1 行。
    press(cell(container, 0, ".k-enum", 0));
    press(cell(container, 1, ".k-enum", 0), { shift: true });
    press(cell(container, 2, ".k-enum", 1), { ctrl: true });
    const menu = await openMenu(cell(container, 0, ".k-enum", 0));
    expect(menu.getByText("「状態」を変える（3 件）")).toBeTruthy();
    fireEvent.click(item(menu, "「完了」にする"));
    await waitFor(() => expect(api.setCells).toHaveBeenCalledTimes(2));
    expect(api.setCells.mock.calls.map((c) => c[0])).toEqual([
      { resourceId: "res.csv", keys: ["KEY_0", "KEY_1"], cellId: "status@ja", value: "done" },
      { resourceId: "res.csv", keys: ["KEY_2"], cellId: "status@en", value: "done" },
    ]);
    expect(await screen.findByText("3 件の「状態」を「完了」にしました")).toBeTruthy();
  });

  it("まとめて変えたとき、変えられなかったセルの数も知らせる", async () => {
    const { container } = await renderStudio({}, (a) => {
      a.setCells.mockResolvedValue({ updated: 1, blocked: ["KEY_1"] });
    });
    press(cell(container, 0, ".k-enum", 0));
    press(cell(container, 1, ".k-enum", 0), { shift: true });
    fireEvent.click(item(await openMenu(cell(container, 0, ".k-enum", 0)), "「完了」にする"));
    expect(await screen.findByText("1 件の「状態」を「完了」にしました（1 件は変更していません）")).toBeTruthy();
  });

  it("レビュー列: 1 つなら投稿のパネルを開き、複数なら一括の投稿の窓で、同じ判定とコメントを 1 件ずつ投稿する", async () => {
    const { container, api } = await renderStudio({}, (a) => {
      a.postReview.mockImplementation(async (p: { key: string; cellId: string; verdict: string; comment: string }) => {
        if (p.key === "KEY_1") throw new RpcError("postReview", "blocked", "「差し戻し」には、いまの判定からは変えられません");
        return { id: `r-${p.key}`, cell: { entryKey: p.key, resourceId: "res.csv", columnId: "review", language: "ja" }, columnId: "review", verdict: p.verdict, comment: p.comment, userName: "tester", createdAt: "2026-01-01T00:00:00Z", stale: false };
      });
    });
    // 1 つ: いつもの投稿のパネル。
    fireEvent.click(item(await openMenu(cell(container, 0, ".k-review", 0)), "レビューを投稿…"));
    const panel = await screen.findByRole("dialog", { name: "レビュー: レビュー" });
    fireEvent.click(within(panel).getAllByRole("button", { name: "閉じる" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "レビュー: レビュー" })).toBeNull());

    press(cell(container, 0, ".k-review", 0));
    press(cell(container, 2, ".k-review", 0), { shift: true });
    fireEvent.click(item(await openMenu(cell(container, 1, ".k-review", 0)), "レビューを一括で投稿…（3 件）"));
    const dialog = await screen.findByRole("dialog", { name: "レビューを一括で投稿: レビュー" });
    const post = within(dialog).getByRole("button", { name: "3 件に投稿" }) as HTMLButtonElement;
    // 判定を選ぶまで、コメントが必須の判定ではコメントを書くまで、投稿できない。
    expect(post.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /差し戻し/ }));
    expect(post.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: /コメント/ }), { target: { value: "語尾をそろえてください" } });
    expect(post.disabled).toBe(false);
    expect(api.postReview).not.toHaveBeenCalled();
    fireEvent.click(post);
    // できなかったセルがあるので、理由を出して開いたままにする。
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("2 件を投稿しました。1 件は投稿できませんでした。");
    expect(alert.textContent).toContain("KEY_1（review@ja）: 「差し戻し」には、いまの判定からは変えられません");
    expect(api.postReview.mock.calls.map((c) => c[0])).toEqual([
      { resourceId: "res.csv", key: "KEY_0", cellId: "review@ja", verdict: "back", comment: "語尾をそろえてください" },
      { resourceId: "res.csv", key: "KEY_1", cellId: "review@ja", verdict: "back", comment: "語尾をそろえてください" },
      { resourceId: "res.csv", key: "KEY_2", cellId: "review@ja", verdict: "back", comment: "語尾をそろえてください" },
    ]);
    // 投稿できたセルには、判定とコメントが出る。できなかったセルは、前のまま。
    expect(cell(container, 0, ".k-review", 0).querySelector(".review-note-text")!.textContent).toBe("語尾をそろえてください");
    expect(cell(container, 2, ".k-review", 0).querySelector(".review-note-by")!.textContent).toBe("tester");
    expect(cell(container, 1, ".k-review", 0).querySelector(".review-note")).toBeNull();
    expect(within(cell(container, 1, ".k-review", 0)).getByRole("button").getAttribute("aria-label")).toBe("レビュー: 未レビュー");
  });

  it("レビューの一括の投稿: すべて投稿できたら、数を知らせて閉じる（2 つの言語のレビューを選んでいれば、両方に投稿する）", async () => {
    const { container, api } = await renderStudio({}, (a) => {
      a.postReview.mockImplementation(async (p: { key: string; verdict: string; comment: string }) => ({
        id: `r-${p.key}`,
        cell: { entryKey: p.key, resourceId: "res.csv", columnId: "review" },
        columnId: "review",
        verdict: p.verdict,
        comment: p.comment,
        userName: "tester",
        createdAt: "2026-01-01T00:00:00Z",
        stale: false,
      }));
    });
    press(cell(container, 0, ".k-review", 0)); // 日本語のレビュー
    press(cell(container, 0, ".k-review", 1), { ctrl: true }); // 英語のレビュー
    fireEvent.click(item(await openMenu(cell(container, 0, ".k-review", 1)), "レビューを一括で投稿…（2 件）"));
    const dialog = await screen.findByRole("dialog", { name: "レビューを一括で投稿: レビュー" });
    expect(within(dialog).getByRole("status").textContent).toContain("2 件のセルに、同じ判定とコメントを投稿します（日本語、英語）");
    fireEvent.click(within(dialog).getByRole("radio", { name: /承認/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "2 件に投稿" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "レビューを一括で投稿: レビュー" })).toBeNull());
    expect(await screen.findByText("2 件のレビューを投稿しました")).toBeTruthy();
    expect(api.postReview.mock.calls.map((c) => [c[0].key, c[0].cellId, c[0].verdict, c[0].comment])).toEqual([
      ["KEY_0", "review@ja", "ok", ""],
      ["KEY_0", "review@en", "ok", ""],
    ]);
  });

  it("コピー: 1 つのセルはそのままの文字、複数のセルは行と列の形のタブ区切り（選択式は表示名）", async () => {
    const clipboard = stubClipboard();
    const { container } = await renderStudio();
    fireEvent.click(item(await openMenu(cell(container, 0, ".k-text", 0)), "コピー"));
    await waitFor(() => expect(clipboard.written).toEqual(["日本語0"]));
    expect(await screen.findByText("コピーしました")).toBeTruthy();

    // 日本語の本文と状態を 2 行、離れた行のキーを 1 つ。
    press(cell(container, 0, ".k-text", 0));
    press(cell(container, 1, ".k-enum", 0), { shift: true });
    press(cell(container, 2, ".k-key"), { ctrl: true });
    fireEvent.click(item(await openMenu(cell(container, 0, ".k-text", 0)), "コピー（5 セル）"));
    // 列はキー、本文、状態の順。選んでいないセルは空。
    await waitFor(() => expect(clipboard.written[1]).toBe("\t日本語0\t未着手\n\t日本語1\t未着手\nKEY_2\t\t"));
    expect(await screen.findByText("5 セルをコピーしました（表計算ソフトに貼り付けられます）")).toBeTruthy();
  });

  it("貼り付け: 本文は、選んだセルすべてに未保存の変更として入れる。終わったら、入れた数を知らせて読み直す", async () => {
    stubClipboard("新しい本文\n");
    const { container, api } = await renderStudio();
    press(cell(container, 0, ".k-text", 0));
    press(cell(container, 1, ".k-text", 0), { shift: true });
    const rowsBefore = api.rows.mock.calls.length;
    fireEvent.click(item(await openMenu(cell(container, 1, ".k-text", 0)), "貼り付け（2 件）"));
    await waitFor(() => expect(api.setText).toHaveBeenCalledTimes(2));
    expect(api.setText.mock.calls.map((c) => c[0])).toEqual([
      { resourceId: "res.csv", key: "KEY_0", language: "ja", value: "新しい本文" },
      { resourceId: "res.csv", key: "KEY_1", language: "ja", value: "新しい本文" },
    ]);
    expect(await screen.findByText("2 件に貼り付けました")).toBeTruthy();
    await waitFor(() => expect(api.rows.mock.calls.length).toBeGreaterThan(rowsBefore));
  });

  it("貼り付け: 選択式の列は表示名でも値でも入れられる。選択肢にない値は、理由を出して入れない。レビュー列には貼り付けられない", async () => {
    const clipboard = stubClipboard("完了");
    const { container, api } = await renderStudio();
    fireEvent.click(item(await openMenu(cell(container, 0, ".k-enum", 0)), "貼り付け"));
    await waitFor(() => expect(api.setCell).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_0", cellId: "status@ja", value: "done", expectedVersion: 3 }));
    expect(await screen.findByText("1 件に貼り付けました")).toBeTruthy();

    clipboard.read = "なし";
    fireEvent.click(item(await openMenu(cell(container, 1, ".k-enum", 0)), "貼り付け"));
    expect(await screen.findByText("「状態」の選択肢にない値のため、貼り付けられません: なし（選択肢: 未着手、完了）")).toBeTruthy();
    expect(api.setCell).toHaveBeenCalledTimes(1);

    const review = await openMenu(cell(container, 0, ".k-review", 0));
    expect(item(review, "貼り付け").disabled).toBe(true);
    expect(item(review, "貼り付け").title).toBe("この列には貼り付けられません");
  });

  it("プラグインのアクションは「アクション」に並び、選んでいる行を対象に実行する。出す列は、アクションの columns と、列の定義の actions で絞られる", async () => {
    const actions = [
      { id: "ticket", label: "チケット", target: "cell" as const },
      { id: "mark", label: "印を付ける", target: "row" as const },
      { id: "note-only", label: "メモを整える", target: "cell" as const, columns: ["note"] },
      { id: "sum", label: "まとめて数える", target: "selection" as const },
      { id: "export", label: "書き出し", target: "file" as const },
      { id: "fill", label: "一括入力", target: "column" as const },
    ];
    const { container, api } = await renderStudio({ actions });
    press(cell(container, 0, ".k-text", 0));
    press(cell(container, 1, ".k-text", 0), { shift: true });
    const menu = await openMenu(cell(container, 0, ".k-text", 0));
    expect(menu.getByText("アクション（2 行）")).toBeTruthy();
    // 本文のセル: セルと行と選択が対象のアクション。メモの列だけのアクション、ファイルと列が対象のアクションは出ない。
    expect(itemNames(menu)).toEqual(["コピー（2 セル）", "貼り付け（2 件）", "チケット", "印を付ける", "まとめて数える", "＋ 行を追加…", "行を削除…（2 行）", "選択を解除"]);
    fireEvent.click(item(menu, "印を付ける"));
    await waitFor(() => expect(api.runAction).toHaveBeenCalledWith({ actionId: "mark", resourceId: "res.csv", keys: ["KEY_0", "KEY_1"], language: "ja" }));

    // メモの列のセルには、メモの列だけのアクションも出る。
    const note = await openMenu(cell(container, 2, ".k-string"));
    expect(itemNames(note)).toContain("メモを整える");
    fireEvent.click(item(note, "メモを整える"));
    await waitFor(() => expect(api.runAction).toHaveBeenLastCalledWith({ actionId: "note-only", resourceId: "res.csv", keys: ["KEY_2"], cellId: "note" }));

    // 列の定義の actions に書いたアクションだけを出す列（フィクスチャの「操作」の列は ticket だけ）。
    const tools = await openMenu(cell(container, 0, ".k-actions", 0));
    expect(itemNames(tools).filter((n: string | null) => ["チケット", "印を付ける", "メモを整える"].includes(n ?? ""))).toEqual(["チケット"]);
  });

  it("行の操作: 追加（選んでいる最後の行の後ろ）、キーの変更（1 行のとき）、削除（選んでいる行すべて）", async () => {
    const { container, api } = await renderStudio();
    fireEvent.click(item(await openMenu(cell(container, 1, ".k-key")), "キーを変更…"));
    const rename = await screen.findByRole("dialog", { name: "キーを変更" });
    expect((within(rename).getByRole("textbox", { name: "新しいキー" }) as HTMLInputElement).value).toBe("KEY_1");
    fireEvent.click(within(rename).getByRole("button", { name: "やめる" }));

    press(cell(container, 0, ".k-key"));
    press(cell(container, 2, ".k-text", 0), { ctrl: true });
    const menu = await openMenu(cell(container, 2, ".k-text", 0));
    // 2 行を選んでいるときは、キーの変更は出ない。
    expect(menu.queryByRole("menuitem", { name: "キーを変更…" })).toBeNull();
    fireEvent.click(item(menu, "行を削除…（2 行）"));
    const remove = await screen.findByRole("dialog", { name: "行を削除" });
    expect(within(remove).getByText("KEY_0、KEY_2")).toBeTruthy();
    expect(api.editEntries).not.toHaveBeenCalled();
    fireEvent.click(within(remove).getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(api.editEntries).toHaveBeenCalledWith({ resourceId: "res.csv", changes: [{ type: "remove", key: "KEY_0" }, { type: "remove", key: "KEY_2" }] }));

    press(cell(container, 0, ".k-key"));
    press(cell(container, 1, ".k-key"), { shift: true });
    fireEvent.click(item(await openMenu(cell(container, 0, ".k-key")), "＋ 行を追加…"));
    const add = await screen.findByRole("dialog", { name: "行を追加" });
    expect(within(add).getByText(/「KEY_1」の後ろに足します/)).toBeTruthy();
  });

  it("「選択を解除」で、いまのセルだけの選択に戻る", async () => {
    const { container } = await renderStudio();
    press(cell(container, 0, ".k-text", 0));
    press(cell(container, 2, ".k-text", 0), { shift: true });
    fireEvent.click(item(await openMenu(cell(container, 1, ".k-text", 0)), "選択を解除"));
    await waitFor(() => expect(screen.queryByText(/セルを選択$/)).toBeNull());
    expect([cell(container, 0, ".k-text", 0), cell(container, 2, ".k-text", 0)].map(selected)).toEqual([false, true]);
  });

  it("役割でできない操作は、理由つきで押せない", async () => {
    const { container, api } = await renderStudio({ permissions: { role: "viewer", can: { edit: false, review: false, run: false, structure: false, manage: false } } });
    const menu = await openMenu(cell(container, 0, ".k-enum", 0));
    const structure = "行の追加・削除とリソースの作成は、あなたの役割ではできません";
    expect(item(menu, "＋ 行を追加…").title).toBe(structure);
    expect(item(menu, "行を削除…").title).toBe(structure);
    for (const name of ["「完了」にする", "貼り付け", "チケット", "＋ 行を追加…", "キーを変更…", "行を削除…"]) expect([name, item(menu, name).disabled]).toEqual([name, true]);
    // コピーは、読むだけの役割でもできる。
    expect(item(menu, "コピー").disabled).toBe(false);
    fireEvent.click(item(menu, "「完了」にする"));
    expect(api.setCell).not.toHaveBeenCalled();
  });
});

describe("コピーと貼り付けの値", () => {
  const info = makeInfo();
  const gc = (id: string, language?: string): GridColumn => {
    const col = info.columns.find((c) => c.id === id)!;
    return { cellId: language ? `${id}@${language}` : id, col, kind: gridKind(col), groupId: language ? `lang:${language}` : "@common", width: 100, ...(language ? { language } : {}) };
  };

  it("コピーする文字: キー、本文、選択式の表示名、数値", () => {
    const row = makeRow(3);
    expect(cellCopyText(row, gc("key"))).toBe("KEY_3");
    expect(cellCopyText(row, gc("text", "ja"))).toBe("日本語3");
    expect(cellCopyText(row, gc("status", "en"))).toBe("完了");
    expect(cellCopyText(row, gc("maxLen"))).toBe("10");
    // 値のないセルは空。
    expect(cellCopyText({ ...row, cells: {} }, gc("note"))).toBe("");
  });

  it("貼り付ける値: 本文は全体（末尾の改行 1 つは落とす）、ほかの列は最初の 1 つ。数値は数に、空は値なしにする", () => {
    expect(pastedValue("1 行目\n2 行目\r\n", gc("text", "ja"))).toEqual({ value: "1 行目\n2 行目" });
    expect(pastedValue("メモ A\tメモ B\nメモ C\n", gc("note"))).toEqual({ value: "メモ A" });
    expect(pastedValue("42\n", gc("maxLen"))).toEqual({ value: 42 });
    expect(pastedValue("", gc("maxLen"))).toEqual({ value: null });
    expect(pastedValue("たくさん", gc("maxLen"))).toEqual({ error: "数値ではないため、貼り付けられません: たくさん" });
    expect(pastedValue("done", gc("status", "ja"))).toEqual({ value: "done" });
    expect(pastedValue("未着手", gc("status", "ja"))).toEqual({ value: "todo" });
    expect(pastedValue("KEY_9", gc("key"))).toEqual({ error: "この列には貼り付けられません" });
  });
});
