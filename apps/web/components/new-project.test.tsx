import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import App from "@/components/App";
import type { DesktopCommand } from "@/components/App";
import { ToastArea, ToastProvider } from "@/components/context";
import { folderName, NewProject } from "@/components/NewProject";
import { Studio } from "@/components/Studio";
import { makeInfo, mockApi } from "@/test/fixtures";

/*
 * 新しいプロジェクトを作る導線: 最初の画面のボタン、作成の画面の入力とサーバーへ送る内容、
 * 開けなかったフォルダからの案内、デスクトップ版のメニューからの操作。
 * サーバー（/api/session/*）は fetch のモックで、送った本文をそのまま確かめる。
 */

interface Call {
  url: string;
  body: Record<string, unknown>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** fetch のモック。応答はあとのタスクで返す（画面が途中の状態を挟むのを、本物と同じにする）。 */
function stubFetch(handler: (url: string, body: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    await new Promise((r) => setTimeout(r, 0));
    const res = await handler(url, body);
    return res instanceof Response ? res : json(res);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, of: (url: string) => calls.filter((c) => c.url === url) };
}

const EMPTY_FOLDER = { root: "/games/new-game", exists: false, resources: [], totalResources: 0 };

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.locStudio;
  window.history.replaceState(null, "", "/");
});

const pathInput = () => screen.getByLabelText(/プロジェクトを置くフォルダ/) as HTMLInputElement;
const nameInput = () => screen.getByLabelText("プロジェクトの名前") as HTMLInputElement;
const createButton = () => screen.getByRole("button", { name: "プロジェクトを作る" }) as HTMLButtonElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

/**
 * ボタンが有効になるのを待ってから押す。画面は、読み込みや確認の途中のボタンを無効にする。
 * 無効のボタンを押しても何も起きないので、待たずに押すと、応答が遅いときにだけ落ちるテストになる。
 */
async function press(name: string): Promise<void> {
  await waitFor(() => expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name }));
}

function renderNew(props: Partial<Parameters<typeof NewProject>[0]> = {}) {
  const handlers = { onCancel: vi.fn(), onCreated: vi.fn(), onOpenExisting: vi.fn() };
  render(<NewProject {...handlers} {...props} />);
  return handlers;
}

describe("folderName", () => {
  it("パスの最後の部分を返す（末尾の区切りとドライブだけのパスは名前にしない）", () => {
    expect(folderName("C:\\Games\\MyGame\\")).toBe("MyGame");
    expect(folderName("/home/me/loc/game")).toBe("game");
    expect(folderName("C:\\")).toBe("");
    expect(folderName("  ")).toBe("");
  });
});

describe("新しいプロジェクトを作る画面", () => {
  it("フォルダを入れると確かめに行き、名前をフォルダの名前で埋める。作ると、選んだ内容をそのまま送る", async () => {
    const created = { project: "/games/new-game", resource: "text/main.csv", warnings: [], recentProjects: ["/games/new-game"] };
    const { of } = stubFetch((url) => (url === "/api/session/inspect" ? { result: EMPTY_FOLDER } : { result: created }));
    const handlers = renderNew();
    // フォルダを入れるまでは作れない
    expect(createButton().disabled).toBe(true);
    type(pathInput(), "/games/new-game");
    expect(nameInput().value).toBe("new-game");
    await screen.findByText("このフォルダはまだありません。プロジェクトを作るときに、一緒に作ります。");
    expect(of("/api/session/inspect").map((c) => c.body)).toEqual([{ path: "/games/new-game", encoding: "auto" }]);
    await waitFor(() => expect(createButton().disabled).toBe(false));

    fireEvent.click(createButton());
    await waitFor(() => expect(handlers.onCreated).toHaveBeenCalledWith(created));
    expect(of("/api/session/create").map((c) => c.body)).toEqual([
      {
        root: "/games/new-game",
        name: "new-game",
        languages: [
          { id: "ja", label: "日本語", pinned: true },
          { id: "en", label: "English", basedOn: "ja" },
        ],
        statusColumn: true,
        reviewColumn: true,
        validators: true,
        firstResource: "text/main.csv",
      },
    ]);
  });

  it("名前を書き換えたあとは、フォルダを変えても名前を上書きしない", async () => {
    stubFetch(() => ({ result: EMPTY_FOLDER }));
    renderNew({ initialPath: "/games/first" });
    expect(nameInput().value).toBe("first");
    type(nameInput(), "My Game");
    type(pathInput(), "/games/second");
    expect(nameInput().value).toBe("My Game");
  });

  it("言語を足す・外す・原文を変える、列と検証と最初のファイルを外す、が送る内容に出る", async () => {
    const { of } = stubFetch((url) => (url === "/api/session/inspect" ? { result: EMPTY_FOLDER } : { result: { project: "/games/new-game", warnings: [], recentProjects: [] } }));
    const handlers = renderNew({ initialPath: "/games/new-game" });
    await screen.findByText(/このフォルダはまだありません/);
    fireEvent.click(screen.getByRole("button", { name: "言語を足す" }));
    // ID が空の行があるあいだは作れず、理由を出す
    expect(createButton().disabled).toBe(true);
    expect(screen.getByTestId("new-project-problem").textContent).toBe("言語の ID が空の行があります。");
    type(screen.getByLabelText("3 番目の言語の ID"), "en");
    expect(screen.getByTestId("new-project-problem").textContent).toBe('言語の ID "en" が重複しています。');
    type(screen.getByLabelText("3 番目の言語の ID"), " zh-Hans ");
    type(screen.getByLabelText("3 番目の言語の表示名"), "简体中文");
    // 日本語を外し、中国語を原文にする
    fireEvent.click(screen.getByRole("button", { name: "1 番目の言語を外す" }));
    fireEvent.click(screen.getByLabelText("2 番目の言語を原文にする"));
    fireEvent.click(screen.getByLabelText(/進捗の列を付ける/));
    fireEvent.click(screen.getByLabelText(/レビューの列を付ける/));
    fireEvent.click(screen.getByLabelText(/基本の検証を付ける/));
    fireEvent.click(screen.getByLabelText("テキストを入れる最初のファイルを作る"));
    expect((screen.getByLabelText(/ファイルの場所/) as HTMLInputElement).disabled).toBe(true);
    type(nameInput(), "  Renamed  ");
    await press("プロジェクトを作る");
    await waitFor(() => expect(handlers.onCreated).toHaveBeenCalled());
    expect(of("/api/session/create").map((c) => c.body)).toEqual([
      {
        root: "/games/new-game",
        name: "Renamed",
        languages: [
          { id: "en", label: "English", basedOn: "zh-Hans" },
          { id: "zh-Hans", label: "简体中文", pinned: true },
        ],
        statusColumn: false,
        reviewColumn: false,
        validators: false,
      },
    ]);
  });

  it("言語が 1 つだけのときは外せない", async () => {
    stubFetch(() => ({ result: EMPTY_FOLDER }));
    renderNew({ initialPath: "/games/new-game" });
    fireEvent.click(screen.getByRole("button", { name: "2 番目の言語を外す" }));
    expect((screen.getByRole("button", { name: "1 番目の言語を外す" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("すでにある CSV の見出しから、キーと本文の列を選べる（言語 ID と同じ見出しは最初から選ぶ）。選んだ対応を送る", async () => {
    const folder = {
      root: "/games/existing",
      exists: true,
      totalResources: 3,
      resources: [
        { path: "Text/ui.csv", headers: ["Note", "ID", "JP", "EN"] },
        { path: "Text/story.csv", headers: ["ID", "JP", "EN"] },
        { path: "Text/broken.csv", error: "UTF-8 として読めません" },
      ],
    };
    const { of } = stubFetch((url) => (url === "/api/session/inspect" ? { result: folder } : { result: { project: "/games/existing", warnings: [], recentProjects: [] } }));
    const handlers = renderNew({ initialPath: "/games/existing" });
    await screen.findByText(/CSV \/ TSV が 3 個あります/);
    // 最初のファイルを作る欄は出さない
    expect(screen.queryByLabelText("テキストを入れる最初のファイルを作る")).toBeNull();
    expect(screen.getByText("Text/ui.csv", { selector: ".mono" })).toBeTruthy();
    expect(screen.getByText(/見出しの並びが違うファイルが 1 個あります（Text\/story\.csv）/)).toBeTruthy();
    expect(screen.getByText(/読めなかったファイルが 1 個あります/).textContent).toContain("Text/broken.csv");

    const key = screen.getByLabelText(/キーの列/) as HTMLSelectElement;
    expect(key.value).toBe("Note");
    expect([...key.options].map((o) => o.value)).toEqual(["Note", "ID", "JP", "EN"]);
    const ja = screen.getByLabelText("日本語 の本文の列") as HTMLSelectElement;
    const en = screen.getByLabelText("English の本文の列") as HTMLSelectElement;
    // "EN" は言語 ID "en" と同じ（大文字小文字を区別しない）ので、最初から選ばれている
    expect(ja.value).toBe("");
    expect(en.value).toBe("EN");

    // 同じ列をキーと本文の両方に選ぶと作れない
    type(ja, "Note");
    expect(screen.getByTestId("new-project-problem").textContent).toBe('列「Note」を、キーと言語 "ja" の本文の両方に選んでいます。');
    expect(createButton().disabled).toBe(true);
    type(key, "ID");
    type(ja, "JP");
    await press("プロジェクトを作る");
    await waitFor(() => expect(handlers.onCreated).toHaveBeenCalled());
    expect(of("/api/session/create").map((c) => c.body)).toEqual([
      {
        root: "/games/existing",
        name: "existing",
        languages: [
          { id: "ja", label: "日本語", pinned: true },
          { id: "en", label: "English", basedOn: "ja" },
        ],
        statusColumn: true,
        reviewColumn: true,
        validators: true,
        mapping: { key: "ID", text: { ja: "JP", en: "EN" } },
      },
    ]);
  });

  it("キーが先頭の列で、本文の列を選ばなければ、対応は空で送る（設定に書かなくてよい）", async () => {
    const folder = { root: "/g", exists: true, totalResources: 1, resources: [{ path: "a.csv", headers: ["key", "fr"] }] };
    const { of } = stubFetch((url) => (url === "/api/session/inspect" ? { result: folder } : { result: { project: "/g", warnings: [], recentProjects: [] } }));
    const handlers = renderNew({ initialPath: "/g" });
    await screen.findByText(/CSV \/ TSV が 1 個あります/);
    await press("プロジェクトを作る");
    await waitFor(() => expect(handlers.onCreated).toHaveBeenCalled());
    expect(of("/api/session/create")[0]!.body.mapping).toEqual({});
  });

  it("文字コードを選び直すと、その文字コードでフォルダを確かめ直し、作るときにも送る", async () => {
    const unreadable = { root: "/g", exists: true, totalResources: 1, resources: [{ path: "s.csv", error: "UTF-8 として読めません" }] };
    const readable = { root: "/g", exists: true, totalResources: 1, resources: [{ path: "s.csv", headers: ["ID", "日本語"] }] };
    const { of } = stubFetch((url, body) => {
      if (url === "/api/session/inspect") return { result: body.encoding === "shift_jis" ? readable : unreadable };
      return { result: { project: "/g", warnings: [], recentProjects: [] } };
    });
    const handlers = renderNew({ initialPath: "/g" });
    await screen.findByText("ファイルの見出しを読めませんでした。文字コードを選び直してください。");
    type(screen.getByLabelText("ファイルの文字コード"), "shift_jis");
    const ja = (await screen.findByLabelText("日本語 の本文の列")) as HTMLSelectElement;
    expect(of("/api/session/inspect").map((c) => c.body)).toEqual([
      { path: "/g", encoding: "auto" },
      { path: "/g", encoding: "shift_jis" },
    ]);
    type(ja, "日本語");
    await press("プロジェクトを作る");
    await waitFor(() => expect(handlers.onCreated).toHaveBeenCalled());
    expect(of("/api/session/create")[0]!.body.mapping).toEqual({ text: { ja: "日本語" }, encoding: "shift_jis" });
  });

  it("すでにプロジェクトのあるフォルダでは作れず、そのプロジェクトを開くことを勧める", async () => {
    const { of } = stubFetch(() => ({ result: { root: "/games/taken", exists: true, configFile: "loc-studio.project.json", resources: [], totalResources: 0 } }));
    const handlers = renderNew({ initialPath: "/games/taken" });
    await screen.findByText(/このフォルダには、すでにプロジェクトがあります（loc-studio\.project\.json）/);
    expect(createButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "このプロジェクトを開く" }));
    expect(handlers.onOpenExisting).toHaveBeenCalledWith("/games/taken");
    expect(of("/api/session/create")).toEqual([]);
  });

  it("フォルダを確かめられなかったら理由を出し、作れない", async () => {
    stubFetch(() => ({ error: { code: "invalid", message: "プロジェクトのフォルダは、絶対パスで指定してください: games" } }));
    renderNew({ initialPath: "games" });
    await screen.findByText("プロジェクトのフォルダは、絶対パスで指定してください: games");
    expect(createButton().disabled).toBe(true);
  });

  it("作成に失敗したら理由を出し、入力を残したまま、もう一度押せる", async () => {
    let fail = true;
    const { of } = stubFetch((url) => {
      if (url === "/api/session/inspect") return { result: EMPTY_FOLDER };
      if (fail) return { error: { code: "failed", message: "フォルダ /games/new-game を作れませんでした: EACCES" } };
      return { result: { project: "/games/new-game", warnings: [], recentProjects: [] } };
    });
    const handlers = renderNew({ initialPath: "/games/new-game" });
    await press("プロジェクトを作る");
    expect((await screen.findByRole("alert")).textContent).toBe("フォルダ /games/new-game を作れませんでした: EACCES");
    expect(handlers.onCreated).not.toHaveBeenCalled();
    expect(pathInput().value).toBe("/games/new-game");
    fail = false;
    await press("プロジェクトを作る");
    await waitFor(() => expect(handlers.onCreated).toHaveBeenCalled());
    expect(of("/api/session/create")).toHaveLength(2);
  });

  it("デスクトップ版では、フォルダを選ぶ窓から入れられる。戻るで元の画面に戻る", async () => {
    stubFetch(() => ({ result: EMPTY_FOLDER }));
    window.locStudio = { pickFolder: vi.fn(async () => "/picked/folder") };
    const handlers = renderNew();
    fireEvent.click(await screen.findByRole("button", { name: "フォルダを選ぶ…" }));
    await waitFor(() => expect(pathInput().value).toBe("/picked/folder"));
    expect(nameInput().value).toBe("folder");
    fireEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("最初の画面からの導線", () => {
  const renderApp = () =>
    render(
      <ToastProvider>
        <App />
        <ToastArea />
      </ToastProvider>,
    );

  /** ローカルモードのサーバーのモック。projects は、開けるプロジェクト（パス → 名前）。 */
  function localServer(projects: Record<string, string>, opts: { defaultProject?: string } = {}) {
    const info = makeInfo();
    const { api } = mockApi(info);
    return stubFetch(async (url, body) => {
      if (url === "/api/session") return { mode: "local", ...(opts.defaultProject ? { defaultProject: opts.defaultProject } : {}), recentProjects: [], desktop: true };
      if (url === "/api/session/open") {
        const p = String(body.project);
        if (projects[p] === undefined) return { error: { code: "failed", message: `${p} にプロジェクトの設定ファイル（loc-studio.project.json）がありません。` } };
        return { result: { project: p, name: projects[p], recentProjects: [p] } };
      }
      if (url === "/api/session/inspect") {
        const p = String(body.path);
        return { result: { root: p, exists: true, ...(projects[p] !== undefined ? { configFile: "loc-studio.project.json" } : {}), resources: [], totalResources: 0 } };
      }
      if (url === "/api/session/create") {
        projects[String(body.root)] = String(body.name);
        return { result: { project: body.root, warnings: [], recentProjects: [body.root] } };
      }
      const method = url.split("/").pop()!;
      if (method === "info") return { result: { ...info, name: projects[String(body.project)] ?? info.name } };
      const fn = (api as unknown as Record<string, (p: unknown) => Promise<unknown>>)[method];
      return { result: fn ? await fn(body.params) : null };
    });
  }

  it("最初の画面に「新しいプロジェクトを作る…」があり、作るとそのプロジェクトを開く", async () => {
    const { of } = localServer({});
    renderApp();
    await press("新しいプロジェクトを作る…");
    await screen.findByRole("heading", { name: /新しいプロジェクトを作る/ });
    type(pathInput(), "/games/brand-new");
    await press("プロジェクトを作る");
    await waitFor(() => expect(document.title).toBe("brand-new - loc-studio"));
    expect(of("/api/session/create")).toHaveLength(1);
    expect(of("/api/session/open").map((c) => c.body)).toEqual([{ project: "/games/brand-new" }]);
    // 作成の画面は閉じている
    expect(screen.queryByRole("button", { name: "プロジェクトを作る" })).toBeNull();
  });

  it("作成の画面の「戻る」で、最初の画面に戻る", async () => {
    localServer({});
    renderApp();
    await press("新しいプロジェクトを作る…");
    await press("戻る");
    expect(await screen.findByRole("button", { name: "新しいプロジェクトを作る…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "プロジェクトを作る" })).toBeNull();
  });

  it("設定ファイルのないフォルダを開こうとしたら、理由と、そのフォルダに作る案内を出す。案内から、フォルダを入れた作成の画面へ進む", async () => {
    localServer({});
    renderApp();
    type(await screen.findByLabelText(/プロジェクトのフォルダ（loc-studio\.project\.json のあるフォルダ）/), "/games/plain-folder");
    await press("開く");
    expect((await screen.findByRole("alert")).textContent).toContain("プロジェクトの設定ファイル（loc-studio.project.json）がありません");
    await press("このフォルダに新しいプロジェクトを作る…");
    await screen.findByRole("heading", { name: /新しいプロジェクトを作る/ });
    expect(pathInput().value).toBe("/games/plain-folder");
    expect(nameInput().value).toBe("plain-folder");
  });

  it("壊れたプロジェクト（設定ファイルはある）を開けなかったときは、作る案内を出さない", async () => {
    stubFetch((url, body) => {
      if (url === "/api/session") return { mode: "local", recentProjects: [], desktop: false };
      if (url === "/api/session/open") return { error: { code: "failed", message: "プロジェクトの設定に問題があります" } };
      if (url === "/api/session/inspect") return { result: { root: String(body.path), exists: true, configFile: "loc-studio.project.json", resources: [], totalResources: 0 } };
      return { result: null };
    });
    renderApp();
    type(await screen.findByLabelText(/プロジェクトのフォルダ（loc-studio\.project\.json のあるフォルダ）/), "/games/broken");
    await press("開く");
    expect((await screen.findByRole("alert")).textContent).toContain("プロジェクトの設定に問題があります");
    // 確かめ終わるまで待ってから、案内がないことを確かめる
    await waitFor(() => expect((screen.getByRole("button", { name: "新しいプロジェクトを作る…" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "このフォルダに新しいプロジェクトを作る…" })).toBeNull();
  });

  it("デスクトップ版のメニューからの操作を、ページを読み直さずに受ける（新しいプロジェクト、別のプロジェクトを開く）", async () => {
    const { of } = localServer({ "/p/first": "First", "/p/second": "Second" }, { defaultProject: "/p/first" });
    let send: ((command: DesktopCommand) => void) | null = null;
    const projectsChanged = vi.fn();
    window.locStudio = { onCommand: (handler) => (send = handler), projectsChanged };
    renderApp();
    await waitFor(() => expect(document.title).toBe("First - loc-studio"));
    expect(projectsChanged).toHaveBeenCalledTimes(1);
    expect(send).not.toBeNull();

    // 「プロジェクトを開く…」「最近使ったプロジェクト」: 選んだプロジェクトに切り替わる（起動時のプロジェクトに戻らない）
    send!({ type: "open", path: "/p/second" });
    await waitFor(() => expect(document.title).toBe("Second - loc-studio"));
    expect(of("/api/session/open").map((c) => c.body)).toEqual([{ project: "/p/first" }, { project: "/p/second" }]);
    expect(projectsChanged).toHaveBeenCalledTimes(2);

    // 開けないプロジェクトを選んだら、いまの画面は残して知らせる
    send!({ type: "open", path: "/p/missing" });
    expect(await screen.findByText(/\/p\/missing にプロジェクトの設定ファイル/)).toBeTruthy();
    expect(document.title).toBe("Second - loc-studio");
    expect(screen.queryByRole("button", { name: "新しいプロジェクトを作る…" })).toBeNull();

    // 「新しいプロジェクト…」: 開いていたプロジェクトを閉じて、作成の画面を出す
    send!({ type: "new" });
    await screen.findByRole("heading", { name: /新しいプロジェクトを作る/ });
    expect(document.title).toBe("loc-studio");
    expect(within(document.body).queryByRole("grid")).toBeNull();

    // 「新しいプロジェクト…」のあとは、プロジェクトを開いていない状態。開けないフォルダを選ぶと、最初の画面で理由と作る案内を出す
    // （前のプロジェクトを開いたままの扱いにしていると、通知だけが出て、案内が出ない）。
    send!({ type: "open", path: "/p/plain-folder" });
    expect(await screen.findByRole("button", { name: "このフォルダに新しいプロジェクトを作る…" })).toBeTruthy();
    // 理由は、通知ではなく、最初の画面の中に出る（前の通知も role="alert" なので、画面の中の表示で確かめる）。
    expect(document.querySelector(".open-card .hint-error")?.textContent).toContain("/p/plain-folder にプロジェクトの設定ファイル");
  });
});

describe("作ったばかりのプロジェクトの画面", () => {
  function renderStudio(prepare: (api: ReturnType<typeof mockApi>["api"]) => void) {
    const info = makeInfo();
    const { api } = mockApi(info);
    prepare(api);
    render(
      <ToastProvider>
        <Studio api={api} project="/tmp/test" initialInfo={info} />
        <ToastArea />
      </ToastProvider>,
    );
    return api;
  }

  it("行のないリソースでは、行の足し方を案内する", async () => {
    renderStudio((api) => api.rows.mockResolvedValue({ total: 0, totalAll: 0, rows: [], diagnostics: [] }));
    expect(await screen.findByText("このリソースには、まだ行がありません。上の「行 ▾」の「行を追加…」で足せます。")).toBeTruthy();
  });

  it("絞り込みで行がなくなったときは、行の足し方ではなく、条件に合う行がないと伝える", async () => {
    renderStudio((api) => api.rows.mockResolvedValue({ total: 0, totalAll: 5, rows: [], diagnostics: [] }));
    expect(await screen.findByText("条件に合う行がありません")).toBeTruthy();
    expect(screen.queryByText(/まだ行がありません/)).toBeNull();
  });

  it("リソースが 1 つもないプロジェクトでは、リソースの作り方を案内する（ツリーを読み終えるまでは出さない）", async () => {
    let finish: (nodes: []) => void = () => {};
    const api = renderStudio((a) => a.tree.mockImplementation(() => new Promise((resolve) => (finish = resolve))));
    await waitFor(() => expect(api.tree).toHaveBeenCalled());
    expect(screen.getByText("左のツリーからリソースを選んでください。")).toBeTruthy();
    expect(screen.queryByText(/まだリソース（テキストのファイル）がありません/)).toBeNull();
    finish([]);
    expect(await screen.findByText("このプロジェクトには、まだリソース（テキストのファイル）がありません。左の「リソースを作成」で、最初のファイルを作れます。")).toBeTruthy();
    expect(api.rows).not.toHaveBeenCalled();
  });
});
