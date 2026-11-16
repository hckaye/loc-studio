import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { QueryResponse, RowsRequest } from "@loc-studio/server";
import { StudioProvider, ToastArea, ToastProvider } from "@/components/context";
import { ColumnsMenu, FavoritesMenu, QueryPanel } from "@/components/FindBar";
import { Studio } from "@/components/Studio";
import { RpcError } from "@/lib/client/api";
import { EMPTY_FILTERS } from "@/lib/client/filters";
import type { Favorite, GridPrefs } from "@/lib/client/prefs";
import { ResourceTree } from "@/components/ResourceTree";
import { makeInfo, makeRow, mockApi } from "@/test/fixtures";

/* 条件の組み立て、お気に入り、列の表示、ツリーの件数、検索ビュー、前回の状態の復元。 */

const info = makeInfo();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPanel(over: Partial<Parameters<typeof QueryPanel>[0]> = {}) {
  const onApply = vi.fn();
  const validate = vi.fn(async (_where: string): Promise<string | null> => null);
  render(<QueryPanel info={info} where="" builder={null} onApply={onApply} validate={validate} {...over} />);
  return { onApply, validate };
}
const openPanel = () => fireEvent.click(screen.getByRole("button", { name: /^条件/ }));
const select = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });
const apply = () => fireEvent.click(screen.getByRole("button", { name: "この条件で絞り込む" }));

describe("条件を選んで組み立てる", () => {
  it("欄、言語、比べ方、値を選ぶと式ができ、サーバーで確かめてから当てる", async () => {
    const { onApply, validate } = renderPanel();
    openPanel();
    // 最初の条件は、最初の欄（キー）で始まる。
    expect((screen.getByLabelText("条件 1 の欄") as HTMLSelectElement).value).toBe("key");
    select("条件 1 の欄", "status");
    // 言語ごとの欄なので、言語を選ぶ欄が出る。値は選択肢から選ぶ。
    select("条件 1 の言語", "en");
    select("条件 1 の値", "done");
    expect(screen.getByText("status@en = done")).toBeTruthy();
    apply();
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(validate).toHaveBeenCalledWith("status@en = done");
    expect(onApply).toHaveBeenCalledWith("status@en = done", { join: "and", conditions: [{ field: "status", language: "en", op: "eq", value: "done" }] });
    // 当てたら閉じる。
    expect(screen.queryByRole("dialog", { name: "条件で絞り込む" })).toBeNull();
  });

  it("条件を足して「どれかの条件に合う行」にすると、or でつながる。条件は削除できる", async () => {
    const { onApply } = renderPanel();
    openPanel();
    select("条件 1 の欄", "text");
    select("条件 1 の言語", "en");
    select("条件 1 の比べ方", "empty");
    // 空かどうかの条件には、値の欄がない。
    expect(screen.queryByLabelText("条件 1 の値")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "＋ 条件を足す" }));
    select("条件 2 の欄", "issues");
    select("条件 2 の言語", "en");
    select("条件 2 の値", "error");
    expect(screen.getByText("text@en is empty and issues@en >= error")).toBeTruthy();
    select("条件のつなぎ方", "or");
    expect(screen.getByText("text@en is empty or issues@en >= error")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "条件 1 を削除" }));
    apply();
    await waitFor(() => expect(onApply).toHaveBeenCalledWith("issues@en >= error", { join: "or", conditions: [{ field: "issues", language: "en", op: "ge", value: "error" }] }));
  });

  it("文字と数の欄は、値を入力する。文字の値は引用符で囲んだ式になる", async () => {
    const { onApply } = renderPanel();
    openPanel();
    select("条件 1 の欄", "note");
    fireEvent.change(screen.getByLabelText("条件 1 の値"), { target: { value: "to do" } });
    fireEvent.click(screen.getByRole("button", { name: "＋ 条件を足す" }));
    select("条件 2 の欄", "maxLen");
    select("条件 2 の比べ方", "ge");
    expect((screen.getByLabelText("条件 2 の値") as HTMLInputElement).type).toBe("number");
    fireEvent.change(screen.getByLabelText("条件 2 の値"), { target: { value: "6" } });
    apply();
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0]![0]).toBe('note ~ "to do" and maxLen >= 6');
  });

  it("サーバーが誤りを返したら、その説明を出して、当てずに開いたままにする", async () => {
    const { onApply } = renderPanel({ validate: vi.fn(async () => '条件式の "nope" に当たる列がありません。') });
    openPanel();
    apply();
    expect((await screen.findByRole("alert")).textContent).toBe('条件式の "nope" に当たる列がありません。');
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "条件で絞り込む" })).toBeTruthy();
    // 条件を直すと、誤りの表示は消える。
    select("条件 1 の欄", "note");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("当ててある条件を開くと、その条件から始まる。「条件を外す」で外せる", async () => {
    const builder = { join: "or" as const, conditions: [{ field: "review", language: "ja", op: "eq", value: "back" }, { field: "stale", language: "any", op: "yes", value: "" }] };
    const { onApply } = renderPanel({ where: "review@ja = back or stale@any", builder });
    // ボタンに、条件の数が出る。
    expect(screen.getByRole("button", { name: /^条件/ }).textContent).toContain("2");
    openPanel();
    expect((screen.getByLabelText("条件 1 の欄") as HTMLSelectElement).value).toBe("review");
    expect((screen.getByLabelText("条件 1 の値") as HTMLSelectElement).value).toBe("back");
    expect((screen.getByLabelText("条件 2 の欄") as HTMLSelectElement).value).toBe("stale");
    expect((screen.getByLabelText("条件のつなぎ方") as HTMLSelectElement).value).toBe("or");
    fireEvent.click(screen.getByRole("button", { name: "条件を外す" }));
    expect(onApply).toHaveBeenCalledWith("", null);
  });
});

describe("条件を式で書く", () => {
  const typeText = (value: string) => {
    const input = screen.getByLabelText("条件式") as HTMLInputElement;
    fireEvent.change(input, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
    return input;
  };
  const options = () => within(screen.getByRole("listbox", { name: "入れられるもの" })).getAllByRole("option").map((o) => o.textContent);

  it("入力に合わせて候補を出し、↑↓ と Enter で入れる。欄、言語、比べ方、値、and / or の順に進む", async () => {
    const { onApply } = renderPanel();
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "式で書く" }));
    let input = typeText("st");
    expect(options()).toEqual(["status@状態（言語ごと）", "stale@要確認（言語ごと）"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("status@");
    // 続けて、言語の候補が出る。
    expect(options()).toEqual(["status@ja状態（日本語）", "status@en状態（英語）", "status@any状態（どれかの言語）", "status@all状態（すべての言語）"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("status@en ");
    expect(options().slice(0, 2)).toEqual(["=同じ", "!=違う"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("status@en = ");
    expect(options()).toEqual(["todo未着手", "done完了"]);
    // 候補を押しても入る。
    fireEvent.mouseDown(screen.getByRole("option", { name: /done/ }));
    input = screen.getByLabelText("条件式") as HTMLInputElement;
    expect(input.value).toBe("status@en = done ");
    expect(options()).toEqual(["andかつ", "orまたは"]);
    // 候補を閉じてから Enter で、式を当てる。
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onApply).toHaveBeenCalledWith("status@en = done", null));
  });

  it("組み立てた条件から「式で書く」に切り替えると、その式から書き始められる。式だけの条件を開くと、式で始まる", async () => {
    renderPanel();
    openPanel();
    select("条件 1 の欄", "note");
    fireEvent.change(screen.getByLabelText("条件 1 の値"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "式で書く" }));
    expect((screen.getByLabelText("条件式") as HTMLInputElement).value).toBe('note ~ "x"');
  });

  it("式を手で書いた条件を開くと、式の入力欄で始まる", () => {
    renderPanel({ where: "not (status@ja = done or note is empty)" });
    expect(screen.getByRole("button", { name: /^条件/ }).textContent).toContain("式");
    openPanel();
    expect((screen.getByLabelText("条件式") as HTMLInputElement).value).toBe("not (status@ja = done or note is empty)");
  });
});

describe("お気に入り", () => {
  const favorite = (name: string, over: Partial<Favorite> = {}): Favorite => ({ id: name, name, filters: { ...EMPTY_FILTERS, where: "text@en is empty" }, sort: null, view: "grid", groupBy: [], ...over });

  it("名前を付けて保存でき、同じ名前は上書きになる。列と言語の表示も覚えるかを選べる", () => {
    const onSave = vi.fn();
    render(<FavoritesMenu favorites={[favorite("未翻訳の英語")]} onApply={vi.fn()} onSave={onSave} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /お気に入り/ }));
    const save = () => screen.getByRole("button", { name: /保存$/ }) as HTMLButtonElement;
    // 名前がなければ保存できない。
    expect(save().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("お気に入りの名前"), { target: { value: "未翻訳の英語" } });
    expect(save().textContent).toBe("上書きして保存");
    fireEvent.change(screen.getByLabelText("お気に入りの名前"), { target: { value: " 差し戻し " } });
    expect(save().textContent).toBe("保存");
    fireEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith("差し戻し", false);
    fireEvent.change(screen.getByLabelText("お気に入りの名前"), { target: { value: "翻訳用" } });
    fireEvent.click(screen.getByLabelText("列と言語の表示も覚える"));
    fireEvent.click(save());
    expect(onSave).toHaveBeenLastCalledWith("翻訳用", true);
  });

  it("選ぶと当て、× で削除する", () => {
    const onApply = vi.fn();
    const onDelete = vi.fn();
    const favorites = [favorite("未翻訳の英語"), favorite("全体の問題", { view: "search" })];
    render(<FavoritesMenu favorites={favorites} onApply={onApply} onSave={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /お気に入り/ }));
    fireEvent.click(screen.getByRole("button", { name: "お気に入り「未翻訳の英語」を削除" }));
    expect(onDelete).toHaveBeenCalledWith("未翻訳の英語");
    // 検索ビューで開くお気に入りには、印が付く。
    fireEvent.click(screen.getByRole("button", { name: "🔎 全体の問題" }));
    expect(onApply).toHaveBeenCalledWith(favorites[1]);
  });
});

describe("列の表示", () => {
  it("列ごとに表示を切り替えられる。キーの列は隠せない", () => {
    const onChange = vi.fn();
    render(<ColumnsMenu columns={info.columns} hidden={["note"]} onChange={onChange} sets={{}} onSaveSet={vi.fn()} onDeleteSet={vi.fn()} />);
    // 隠せる列は 7 つ（キー以外）。1 つ隠している。
    fireEvent.click(screen.getByRole("button", { name: "表示する列を選ぶ（6 / 7）" }));
    const box = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;
    expect(box(/^key/).disabled).toBe(true);
    expect(box(/^key/).checked).toBe(true);
    expect(box(/^メモ/).checked).toBe(false);
    fireEvent.click(box(/^状態/));
    expect(onChange).toHaveBeenLastCalledWith(["note", "status"]);
    fireEvent.click(box(/^メモ/));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByRole("button", { name: "すべて表示" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("いまの表示をプリセットに保存し、選ぶとその表示になる。プリセットは削除できる", () => {
    const onChange = vi.fn();
    const onSaveSet = vi.fn();
    const onDeleteSet = vi.fn();
    render(<ColumnsMenu columns={info.columns} hidden={["review", "back"]} onChange={onChange} sets={{ 翻訳用: ["review", "back"], 全部: [] }} onSaveSet={onSaveSet} onDeleteSet={onDeleteSet} />);
    fireEvent.click(screen.getByRole("button", { name: /表示する列を選ぶ/ }));
    // いまの表示と同じプリセットには、印が付く。
    expect(screen.getByRole("button", { name: "翻訳用" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "全部" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.change(screen.getByLabelText("列のプリセットの名前"), { target: { value: "レビュー用" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSaveSet).toHaveBeenCalledWith("レビュー用");
    fireEvent.click(screen.getByRole("button", { name: "列のプリセット「翻訳用」を削除" }));
    expect(onDeleteSet).toHaveBeenCalledWith("翻訳用");
  });
});

// ---------------------------------------------------------------------------
// 画面全体
// ---------------------------------------------------------------------------

type Api = ReturnType<typeof mockApi>["api"];
const TWO_RESOURCES = [
  { id: "a", name: "a.csv", kind: "resource" as const, resource: { id: "a.csv", path: "a.csv", name: "a.csv" } },
  { id: "b", name: "b.csv", kind: "resource" as const, resource: { id: "b.csv", path: "dir/b.csv", name: "b.csv" } },
];

async function renderStudio(prepare?: (api: Api) => void, opts: { waitForGrid?: boolean } = {}) {
  const { api } = mockApi(info);
  prepare?.(api);
  const utils = render(
    <ToastProvider>
      <Studio api={api} project="/tmp/test" initialInfo={info} />
      <ToastArea />
    </ToastProvider>,
  );
  if (opts.waitForGrid !== false) await waitFor(() => expect(utils.container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
  return { ...utils, api };
}
const lastRows = (api: Api): RowsRequest => api.rows.mock.calls[api.rows.mock.calls.length - 1]![0];
/** 最後に保存した画面の状態。 */
const savedState = (api: Api): GridPrefs => api.setUiState.mock.calls[api.setUiState.mock.calls.length - 1]![0].state as unknown as GridPrefs;
const queryResult = (over: Partial<QueryResponse> = {}): QueryResponse => ({ matched: { rows: 0, characters: 0, words: 0 }, totalRows: 0, resources: [], unreadable: [], rows: [], ...over });

describe("前回の状態の復元", () => {
  const LAST: GridPrefs = {
    hiddenColumns: ["status"],
    last: {
      resourceId: "b.csv",
      filters: { ...EMPTY_FILTERS, search: "save", onlyStale: true, where: "text@en is empty" },
      sort: { cellId: "note", dir: "desc" },
      scroll: { resourceId: "b.csv", top: 120, left: 40, row: 2, col: 1 },
    },
  };

  it("前回開いていたリソース、絞り込み、並べ替え、隠した列、選んでいたセル、スクロールの位置を戻す", async () => {
    const { api, container } = await renderStudio((a) => {
      a.tree.mockResolvedValue(TWO_RESOURCES);
      a.uiState.mockResolvedValue({ state: LAST as unknown as Record<string, unknown> });
    });
    // 最初の読み込みから、前回のリソースを前回の条件で読む（最初のリソースを先に読まない）。
    expect(api.rows.mock.calls.every(([req]) => req.resourceId === "b.csv")).toBe(true);
    expect(lastRows(api)).toMatchObject({ resourceId: "b.csv", search: "save", onlyStale: true, where: "text@en is empty", sort: { cellId: "note", dir: "desc" } });
    expect(container.querySelector(".tree-row.resource.selected")?.textContent).toContain("b.csv");
    // ツールバーにも、前回の条件が出ている。
    expect((screen.getByLabelText("検索") as HTMLInputElement).value).toBe("save");
    expect(screen.getByRole("button", { name: "要確認" }).getAttribute("aria-pressed")).toBe("true");
    // 隠した列（状態）は出ない。
    expect(container.querySelector('[data-row="0"] .k-enum')).toBeNull();
    expect(container.querySelector('[data-row="0"] .k-review')).not.toBeNull();
    // 選んでいたセルと、スクロールの位置。
    const grid = container.querySelector<HTMLElement>(".grid-scroll")!;
    expect(grid.getAttribute("aria-activedescendant")).toBe("gc-2-1");
    await waitFor(() => expect(grid.scrollTop).toBe(120));
    expect(grid.scrollLeft).toBe(40);
  });

  it("ツリーの見え方（たたんだフォルダ、名前の絞り込み）も戻り、変えると保存される", async () => {
    const nested = [
      { id: "dir1", name: "story", kind: "folder" as const, children: [TWO_RESOURCES[0]!] },
      { id: "dir2", name: "system", kind: "folder" as const, children: [TWO_RESOURCES[1]!] },
    ];
    const { api, container } = await renderStudio((a) => {
      a.tree.mockResolvedValue(nested);
      a.uiState.mockResolvedValue({ state: { last: { resourceId: "b.csv", tree: { collapsed: ["dir1"], query: "", onlyMatching: false } } } });
    });
    const names = () => [...container.querySelectorAll(".tree-row .tree-name")].map((n) => n.textContent);
    // story はたたんだまま（中の a.csv は出ない）。
    expect(names()).toEqual(["story", "system", "b.csv"]);
    expect(container.querySelector('[role="treeitem"][aria-expanded="false"]')?.textContent).toContain("story");
    // 開くと、その状態が保存される。
    fireEvent.click(screen.getByRole("button", { name: /story/ }));
    expect(names()).toEqual(["story", "a.csv", "system", "b.csv"]);
    await waitFor(() => expect(savedState(api).last?.tree).toEqual({ collapsed: [], query: "", onlyMatching: false }));
    fireEvent.change(screen.getByLabelText("リソースを名前で絞り込む"), { target: { value: "b.c" } });
    await waitFor(() => expect(savedState(api).last?.tree).toEqual({ collapsed: [], query: "b.c", onlyMatching: false }));
  });

  it("前回のリソースがなくなっていたら、最初のリソースを開き、前回の位置は使わない", async () => {
    const { api, container } = await renderStudio((a) => {
      a.tree.mockResolvedValue(TWO_RESOURCES);
      a.uiState.mockResolvedValue({ state: { last: { ...LAST.last, resourceId: "gone.csv", scroll: { resourceId: "gone.csv", top: 120, left: 0, row: 2, col: 1 } } } });
    });
    expect(lastRows(api).resourceId).toBe("a.csv");
    expect(container.querySelector<HTMLElement>(".grid-scroll")!.getAttribute("aria-activedescendant")).toBe("gc-0-0");
  });

  it("前回の絞り込みが、いまの設定に合わなくなっていたら、外して知らせる", async () => {
    const { api } = await renderStudio((a) => {
      a.uiState.mockResolvedValue({ state: { last: { resourceId: "res.csv", filters: { ...EMPTY_FILTERS, where: "gone@ja = x" }, sort: { cellId: "gone", dir: "asc" } } } });
      const orig = a.rows.getMockImplementation()!;
      a.rows.mockImplementation(async (req) => {
        if (req.where !== undefined) throw new RpcError("rows", "invalid", '条件式の "gone@ja" に当たる列がありません。');
        return orig(req);
      });
    });
    expect(await screen.findByText("前回の絞り込みと並べ替えが、いまの設定に合わないため外しました。")).toBeTruthy();
    expect(lastRows(api).where).toBeUndefined();
    expect(lastRows(api).sort).toBeUndefined();
  });

  it("サーバーに状態がなければ、ブラウザに覚えていた状態を使う。どちらもなければ、最初のリソースを条件なしで開く", async () => {
    // ブラウザの保存領域（テストの環境にはないので、同じ形のものを置く）。
    const stored = new Map([["loc-studio:grid:/tmp/test", JSON.stringify({ last: { resourceId: "b.csv" } })]]);
    vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) });
    const first = await renderStudio((a) => a.tree.mockResolvedValue(TWO_RESOURCES));
    expect(lastRows(first.api).resourceId).toBe("b.csv");
    first.unmount();
    stored.clear();
    const second = await renderStudio((a) => a.tree.mockResolvedValue(TWO_RESOURCES));
    expect(lastRows(second.api)).toEqual({ resourceId: "a.csv", languages: ["ja", "en"], offset: 0, limit: 100 });
  });

  it("状態を読めなくても（失敗しても）、表は開く", async () => {
    const { api } = await renderStudio((a) => a.uiState.mockRejectedValue(new RpcError("uiState", "failed", "読めません")));
    expect(lastRows(api).resourceId).toBe("res.csv");
  });
});

describe("状態の保存", () => {
  it("絞り込み、並べ替え、開いているリソースを変えると、サーバー側に保存する", async () => {
    const { api } = await renderStudio((a) => a.tree.mockResolvedValue(TWO_RESOURCES));
    fireEvent.click(screen.getByRole("button", { name: "要確認" }));
    fireEvent.click(screen.getByRole("button", { name: /メモ で並べ替え/ }));
    await waitFor(() => expect(api.setUiState).toHaveBeenCalled());
    await waitFor(() => expect(savedState(api).last).toMatchObject({ resourceId: "a.csv", filters: { onlyStale: true }, sort: { cellId: "note", dir: "asc" }, view: "grid" }));
    fireEvent.click(screen.getByRole("button", { name: /b\.csv/ }));
    // リソースを切り替えると、並べ替えは外れる。絞り込みは残る。
    await waitFor(() => expect(savedState(api).last).toMatchObject({ resourceId: "b.csv", filters: { onlyStale: true }, sort: null }));
  });

  it("隠した列と、列のプリセットを保存する。隠した列は表から消える", async () => {
    const { api, container } = await renderStudio();
    expect(container.querySelectorAll('[data-row="0"] .k-enum').length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: /表示する列を選ぶ/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^状態/ }));
    await waitFor(() => expect(container.querySelectorAll('[data-row="0"] .k-enum').length).toBe(0));
    fireEvent.change(screen.getByLabelText("列のプリセットの名前"), { target: { value: "翻訳用" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "表示する列" })).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(savedState(api)).toMatchObject({ hiddenColumns: ["status"], columnSets: { 翻訳用: ["status"] } }));
  });

  it("お気に入りを保存すると状態に入り、選ぶと絞り込みと並べ替えが戻る", async () => {
    const { api } = await renderStudio();
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    fireEvent.click(screen.getByRole("button", { name: /メモ で並べ替え/ }));
    fireEvent.click(screen.getByRole("button", { name: /お気に入り/ }));
    fireEvent.change(screen.getByLabelText("お気に入りの名前"), { target: { value: "未翻訳" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "お気に入りの条件" })).getByRole("button", { name: "保存" }));
    expect(await screen.findByText("お気に入り「未翻訳」を保存しました")).toBeTruthy();
    await waitFor(() => expect(savedState(api).favorites).toMatchObject([{ id: "未翻訳", name: "未翻訳", filters: { onlyUntranslated: true }, sort: { cellId: "note", dir: "asc" }, view: "grid" }]));
    // 条件を外してから、お気に入りを選ぶ。
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    fireEvent.click(screen.getByRole("button", { name: /メモ で並べ替え/ }));
    fireEvent.click(screen.getByRole("button", { name: /メモ で並べ替え/ }));
    await waitFor(() => expect(lastRows(api).onlyUntranslated).toBeUndefined());
    fireEvent.click(screen.getByRole("button", { name: "未翻訳" }));
    await waitFor(() => expect(lastRows(api)).toMatchObject({ onlyUntranslated: true, sort: { cellId: "note", dir: "asc" } }));
    // 同じ名前で保存し直すと、置き換わる（2 つにならない）。
    fireEvent.click(screen.getByRole("button", { name: "要確認" }));
    fireEvent.click(screen.getByRole("button", { name: /お気に入り/ }));
    fireEvent.change(screen.getByLabelText("お気に入りの名前"), { target: { value: "未翻訳" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "お気に入りの条件" })).getByRole("button", { name: "上書きして保存" }));
    await waitFor(() => expect(savedState(api).favorites).toMatchObject([{ name: "未翻訳", filters: { onlyUntranslated: true, onlyStale: true } }]));
    expect(savedState(api).favorites).toHaveLength(1);
  });
});

describe("条件で絞り込む（画面全体）", () => {
  it("組み立てた条件は、サーバーで確かめてから表に当たる。誤りがあれば表は変えない", async () => {
    const { api } = await renderStudio();
    fireEvent.click(screen.getByRole("button", { name: /^条件/ }));
    select("条件 1 の欄", "text");
    select("条件 1 の言語", "en");
    select("条件 1 の比べ方", "empty");
    api.query.mockRejectedValueOnce(new RpcError("query", "invalid", "条件式が正しくありません。"));
    apply();
    expect((await screen.findByRole("alert")).textContent).toBe("条件式が正しくありません。");
    // 確かめるときは、リソースを読まない（resourceIds: []）。
    expect(api.query).toHaveBeenLastCalledWith({ languages: ["ja", "en"], resourceIds: [], where: "text@en is empty", limit: 0 });
    expect(lastRows(api).where).toBeUndefined();
    apply();
    await waitFor(() => expect(lastRows(api).where).toBe("text@en is empty"));
  });
});

describe("ツリーの、条件に合う行の数", () => {
  it("絞り込んでいないときは数えない。絞り込むと、リソースごとの数と合計を出す", async () => {
    const { api, container } = await renderStudio((a) => {
      a.tree.mockResolvedValue([{ id: "dir", name: "dir", kind: "folder", children: TWO_RESOURCES }]);
      a.query.mockImplementation(async (req) =>
        queryResult({ resources: (req.resourceIds ?? []).map((id) => ({ resourceId: id, path: id, matched: id === "a.csv" ? 3 : 0, total: 5 })) }),
      );
    });
    expect(api.query).not.toHaveBeenCalled();
    expect(container.querySelector(".tree-match")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    await waitFor(() => expect(container.querySelectorAll(".tree-match").length).toBe(3));
    // 表と同じ条件と言語で、行は取らずに数だけを問い合わせる。
    expect(api.query).toHaveBeenLastCalledWith({ onlyUntranslated: true, languages: ["ja", "en"], resourceIds: ["a.csv", "b.csv"], limit: 0 });
    const badge = (row: Element | null) => row?.querySelector(".tree-match")?.getAttribute("aria-label");
    const rows = [...container.querySelectorAll(".tree-row")];
    // フォルダは、中のリソースの合計。
    expect(badge(rows.find((r) => r.classList.contains("folder"))!)).toBe("条件に合う行 3 件");
    expect(badge(rows.find((r) => r.textContent?.includes("a.csv"))!)).toBe("条件に合う行 3 件");
    const none = rows.find((r) => r.textContent?.includes("b.csv"))!;
    expect(badge(none)).toBe("条件に合う行 0 件");
    expect(none.classList.contains("no-match")).toBe(true);
    expect(within(screen.getByRole("navigation", { name: "リソース" })).getByText("3 行")).toBeTruthy();
    // 「該当ありだけ」で、合う行のないリソースを隠す。
    fireEvent.click(screen.getByLabelText("該当ありだけ"));
    expect([...container.querySelectorAll(".tree-row.resource")].map((r) => r.querySelector(".tree-name")?.textContent)).toEqual(["a.csv"]);
    // 絞り込みを外すと、数も消える。
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    await waitFor(() => expect(container.querySelector(".tree-match")).toBeNull());
    expect(container.querySelectorAll(".tree-row.resource").length).toBe(2);
  });
});

describe("ツリーの件数の問い合わせ", () => {
  it("絞り込みがないあいだは問い合わせず、条件が変わったら、入力が止まってから 1 回だけ問い合わせる", async () => {
    vi.useFakeTimers();
    try {
      const { api } = mockApi(info);
      const tree = (match?: Parameters<typeof ResourceTree>[0]["match"]) => (
        <StudioProvider value={{ api, project: "/tmp/test", info, setInfo: () => undefined, mode: "local" }}>
          <ResourceTree nodes={TWO_RESOURCES} selected={undefined} onSelect={() => undefined} statsToken={0} onError={() => undefined} match={match} />
        </StudioProvider>
      );
      const { rerender } = render(tree());
      await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
      expect(api.query).not.toHaveBeenCalled();
      // 続けて条件が変わるあいだ（入力の途中）は、問い合わせない。
      rerender(tree({ languages: ["ja"], search: "a" }));
      await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
      rerender(tree({ languages: ["ja"], search: "ab" }));
      await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
      expect(api.query).not.toHaveBeenCalled();
      await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
      expect(api.query.mock.calls.map(([req]) => req)).toEqual([{ languages: ["ja"], search: "ab", resourceIds: ["a.csv", "b.csv"], limit: 0 }]);
      // 条件を外すと、もう問い合わせない。
      rerender(tree());
      await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
      expect(api.query).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("検索ビュー", () => {
  const cellsOf = (i: number) => ({ "text@ja": { value: `日本語${i}` }, "text@en": { value: "" }, "status@en": { value: "done" } });
  // キーは、表のモックの行（KEY_0、KEY_1、…）と同じにする（行へ移る確認で、移った先の行と照らすため）。
  const ROWS = [
    { resourceId: "a.csv", path: "a.csv", key: "KEY_0", cells: cellsOf(1) },
    { resourceId: "b.csv", path: "dir/b.csv", key: "KEY_0", cells: cellsOf(2) },
    { resourceId: "b.csv", path: "dir/b.csv", key: "KEY_1", cells: { ...cellsOf(3), "text@en": { value: "x", issues: [{ validatorId: "v", code: "c", message: "長すぎます", severity: "error" as const }] } } },
  ];
  const prepare = (a: Api) => {
    a.tree.mockResolvedValue(TWO_RESOURCES);
    a.query.mockImplementation(async (req) =>
      queryResult({
        matched: { rows: 3, characters: 1234, words: 56 },
        totalRows: 20,
        resources: [
          { resourceId: "a.csv", path: "a.csv", matched: 1, total: 10 },
          { resourceId: "b.csv", path: "dir/b.csv", matched: 2, total: 10 },
        ],
        rows: (req.limit ?? 0) > 0 ? ROWS : [],
        ...(req.groupBy ? { groups: [{ values: ["todo"], labels: ["未着手"], rows: 2, characters: 1000, words: 40 }, { values: ["done"], labels: ["完了"], rows: 1, characters: 234, words: 16 }] } : {}),
      }),
    );
  };
  const openView = async () => {
    fireEvent.click(screen.getByRole("button", { name: "検索ビュー" }));
    return screen.findByRole("region", { name: "検索ビュー" });
  };

  it("いまの絞り込みに合う行を、すべてのリソースから集めて、件数と原文の量と一緒に出す", async () => {
    const { api } = await renderStudio(prepare);
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    const view = await openView();
    await within(view).findByText("日本語1");
    // 表と同じ条件を、リソースを限らずに問い合わせる。返すセルは、表に出している列（キーと操作の列は除く）。
    const req = api.query.mock.calls.map(([r]) => r).find((r) => r.limit === 200)!;
    expect(req).toEqual({
      onlyUntranslated: true,
      languages: ["ja", "en"],
      cells: ["note", "maxLen", "text@ja", "status@ja", "review@ja", "text@en", "status@en", "review@en", "back@en"],
      offset: 0,
      limit: 200,
    });
    expect(within(view).getByRole("status").textContent).toContain("3 行（全 20 行のうち。2 / 2 個のリソース） ・ 原文 1,234 文字 / 56 語");
    const table = within(view).getByRole("table", { name: "結果の表" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell").slice(0, 2).map((c) => c.textContent))).toEqual([
      ["a.csv", "KEY_0"],
      ["dir/b.csv", "KEY_0"],
      ["dir/b.csv", "KEY_1"],
    ]);
    // 選択式の列は表示名で出し、問題のあるセルには印と説明が付く。
    expect(within(rows[0]!).getByText("完了")).toBeTruthy();
    const bad = within(rows[2]!).getByText("x");
    expect(bad.className).toBe("sev-error");
    expect(bad.getAttribute("title")).toBe("長すぎます");
  });

  it("行を選ぶと、絞り込みを保ったまま、そのリソースのその行へ移る（まだ読み込んでいない位置の行でも）", async () => {
    // b.csv には 250 行あり、絞り込むと KEY_50 から後ろの 200 行が合う。検索ビューには、そのうち KEY_50〜KEY_200 の 151 行が出ている。
    const all = Array.from({ length: 250 }, (_, i) => makeRow(i));
    const matching = all.slice(50);
    const found = matching.slice(0, 151).map((r) => ({ resourceId: "b.csv", path: "dir/b.csv", key: r.key, cells: { "text@ja": r.cells["text@ja"]! } }));
    const { api, container } = await renderStudio((a) => {
      a.tree.mockResolvedValue(TWO_RESOURCES);
      a.rows.mockImplementation(async (req) => {
        const list = req.onlyUntranslated ? matching : all;
        return { total: list.length, totalAll: all.length, rows: list.slice(req.offset, req.offset + req.limit), diagnostics: [] };
      });
      a.rowDetail.mockImplementation(async ({ key }) => ({ row: all.find((r) => r.key === key)!, languages: ["ja", "en"] }));
      a.query.mockImplementation(async (req) =>
        queryResult({ matched: { rows: 200, characters: 0, words: 0 }, totalRows: 500, resources: [{ resourceId: "b.csv", path: "dir/b.csv", matched: 200, total: 250 }], rows: (req.limit ?? 0) > 0 ? found : [] }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    const view = await openView();
    // KEY_200 は、b.csv で条件に合う行の 151 番目（0 始まりで 150）。リソースの中では 201 番目なので、その位置では見つからない。
    fireEvent.click(await within(view).findByText("日本語200"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "検索ビュー" })).toBeNull());
    await waitFor(() => expect(lastRows(api)).toMatchObject({ resourceId: "b.csv", onlyUntranslated: true }));
    await waitFor(() => expect(container.querySelector<HTMLElement>(".grid-scroll")?.getAttribute("aria-activedescendant")).toMatch(/^gc-150-/));
    expect(screen.queryByText(/の行が表に見つかりませんでした/)).toBeNull();
  });

  it("集計の区切りを選ぶと、値ごとの行数と原文の量を出す。区切りは 2 つまで", async () => {
    const { api } = await renderStudio(prepare);
    const view = await openView();
    await within(view).findByText("日本語1");
    expect(within(view).queryByRole("table", { name: "集計の表" })).toBeNull();
    // 区切りに選べるのは、値の種類の少ない欄（選択式、問題の重さなど）とリソース。本文やメモは出ない。
    const options = [...(within(view).getByLabelText("集計の区切り") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual([
      "区切りを選ぶ…",
      "状態（日本語）",
      "状態（英語）",
      "レビュー（日本語）",
      "レビュー（英語）",
      "リソース",
      "検証の問題（日本語）",
      "検証の問題（英語）",
      "問題の種類（日本語）",
      "問題の種類（英語）",
      "要確認（日本語）",
      "要確認（英語）",
      "未保存（日本語）",
      "未保存（英語）",
    ]);
    fireEvent.change(within(view).getByLabelText("集計の区切り"), { target: { value: "status@en" } });
    const groups = await within(view).findByRole("table", { name: "集計の表" });
    expect(api.query).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: ["status@en"], limit: 200 }));
    expect(within(groups).getAllByRole("row").map((r) => [...r.querySelectorAll("th,td")].map((c) => c.textContent))).toEqual([
      ["状態（英語）", "行数", "原文の文字数", "原文の語数"],
      ["未着手", "2", "1,000", "40"],
      ["完了", "1", "234", "16"],
    ]);
    fireEvent.change(within(view).getByLabelText("集計の区切り（2 つ目）"), { target: { value: "resource" } });
    await waitFor(() => expect(api.query).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: ["status@en", "resource"] })));
  });

  it("結果を CSV に保存でき（BOM つき）、コピーもできる。集計も書き出せる", async () => {
    const created: Blob[] = [];
    Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => (created.push(b), "blob:x")), revokeObjectURL: vi.fn() });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { api } = await renderStudio((a) => {
      prepare(a);
      a.exportQuery.mockImplementation(async (req) => ({ text: req.table === "groups" ? "g\r\n" : "resource,key\r\na.csv,A_1\r\n", rows: req.table === "groups" ? 2 : 3, truncated: false }));
    });
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    const view = await openView();
    await within(view).findByText("日本語1");
    fireEvent.click(within(view).getByRole("button", { name: "結果を CSV に保存" }));
    expect(await screen.findByText("結果 3 行を CSV に書き出しました")).toBeTruthy();
    expect(api.exportQuery).toHaveBeenLastCalledWith(expect.objectContaining({ onlyUntranslated: true, languages: ["ja", "en"], format: "csv", table: "rows" }));
    expect(clicked).toHaveBeenCalledTimes(1);
    // 先頭の 3 バイトが BOM（EF BB BF）。
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(created[0]!);
    });
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3))).toBe("resource,key\r\na.csv,A_1\r\n");
    fireEvent.click(within(view).getByRole("button", { name: "結果をコピー" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("resource,key\r\na.csv,A_1\r\n"));
    expect(api.exportQuery).toHaveBeenLastCalledWith(expect.objectContaining({ format: "tsv", table: "rows" }));
    // 集計は、区切りを選ぶと書き出せる。
    expect(within(view).queryByRole("button", { name: "集計を CSV に保存" })).toBeNull();
    fireEvent.change(within(view).getByLabelText("集計の区切り"), { target: { value: "status@en" } });
    fireEvent.click(await within(view).findByRole("button", { name: "集計をコピー" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("g\r\n"));
    expect(api.exportQuery).toHaveBeenLastCalledWith(expect.objectContaining({ format: "tsv", table: "groups", groupBy: ["status@en"] }));
  });

  it("問い合わせの失敗と、読めなかったリソースを知らせる", async () => {
    const { api } = await renderStudio((a) => {
      prepare(a);
      a.query.mockResolvedValueOnce(queryResult({ unreadable: [{ resourceId: "x.csv", path: "x.csv", error: "壊れています" }] }));
    });
    const view = await openView();
    expect((await within(view).findByRole("alert")).textContent).toContain("読めなかったリソースが 1 個あります（数に入っていません）: x.csv");
    api.query.mockRejectedValueOnce(new RpcError("query", "failed", "つながりません"));
    fireEvent.change(within(view).getByLabelText("集計の区切り"), { target: { value: "resource" } });
    await waitFor(() => expect(within(view).getAllByRole("alert").some((el) => el.textContent === "つながりません")).toBe(true));
  });

  it("検索ビューを開いていたことと、集計の区切りも、前回の状態として戻る", async () => {
    const { api } = await renderStudio((a) => {
      prepare(a);
      a.uiState.mockResolvedValue({ state: { last: { resourceId: "a.csv", view: "search", groupBy: ["resource"], filters: { ...EMPTY_FILTERS, onlyStale: true } } } });
    }, { waitForGrid: false });
    const view = await screen.findByRole("region", { name: "検索ビュー" });
    await within(view).findByRole("table", { name: "集計の表" });
    expect(api.query).toHaveBeenCalledWith(expect.objectContaining({ onlyStale: true, groupBy: ["resource"], limit: 200 }));
    fireEvent.click(within(view).getByRole("button", { name: "表に戻る" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "検索ビュー" })).toBeNull());
  });
});
