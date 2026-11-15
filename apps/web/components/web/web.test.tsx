import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/components/App";
import { AdminScreen } from "@/components/web/AdminScreen";
import { ToastArea, ToastProvider } from "@/components/context";
import { makeInfo, mockApi } from "@/test/fixtures";

/* Web モードの画面（ログイン、プロジェクトの一覧、ログアウト、401、管理）。fetch を差し替えてサーバーのふりをする。 */

type Handler = (body: Record<string, unknown>) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const RESPONSE_DELAY_MS = 0;

/**
 * 操作の途中は、画面がボタンを無効にする。無効のボタンを押しても何も起きないので、
 * 前の操作が終わって有効になるのを待ってから押す。
 */
async function press(find: () => HTMLElement): Promise<void> {
  await waitFor(() => expect((find() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(find());
}

function installFetch(routes: Record<string, Handler>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const path = url.replace(/\?.*$/, "");
    const h = routes[path] ?? (path.startsWith("/api/rpc/") ? routes["/api/rpc/*"] : undefined);
    if (!h) return json(404, { error: { code: "not-found", message: `no route ${path}` } });
    const r = await h({ ...body, __path: path });
    // 本物の fetch と同じく、応答は呼び出しと同じタスクの中では返らない。
    // すぐ返すと、「前の操作が終わる前に次のボタンを押す」テストの誤りが、混んでいるときにしか表に出ない。
    await new Promise((resolve) => setTimeout(resolve, RESPONSE_DELAY_MS));
    return json(r.status ?? 200, r.body);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const user = { name: "tom", displayName: "Tom", admin: false, disabled: false, hasPassword: true, createdAt: "", updatedAt: "" };

function rpcRoutes(over: Partial<Record<string, unknown>> = {}) {
  const info = makeInfo({ permissions: { role: "translator", can: { edit: true, review: false, run: true, structure: false, manage: false }, languages: ["en"] } });
  const { api } = mockApi(info);
  let unauthorized = false;
  const handler: Handler = async (body) => {
    if (unauthorized) return { status: 401, body: { error: { code: "unauthorized", message: "ログインしてください。" } } };
    const method = String(body["__path"]).split("/").pop()!;
    if (method in over) return { body: { result: over[method] } };
    const fn = (api as unknown as Record<string, (p: unknown) => Promise<unknown>>)[method];
    return { body: { result: fn ? await fn(body["params"]) : null } };
  };
  return { handler, info, expire: () => (unauthorized = true) };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Web モード: ログイン", () => {
  it("ログインしていなければログインの画面。サーバーの文言をそのまま出し、成功したらプロジェクトの一覧", async () => {
    let loggedIn = false;
    const rpc = rpcRoutes();
    installFetch({
      "/api/session": () => ({ body: { mode: "web", recentProjects: [], desktop: false } }),
      "/api/auth/me": () =>
        loggedIn
          ? { body: { result: { mode: "web", user, admin: false, authMode: "password", projects: [{ id: "game", name: "TestGame", role: "translator", roleLabel: "翻訳", languages: ["en"] }, { id: "other", name: "Other", role: "lqa" }] } } }
          : { status: 401, body: { error: { code: "unauthorized", message: "ログインしてください。", data: { authMode: "password" } } } },
      "/api/auth/login": (b) => {
        if (b["password"] !== "right-password") return { status: 401, body: { error: { code: "unauthorized", message: "名前かパスワードが違います。" } } };
        loggedIn = true;
        return { body: { result: { user } } };
      },
      "/api/rpc/*": rpc.handler,
    });
    render(
      <ToastProvider>
        <App />
        <ToastArea />
      </ToastProvider>,
    );
    fireEvent.change(await screen.findByLabelText("ログイン名"), { target: { value: "tom" } });
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    expect((await screen.findByRole("alert")).textContent).toBe("名前かパスワードが違います。");
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "right-password" } });
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    // プロジェクトの一覧（役割つき）
    const game = await screen.findByRole("button", { name: /TestGame/ });
    expect(game.textContent).toContain("翻訳");
    expect(game.textContent).toContain("担当: en");
    // サーバーが表示名を返さない役割（プロジェクトをまだ開いていない、設定の役割）は ID のまま出す
    expect(screen.getByRole("button", { name: /Other/ }).textContent).toContain("lqa");
  });

  it("続けて失敗して待たされているときは、待つ時間を出してボタンを止める", async () => {
    installFetch({
      "/api/session": () => ({ body: { mode: "web", recentProjects: [], desktop: false } }),
      "/api/auth/me": () => ({ status: 401, body: { error: { code: "unauthorized", message: "ログインしてください。" } } }),
      "/api/auth/login": () => ({ status: 429, body: { error: { code: "throttled", message: "ログインの失敗が続いたため、しばらく待ってからやり直してください。", data: { retryAfterMs: 30000 } } } }),
    });
    render(
      <ToastProvider>
        <App />
      </ToastProvider>,
    );
    fireEvent.change(await screen.findByLabelText("ログイン名"), { target: { value: "tom" } });
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "whatever1" } });
    // 時計を、読むたびに必ず 1 ミリ秒進むものにする。待つ時間を、時計を 2 回読んで計算する実装だと、
    // サーバーの答え（30 秒）より長い「あと 31 秒」が出る。本物の時計では、たまにしか起きない。
    const realNow = Date.now.bind(Date);
    let ticks = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + ticks++);
    try {
      fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("ログインの失敗が続いたため、しばらく待ってからやり直してください。");
      const secs = Number(/あと (\d+) 秒/.exec(alert.textContent ?? "")?.[1]);
      expect(secs).toBeGreaterThan(20);
      expect(secs).toBeLessThanOrEqual(30);
    } finally {
      clock.mockRestore();
    }
    expect((screen.getByRole("button", { name: /秒後にやり直せます/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("プロジェクトを開き、認証が切れたら（401）ログインの画面に戻る。ログアウトもできる", async () => {
    const rpc = rpcRoutes();
    let loggedIn = true;
    const calls = installFetch({
      "/api/session": () => ({ body: { mode: "web", recentProjects: [], desktop: false } }),
      "/api/auth/me": () =>
        loggedIn
          ? { body: { result: { mode: "web", user, admin: false, authMode: "password", projects: [{ id: "game", name: "TestGame", role: "translator", languages: ["en"] }] } } }
          : { status: 401, body: { error: { code: "unauthorized", message: "ログインしてください。" } } },
      "/api/auth/login": () => {
        loggedIn = true;
        return { body: { result: { user } } };
      },
      "/api/auth/logout": () => {
        loggedIn = false;
        return { body: { result: null } };
      },
      "/api/rpc/*": rpc.handler,
    });
    const { container } = render(
      <ToastProvider>
        <App />
        <ToastArea />
      </ToastProvider>,
    );
    // プロジェクトが 1 つなら、そのまま開く
    await waitFor(() => expect(container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
    expect(calls.some((c) => c.url === "/api/rpc/info" && c.body["project"] === "game")).toBe(true);
    expect(screen.getByText(/翻訳（en）/)).toBeTruthy(); // 役割と担当の言語
    // 利用者のメニューからログアウト
    fireEvent.click(screen.getByRole("button", { name: /Tom/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "ログアウト" }));
    expect(await screen.findByText("ログアウトしました。")).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/auth/logout")).toBe(true);
    // ログインし直して開き、そのあとセッションが切れたら戻る
    fireEvent.change(screen.getByLabelText("ログイン名"), { target: { value: "tom" } });
    fireEvent.change(screen.getByLabelText("パスワード"), { target: { value: "right-password" } });
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    await waitFor(() => expect(container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
    rpc.expire();
    fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
    expect(await screen.findByLabelText("ログイン名")).toBeTruthy();
    expect(screen.getByText(/ログインし直してください/)).toBeTruthy();
  });

  it("Web モードでは任意のフォルダを開く画面、プラグインの確認、ユーザー名の設定を出さない", async () => {
    const rpc = rpcRoutes({});
    const info = { ...rpc.info, untrustedPlugins: 2 };
    installFetch({
      "/api/session": () => ({ body: { mode: "web", recentProjects: [], desktop: false } }),
      "/api/auth/me": () => ({ body: { result: { mode: "web", user, admin: false, authMode: "password", projects: [{ id: "game", name: "TestGame", role: "translator" }] } } }),
      "/api/rpc/info": () => ({ body: { result: info } }),
      "/api/rpc/settings": () => ({
        body: { result: { local: [{ key: "user.name", value: "tom", source: "local", locked: false }, { key: "ui.theme", value: "light", source: "app", locked: false }], localFile: "", project: { languages: info.languages }, projectFromCode: [], projectFile: "/p.json" } },
      }),
      "/api/rpc/*": rpc.handler,
    });
    const { container } = render(
      <ToastProvider>
        <App />
      </ToastProvider>,
    );
    await waitFor(() => expect(container.querySelector('[data-row="0"] .k-key')).not.toBeNull());
    expect(screen.queryByRole("dialog", { name: /プラグインを実行しますか/ })).toBeNull();
    expect(screen.queryByText(/プラグインを読み込んでいません/)).toBeNull();
    expect(screen.queryByLabelText(/プロジェクトのフォルダ/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "設定" }));
    fireEvent.click(await screen.findByRole("tab", { name: "個人設定" }));
    await screen.findByLabelText("テーマ");
    expect(screen.queryByLabelText("ユーザー名")).toBeNull();
  });
});

describe("管理の画面", () => {
  const users = [
    { ...user, name: "admin", displayName: "Admin", admin: true },
    { ...user, name: "tom", displayName: "Tom" },
  ];
  function setup() {
    const members = [{ projectId: "game", user: "tom", role: "translator", languages: ["en"] }];
    const info = makeInfo();
    const calls = installFetch({
      "/api/admin/listUsers": () => ({ body: { result: users } }),
      "/api/admin/createUser": (b) => ({ body: { result: { ...user, name: (b["input"] as { name: string }).name } } }),
      "/api/admin/updateUser": () => ({ body: { result: users[1] } }),
      "/api/admin/deleteUser": () => ({ body: { result: null } }),
      "/api/admin/setPassword": () => ({ body: { result: null } }),
      "/api/admin/projects": () => ({ body: { result: [{ id: "game", name: "TestGame" }] } }),
      "/api/admin/listMemberships": () => ({ body: { result: members } }),
      "/api/admin/setMembership": (b) => ({ body: { result: b } }),
      "/api/admin/removeMembership": () => ({ body: { result: null } }),
      "/api/rpc/info": () => ({ body: { result: info } }),
    });
    render(
      <ToastProvider>
        <AdminScreen me="admin" onClose={() => {}} />
        <ToastArea />
      </ToastProvider>,
    );
    return calls;
  }
  const bodyOf = (calls: { url: string; body: Record<string, unknown> }[], url: string) => calls.filter((c) => c.url === url).map((c) => c.body);

  it("利用者: 一覧、追加、無効化、パスワードの再設定、削除（確認つき）。自分の行は無効化・降格・削除できない", async () => {
    const calls = setup();
    const adminRow = (await screen.findByText("admin", { selector: "td" })).closest("tr")!;
    for (const name of ["無効にする", "管理者から外す", "削除"]) {
      const b = within(adminRow).getByRole("button", { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe("自分自身には使えません");
    }
    const tomRow = (): HTMLElement => screen.getByText("tom", { selector: "td" }).closest("tr")!;
    await press(() => within(tomRow()).getByRole("button", { name: "無効にする" }));
    await waitFor(() => expect(bodyOf(calls, "/api/admin/updateUser")).toEqual([{ name: "tom", patch: { disabled: true } }]));
    // 追加
    const form = screen.getByRole("form", { name: "利用者を追加" });
    fireEvent.change(within(form).getByLabelText("ログイン名"), { target: { value: "ann" } });
    fireEvent.change(within(form).getByLabelText(/初期パスワード/), { target: { value: "ann-pass-1234" } });
    await press(() => within(form).getByRole("button", { name: "追加" }));
    await waitFor(() => expect(bodyOf(calls, "/api/admin/createUser")).toEqual([{ input: { name: "ann", password: "ann-pass-1234", admin: false } }]));
    // パスワードの再設定
    await press(() => within(tomRow()).getByRole("button", { name: "パスワードを再設定" }));
    const pwDialog = await screen.findByRole("dialog", { name: "「tom」のパスワードを再設定" });
    fireEvent.change(within(pwDialog).getByLabelText(/新しいパスワード/), { target: { value: "new-pass-1234" } });
    await press(() => within(pwDialog).getByRole("button", { name: "再設定" }));
    await waitFor(() => expect(bodyOf(calls, "/api/admin/setPassword")).toEqual([{ name: "tom", password: "new-pass-1234" }]));
    // 削除は確認してから
    await press(() => within(tomRow()).getByRole("button", { name: "削除" }));
    const del = await screen.findByRole("dialog", { name: "利用者「tom」を削除しますか？" });
    expect(bodyOf(calls, "/api/admin/deleteUser")).toEqual([]);
    await press(() => within(del).getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(bodyOf(calls, "/api/admin/deleteUser")).toEqual([{ name: "tom" }]));
  });

  it("プロジェクトの権限: 役割の変更、担当の言語を言語の選択パネルで選ぶ、外す、割り当てる", async () => {
    const calls = setup();
    fireEvent.click(await screen.findByRole("tab", { name: "プロジェクトの権限" }));
    const role = (await screen.findByRole("combobox", { name: "tom の役割" })) as HTMLSelectElement;
    expect(role.value).toBe("translator");
    expect(screen.getByText("英語")).toBeTruthy(); // 担当の言語のラベル
    fireEvent.change(role, { target: { value: "reviewer" } });
    await waitFor(() => expect(bodyOf(calls, "/api/admin/setMembership")[0]).toEqual({ projectId: "game", user: "tom", role: "reviewer", languages: ["en"] }));
    // 言語の選択（同じ言語の選択パネル）
    await waitFor(() => expect((screen.getByRole("button", { name: "tom の担当の言語を選ぶ" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "tom の担当の言語を選ぶ" }));
    const picker = await screen.findByRole("dialog", { name: /tom の担当の言語/ });
    expect(within(picker).queryByRole("button", { name: /左に固定/ })).toBeNull();
    fireEvent.click(within(picker).getByRole("checkbox", { name: /^日本語/ }));
    fireEvent.click(within(picker).getByRole("button", { name: "適用" }));
    await waitFor(() => expect(bodyOf(calls, "/api/admin/setMembership").at(-1)).toEqual({ projectId: "game", user: "tom", role: "translator", languages: ["ja", "en"] }));
    await press(() => screen.getByRole("button", { name: "外す" }));
    await waitFor(() => expect(bodyOf(calls, "/api/admin/removeMembership")).toEqual([{ projectId: "game", user: "tom" }]));
    fireEvent.change(screen.getByRole("combobox", { name: "割り当てる利用者" }), { target: { value: "admin" } });
    fireEvent.change(screen.getByRole("combobox", { name: "割り当てる役割" }), { target: { value: "viewer" } });
    await press(() => screen.getByRole("button", { name: "割り当てる" }));
    await waitFor(() => expect(bodyOf(calls, "/api/admin/setMembership").at(-1)).toEqual({ projectId: "game", user: "admin", role: "viewer" }));
  });
});
