import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { EditModal, issueSegments } from "@/components/EditModal";
import { RpcError } from "@/lib/client/api";
import { makeInfo, makeRow, mockApi } from "@/test/fixtures";
import { renderWithStudio } from "@/test/render";

async function open(rowIndex = 0, lang = "en", prepare?: (api: ReturnType<typeof mockApi>["api"]) => void) {
  const info = makeInfo();
  const { api } = mockApi(info);
  prepare?.(api);
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  const onCellsChanged = vi.fn();
  renderWithStudio(
    <EditModal
      resourceId="res.csv"
      rowIndex={rowIndex}
      total={3}
      language={info.languages.find((l) => l.id === lang)!}
      textColumn={info.columns.find((c) => c.kind === "text")!}
      loadRow={async (i) => makeRow(i)}
      onClose={onClose}
      onNavigate={onNavigate}
      onCellsChanged={onCellsChanged}
      onSetCell={vi.fn(async () => undefined)}
      onOpenReview={vi.fn()}
    />,
    api,
    info,
  );
  const textarea = (await screen.findByRole("textbox", { name: /本文/ })) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.value).toBe(makeRow(rowIndex).cells[`text@${lang}`]!.value));
  return { api, onClose, onNavigate, onCellsChanged, textarea };
}

describe("編集モーダル", () => {
  it("Enter は改行で、確定しない", async () => {
    const { api, onClose, textarea } = await open();
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "English 0\n2 行目" } });
    expect(api.setText).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("2 行")).toBeTruthy();
  });

  it("Ctrl+Enter で確定する（setText でドラフトにして閉じる）", async () => {
    const { api, onClose, onCellsChanged, textarea } = await open();
    fireEvent.change(textarea, { target: { value: "Hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.setText).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_0", language: "en", value: "Hello", baseValue: "English 0" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onCellsChanged).toHaveBeenCalledWith("KEY_0", { "text@en": expect.objectContaining({ value: "Hello", draft: true }) }, 1);
  });

  it("IME の変換中の Enter / Ctrl+Enter では確定しない", async () => {
    const { api, onClose, textarea } = await open();
    fireEvent.change(textarea, { target: { value: "にほん" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true, keyCode: 229 });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.setText).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("変更があるときの Esc は確認を出し、すぐには閉じない", async () => {
    const { onClose, textarea } = await open();
    fireEvent.change(textarea, { target: { value: "changed" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    const bar = screen.getByRole("alertdialog", { name: "変更の破棄の確認" });
    fireEvent.click(within(bar).getByRole("button", { name: "編集に戻る" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "破棄して閉じる" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("変更がなければ Esc ですぐ閉じる", async () => {
    const { onClose, textarea, api } = await open();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(api.setText).not.toHaveBeenCalled();
  });

  it("Alt+↓ で確定して次の行へ、Alt+↑ で前の行へ", async () => {
    const { api, onNavigate, textarea } = await open(0);
    fireEvent.change(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith(1));
    expect(api.setText).toHaveBeenCalledWith(expect.objectContaining({ key: "KEY_0", value: "first" }));
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(onNavigate).toHaveBeenLastCalledWith(0));
    expect(api.setText).toHaveBeenCalledTimes(1); // 変更のない行は書かない
  });

  it("検証結果の修正案を適用できる", async () => {
    const info = makeInfo();
    const { api } = mockApi(info);
    const row = makeRow(0);
    row.cells["text@en"] = { value: "Hi {name", issues: [{ validatorId: "v", code: "c", message: "括弧が閉じていません", severity: "error", range: { start: 3, end: 8 }, fix: { label: "括弧を補う", value: "Hi {name}" } }] };
    renderWithStudio(
      <EditModal resourceId="r" rowIndex={0} total={1} language={info.languages[1]!} textColumn={info.columns[2]!} loadRow={async () => row} onClose={vi.fn()} onNavigate={vi.fn()} onCellsChanged={vi.fn()} onSetCell={vi.fn(async () => undefined)} onOpenReview={vi.fn()} />,
      api,
      info,
    );
    const textarea = (await screen.findByRole("textbox", { name: /本文/ })) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("Hi {name"));
    fireEvent.click(screen.getByRole("button", { name: /括弧が閉じていません/ }));
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 8]);
    fireEvent.click(screen.getByRole("button", { name: "括弧を補う" }));
    expect(textarea.value).toBe("Hi {name}");
  });

  it("入力中の本文を validateText で確かめ（止まってから）、古い応答は捨てる", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    const { api, textarea } = await open(0, "en", (a) => {
      a.validateText
        .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r as (v: unknown) => void)) as never)
        .mockImplementationOnce(async () => [{ validatorId: "v", code: "len", message: "長すぎます（新しい結果）", severity: "warning" as const, range: { start: 0, end: 2 } }]);
    });
    fireEvent.change(textarea, { target: { value: "a" } });
    expect(api.validateText).not.toHaveBeenCalled(); // まだ止まっていない
    await waitFor(() => expect(api.validateText).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_0", language: "en", value: "a" }));
    fireEvent.change(textarea, { target: { value: "ab" } });
    await waitFor(() => expect(api.validateText).toHaveBeenCalledTimes(2));
    await screen.findByText("長すぎます（新しい結果）");
    // 遅れて届いた古い応答は表示しない
    resolveFirst([{ validatorId: "v", code: "old", message: "古い結果", severity: "error" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("古い結果")).toBeNull();
    expect(api.setText).not.toHaveBeenCalled(); // 確かめるだけで保存しない
    fireEvent.click(screen.getByRole("button", { name: /長すぎます/ }));
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([0, 2]);
  });

  it("「変更を取り消す」でこのセルのドラフトを保存済みの値に戻す", async () => {
    const { api, onCellsChanged, textarea } = await open(2, "en");
    fireEvent.click(screen.getByRole("button", { name: "変更を取り消す" }));
    await waitFor(() => expect(api.setText).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_2", language: "en", value: "Saved 2" }));
    await waitFor(() => expect(textarea.value).toBe("Saved 2"));
    expect(onCellsChanged).toHaveBeenCalled();
  });

  it("文字・数値の列は Enter で保存し、Esc では閉じずに元へ戻す", async () => {
    const info = makeInfo({
      columns: [...makeInfo().columns, { id: "memoL", kind: "meta", scope: "language", label: "言語メモ", type: "string" }],
    });
    const { api } = mockApi(info);
    const onSetCell = vi.fn(async () => ({ value: "x" }));
    const onClose = vi.fn();
    renderWithStudio(
      <EditModal resourceId="r" rowIndex={0} total={1} language={info.languages[1]!} textColumn={info.columns[2]!} loadRow={async () => makeRow(0)} onClose={onClose} onNavigate={vi.fn()} onCellsChanged={vi.fn()} onSetCell={onSetCell} onOpenReview={vi.fn()} />,
      api,
      info,
    );
    const input = (await screen.findByRole("textbox", { name: "言語メモ" })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "メモ" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "メモ" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSetCell).toHaveBeenCalledWith(expect.objectContaining({ key: "KEY_0" }), expect.objectContaining({ cellId: "memoL@en" }), "メモ"));
  });

  it("ほかの人が先に確定していたら（conflict）相手の値と名前を見せ、上書きか相手の変更かを選べる", async () => {
    const { api, onClose, textarea } = await open(0, "en", (a) => {
      a.setText.mockRejectedValueOnce(new RpcError("setText", "conflict", "ほかの人が先に変更しました", { value: "Their text", by: "alice" }));
    });
    fireEvent.change(textarea, { target: { value: "Mine" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "ほかの人が先にこのセルを変更しました" });
    expect(within(dialog).getByText("Their text")).toBeTruthy();
    expect(within(dialog).getByText("aliceさん")).toBeTruthy();
    expect(within(dialog).getByText("Mine")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(api.setText).toHaveBeenLastCalledWith(expect.objectContaining({ value: "Mine", baseValue: "English 0" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "自分の変更で上書きする" }));
    // いまの値（相手の値）を基にして確定し直す
    await waitFor(() => expect(api.setText).toHaveBeenLastCalledWith({ resourceId: "res.csv", key: "KEY_0", language: "en", value: "Mine", baseValue: "Their text" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("「相手の変更を使う」でいまの値を読み直し、自分の編集は捨てる", async () => {
    let calls = 0;
    const info = makeInfo();
    const { api } = mockApi(info);
    api.setText.mockRejectedValueOnce(new RpcError("setText", "conflict", "競合", { value: "Their text", by: "alice" }));
    renderWithStudio(
      <EditModal
        resourceId="r"
        rowIndex={0}
        total={1}
        language={info.languages[1]!}
        textColumn={info.columns[2]!}
        loadRow={async () => {
          calls++;
          const row = makeRow(0);
          if (calls > 1) row.cells["text@en"] = { value: "Their text", draft: true, draftBy: "alice", saved: "English 0" };
          return row;
        }}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onCellsChanged={vi.fn()}
        onSetCell={vi.fn(async () => undefined)}
        onOpenReview={vi.fn()}
      />,
      api,
      info,
    );
    const textarea = (await screen.findByRole("textbox", { name: /本文/ })) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe("English 0"));
    fireEvent.change(textarea, { target: { value: "Mine" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "ほかの人が先にこのセルを変更しました" });
    fireEvent.click(within(dialog).getByRole("button", { name: "相手の変更を使う" }));
    await waitFor(() => expect(textarea.value).toBe("Their text"));
    // ほかの人が編集中であることを見出しに出す（いまの利用者は tester）
    expect(screen.getByText("aliceさんが編集中")).toBeTruthy();
  });

  it("検証結果の範囲に、重さの色の下線を引く（いまの本文と同じ内容を検証したときだけ）", async () => {
    const info = makeInfo();
    const { api } = mockApi(info);
    const row = makeRow(0);
    row.cells["text@en"] = {
      value: "Hello {name and ①",
      issues: [
        { validatorId: "v", code: "brace", message: "括弧", severity: "error", range: { start: 6, end: 11 } },
        { validatorId: "v", code: "w", message: "警告", severity: "warning", range: { start: 16, end: 17 } },
      ],
    };
    const { container } = renderWithStudio(
      <EditModal resourceId="r" rowIndex={0} total={1} language={info.languages[1]!} textColumn={info.columns[2]!} loadRow={async () => row} onClose={vi.fn()} onNavigate={vi.fn()} onCellsChanged={vi.fn()} onSetCell={vi.fn(async () => undefined)} onOpenReview={vi.fn()} />,
      api,
      info,
    );
    const textarea = (await screen.findByRole("textbox", { name: /本文/ })) as HTMLTextAreaElement;
    await waitFor(() => expect(document.querySelectorAll(".edit-overlay mark").length).toBe(2));
    const marks = [...document.querySelectorAll<HTMLElement>(".edit-overlay mark")];
    expect(marks.map((m) => [m.textContent, m.dataset["severity"]])).toEqual([
      ["{name", "error"],
      ["①", "warning"],
    ]);
    expect(document.querySelector(".edit-overlay")!.textContent).toBe("Hello {name and ①\n");
    // 入力して内容が変わったら（検証の結果が届くまで）下線は出さない。スクロールは重ねた層に合わせる
    fireEvent.change(textarea, { target: { value: "Hello {name and ①!" } });
    expect(document.querySelectorAll(".edit-overlay mark").length).toBe(0);
    textarea.scrollTop = 40;
    fireEvent.scroll(textarea);
    expect((document.querySelector(".edit-overlay") as HTMLElement).scrollTop).toBe(40);
    // IME の変換中も出さない
    fireEvent.compositionStart(textarea);
    expect(document.querySelectorAll(".edit-overlay mark").length).toBe(0);
    void container;
  });
});

describe("issueSegments", () => {
  it("範囲で分け、重なったところは重いほうにする", () => {
    const segs = issueSegments("abcdef", [
      { validatorId: "v", code: "a", message: "", severity: "warning", range: { start: 1, end: 4 } },
      { validatorId: "v", code: "b", message: "", severity: "error", range: { start: 3, end: 5 } },
      { validatorId: "v", code: "c", message: "", severity: "info", range: { start: 10, end: 12 } },
    ]);
    expect(segs).toEqual([{ text: "a" }, { text: "bc", severity: "warning" }, { text: "de", severity: "error" }, { text: "f" }]);
  });
});
