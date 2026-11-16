import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SettingsDialog } from "@/components/SettingsDialog";
import { makeInfo, mockApi } from "@/test/fixtures";
import { renderWithStudio } from "@/test/render";

/* 設定の画面での、プロジェクト設定の編集（言語、列、検証、CSV / TSV の列の対応）。保存する設定の形は、ここに書き下す。 */

const AVAILABLE = {
  columns: [
    { id: "builtin.key", kind: "key", scope: "entry" },
    { id: "builtin.text", kind: "text", scope: "language" },
    { id: "builtin.textStatus", kind: "meta", scope: "language", label: "テキスト" },
    { id: "builtin.reviewStatus", kind: "review", scope: "language", label: "レビュー" },
  ],
  validators: [
    { id: "builtin.whitespace", label: "空白" },
    { id: "builtin.untranslated", label: "未翻訳" },
    { id: "studio.width", label: "1 行の幅" },
  ],
};

const LANGUAGES = [
  { id: "ja", label: "日本語", pinned: true },
  { id: "en", label: "英語", basedOn: "ja", group: "欧米" },
];

async function setup(project: Record<string, unknown> = {}, opts: { fromCode?: string[]; infrastructure?: boolean } = {}) {
  const info = makeInfo();
  const { api } = mockApi(info);
  api.settings.mockResolvedValue({
    local: [],
    localFile: "/home/u/settings.json",
    project: { name: "TestGame", languages: LANGUAGES, ...project },
    projectFromCode: opts.fromCode ?? [],
    projectFile: "/tmp/test/loc-studio.project.json",
    available: AVAILABLE,
  } as never);
  renderWithStudio(<SettingsDialog onClose={vi.fn()} onThemeChange={vi.fn()} {...(opts.infrastructure === false ? { infrastructure: false } : {})} />, api, info);
  await screen.findByLabelText("プロジェクト名");
  return { api };
}

/** ボタンが有効になるのを待ってから押す（保存の途中は無効になっている）。 */
async function press(name: string): Promise<void> {
  await waitFor(() => expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name }));
}
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const lastPatch = (api: Awaited<ReturnType<typeof setup>>["api"]) => api.updateProjectSettings.mock.calls.at(-1)![0];

describe("言語の編集", () => {
  it("表示名を変え、言語を足し、並べ替えて保存すると、languages をまるごと書く（画面に欄のない項目は残す）", async () => {
    const { api } = await setup();
    expect(button("言語を保存").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("en の表示名"), { target: { value: "English" } });
    fireEvent.change(screen.getByLabelText("追加する言語の ID"), { target: { value: "ko" } });
    fireEvent.change(screen.getByLabelText("追加する言語の表示名"), { target: { value: "韓国語" } });
    await press("言語を追加");
    fireEvent.click(screen.getByLabelText("ko を表の固定側に置く"));
    await press("ko を上へ");
    await press("言語を保存");
    await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(lastPatch(api)).toEqual({
      patch: {
        languages: [
          { id: "ja", label: "日本語", pinned: true },
          { id: "ko", label: "韓国語", basedOn: "ja", pinned: true },
          { id: "en", label: "English", basedOn: "ja", group: "欧米" },
        ],
      },
    });
    expect(await screen.findByText("プロジェクト設定を保存しました")).toBeTruthy();
  });

  it("基にする言語を原文に変えると basedOn を消し、固定を外すと pinned を消す", async () => {
    const { api } = await setup();
    fireEvent.change(screen.getByLabelText("en の基にする言語"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("ja を表の固定側に置く"));
    await press("言語を保存");
    await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(lastPatch(api)).toEqual({
      patch: {
        languages: [
          { id: "ja", label: "日本語" },
          { id: "en", label: "英語", group: "欧米" },
        ],
      },
    });
  });

  it("誤りがある間は保存できず、理由を出す（使えない ID、基にしている言語の削除）", async () => {
    const { api } = await setup();
    fireEvent.change(screen.getByLabelText("追加する言語の ID"), { target: { value: "ja jp" } });
    await press("言語を追加");
    expect(screen.getByText(/言語の ID "ja jp" は使えません/)).toBeTruthy();
    expect(button("言語を保存").disabled).toBe(true);
    await press("ja jp を削除");
    await press("ja を削除");
    expect(screen.getByText('言語 "en" の基にする言語 "ja" がありません。基にする言語を選び直してください。')).toBeTruthy();
    expect(button("言語を保存").disabled).toBe(true);
    expect(api.updateProjectSettings).not.toHaveBeenCalled();
  });

  it("コードの設定にある項目は、変えられない（保存のボタンも、足す欄も出さない）", async () => {
    await setup({ columns: [{ use: "builtin.key", id: "key" }, { use: "builtin.text", id: "text" }], validators: ["builtin.whitespace"] }, { fromCode: ["languages", "columns", "validators", "formats"] });
    expect((screen.getByLabelText("en の表示名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("列 text の表示名") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("キーの列の見出し") as HTMLInputElement).disabled).toBe(true);
    for (const name of ["言語を保存", "言語を追加", "列を保存", "列を追加", "検証を保存", "検証を追加", "列の対応を保存"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(button("en を削除").disabled).toBe(true);
    expect(button("空白（1 番目）を削除").disabled).toBe(true);
  });
});

describe("列の編集", () => {
  it("設定に列がないときは既定の 2 列を見せ、列を足して保存すると columns を書く（レビュー列は本文の列を対象にする）", async () => {
    const { api } = await setup();
    expect(screen.getByText(/既定の 2 列（キーと本文）を使っています/)).toBeTruthy();
    expect(button("列を保存").disabled).toBe(true);
    // キーと本文の列は消せない。
    expect(button("列 key を削除").disabled).toBe(true);
    expect(button("列 text を削除").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("追加する列"), { target: { value: "builtin.textStatus" } });
    expect((screen.getByLabelText("追加する列の ID") as HTMLInputElement).value).toBe("textStatus");
    await press("列を追加");
    fireEvent.change(screen.getByLabelText("追加する列"), { target: { value: "builtin.reviewStatus" } });
    fireEvent.change(screen.getByLabelText("追加する列の ID"), { target: { value: "check" } });
    await press("列を追加");
    fireEvent.change(screen.getByLabelText("列 textStatus の表示名"), { target: { value: "進み具合" } });
    await press("列を保存");
    await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(lastPatch(api)).toEqual({
      patch: {
        columns: [
          { use: "builtin.key", id: "key" },
          { use: "builtin.text", id: "text" },
          { use: "builtin.textStatus", id: "textStatus", label: "進み具合" },
          { use: "builtin.reviewStatus", id: "check", of: "text" },
        ],
      },
    });
  });

  it("並べ替えと削除、「詳細」の JSON での書き換えを保存する。JSON の誤りは理由を出して、取り込まない", async () => {
    const columns = [
      { use: "builtin.key", id: "key" },
      { use: "builtin.text", id: "text" },
      { use: "builtin.textStatus", id: "textStatus" },
      { id: "note", kind: "meta", scope: "entry", label: "メモ", type: "string" },
    ];
    const { api } = await setup({ columns });
    await press("列 note を上へ");
    await press("列 textStatus の詳細");
    const detail = screen.getByLabelText("列 textStatus の設定（JSON）") as HTMLTextAreaElement;
    expect(JSON.parse(detail.value)).toEqual({ use: "builtin.textStatus", id: "textStatus" });
    fireEvent.change(detail, { target: { value: "{ broken" } });
    await press("この内容にする");
    expect(screen.getByText("JSON の形が正しくありません。")).toBeTruthy();
    const withEnum = { use: "builtin.textStatus", id: "textStatus", type: { enum: [{ value: "todo" }, { value: "done", complete: true }], default: "todo" } };
    fireEvent.change(detail, { target: { value: JSON.stringify(withEnum) } });
    await press("この内容にする");
    await press("列 note を削除");
    await press("列を保存");
    await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(lastPatch(api)).toEqual({ patch: { columns: [{ use: "builtin.key", id: "key" }, { use: "builtin.text", id: "text" }, withEnum] } });
  });

  it("表示名を空にすると、設定から label を消す（登録した列の表示名に戻る）", async () => {
    const { api } = await setup({ columns: [{ use: "builtin.key", id: "key" }, { use: "builtin.text", id: "text" }, { use: "builtin.textStatus", id: "textStatus", label: "進み具合" }] });
    const label = screen.getByLabelText("列 textStatus の表示名") as HTMLInputElement;
    expect(label.value).toBe("進み具合");
    expect(label.placeholder).toBe("テキスト");
    fireEvent.change(label, { target: { value: "" } });
    await press("列を保存");
    await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(lastPatch(api)).toEqual({ patch: { columns: [{ use: "builtin.key", id: "key" }, { use: "builtin.text", id: "text" }, { use: "builtin.textStatus", id: "textStatus" }] } });
  });

  it("ID が重なる列を足すと、理由を出して保存できない", async () => {
    await setup();
    fireEvent.change(screen.getByLabelText("追加する列"), { target: { value: "builtin.textStatus" } });
    fireEvent.change(screen.getByLabelText("追加する列の ID"), { target: { value: "text" } });
    await press("列を追加");
    expect(screen.getByText('列の ID "text" が重複しています。')).toBeTruthy();
    expect(button("列を保存").disabled).toBe(true);
  });
});

describe("検証の編集", () => {
  it("検証を足し、重さを変え、消して保存すると validators を書く（同じ検証が 2 つあっても、選んだほうだけを変える）", async () => {
    const validators = ["builtin.whitespace", { use: "studio.width", options: { max: 18 }, languages: ["ja"] }, { use: "studio.width", options: { max: 40 }, languages: ["en"] }];
    const { api } = await setup({ validators });
    const rows = screen.getAllByRole("row").filter((r) => within(r).queryByText("studio.width"));
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("言語: ja / オプションあり")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("追加する検証"), { target: { value: "builtin.untranslated" } });
    await press("検証を追加");
    fireEvent.change(screen.getByLabelText("空白（1 番目）の重さ"), { target: { value: "info" } });
    fireEvent.change(screen.getByLabelText("1 行の幅（3 番目）の重さ"), { target: { value: "error" } });
    await press("1 行の幅（2 番目）を削除");
    await press("検証を保存");
    await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(lastPatch(api)).toEqual({
      patch: {
        validators: [{ use: "builtin.whitespace", severity: "info" }, { use: "studio.width", options: { max: 40 }, languages: ["en"], severity: "error" }, "builtin.untranslated"],
      },
    });
  });

  it("登録されていない検証は、その旨を出す。設定に検証がなければ「使っていません」", async () => {
    await setup({ validators: ["gone.validator"] });
    expect(screen.getByText("登録されていません")).toBeTruthy();
    expect(button("検証を保存").disabled).toBe(true);
    await press("gone.validator（1 番目）を削除");
    expect(screen.getByText("検証を使っていません。")).toBeTruthy();
    expect(button("検証を保存").disabled).toBe(false);
  });
});

describe("CSV / TSV の列の対応の編集", () => {
  it("設定に formats がないときは、対応を書くと、CSV と TSV の項目を足して保存する", async () => {
    const { api } = await setup();
    expect(button("列の対応を保存").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("キーの列の見出し"), { target: { value: "ID" } });
    fireEvent.change(screen.getByLabelText("日本語（ja）の本文の列の見出し"), { target: { value: "JP" } });
    fireEvent.change(screen.getByLabelText("ファイルの文字コード"), { target: { value: "shift_jis" } });
    await press("列の対応を保存");
    await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalledTimes(1));
    const options = { key: "ID", text: { ja: "JP" }, encoding: "shift_jis" };
    expect(lastPatch(api)).toEqual({ patch: { formats: [{ use: "builtin.csv", match: "**/*.csv", options }, { use: "builtin.tsv", match: "**/*.tsv", options }] } });
  });

  it("すでにある formats では、対応だけを書き換え、ほかのオプションは残す。同じ見出しを 2 回使うと保存できない", async () => {
    const formats = [{ use: "builtin.csv", match: "**/*.csv", options: { key: "ID", text: { ja: "JP", en: "EN" }, columns: { maxLength: "MaxLen" } } }];
    const { api } = await setup({ formats });
    expect((screen.getByLabelText("キーの列の見出し") as HTMLInputElement).value).toBe("ID");
    const en = screen.getByLabelText("英語（en）の本文の列の見出し") as HTMLInputElement;
    expect(en.value).toBe("EN");
    fireEvent.change(en, { target: { value: "JP" } });
    expect(screen.getByText('列「JP」を、言語 "ja" の本文と言語 "en" の本文の両方に使っています。別の列にしてください。')).toBeTruthy();
    expect(button("列の対応を保存").disabled).toBe(true);
    fireEvent.change(en, { target: { value: "English" } });
    await press("列の対応を保存");
    await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalledTimes(1));
    expect(lastPatch(api)).toEqual({
      patch: { formats: [{ use: "builtin.csv", match: "**/*.csv", options: { columns: { maxLength: "MaxLen" }, key: "ID", text: { ja: "JP", en: "English" } } }] },
    });
  });

  it("まとめて変えられない書き方では、欄を出さずに理由を出す。基盤の設定を見られない利用者には、欄そのものを出さない", async () => {
    await setup({ formats: [{ use: "builtin.csv", options: { key: "ID" } }, { use: "builtin.tsv", options: { key: "Key" } }] });
    expect(screen.getByText(/フォーマットごとに違う列の対応が書かれています/)).toBeTruthy();
    expect(screen.queryByLabelText("キーの列の見出し")).toBeNull();
  });

  it("基盤の設定を見られない利用者（Web モードの管理者でない人）には、列の対応を出さない（言語、列、検証は変えられる）", async () => {
    await setup({}, { infrastructure: false });
    expect(screen.queryByLabelText("キーの列の見出し")).toBeNull();
    expect(screen.queryByText("CSV / TSV の列の対応")).toBeNull();
    expect(button("言語を保存")).toBeTruthy();
    expect(button("列を保存")).toBeTruthy();
    expect(button("検証を保存")).toBeTruthy();
  });
});

describe("権限", () => {
  it("プロジェクトを管理できない人には、編集の操作を出さない", async () => {
    const info = makeInfo({ permissions: { role: "translator", can: { edit: true, review: false, run: false, structure: false, manage: false } } });
    const { api } = mockApi(info);
    api.settings.mockResolvedValue({ local: [], localFile: "", project: { name: "TestGame", languages: LANGUAGES }, projectFromCode: [], projectFile: "", available: AVAILABLE } as never);
    renderWithStudio(<SettingsDialog onClose={vi.fn()} onThemeChange={vi.fn()} infrastructure={false} />, api, info);
    await screen.findByLabelText("プロジェクト名");
    expect(screen.getByText("プロジェクトの管理者だけが変更できます")).toBeTruthy();
    for (const name of ["言語を保存", "言語を追加", "列を保存", "列を追加", "検証を保存", "検証を追加"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect((screen.getByLabelText("ja の表示名") as HTMLInputElement).disabled).toBe(true);
  });
});
