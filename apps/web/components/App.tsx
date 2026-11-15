"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthUser, ProjectInfo } from "@loc-studio/server";
import { createApi, getJson, postJson, type RpcError } from "@/lib/client/api";
import { ToastArea, ToastProvider, useToasts } from "@/components/context";
import { Studio, type WebSession } from "@/components/Studio";
import { OpenProject } from "@/components/OpenProject";
import { LoginScreen } from "@/components/web/LoginScreen";
import { ProjectList, type ProjectSummary } from "@/components/web/ProjectList";
import { AdminScreen } from "@/components/web/AdminScreen";
import { PluginTrustDialog } from "@/components/PluginTrustDialog";
import type { ClientApi } from "@/lib/client/api";

/*
 * 起動。
 * - ローカルモード: 既定のプロジェクト（または ?project=）があれば開き、なければ「プロジェクトを開く」画面。
 * - Web モード: ログイン → 開けるプロジェクトの一覧 → プロジェクト。認証が切れたら（401）ログインの画面に戻る。
 */

declare global {
  interface Window {
    /** Electron の殻が用意する機能（ブラウザでは undefined）。 */
    locStudio?: {
      pickFolder?: () => Promise<string | undefined | null>;
      openPath?: (path: string, line?: number) => Promise<void> | void;
    };
  }
}

interface SessionInfo {
  mode?: "local" | "web";
  defaultProject?: string;
  recentProjects: string[];
  desktop: boolean;
}

interface Me {
  user: AuthUser;
  admin: boolean;
  authMode: "password" | "proxy";
  projects: ProjectSummary[];
}

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
      <ToastArea />
    </ToastProvider>
  );
}

function setUrlProject(project: string | null) {
  const url = new URL(window.location.href);
  if (project) url.searchParams.set("project", project);
  else url.searchParams.delete("project");
  window.history.replaceState(null, "", url);
}

function AppInner() {
  const { reportError } = useToasts();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // Web モード
  const [me, setMe] = useState<Me | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [proxyAuth, setProxyAuth] = useState(false);
  const web = session?.mode === "web";

  /** 認証が切れたらログインの画面へ（入力中の画面は捨てる）。 */
  const onUnauthorized = useCallback((err?: RpcError) => {
    setMe(null);
    setProject(null);
    setInfo(null);
    setAdminOpen(false);
    setNeedLogin(true);
    setLoginNotice(err ? `ログインし直してください（${err.message}）` : null);
  }, []);

  // ローカルモードで、起動の合言葉のクッキーが無効になった（サーバーを起動し直したなど）
  const [localExpired, setLocalExpired] = useState(false);
  const onLocalUnauthorized = useCallback(() => setLocalExpired(true), []);
  // コードの設定を信頼していない、制限された状態（信頼の確認だけを出す）
  const [restricted, setRestricted] = useState(false);
  // 設定ファイルを信頼して開いた直後（続けて出るコードの確認に、その旨を出す）
  const [trustContinued, setTrustContinued] = useState(false);
  // 表の画面を一度出したプロジェクト。作業の途中で制限された状態になったら、表の画面は消さずに隠し、
  // 確認の画面を重ねる（開いている編集欄の入力を失わないため）。信頼したら読み直して元に戻す。
  const [liveProject, setLiveProject] = useState<string | null>(null);
  const [resumeToken, setResumeToken] = useState(0);
  const projectRef = useRef<string | null>(null);
  projectRef.current = project;
  const onUntrusted = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    // info は制限された状態でも使えるので読み直し、確認の画面に戻す
    createApi({ project: p })
      .info()
      .then((i) => {
        setInfo(i);
        setRestricted(i.restricted === true);
      })
      .catch(() => setRestricted(true));
  }, []);

  const api = useMemo(
    () => (project ? createApi({ project, onUntrusted, ...(web ? { onUnauthorized } : { onUnauthorized: onLocalUnauthorized }) }) : null),
    [project, web, onUnauthorized, onUntrusted, onLocalUnauthorized],
  );

  const openLocal = useCallback(async (path: string) => {
    setOpening(true);
    setOpenError(null);
    try {
      const res = (await postJson("/api/session/open", { project: path }, { onUnauthorized: onLocalUnauthorized })) as { project: string; recentProjects: string[] };
      const i = await createApi({ project: res.project }).info();
      setSession((s) => (s ? { ...s, recentProjects: res.recentProjects } : s));
      setInfo(i);
      setRestricted(i.restricted === true);
      setTrustContinued(false);
      setLiveProject(null);
      setProject(res.project);
      document.title = `${i.name} - loc-studio`;
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    } finally {
      setOpening(false);
    }
  }, [onLocalUnauthorized]);

  const openWeb = useCallback(
    async (id: string) => {
      setOpening(true);
      setOpenError(null);
      try {
        const i = await createApi({ project: id, onUnauthorized }).info();
        setInfo(i);
        setRestricted(i.restricted === true);
        setProject(id);
        document.title = `${i.name} - loc-studio`;
      } catch (err) {
        setOpenError(err instanceof Error ? err.message : String(err));
      } finally {
        setOpening(false);
      }
    },
    [onUnauthorized],
  );

  const loadMe = useCallback(async () => {
    try {
      const m = (await getJson("/api/auth/me", {
        onUnauthorized: (err) => {
          setProxyAuth((err.data as { authMode?: unknown } | undefined)?.authMode === "proxy");
          setNeedLogin(true);
        },
      })) as Me;
      setMe(m);
      setNeedLogin(false);
      setLoginNotice(null);
      // URL の ?project= では開かない（プロジェクトを開くのは利用者の操作だけ）。開けるのが 1 つだけなら、それを開く
      if (m.projects.length === 1) void openWeb(m.projects[0]!.id);
    } catch (err) {
      if ((err as RpcError).code !== "unauthorized") reportError(err, "ログインの状態を確かめられませんでした");
    }
  }, [openWeb, reportError]);

  useEffect(() => {
    fetch("/api/session", { cache: "no-store" })
      .then(async (r) => {
        const s = (await r.json()) as SessionInfo & { error?: { code?: string; message: string } };
        if (s.error?.code === "unauthorized") {
          setLocalExpired(true);
          return;
        }
        if (s.error) throw new Error(s.error.message);
        setSession(s);
        if (s.mode === "web") {
          void loadMe();
          return;
        }
        // 自動で開くのは、サーバーを起動した人が決めた LOC_STUDIO_PROJECT だけ。URL の ?project= は入力欄に入れるだけ
        if (s.defaultProject) void openLocal(s.defaultProject);
      })
      .catch((err: unknown) => reportError(err, "起動情報を読めませんでした"));
  }, [openLocal, loadMe, reportError]);

  const logout = useCallback(async () => {
    try {
      await postJson("/api/auth/logout", {});
    } catch (err) {
      reportError(err, "ログアウトできませんでした");
    }
    setUrlProject(null);
    onUnauthorized();
    setLoginNotice("ログアウトしました。");
  }, [onUnauthorized, reportError]);

  const webSession: WebSession | undefined = me
    ? {
        user: { name: me.user.name, displayName: me.user.displayName, admin: me.admin },
        authMode: me.authMode,
        onLogout: () => void logout(),
        ...(me.admin ? { onOpenAdmin: () => setAdminOpen(true) } : {}),
      }
    : undefined;

  const adminScreen = adminOpen && me && <AdminScreen me={me.user.name} onClose={() => setAdminOpen(false)} />;

  if (web) {
    if (needLogin) {
      if (proxyAuth) {
        return (
          <main className="open-project">
            <div className="open-card">
              <h1 className="open-title">loc-studio</h1>
              <p>このサーバーは社内の認証（リバースプロキシ）を通して使います。認証を通ったアドレスから開き直してください。</p>
            </div>
          </main>
        );
      }
      return <LoginScreen notice={loginNotice} onLoggedIn={() => void loadMe()} />;
    }
    if (!me || !webSession) {
      return (
        <main className="open-project">
          <p className="muted">読み込み中…</p>
        </main>
      );
    }
    if (project && api && info && restricted) {
      return (
        <main className="open-project">
          <div className="open-card">
            <p>このプロジェクトは、サーバーの管理者がコードの設定を確認するまで開けません。</p>
            <button type="button" className="btn" onClick={() => (setProject(null), setInfo(null), setRestricted(false))}>
              プロジェクト一覧へ
            </button>
          </div>
        </main>
      );
    }
    if (project && api && info) {
      return (
        <>
          <Studio
            key={project}
            api={api}
            project={project}
            initialInfo={info}
            web={webSession}
            onCloseProject={() => {
              setProject(null);
              setInfo(null);
              setUrlProject(null);
              void loadMe();
            }}
          />
          {adminScreen}
        </>
      );
    }
    return (
      <>
        <ProjectList projects={me.projects} session={webSession} onOpen={(id) => void openWeb(id)} loading={opening} error={openError} />
        {adminScreen}
      </>
    );
  }

  if (localExpired) return <LocalTokenScreen />;
  const closeLocal = () => {
    setProject(null);
    setInfo(null);
    setRestricted(false);
    setLiveProject(null);
    setUrlProject(null);
  };
  if (project && api && info && (!restricted || liveProject === project)) {
    return (
      <>
        <div className="studio-host" hidden={restricted} inert={restricted}>
          <Studio
            key={project}
            api={api}
            project={project}
            initialInfo={info}
            trustContinued={trustContinued}
            resumeToken={resumeToken}
            onReady={() => setLiveProject(project)}
            onRestricted={onUntrusted}
            onCloseProject={closeLocal}
          />
        </div>
        {restricted && (
          <RestrictedScreen
            api={api}
            info={info}
            midSession
            onTrusted={async () => {
              const i = await api.info();
              setInfo(i);
              setRestricted(i.restricted === true);
              if (i.restricted !== true) setResumeToken((t) => t + 1);
            }}
            onClose={closeLocal}
          />
        )}
      </>
    );
  }
  if (project && api && info && restricted) {
    return (
      <RestrictedScreen
        api={api}
        info={info}
        onTrusted={async () => {
          const i = await api.info();
          setInfo(i);
          setTrustContinued(i.restricted !== true);
          setRestricted(i.restricted === true);
        }}
        onClose={closeLocal}
      />
    );
  }
  return (
    <OpenProject
      recent={session?.recentProjects ?? []}
      loading={session === null || opening}
      error={openError}
      initialPath={typeof window !== "undefined" ? (new URL(window.location.href).searchParams.get("project") ?? "") : ""}
      onOpen={(p) => void openLocal(p)}
    />
  );
}

/**
 * 制限された状態: プロジェクトの設定ファイルやコードの設定を信頼するまで、確認だけを出す（表もツリーも読まない）。
 * midSession は、作業の途中でファイルが変わって確認が必要になったとき（表の画面は後ろに隠して残してある）。
 */
function RestrictedScreen({
  api,
  info,
  onTrusted,
  onClose,
  midSession,
}: {
  api: ClientApi;
  info: ProjectInfo;
  onTrusted(): Promise<void>;
  onClose(): void;
  midSession?: boolean;
}) {
  const { reportError } = useToasts();
  return (
    <main className="open-project restricted-screen">
      <div className="open-card">
        <h1 className="open-title">{info.name}</h1>
        {midSession ? (
          <p>
            プロジェクトの設定かコードの設定が、アプリの外で変わりました。内容を確認して信頼すると、元の画面に戻ります。保存していない変更と、編集中の入力は残っています。
          </p>
        ) : (
          <p>このプロジェクトは、設定を確認して信頼するまで開けません。</p>
        )}
        <button type="button" className="btn" onClick={onClose}>
          プロジェクトを閉じる
        </button>
      </div>
      <PluginTrustDialog
        restricted
        midSession={midSession === true}
        api={api}
        projectName={info.name}
        onTrusted={() => void onTrusted().catch((err: unknown) => reportError(err, "プロジェクトを開けませんでした"))}
        onSkip={onClose}
      />
    </main>
  );
}

/** ローカルモードで、起動の合言葉のクッキーが無効になったとき（サーバーを起動し直したなど）。 */
function LocalTokenScreen() {
  return (
    <main className="open-project">
      <div className="open-card">
        <h1 className="open-title">loc-studio を開き直してください</h1>
        <p>サーバーが起動し直されたため、この画面の接続は無効になりました。</p>
        <p>起動したときに表示された URL（<code>?token=…</code> の付いたもの）から開き直してください。デスクトップ版では、アプリを開き直してください。</p>
      </div>
    </main>
  );
}
