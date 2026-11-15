import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { LanguagePicker } from "@/components/LanguagePicker";
import type { LanguageDef } from "@/lib/client/model";

const LANGS: LanguageDef[] = [
  { id: "ja", label: "日本語" },
  ...["en", "fr", "de", "es", "it", "pt", "ru", "pl"].map((id) => ({ id, label: `欧州-${id}`, basedOn: "ja", group: "欧州" })),
  ...["zh-Hans", "zh-Hant", "ko", "th", "vi", "id", "ms"].map((id) => ({ id, label: `アジア-${id}`, basedOn: "ja", group: "アジア" })),
];

function setup() {
  const onApply = vi.fn();
  const onSaveSet = vi.fn();
  const onClose = vi.fn();
  render(
    <LanguagePicker
      languages={LANGS}
      projectSets={{ 東アジア: ["ja", "zh-Hans", "ko"] }}
      userSets={{ 自分用: ["ja", "fr"] }}
      visible={["ja", "en"]}
      pins={["ja"]}
      onApply={onApply}
      onSaveSet={onSaveSet}
      onDeleteSet={vi.fn()}
      onClose={onClose}
    />,
  );
  return { onApply, onSaveSet, onClose };
}

const checkbox = (label: string) => screen.getByRole("checkbox", { name: new RegExp(label) }) as HTMLInputElement;

describe("言語の選択パネル（16 言語）", () => {
  it("全言語を出し、グループごとにまとめる", () => {
    setup();
    expect(LANGS.length).toBe(16);
    expect(screen.getAllByRole("checkbox")).toHaveLength(16);
    expect(screen.getByRole("button", { name: /欧州/, expanded: true })).toBeTruthy();
    expect(screen.getByText("言語の表示（2 / 16）")).toBeTruthy();
  });

  it("検索で絞り込む（名前・ID・グループ）", () => {
    setup();
    fireEvent.change(screen.getByRole("searchbox", { name: "言語を検索" }), { target: { value: "zh" } });
    expect(screen.getAllByRole("checkbox").map((c) => (c as HTMLInputElement).closest("label")!.textContent)).toEqual([
      expect.stringContaining("zh-Hans"),
      expect.stringContaining("zh-Hant"),
    ]);
    fireEvent.change(screen.getByRole("searchbox", { name: "言語を検索" }), { target: { value: "アジア" } });
    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
  });

  it("グループを折りたためる", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: /アジア/, expanded: true }));
    expect(screen.getAllByRole("checkbox")).toHaveLength(9);
  });

  it("表示セットを選ぶとその言語だけにし、適用で返す", () => {
    const { onApply, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /東アジア/ }));
    expect(checkbox("zh-Hans").checked).toBe(true);
    expect(checkbox("欧州-en").checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onApply).toHaveBeenCalledWith(["ja", "zh-Hans", "ko"], ["ja"]);
    expect(onClose).toHaveBeenCalled();
  });

  it("ピンを付けた言語は表示もされ、ピンの順で返す", () => {
    const { onApply } = setup();
    const row = checkbox("アジア-ko").closest(".lp-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /左に固定/ }));
    expect(checkbox("アジア-ko").checked).toBe(true);
    // ja のピンを外す
    fireEvent.click(within(checkbox("^日本語").closest(".lp-row") as HTMLElement).getByRole("button", { name: /左に固定/ }));
    fireEvent.click(screen.getByRole("button", { name: "適用" }));
    expect(onApply).toHaveBeenCalledWith(["ja", "en", "ko"], ["ko"]);
  });

  it("いまの選択を名前を付けて保存できる", () => {
    const { onSaveSet } = setup();
    fireEvent.click(checkbox("欧州-de"));
    fireEvent.change(screen.getByRole("textbox", { name: "表示セットの名前" }), { target: { value: "ドイツ語チェック" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSaveSet).toHaveBeenCalledWith("ドイツ語チェック", ["ja", "en", "de"]);
  });

  it("キャンセルでは何も反映しない", () => {
    const { onApply, onClose } = setup();
    fireEvent.click(checkbox("欧州-fr"));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
