import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProjectInfo } from "@loc-studio/server";
import { ToastArea, ToastProvider } from "@/components/context";
import { Studio } from "@/components/Studio";
import { RpcError } from "@/lib/client/api";
import { makeInfo, mockApi } from "@/test/fixtures";

/* 役割ごとに、使えない操作が理由つきで無効になること。 */

type Perms = ProjectInfo["permissions"];
const roles: Record<string, Perms> = {
  viewer: { role: "viewer", can: { edit: false, review: false, run: false, structure: false, manage: false } },
  translator: { role: "translator", can: { edit: true, review: false, run: true, structure: false, manage: false }, languages: ["en"] },
  reviewer: { role: "reviewer", can: { edit: false, review: true, run: true, structure: false, manage: false } },
  manager: { role: "manager", can: { edit: true, review: true, run: true, structure: true, manage: true } },
};

async function renderAs(perms: Perms, prepare?: (api: ReturnType<typeof mockApi>["api"]) => void, over: Partial<ProjectInfo> = {}) {
  const info = makeInfo({ permissions: perms, ...over });
  const { api } = mockApi(info);
  api.tree.mockResolvedValue([{ id: "res", name: "res.csv", kind: "resource", resource: { id: "res.csv", path: "res.csv", name: "res.csv" }, unsaved: 1 }]);
  prepare?.(api);
  const web = { user: { name: "tester", displayName: "Tester", admin: false }, authMode: "password" as const, onLogout: () => {} };
  const utils = render(
    <ToastProvider>
      <Studio api={api} project="game" initialInfo={info} web={web} />
      <ToastArea />
    </ToastProvider>,
  );
  await waitFor(() => expect(utils.container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
  return { ...utils, api };
}

const cellEl = (c: HTMLElement, row: number, sel: string, nth = 0) => c.querySelectorAll<HTMLElement>(`[data-row="${row}"] ${sel}`)[nth]!;
const btn = (el: HTMLElement) => within(el).getByRole("button") as HTMLButtonElement;

describe("権限に応じた画面", () => {
  it("viewer: 編集・レビュー・実行・保存がすべて「読み取り専用です」で無効", async () => {
    const { container } = await renderAs(roles["viewer"]!);
    const status = btn(cellEl(container, 0, ".k-enum", 0));
    expect(status.disabled).toBe(true);
    expect(status.title).toBe("読み取り専用です");
    expect(btn(cellEl(container, 0, ".k-review", 0)).disabled).toBe(true);
    expect((within(cellEl(container, 0, ".k-generated")).getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect((within(cellEl(container, 0, ".k-actions")).getByRole("button", { name: "チケット" }) as HTMLButtonElement).disabled).toBe(true);
    const save = screen.getByRole("button", { name: /^保存/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.title).toBe("読み取り専用です");
    expect((screen.getByRole("button", { name: /すべて保存/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(cellEl(container, 0, ".k-string").title).toBe("読み取り専用です");
    // 本文は見るだけ（編集欄は読み取り専用、確定できない）
    fireEvent.doubleClick(cellEl(container, 0, ".k-text", 1));
    const dialog = await screen.findByRole("dialog", { name: "本文の編集" });
    const ta = within(dialog).getByRole("textbox", { name: /本文/ }) as HTMLTextAreaElement;
    expect(ta.readOnly).toBe(true);
    expect(within(dialog).getAllByText("読み取り専用です").length).toBeGreaterThan(0);
    expect((within(dialog).getByRole("button", { name: /^確定 / }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("閲覧")).toBeTruthy(); // 上のバーの役割
  });

  it("translator（en だけ）: 担当外の言語は「この言語は担当外です」、担当の言語は編集できる。レビューはできない", async () => {
    const { container } = await renderAs(roles["translator"]!);
    const ja = btn(cellEl(container, 0, ".k-enum", 0));
    expect(ja.disabled).toBe(true);
    expect(ja.title).toBe("この言語は担当外です");
    expect(btn(cellEl(container, 0, ".k-enum", 1)).disabled).toBe(false);
    expect(btn(cellEl(container, 0, ".k-review", 1)).title).toBe("読み取り専用です");
    expect(cellEl(container, 0, ".k-text", 0).title).toBe("この言語は担当外です");
    expect(cellEl(container, 0, ".k-string").title).toBe(""); // 共通の列は言語の制限を受けない
    expect((within(cellEl(container, 0, ".k-actions")).getByRole("button", { name: "チケット" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /^保存/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.doubleClick(cellEl(container, 0, ".k-text", 0));
    const dialog = await screen.findByRole("dialog", { name: "本文の編集" });
    expect((within(dialog).getByRole("textbox", { name: /本文/ }) as HTMLTextAreaElement).readOnly).toBe(true);
    expect(within(dialog).getAllByText("この言語は担当外です").length).toBeGreaterThan(0);
  });

  it("reviewer: レビューはでき、編集はできない", async () => {
    const { container } = await renderAs(roles["reviewer"]!);
    expect(btn(cellEl(container, 0, ".k-review", 1)).disabled).toBe(false);
    expect(btn(cellEl(container, 0, ".k-enum", 1)).disabled).toBe(true);
    expect((within(cellEl(container, 0, ".k-generated")).getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("manager: すべて使える", async () => {
    const { container } = await renderAs(roles["manager"]!);
    expect(btn(cellEl(container, 0, ".k-enum", 0)).disabled).toBe(false);
    expect(btn(cellEl(container, 0, ".k-review", 0)).disabled).toBe(false);
  });

  it("設定の役割: 列・アクション・生成の絞り込みに合わない操作だけが、理由つきで無効になる", async () => {
    const lqa: Perms = {
      role: "lqa",
      roleLabel: "LQA",
      can: { edit: true, review: true, run: true, structure: false, manage: false },
      editColumns: ["status"],
      reviewColumns: [],
      actions: [],
      generators: ["back"],
    };
    const { container } = await renderAs(lqa);
    const reason = "この列は、あなたの役割では変更できません";
    // editColumns にある列は変えられ、ない列（本文、メモ）は変えられない
    expect(btn(cellEl(container, 0, ".k-enum", 0)).disabled).toBe(false);
    expect(cellEl(container, 0, ".k-text", 0).title).toBe(reason);
    expect(cellEl(container, 0, ".k-string").title).toBe(reason);
    // reviewColumns が空なら、review の権限があってもレビュー列は選べない
    const review = btn(cellEl(container, 0, ".k-review", 0));
    expect(review.disabled).toBe(true);
    expect(review.title).toBe(reason);
    // actions が空ならアクションは実行できず、generators にある列は生成できる
    const ticket = within(cellEl(container, 0, ".k-actions")).getByRole("button", { name: "チケット" }) as HTMLButtonElement;
    expect(ticket.disabled).toBe(true);
    expect(ticket.title).toBe("このアクションは、あなたの役割では実行できません");
    expect((within(cellEl(container, 0, ".k-generated")).getByRole("button") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("LQA")).toBeTruthy(); // 上のバーには役割の表示名
    fireEvent.doubleClick(cellEl(container, 0, ".k-text", 1));
    const dialog = await screen.findByRole("dialog", { name: "本文の編集" });
    expect((within(dialog).getByRole("textbox", { name: /本文/ }) as HTMLTextAreaElement).readOnly).toBe(true);
  });

  describe("選択肢の遷移の制限（from / roles）", () => {
    // 状態: 未着手 → 作業中 → 完了。完了にできるのは作業中からだけで、役割 reviewer だけ。
    const columns = makeInfo().columns.map((c) =>
      c.id === "status"
        ? {
            ...c,
            type: {
              default: "todo",
              enum: [
                { value: "todo", label: "未着手" },
                { value: "wip", label: "作業中" },
                { value: "done", label: "完了", complete: true, from: ["wip"], roles: ["reviewer"] },
              ],
            },
          }
        : c,
    );
    const openStatus = async (container: HTMLElement) => {
      fireEvent.click(btn(cellEl(container, 0, ".k-enum", 0))); // KEY_0 の日本語の状態（いまは未着手）
      return within(await screen.findByRole("listbox"));
    };

    it("いまの値から変えられない選択肢は、理由つきで選べない。選べる選択肢は保存される", async () => {
      const { container, api } = await renderAs({ ...roles["manager"]!, role: "reviewer" }, undefined, { columns });
      const list = await openStatus(container);
      const done = list.getByRole("option", { name: /完了/ });
      expect(done.getAttribute("aria-disabled")).toBe("true");
      expect(done.title).toBe("「完了」には、作業中 からだけ変えられます");
      fireEvent.click(done);
      expect(api.setCell).not.toHaveBeenCalled();
      expect(list.getByRole("option", { name: /作業中/ }).getAttribute("aria-disabled")).toBe("false");
      fireEvent.click(list.getByRole("option", { name: /作業中/ }));
      await waitFor(() => expect(api.setCell).toHaveBeenCalledWith(expect.objectContaining({ cellId: "status@ja", value: "wip" })));
    });

    it("roles にない役割は選べない。制限のない利用者（ローカルモード、管理者）には roles は効かず、from だけが効く", async () => {
      // 英語の状態はフィクスチャで「完了」なので、いまの値そのものは選べる扱い。日本語（未着手）で確かめる。
      const translator = await renderAs({ ...roles["manager"]!, role: "translator" }, undefined, { columns });
      const t = (await openStatus(translator.container)).getByRole("option", { name: /完了/ });
      expect(t.title).toBe("「完了」にできるのは、役割が reviewer の利用者だけです");
      translator.unmount();
      const local = await renderAs({ ...roles["manager"]!, unrestricted: true }, undefined, { columns });
      const l = (await openStatus(local.container)).getByRole("option", { name: /完了/ });
      expect(l.title).toBe("「完了」には、作業中 からだけ変えられます");
    });
  });

  it("サーバーが forbidden を返したら、その文言で通知する", async () => {
    const { container, api } = await renderAs(roles["manager"]!, (a) => {
      a.setCell.mockRejectedValueOnce(new RpcError("setCell", "forbidden", "言語「ja」のセルは編集できません（割り当てられた言語: en）。"));
    });
    fireEvent.click(btn(cellEl(container, 0, ".k-enum", 0)));
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("完了"));
    await waitFor(() => expect(api.setCell).toHaveBeenCalled());
    expect(await screen.findByText(/言語「ja」のセルは編集できません/)).toBeTruthy();
  });

  it("ほかの人の未保存の編集には「○○さんが編集中」を出す", async () => {
    const { container } = await renderAs(roles["manager"]!, (a) => {
      const orig = a.rows.getMockImplementation()!;
      a.rows.mockImplementation(async (req) => {
        const res = await orig(req);
        const rows = res.rows.map((r) => (r.key === "KEY_2" ? { ...r, cells: { ...r.cells, "text@en": { ...r.cells["text@en"]!, draftBy: "alice" } } } : r));
        return { ...res, rows };
      });
    });
    const c = cellEl(container, 2, ".k-text", 1);
    expect(c.title).toBe("aliceさんが編集中");
    expect(within(c).getByLabelText("aliceさんが編集中")).toBeTruthy();
    // 自分の編集なら名前は出さない
    expect(cellEl(container, 0, ".k-text", 1).title).toBe("");
  });
});
