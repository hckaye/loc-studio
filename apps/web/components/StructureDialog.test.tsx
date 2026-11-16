import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProjectInfo } from "@loc-studio/server";
import { ToastArea, ToastProvider } from "@/components/context";
import { Studio } from "@/components/Studio";
import { RpcError } from "@/lib/client/api";
import { makeInfo, mockApi } from "@/test/fixtures";

/* 行の追加・キーの変更・削除と、リソースの作成。表の画面（Studio）から操作して、API に渡る値と画面の更新を確かめる。右クリックのメニューからの操作は cell-menu.test.tsx にある。 */

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
  return { ...utils, api };
}

/** ツールバーの「操作」のボタン（「＋ 行を追加」「行を削除」）。 */
const rowButton = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const selectRow = (container: HTMLElement, row: number, mods: { shift?: boolean; ctrl?: boolean } = {}) =>
  fireEvent.mouseDown(container.querySelector<HTMLElement>(`[data-row="${row}"] .k-key`)!, { button: 0, shiftKey: mods.shift === true, ctrlKey: mods.ctrl === true });

describe("行の操作", () => {
  it("行を追加: 選択中の行の後ろに足し、表を読み直す", async () => {
    const { container, api } = await renderStudio();
    selectRow(container, 1);
    fireEvent.click(rowButton(/^＋ 行を追加$/));
    const dialog = await screen.findByRole("dialog", { name: "行を追加" });
    const add = within(dialog).getByRole("button", { name: "追加する" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true); // キーが空の間は足せない
    expect(within(dialog).getByText(/「KEY_1」の後ろに足します/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "新しい行のキー" }), { target: { value: "  KEY_NEW  " } });
    const rowsBefore = api.rows.mock.calls.length;
    fireEvent.click(add);
    await waitFor(() => expect(api.editEntries).toHaveBeenCalledWith({ resourceId: "res.csv", changes: [{ type: "add", key: "KEY_NEW", after: "KEY_1" }] }));
    expect(await screen.findByText("行「KEY_NEW」を追加しました")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "行を追加" })).toBeNull());
    await waitFor(() => expect(api.rows.mock.calls.length).toBeGreaterThan(rowsBefore));
  });

  it("キーを変更: キーのセルのダブルクリックで開き、同じキーのままでは確定できない", async () => {
    const { container, api } = await renderStudio();
    fireEvent.doubleClick(container.querySelector<HTMLElement>('[data-row="2"] .k-key')!);
    const dialog = await screen.findByRole("dialog", { name: "キーを変更" });
    const input = within(dialog).getByRole("textbox", { name: "新しいキー" }) as HTMLInputElement;
    expect(input.value).toBe("KEY_2");
    const ok = within(dialog).getByRole("button", { name: "変更する" }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "KEY_RENAMED" } });
    fireEvent.click(ok);
    await waitFor(() => expect(api.editEntries).toHaveBeenCalledWith({ resourceId: "res.csv", changes: [{ type: "rename", key: "KEY_2", newKey: "KEY_RENAMED" }] }));
  });

  it("行を削除: ボタンに選んでいる行の数が出る。選んだ行のキーを見せて確かめてから、まとめて消す（Ctrl で選んだ離れた行も）", async () => {
    const { container, api } = await renderStudio();
    selectRow(container, 0);
    // 1 行のときは数を出さない。
    expect(rowButton(/^行を削除/).textContent).toBe("行を削除");
    selectRow(container, 2, { ctrl: true });
    expect(rowButton(/^行を削除/).textContent).toBe("行を削除（2）");
    expect(rowButton(/^行を削除/).title).toContain("選んでいる 2 行を削除する");
    fireEvent.click(rowButton(/^行を削除/));
    const dialog = await screen.findByRole("dialog", { name: "行を削除" });
    expect(within(dialog).getByText("KEY_0、KEY_2")).toBeTruthy();
    expect(api.editEntries).not.toHaveBeenCalled(); // 確かめるまで消さない
    fireEvent.click(within(dialog).getByRole("button", { name: "削除する" }));
    await waitFor(() =>
      expect(api.editEntries).toHaveBeenCalledWith({ resourceId: "res.csv", changes: [{ type: "remove", key: "KEY_0" }, { type: "remove", key: "KEY_2" }] }),
    );
    expect(await screen.findByText("2 行を削除しました")).toBeTruthy();
  });

  it("サーバーが断ったら、その理由を知らせ、ダイアログは開いたままにする（入力を失わない）", async () => {
    const { container } = await renderStudio({}, (api) => {
      api.editEntries.mockRejectedValueOnce(new RpcError("editEntries", "failed", "add: キー「KEY_0」は既にあります（res.csv）。"));
    });
    selectRow(container, 0);
    fireEvent.click(rowButton(/^＋ 行を追加$/));
    const dialog = await screen.findByRole("dialog", { name: "行を追加" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "新しい行のキー" }), { target: { value: "KEY_0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "追加する" }));
    expect(await screen.findByText(/キー「KEY_0」は既にあります/)).toBeTruthy();
    expect((within(dialog).getByRole("textbox", { name: "新しい行のキー" }) as HTMLInputElement).value).toBe("KEY_0");
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "追加する" }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("行のないリソース", () => {
  it("行がなければ、削除は押せず（理由を出す）、追加は押せる。追加は末尾に足す", async () => {
    const info = makeInfo();
    const { api } = mockApi(info, 0);
    render(
      <ToastProvider>
        <Studio api={api} project="/tmp/test" initialInfo={info} />
        <ToastArea />
      </ToastProvider>,
    );
    await screen.findByText(/このリソースには、まだ行がありません/);
    expect(rowButton(/^行を削除/).disabled).toBe(true);
    expect(rowButton(/^行を削除/).title).toBe("削除する行を選んでください");
    expect(rowButton(/^＋ 行を追加$/).disabled).toBe(false);
    fireEvent.click(rowButton(/^＋ 行を追加$/));
    const dialog = await screen.findByRole("dialog", { name: "行を追加" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "新しい行のキー" }), { target: { value: "FIRST" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "追加する" }));
    await waitFor(() => expect(api.editEntries).toHaveBeenCalledWith({ resourceId: "res.csv", changes: [{ type: "add", key: "FIRST" }] }));
  });
});

describe("リソースの作成", () => {
  it("選んでいるリソースと同じフォルダを初期値にし、作ったリソースを開く", async () => {
    const { api } = await renderStudio({}, (a) => {
      a.tree.mockResolvedValue([
        { id: "text", name: "text", kind: "folder", children: [{ id: "text/res.csv", name: "res.csv", kind: "resource", resource: { id: "text/res.csv", path: "text/res.csv", name: "res.csv" } }] },
      ]);
    });
    fireEvent.click(screen.getByRole("button", { name: "リソースを作成" }));
    const dialog = await screen.findByRole("dialog", { name: "リソースを作成" });
    const input = within(dialog).getByRole("textbox", { name: "リソースの場所" }) as HTMLInputElement;
    expect(input.value).toBe("text/");
    fireEvent.change(input, { target: { value: "text/dlc.csv" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "作成する" }));
    await waitFor(() => expect(api.createResource).toHaveBeenCalledWith({ path: "text/dlc.csv" }));
    // 作ったリソースの行を読みにいく。
    await waitFor(() => expect(api.rows.mock.calls.some(([req]) => req.resourceId === "text/dlc.csv")).toBe(true));
  });
});

describe("権限", () => {
  it("structure の権限がなければ、行の操作とリソースの作成は理由つきで無効", async () => {
    await renderStudio({ permissions: { role: "translator", can: { edit: true, review: false, run: true, structure: false, manage: false } } });
    const reason = "行の追加・削除とリソースの作成は、あなたの役割ではできません";
    for (const button of [rowButton(/^＋ 行を追加$/), rowButton(/^行を削除/)]) {
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(reason);
    }
    const create = screen.getByRole("button", { name: "リソースを作成" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.title).toBe(reason);
  });
});
