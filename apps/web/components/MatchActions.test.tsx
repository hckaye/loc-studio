import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { QueryResponse } from "@loc-studio/server";
import { ToastArea, ToastProvider } from "@/components/context";
import { MatchActions } from "@/components/MatchActions";
import { Studio } from "@/components/Studio";
import { makeInfo, mockApi } from "@/test/fixtures";
import { renderWithStudio } from "@/test/render";

/* 「一括アクション」: 絞り込みに合う行すべてに、アクションを実行する（表では開いているリソース、検索結果の表示ではプロジェクト全体）。 */

const ACTIONS = [
  { id: "ticket", label: "チケット", target: "cell" as const },
  { id: "send", label: "送る", target: "row" as const },
  { id: "export", label: "書き出し", target: "file" as const },
];
const TARGETS = [
  { resourceId: "a.csv", path: "a.csv" },
  { resourceId: "b.csv", path: "dir/b.csv" },
];

function renderMenu(over: Partial<Parameters<typeof MatchActions>[0]> = {}, infoOver: Parameters<typeof makeInfo>[0] = {}) {
  const info = makeInfo({ actions: ACTIONS, ...infoOver });
  const { api } = mockApi(info);
  const onDone = vi.fn();
  const onJob = vi.fn();
  const utils = renderWithStudio(<MatchActions filter={{ onlyUntranslated: true }} languages={["ja", "en"]} targets={TARGETS} rows={12} scope="プロジェクト全体" onDone={onDone} onJob={onJob} {...over} />, api, info);
  return { api, onDone, onJob, unmount: utils.unmount };
}
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "一括アクション ▾" }));
/** ボタンが有効になるのを待ってから押す。 */
async function press(find: () => HTMLElement): Promise<void> {
  await waitFor(() => expect((find() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(find());
}

describe("一括アクションのメニュー", () => {
  it("行が対象のアクションを、列と言語ごとに並べる（ファイル全体が対象のアクションは出さない）。押しても、確かめるまで実行しない", async () => {
    const { api } = renderMenu();
    openMenu();
    expect(screen.getByRole("menu", { name: "絞り込みに合う行に実行するアクション" }).textContent).toContain("プロジェクト全体の、絞り込みに合う 12 行に実行");
    // アクションのあとに、生成列の生成（列と、その列のある言語ごと）が並ぶ。
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["チケット（日本語 / 本文）", "チケット（英語 / 本文）", "送る", "逆翻訳 を生成（英語）"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "送る" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: 送る" });
    expect(dialog.textContent).toContain("「送る」を、プロジェクト全体の、絞り込みに合う 12 行（2 個のリソース）に実行します。");
    expect(api.runAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "やめる" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.runAction).not.toHaveBeenCalled();
  });

  it("実行すると、リソースごとに条件とセルを渡して runAction を呼び、結果を出して、値を読み直させる", async () => {
    const { api, onDone } = renderMenu();
    api.runAction.mockResolvedValueOnce({ patched: 2, matched: 5 }).mockResolvedValueOnce({ patched: 0, matched: 7, errors: ["KEY_3: 変えられません"] });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "チケット（英語 / 本文）" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: チケット（英語 / 本文）" });
    await press(() => within(dialog).getByRole("button", { name: "12 行に実行" }));
    await within(dialog).findByText(/終わりました。/);
    const filter = { onlyUntranslated: true, languages: ["ja", "en"] };
    expect(api.runAction.mock.calls.map((c) => c[0])).toEqual([
      { actionId: "ticket", resourceId: "a.csv", filter, cellId: "text@en", language: "en" },
      { actionId: "ticket", resourceId: "b.csv", filter, cellId: "text@en", language: "en" },
    ]);
    expect(within(dialog).getByRole("status").textContent).toContain("終わりました。 リソース 2 / 2");
    expect(within(dialog).getByRole("status").textContent).toContain("条件に合った行 12 / 反映した変更 2 / エラー 1 件");
    expect(within(dialog).getByRole("alert").textContent).toBe("dir/b.csv: KEY_3: 変えられません");
    expect(onDone).toHaveBeenCalledTimes(1);
    // 「閉じる」は、ダイアログの右上と、下の 2 つある。下のボタンで閉じる。
    await press(() => within(dialog).getAllByRole("button", { name: "閉じる" }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("ジョブになったリソースは、ジョブの一覧に出るよう知らせ、ジョブで実行した行の数を結果に出す", async () => {
    const { api, onJob } = renderMenu({ targets: [TARGETS[0]!] });
    api.runAction.mockResolvedValueOnce({ patched: 0, matched: 30, jobId: "j9" });
    api.job.mockResolvedValue({ id: "j9", kind: "action", label: "送る", status: "done", total: 30, done: 29, failed: 1, skipped: 0, startedBy: "tester", startedAt: 0, error: "KEY_7: 失敗" } as never);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "送る" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: 送る" });
    await press(() => within(dialog).getByRole("button", { name: "12 行に実行" }));
    await within(dialog).findByText(/終わりました。/);
    expect(onJob).toHaveBeenCalledWith("j9");
    expect(within(dialog).getByRole("status").textContent).toContain("条件に合った行 30 / 反映した変更 0 / ジョブで実行した行 29 / エラー 1 件");
    expect(within(dialog).getByRole("alert").textContent).toBe("a.csv: KEY_7: 失敗");
  });

  it("絞り込みがないときは「すべての行」と出す。合う行がないときと、実行する権限がないときは、理由を付けて押せなくする", () => {
    renderMenu({ filter: {}, rows: 0 });
    openMenu();
    expect(screen.getByRole("menu", { name: "すべての行に実行するアクション" }).textContent).toContain("プロジェクト全体の、すべての 0 行に実行");
    const item = screen.getByRole("menuitem", { name: "送る" }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe("条件に合う行がありません");
  });

  it("実行する権限がない役割では、理由を付けて押せなくする", () => {
    renderMenu({}, { permissions: { role: "translator", can: { edit: true, review: false, run: false, structure: false, manage: false } } });
    openMenu();
    const item = screen.getByRole("menuitem", { name: "送る" }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe("アクションと生成を実行する権限がありません");
  });

  it("行が対象のアクションも、生成列もなければ、ボタンを出さない。生成列があれば、生成だけを並べる", () => {
    const columns = makeInfo().columns;
    const first = renderMenu({}, { actions: [{ id: "export", label: "書き出し", target: "file" }], columns: columns.filter((c) => c.kind !== "generated") });
    expect(screen.queryByRole("button", { name: "一括アクション ▾" })).toBeNull();
    first.unmount();
    renderMenu({}, { actions: [{ id: "export", label: "書き出し", target: "file" }] });
    openMenu();
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["逆翻訳 を生成（英語）"]);
  });
});

describe("生成列の生成を、条件に合う行にまとめて実行する", () => {
  it("生成を選ぶと、まとめて送る行数を選べる。実行すると、リソースごとに条件と言語を渡して generate を呼び、結果を数で出す", async () => {
    const { api, onDone, onJob } = renderMenu();
    api.generate.mockResolvedValueOnce({ total: 6, cached: 2, toRun: 4, batchSize: 5, jobId: "g1" }).mockResolvedValueOnce({ total: 3, cached: 3, toRun: 0, batchSize: 5 });
    api.job.mockResolvedValue({ id: "g1", kind: "generate", label: "生成", status: "done", total: 4, done: 4, failed: 0, skipped: 0, startedBy: "tester", startedAt: 0 } as never);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "逆翻訳 を生成（英語）" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: 逆翻訳 を生成（英語）" });
    expect(dialog.textContent).toContain("「逆翻訳 を生成（英語）」を、プロジェクト全体の、絞り込みに合う 12 行（2 個のリソース）に実行します。");
    expect(dialog.textContent).toContain("結果がキャッシュにある行は、もう一度は生成しません。");
    const batch = within(dialog).getByLabelText("まとめて送る行数（バッチサイズ）") as HTMLInputElement;
    expect(batch.placeholder).toBe("既定");
    fireEvent.change(batch, { target: { value: "5" } });
    expect(api.generate).not.toHaveBeenCalled();
    await press(() => within(dialog).getByRole("button", { name: "12 行に実行" }));
    await within(dialog).findByText(/終わりました。/);
    const filter = { onlyUntranslated: true, languages: ["ja", "en"] };
    expect(api.generate.mock.calls.map((c) => c[0])).toEqual([
      { columnId: "back", scope: "resource", resourceId: "a.csv", filter, languages: ["en"], batchSize: 5 },
      { columnId: "back", scope: "resource", resourceId: "b.csv", filter, languages: ["en"], batchSize: 5 },
    ]);
    expect(api.runAction).not.toHaveBeenCalled();
    expect(onJob).toHaveBeenCalledWith("g1");
    expect(within(dialog).getByRole("status").textContent).toContain("対象のセル 9 / キャッシュにあり生成しなかったセル 5 / 生成したセル 4 / エラー 0 件");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("まとめて送る行数を空のままにすると、batchSize を付けずに呼ぶ（生成器の既定で動く）", async () => {
    const { api } = renderMenu({ targets: [TARGETS[0]!] });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "逆翻訳 を生成（英語）" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: 逆翻訳 を生成（英語）" });
    await press(() => within(dialog).getByRole("button", { name: "12 行に実行" }));
    await within(dialog).findByText(/終わりました。/);
    expect(api.generate.mock.calls.map((c) => c[0])).toEqual([{ columnId: "back", scope: "resource", resourceId: "a.csv", filter: { onlyUntranslated: true, languages: ["ja", "en"] }, languages: ["en"] }]);
  });

  it("その列を生成できない役割では、理由を付けて押せなくする", () => {
    renderMenu({}, { permissions: { role: "translator", can: { edit: true, review: false, run: true, structure: false, manage: false }, generators: ["other"] } });
    openMenu();
    const item = screen.getByRole("menuitem", { name: "逆翻訳 を生成（英語）" }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe("この列の生成は、あなたの役割では実行できません");
    // アクションは実行できる。
    expect((screen.getByRole("menuitem", { name: "送る" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("まとめて送る行数（バッチサイズ）", () => {
  const BATCH_ACTIONS = [
    { id: "mt", label: "外部に送る", target: "row" as const, batch: true },
    { id: "send", label: "送る", target: "row" as const },
  ];

  it("行をまとめて受け取れるアクションにだけ、入力欄を出す。入れた数を runAction に渡す", async () => {
    const { api } = renderMenu({ targets: [TARGETS[0]!] }, { actions: BATCH_ACTIONS });
    api.runAction.mockResolvedValue({ patched: 12, matched: 12 });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "送る" }));
    let dialog = await screen.findByRole("dialog", { name: "一括アクション: 送る" });
    expect(within(dialog).queryByLabelText("まとめて送る行数（バッチサイズ）")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "やめる" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "外部に送る" }));
    dialog = await screen.findByRole("dialog", { name: "一括アクション: 外部に送る" });
    const batch = within(dialog).getByLabelText("まとめて送る行数（バッチサイズ）") as HTMLInputElement;
    expect(batch.placeholder).toBe("1");
    expect(dialog.textContent).toContain("空なら既定（1 行ずつ）で実行します。");
    fireEvent.change(batch, { target: { value: "20" } });
    await press(() => within(dialog).getByRole("button", { name: "12 行に実行" }));
    await within(dialog).findByText(/終わりました。/);
    expect(api.runAction.mock.calls.map((c) => c[0])).toEqual([{ actionId: "mt", resourceId: "a.csv", filter: { onlyUntranslated: true, languages: ["ja", "en"] }, batchSize: 20 }]);
  });

  it("1 以上 1000 以下の整数でない値は、理由を出して、実行させない", async () => {
    const { api } = renderMenu({ targets: [TARGETS[0]!] }, { actions: BATCH_ACTIONS });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "外部に送る" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: 外部に送る" });
    const batch = within(dialog).getByLabelText("まとめて送る行数（バッチサイズ）");
    for (const value of ["0", "2.5", "1001", "たくさん"]) {
      fireEvent.change(batch, { target: { value } });
      expect(within(dialog).getByRole("alert").textContent).toBe("1 以上 1000 以下の整数で入力してください。");
      expect((within(dialog).getByRole("button", { name: "12 行に実行" }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(batch, { target: { value: "" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await press(() => within(dialog).getByRole("button", { name: "12 行に実行" }));
    await within(dialog).findByText(/終わりました。/);
    // 空なら、batchSize を付けない（1 行ずつ）。
    expect(api.runAction.mock.calls.map((c) => c[0])).toEqual([{ actionId: "mt", resourceId: "a.csv", filter: { onlyUntranslated: true, languages: ["ja", "en"] } }]);
  });
});

describe("対象の範囲を、プロジェクト全体に広げる", () => {
  const result = (over: Partial<QueryResponse>): QueryResponse => ({ matched: { rows: 0, characters: 0, words: 0 }, totalRows: 0, resources: [], unreadable: [], rows: [], ...over });

  it("表のツールバーでは、確かめる窓で範囲を選べる。プロジェクト全体を選ぶと、条件に合う行を数え、合う行のあるリソースだけに実行する", async () => {
    const { api } = renderMenu({ targets: [TARGETS[0]!], rows: 3, scope: "このリソース", allowProject: true });
    api.query.mockResolvedValue(
      result({
        matched: { rows: 9, characters: 90, words: 18 },
        totalRows: 40,
        resources: [
          { resourceId: "a.csv", path: "a.csv", matched: 3, total: 10 },
          { resourceId: "b.csv", path: "dir/b.csv", matched: 6, total: 10 },
          { resourceId: "c.csv", path: "c.csv", matched: 0, total: 20 },
        ],
      }),
    );
    api.runAction.mockResolvedValueOnce({ patched: 3, matched: 3 }).mockResolvedValueOnce({ patched: 6, matched: 6 });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "送る" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: 送る" });
    // はじめは、このリソース。
    expect((within(dialog).getByRole("radio", { name: "このリソース（3 行）" }) as HTMLInputElement).checked).toBe(true);
    expect(dialog.textContent).toContain("「送る」を、このリソースの、絞り込みに合う 3 行に実行します。");
    expect(api.query).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("radio", { name: /^プロジェクト全体（すべてのリソース）/ }));
    await waitFor(() => expect(dialog.textContent).toContain("「送る」を、プロジェクト全体の、絞り込みに合う 9 行（2 個のリソース）に実行します。"));
    // 数えるときも、表と同じ条件と、対象の言語を渡す（行は返させない）。
    expect(api.query.mock.calls.map((c) => c[0])).toEqual([{ onlyUntranslated: true, languages: ["ja", "en"], limit: 0 }]);
    await press(() => within(dialog).getByRole("button", { name: "9 行に実行" }));
    await within(dialog).findByText(/終わりました。/);
    const filter = { onlyUntranslated: true, languages: ["ja", "en"] };
    expect(api.runAction.mock.calls.map((c) => c[0])).toEqual([
      { actionId: "send", resourceId: "a.csv", filter },
      { actionId: "send", resourceId: "b.csv", filter },
    ]);
    expect(within(dialog).getByRole("status").textContent).toContain("終わりました。 リソース 2 / 2");
  });

  it("このリソースに合う行がなくても、プロジェクト全体に広げれば実行できる。数えられなければ、理由を出して実行させない", async () => {
    const { api } = renderMenu({ targets: [TARGETS[0]!], rows: 0, scope: "このリソース", allowProject: true });
    api.query.mockRejectedValueOnce(new Error("リソース c.csv を読めませんでした"));
    openMenu();
    const item = screen.getByRole("menuitem", { name: "送る" }) as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: 送る" });
    // このリソースには合う行がないので、そのままでは実行できない。
    expect((within(dialog).getByRole("button", { name: "0 行に実行" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /^プロジェクト全体（すべてのリソース）/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("プロジェクト全体の行数を数えられませんでした: リソース c.csv を読めませんでした");
    expect((within(dialog).getByRole("button", { name: "行数を数えています…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.runAction).not.toHaveBeenCalled();
  });

  it("検索結果の表示（はじめからプロジェクト全体）では、範囲の選択を出さない", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "送る" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: 送る" });
    expect(within(dialog).queryByRole("radio")).toBeNull();
  });
});

describe("表と検索結果の表示の一括アクション", () => {
  const TREE = [
    { id: "a", name: "a.csv", kind: "resource" as const, resource: { id: "a.csv", path: "a.csv", name: "a.csv" } },
    { id: "b", name: "b.csv", kind: "resource" as const, resource: { id: "b.csv", path: "dir/b.csv", name: "b.csv" } },
  ];
  const queryResult = (over: Partial<QueryResponse>): QueryResponse => ({ matched: { rows: 0, characters: 0, words: 0 }, totalRows: 0, resources: [], unreadable: [], rows: [], ...over });

  async function renderStudio() {
    const info = makeInfo({ actions: ACTIONS });
    const { api } = mockApi(info);
    api.tree.mockResolvedValue(TREE);
    api.query.mockImplementation(async () =>
      queryResult({
        matched: { rows: 4, characters: 40, words: 8 },
        totalRows: 20,
        resources: [
          { resourceId: "a.csv", path: "a.csv", matched: 0, total: 10 },
          { resourceId: "b.csv", path: "dir/b.csv", matched: 4, total: 10 },
        ],
      }),
    );
    const utils = render(
      <ToastProvider>
        <Studio api={api} project="/tmp/test" initialInfo={info} />
        <ToastArea />
      </ToastProvider>,
    );
    await waitFor(() => expect(utils.container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
    return { ...utils, api };
  }

  it("表のツールバーからは、開いているリソースの、いまの絞り込みに合う行に実行する", async () => {
    const { api } = await renderStudio();
    api.runAction.mockResolvedValue({ patched: 3, matched: 3 });
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    await waitFor(() => expect(api.rows.mock.calls.at(-1)![0]).toMatchObject({ onlyUntranslated: true }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "送る" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: 送る" });
    expect(dialog.textContent).toContain("「送る」を、このリソースの、絞り込みに合う");
    const rowsBefore = api.rows.mock.calls.length;
    await press(() => within(dialog).getByRole("button", { name: /行に実行$/ }));
    await within(dialog).findByText(/終わりました。/);
    expect(api.runAction.mock.calls.map((c) => c[0])).toEqual([{ actionId: "send", resourceId: "a.csv", filter: { onlyUntranslated: true, languages: ["ja", "en"] } }]);
    // 終わったら、表を読み直す。
    await waitFor(() => expect(api.rows.mock.calls.length).toBeGreaterThan(rowsBefore));
  });

  it("検索結果の表示からは、条件に合う行のあるリソースだけを回す（合う行のないリソースには呼ばない）", async () => {
    const { api } = await renderStudio();
    api.runAction.mockResolvedValue({ patched: 4, matched: 4 });
    fireEvent.click(screen.getByRole("button", { name: "未翻訳のみ" }));
    fireEvent.click(screen.getByRole("button", { name: "全体" }));
    const view = await screen.findByRole("region", { name: "検索結果の表示" });
    await waitFor(() => expect(within(view).getByRole("status").textContent).toContain("4 行"));
    // 検索結果の表示を開いている間、表のツールバーの一括アクション（開いているリソースだけが対象）は出さない。
    expect(screen.getAllByRole("button", { name: "一括アクション ▾" })).toHaveLength(1);
    fireEvent.click(within(view).getByRole("button", { name: "一括アクション ▾" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "チケット（日本語 / 本文）" }));
    const dialog = await screen.findByRole("dialog", { name: "一括アクション: チケット（日本語 / 本文）" });
    expect(dialog.textContent).toContain("プロジェクト全体の、絞り込みに合う 4 行に実行します。");
    // 検索結果の表示の問い合わせ（行を返すもの。ツリーの件数の問い合わせは行を返さない）だけを数える。
    const viewQueries = () => api.query.mock.calls.filter((c) => (c[0].limit ?? 0) > 0).length;
    const queriesBefore = viewQueries();
    await press(() => within(dialog).getByRole("button", { name: "4 行に実行" }));
    await within(dialog).findByText(/終わりました。/);
    expect(api.runAction.mock.calls.map((c) => c[0])).toEqual([
      { actionId: "ticket", resourceId: "b.csv", filter: { onlyUntranslated: true, languages: ["ja", "en"] }, cellId: "text@ja", language: "ja" },
    ]);
    // 終わったら、検索結果の表示も読み直す。
    await waitFor(() => expect(viewQueries()).toBeGreaterThan(queriesBefore));
  });
});
