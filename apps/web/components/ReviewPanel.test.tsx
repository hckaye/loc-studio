import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ReviewPanel } from "@/components/ReviewPanel";
import { gridKind } from "@/lib/client/model";
import { makeInfo, mockApi } from "@/test/fixtures";
import { renderWithStudio } from "@/test/render";

function setup(over: Parameters<typeof makeInfo>[0] = {}, posts: { verdict: string }[] = []) {
  const info = makeInfo(over);
  const { api } = mockApi(info);
  api.reviews.mockResolvedValue(
    posts.map((p, i) => ({
      id: `old${i}`,
      cell: { entryKey: "KEY_0", resourceId: "res.csv", columnId: "review", language: "en" },
      columnId: "review",
      verdict: p.verdict,
      comment: "",
      userName: "someone",
      createdAt: "2025-12-31T00:00:00Z",
      stale: false,
    })),
  );
  api.postReview.mockImplementation(async (p: { verdict: string; comment: string }) => ({
    id: "r1",
    cell: { entryKey: "KEY_0", resourceId: "res.csv", columnId: "review", language: "en" },
    columnId: "review",
    verdict: p.verdict,
    comment: p.comment,
    userName: "tester",
    createdAt: "2026-01-01T00:00:00Z",
    stale: false,
  }));
  const col = info.columns.find((c) => c.kind === "review")!;
  const onPosted = vi.fn();
  renderWithStudio(
    <ReviewPanel resourceId="res.csv" rowKey="KEY_0" gc={{ cellId: "review@en", col, kind: gridKind(col), language: "en", groupId: "lang:en", width: 100 }} onClose={vi.fn()} onPosted={onPosted} />,
    api,
    info,
  );
  return { api, onPosted };
}

describe("レビューの投稿パネル", () => {
  it("requireComment の判定はコメントが空だと投稿できない", async () => {
    const { api, onPosted } = setup();
    fireEvent.click(await screen.findByRole("radio", { name: /差し戻し/ }));
    const post = screen.getByRole("button", { name: "投稿" }) as HTMLButtonElement;
    expect(post.disabled).toBe(true);
    expect(screen.getByText(/コメントが必要です/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /コメント/ }), { target: { value: "   " } });
    expect(post.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /コメント/ }), { target: { value: "訳抜けがあります" } });
    expect(post.disabled).toBe(false);
    fireEvent.click(post);
    await waitFor(() => expect(api.postReview).toHaveBeenCalledWith({ resourceId: "res.csv", key: "KEY_0", cellId: "review@en", verdict: "back", comment: "訳抜けがあります" }));
    await waitFor(() => expect(onPosted).toHaveBeenCalledWith("KEY_0", "review@en", expect.objectContaining({ value: "back" })));
  });

  it("コメント不要の判定はコメントなしで投稿できる", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("radio", { name: /承認/ }));
    const post = screen.getByRole("button", { name: "投稿" }) as HTMLButtonElement;
    expect(post.disabled).toBe(false);
    fireEvent.click(post);
    await waitFor(() => expect(api.postReview).toHaveBeenCalledWith(expect.objectContaining({ verdict: "ok", comment: "" })));
  });

  describe("判定の遷移の制限（from）", () => {
    // 承認にできるのは、直前の判定が「差し戻し」のときだけ。
    const columns = makeInfo().columns.map((c) =>
      c.id === "review"
        ? { ...c, type: { default: "none", enum: [{ value: "none", label: "未レビュー" }, { value: "back", label: "差し戻し" }, { value: "ok", label: "承認", complete: true, from: ["back"] }] } }
        : c,
    );

    it("直前の判定から選べない判定は、理由つきで選べず、投稿もできない", async () => {
      const { api } = setup({ columns }, []);
      const ok = (await screen.findByRole("radio", { name: /承認/ })) as HTMLInputElement;
      await waitFor(() => expect(ok.disabled).toBe(true));
      expect(ok.closest("label")!.title).toBe("「承認」には、差し戻し からだけ変えられます");
      expect((screen.getByRole("radio", { name: /差し戻し/ }) as HTMLInputElement).disabled).toBe(false);
      fireEvent.click(ok);
      expect((screen.getByRole("button", { name: "投稿" }) as HTMLButtonElement).disabled).toBe(true);
      expect(api.postReview).not.toHaveBeenCalled();
    });

    it("直前の判定（いちばん新しい投稿）が from にあれば選べる", async () => {
      const { api } = setup({ columns }, [{ verdict: "back" }, { verdict: "none" }]);
      const ok = (await screen.findByRole("radio", { name: /承認/ })) as HTMLInputElement;
      await waitFor(() => expect(screen.getAllByText("someone").length).toBe(2)); // これまでの投稿を読み込み終えた
      expect(ok.disabled).toBe(false);
      fireEvent.click(ok);
      fireEvent.click(screen.getByRole("button", { name: "投稿" }));
      await waitFor(() => expect(api.postReview).toHaveBeenCalledWith(expect.objectContaining({ verdict: "ok" })));
    });
  });

  it("判定を選ぶまでは投稿できない", async () => {
    setup();
    await screen.findByRole("radio", { name: /承認/ });
    expect((screen.getByRole("button", { name: "投稿" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
