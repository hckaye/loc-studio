import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { ReviewPanel } from "@/components/ReviewPanel";
import { gridKind } from "@/lib/client/model";
import { makeInfo, mockApi } from "@/test/fixtures";
import { renderWithStudio } from "@/test/render";

function setup() {
  const info = makeInfo();
  const { api } = mockApi(info);
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

  it("判定を選ぶまでは投稿できない", async () => {
    setup();
    await screen.findByRole("radio", { name: /承認/ });
    expect((screen.getByRole("button", { name: "投稿" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
