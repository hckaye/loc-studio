import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { PluginSettingsInfo, ProjectInfo } from "@loc-studio/server";
import { SettingsDialog } from "@/components/SettingsDialog";
import { RpcError } from "@/lib/client/api";
import { makeInfo, mockApi } from "@/test/fixtures";
import { renderWithStudio } from "@/test/render";

/*
 * 設定の画面の「プラグインの設定」。プラグインが宣言した項目から入力欄を作り、変えた項目だけをサービス層に送る。
 * サーバー（pluginSettings / setPluginSettings）は API のモックで、送った値と、返ってきた一覧からの表示を確かめる。
 */

const WIDTH: PluginSettingsInfo = {
  plugin: "mystudio-width",
  version: "1.0.0",
  layer: "project",
  file: "/tmp/test/loc-studio-plugin-settings/mystudio-width.json",
  items: [
    { key: "maxLength", label: "文字数の上限", description: "これより長い本文を指摘します。", type: "number", default: 5, value: 9, stored: true },
    { key: "severity", label: "重さ", type: "enum", options: [{ value: "warning", label: "警告" }, { value: "error", label: "エラー" }], default: "warning", value: "warning", stored: false },
    { key: "skipEmpty", label: "空の本文を飛ばす", type: "boolean", default: true, value: true, stored: false },
    { key: "note", label: "メモ", type: "string", stored: false },
  ],
  problems: [],
};

/** 複数行の項目（プロンプト）を持つプラグイン。 */
const PROMPTS: PluginSettingsInfo = {
  plugin: "mystudio-llm",
  layer: "builtin",
  file: "",
  items: [
    { key: "prompt", label: "プロンプト", description: "モデルに渡す指示です。", type: "string", multiline: true, default: "1 行目の指示\n2 行目の指示", value: "1 行目の指示\n2 行目の指示", stored: false },
    { key: "to", label: "訳し先", type: "string", default: "日本語", value: "日本語", stored: false },
  ],
  problems: [],
};

async function open(plugins: PluginSettingsInfo[], over: Partial<ProjectInfo> = {}) {
  const info = makeInfo(over);
  const { api } = mockApi(info);
  api.pluginSettings.mockResolvedValue(plugins);
  renderWithStudio(<SettingsDialog onClose={vi.fn()} onThemeChange={vi.fn()} />, api, info);
  fireEvent.click(await screen.findByRole("tab", { name: "プラグインの設定" }));
  return { api };
}

describe("プラグインの設定", () => {
  it("宣言した項目ごとに、種類に合った入力欄を出す。保存されている値は欄に入り、既定の値で動いている項目は、そう分かる", async () => {
    await open([WIDTH]);
    const form = within(await screen.findByRole("region", { name: "プラグイン mystudio-width の設定" }));
    expect(form.getByText("mystudio-width")).toBeTruthy();
    expect(form.getByText("v1.0.0", { exact: false })).toBeTruthy();
    expect(form.getByText("/tmp/test/loc-studio-plugin-settings/mystudio-width.json")).toBeTruthy();
    const max = form.getByLabelText("文字数の上限") as HTMLInputElement;
    expect([max.type, max.value, max.placeholder]).toEqual(["text", "9", "5"]);
    const severity = form.getByLabelText("重さ") as HTMLSelectElement;
    expect(severity.value).toBe("");
    expect([...severity.options].map((o) => o.textContent)).toEqual(["（既定の値を使う）", "警告", "エラー"]);
    expect((form.getByLabelText("空の本文を飛ばす") as HTMLInputElement).checked).toBe(true);
    expect((form.getByLabelText("メモ") as HTMLInputElement).value).toBe("");
    // 説明と、既定の値。
    expect(form.getByText("これより長い本文を指摘します。", { exact: false }).textContent).toBe("これより長い本文を指摘します。 既定の値: 5");
    expect(form.getByText("既定の値: 警告（いまは既定の値で動いています）")).toBeTruthy();
    expect(form.getByText("既定の値なし（いまは既定の値で動いています）")).toBeTruthy();
    // 変えるまで、保存は押せない。
    expect((form.getByRole("button", { name: "設定を保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("複数行の項目（multiline）は、複数行の入力欄で出す。既定の文章を入力欄に入れて、そこから書き換えられる", async () => {
    const { api } = await open([PROMPTS]);
    api.setPluginSettings.mockResolvedValue([PROMPTS]);
    const form = within(await screen.findByRole("region", { name: "プラグイン mystudio-llm の設定" }));
    const prompt = form.getByLabelText("プロンプト") as HTMLTextAreaElement;
    expect([prompt.tagName, prompt.value, prompt.placeholder]).toEqual(["TEXTAREA", "", "1 行目の指示\n2 行目の指示"]);
    // 1 行の項目は、これまでどおり 1 行の入力欄。
    expect((form.getByLabelText("訳し先") as HTMLInputElement).tagName).toBe("INPUT");
    // 既定の値は長いので、たたんで出す。
    expect(form.getByText("モデルに渡す指示です。", { exact: false }).textContent).toBe("モデルに渡す指示です。 既定の値は、下で見られます（いまは既定の値で動いています）");
    expect(form.getByText("既定の値を見る").closest("details")?.querySelector("pre")?.textContent).toBe("1 行目の指示\n2 行目の指示");

    fireEvent.click(form.getByRole("button", { name: "既定の文章を入力欄に入れる" }));
    expect(prompt.value).toBe("1 行目の指示\n2 行目の指示");
    // 入れた直後は、既定と同じなので、もう一度は押せない。
    expect((form.getByRole("button", { name: "既定の文章を入力欄に入れる" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(prompt, { target: { value: "1 行目の指示\n2 行目の指示\n敬語で訳す。" } });
    const save = form.getByRole("button", { name: "設定を保存" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    // 改行を含む値を、そのまま送る。
    await waitFor(() => expect(api.setPluginSettings).toHaveBeenCalledWith({ plugin: "mystudio-llm", values: { prompt: "1 行目の指示\n2 行目の指示\n敬語で訳す。" } }));
  });

  it("変えた項目だけを送る。空にした欄は null（既定の値に戻す）で送り、保存のあとは、返ってきた値から欄を作り直す", async () => {
    const { api } = await open([WIDTH]);
    api.setPluginSettings.mockResolvedValue([
      { ...WIDTH, items: [{ ...WIDTH.items[0]!, value: 5, stored: false }, { ...WIDTH.items[1]!, value: "error", stored: true }, { ...WIDTH.items[2]!, value: false, stored: true }, { ...WIDTH.items[3]!, value: "LQA 用", stored: true }] },
    ]);
    // 保存のあとで欄を作り直すので、そのつど探す。
    const form = () => within(screen.getByRole("region", { name: "プラグイン mystudio-width の設定" }));
    await screen.findByRole("region", { name: "プラグイン mystudio-width の設定" });
    fireEvent.change(form().getByLabelText("文字数の上限"), { target: { value: "" } });
    fireEvent.change(form().getByLabelText("重さ"), { target: { value: "error" } });
    fireEvent.click(form().getByLabelText("空の本文を飛ばす"));
    fireEvent.change(form().getByLabelText("メモ"), { target: { value: "LQA 用" } });
    fireEvent.click(form().getByRole("button", { name: "設定を保存" }));
    await waitFor(() => expect(api.setPluginSettings).toHaveBeenCalledWith({ plugin: "mystudio-width", values: { maxLength: null, severity: "error", skipEmpty: false, note: "LQA 用" } }));
    expect(await screen.findByText("プラグイン「mystudio-width」の設定を保存しました")).toBeTruthy();
    await waitFor(() => expect((form().getByLabelText("重さ") as HTMLSelectElement).value).toBe("error"));
    expect((form().getByLabelText("文字数の上限") as HTMLInputElement).value).toBe("");
    expect((form().getByLabelText("空の本文を飛ばす") as HTMLInputElement).checked).toBe(false);
    expect((form().getByRole("button", { name: "設定を保存" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("1 つだけ変えたら、その 1 つだけを送る。「変更を戻す」で、保存されている値に戻る", async () => {
    const { api } = await open([WIDTH]);
    const form = within(await screen.findByRole("region", { name: "プラグイン mystudio-width の設定" }));
    const max = form.getByLabelText("文字数の上限") as HTMLInputElement;
    fireEvent.change(max, { target: { value: "12" } });
    fireEvent.click(form.getByRole("button", { name: "変更を戻す" }));
    expect(max.value).toBe("9");
    expect(form.queryByRole("button", { name: "変更を戻す" })).toBeNull();
    fireEvent.change(max, { target: { value: "12.5" } });
    fireEvent.click(form.getByRole("button", { name: "設定を保存" }));
    await waitFor(() => expect(api.setPluginSettings).toHaveBeenCalledWith({ plugin: "mystudio-width", values: { maxLength: 12.5 } }));
  });

  it("保存してある文字と選択式の値を空に戻すと、null（既定の値に戻す）で送る", async () => {
    const stored: PluginSettingsInfo = {
      ...WIDTH,
      items: WIDTH.items.map((i) => (i.key === "severity" ? { ...i, value: "error", stored: true } : i.key === "note" ? { ...i, value: "LQA 用", stored: true } : i)),
    };
    const { api } = await open([stored]);
    const form = within(await screen.findByRole("region", { name: "プラグイン mystudio-width の設定" }));
    expect((form.getByLabelText("重さ") as HTMLSelectElement).value).toBe("error");
    expect((form.getByLabelText("メモ") as HTMLInputElement).value).toBe("LQA 用");
    fireEvent.change(form.getByLabelText("重さ"), { target: { value: "" } });
    fireEvent.change(form.getByLabelText("メモ"), { target: { value: "" } });
    fireEvent.click(form.getByRole("button", { name: "設定を保存" }));
    await waitFor(() => expect(api.setPluginSettings).toHaveBeenCalledWith({ plugin: "mystudio-width", values: { severity: null, note: null } }));
  });

  it("数値でない文字は、送らずに知らせる。サーバーが断ったら、理由を出して、入力を残す", async () => {
    const { api } = await open([WIDTH]);
    const form = within(await screen.findByRole("region", { name: "プラグイン mystudio-width の設定" }));
    const max = form.getByLabelText("文字数の上限") as HTMLInputElement;
    fireEvent.change(max, { target: { value: "多め" } });
    fireEvent.click(form.getByRole("button", { name: "設定を保存" }));
    expect(form.getByRole("alert").textContent).toBe("「文字数の上限」は、数値で入力してください。");
    expect(api.setPluginSettings).not.toHaveBeenCalled();

    api.setPluginSettings.mockRejectedValueOnce(new RpcError("setPluginSettings", "invalid", 'プラグイン "mystudio-width" の設定「文字数の上限」（maxLength）の値 -1 は使えません。'));
    fireEvent.change(max, { target: { value: "-1" } });
    fireEvent.click(form.getByRole("button", { name: "設定を保存" }));
    expect(await screen.findByText(/の値 -1 は使えません/)).toBeTruthy();
    expect(max.value).toBe("-1");
    await waitFor(() => expect((form.getByRole("button", { name: "設定を保存" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("設定ファイルの問題（使わなかった値）を、そのプラグインの欄の上に出す", async () => {
    const problem = 'プラグイン "mystudio-width" の設定「文字数の上限」（… の "maxLength"）は数値ではありません。 既定の値（5）で動かします。設定の画面の「プラグインの設定」で直せます。';
    await open([{ ...WIDTH, items: WIDTH.items.map((i) => (i.key === "maxLength" ? { ...i, value: 5, stored: false } : i)), problems: [problem] }]);
    const form = within(await screen.findByRole("region", { name: "プラグイン mystudio-width の設定" }));
    expect(form.getByRole("alert").textContent).toBe(problem);
  });

  it("manage の権限がない役割では、値は見られるが、変えられない（理由を出す）", async () => {
    const { api } = await open([WIDTH], { permissions: { role: "translator", can: { edit: true, review: false, run: false, structure: false, manage: false } } });
    const form = within(await screen.findByRole("region", { name: "プラグイン mystudio-width の設定" }));
    const max = form.getByLabelText("文字数の上限") as HTMLInputElement;
    expect([max.value, max.disabled, max.title]).toEqual(["9", true, "プロジェクトの管理者だけが変更できます"]);
    expect((form.getByLabelText("重さ") as HTMLSelectElement).disabled).toBe(true);
    expect((form.getByLabelText("空の本文を飛ばす") as HTMLInputElement).disabled).toBe(true);
    expect((form.getByRole("button", { name: "設定を保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/プロジェクトの管理者だけが変更できます。$/)).toBeTruthy();
    expect(api.setPluginSettings).not.toHaveBeenCalled();
  });

  it("設定を宣言しているプラグインがなければ、そう伝える。プラグインが複数あれば、それぞれの欄を出す", async () => {
    await open([]);
    expect(await screen.findByText(/設定を宣言しているプラグインはありません/)).toBeTruthy();
  });

  it("複数のプラグインは、それぞれの欄と保存のボタンを持つ（管理者でない人に場所が返らなければ、設定ファイルの場所は出さない）", async () => {
    const other: PluginSettingsInfo = { plugin: "tracker", layer: "app", file: "", items: [{ key: "project", label: "プロジェクトの番号", type: "string", stored: false }], problems: [] };
    const { api } = await open([WIDTH, other]);
    const tracker = within(await screen.findByRole("region", { name: "プラグイン tracker の設定" }));
    expect(tracker.getByText("アプリ")).toBeTruthy();
    expect(tracker.queryByText(/設定ファイル:/)).toBeNull();
    fireEvent.change(tracker.getByLabelText("プロジェクトの番号"), { target: { value: "LOC" } });
    fireEvent.click(tracker.getByRole("button", { name: "設定を保存" }));
    await waitFor(() => expect(api.setPluginSettings).toHaveBeenCalledWith({ plugin: "tracker", values: { project: "LOC" } }));
  });
});
