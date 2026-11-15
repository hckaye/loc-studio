import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { SettingsDialog } from "@/components/SettingsDialog";
import { makeInfo, mockApi } from "@/test/fixtures";
import { renderWithStudio } from "@/test/render";

function setup() {
  const info = makeInfo();
  const { api } = mockApi(info);
  api.settings.mockResolvedValue({
    local: [
      { key: "user.name", value: "tester", source: "local", locked: false },
      { key: "ui.theme", value: "dark", source: "enforce", locked: true },
      { key: "review.forwardOnPost", value: "ask", source: "app", locked: false },
      { key: "plugins.local.formats", value: "deny", source: "enforce", locked: true },
    ],
    localFile: "/home/u/.config/loc-studio/settings.json",
    project: { name: "TestGame", languages: info.languages, storage: { driver: "sqlite" } },
    projectFromCode: ["validators", "storage"],
    projectFile: "/tmp/test/loc-studio.project.json",
  } as never);
  const onThemeChange = vi.fn();
  renderWithStudio(<SettingsDialog onClose={vi.fn()} onThemeChange={onThemeChange} />, api, info);
  return { api, onThemeChange };
}

describe("設定", () => {
  it("ローカル設定: 固定された項目は変更できず、印が付く", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("tab", { name: "ローカル設定" }));
    const theme = (await screen.findByLabelText("テーマ")) as HTMLSelectElement;
    expect(theme.disabled).toBe(true);
    expect((screen.getByLabelText("plugins.local.formats") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText("プロジェクト設定で固定")).toHaveLength(2);
    expect((screen.getByLabelText("ユーザー名") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText("/home/u/.config/loc-studio/settings.json")).toBeTruthy();
    // ユーザー名を PC 名に戻す
    fireEvent.click(screen.getByRole("button", { name: "PC 名に戻す" }));
    await waitFor(() => expect(api.setLocalSetting).toHaveBeenCalledWith({ key: "user.name", value: null }));
  });

  it("プロジェクト設定: コードの設定にある項目は読み取り専用、ほかは updateProjectSettings で書く", async () => {
    const { api } = setup();
    const name = (await screen.findByLabelText("プロジェクト名")) as HTMLInputElement;
    expect(screen.getByText("/tmp/test/loc-studio.project.json")).toBeTruthy();
    expect((screen.getByLabelText(/^パス/) as HTMLInputElement).disabled).toBe(true); // storage はコードの設定
    expect(screen.getAllByText("コードの設定").length).toBeGreaterThanOrEqual(2);
    fireEvent.change(name, { target: { value: "NewName" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]!);
    await waitFor(() => expect(api.updateProjectSettings).toHaveBeenCalledWith({ patch: { name: "NewName" } }));
  });

  it("基盤の設定を見られない利用者（Web モードの管理者でない人）には、保存先とプラグインフォルダの欄を出さない", async () => {
    const info = makeInfo({ storage: { path: "", shared: false } });
    const { api } = mockApi(info);
    api.settings.mockResolvedValue({
      local: [],
      localFile: "",
      project: { name: "TestGame", languages: info.languages },
      projectFromCode: [],
      projectFile: "",
    } as never);
    renderWithStudio(<SettingsDialog onClose={vi.fn()} onThemeChange={vi.fn()} infrastructure={false} />, api, info);
    await screen.findByLabelText("プロジェクト名");
    expect(screen.queryByLabelText(/^パス/)).toBeNull();
    expect(screen.queryByLabelText("共有の方式")).toBeNull();
    expect(screen.queryByLabelText(/プロジェクトからの相対パス/)).toBeNull();
    expect(screen.getByText(/サーバーの管理者だけが見たり変えたりできます/)).toBeTruthy();
  });

  it("保存したら確認が必要になった（設定ファイルがアプリの外でも変わっていた）ときは、その旨を知らせる", async () => {
    const { api } = setup();
    const name = (await screen.findByLabelText("プロジェクト名")) as HTMLInputElement;
    api.updateProjectSettings.mockResolvedValueOnce(makeInfo({ restricted: true }));
    fireEvent.change(name, { target: { value: "NewName" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]!);
    expect(await screen.findByText(/内容の確認が必要です/)).toBeTruthy();
  });
});
