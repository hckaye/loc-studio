"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuthUser, Membership, ProjectInfo } from "@loc-studio/server";
import { Dialog } from "@/components/Dialog";
import { LanguagePicker } from "@/components/LanguagePicker";
import { useToasts } from "@/components/context";
import { createApi, postJson } from "@/lib/client/api";
import { ROLE_LABEL } from "@/lib/client/permissions";

/*
 * 管理の画面（Web モード、管理者だけ）。利用者の一覧と、プロジェクトごとの権限の割り当て。
 * 権限の確認はサーバーが行う（自分を外す・無効にする・削除するのは invalid）。画面でも自分の行の操作は無効にする。
 */

const ROLES = ["viewer", "translator", "reviewer", "manager"] as const;
type Role = (typeof ROLES)[number];
const SELF_REASON = "自分自身には使えません";

const admin = (op: string, body: unknown = {}) => postJson(`/api/admin/${op}`, body);

export function AdminScreen({ me, onClose, onUnauthorized }: { me: string; onClose(): void; onUnauthorized?(): void }) {
  const [tab, setTab] = useState<"users" | "members">("users");
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const { reportError } = useToasts();
  const loadUsers = useCallback(() => {
    admin("listUsers")
      .then((u) => setUsers(u as AuthUser[]))
      .catch((err: unknown) => reportError(err, "利用者の一覧を読めませんでした"));
  }, [reportError]);
  useEffect(loadUsers, [loadUsers]);
  void onUnauthorized;

  return (
    <Dialog title="管理" className="admin-dialog" onClose={onClose}>
      <div className="tabs" role="tablist" aria-label="管理の種類">
        <button type="button" role="tab" id="tab-users" aria-selected={tab === "users"} aria-controls="panel-users" className={`tab${tab === "users" ? " on" : ""}`} onClick={() => setTab("users")}>
          利用者
        </button>
        <button type="button" role="tab" id="tab-members" aria-selected={tab === "members"} aria-controls="panel-members" className={`tab${tab === "members" ? " on" : ""}`} onClick={() => setTab("members")}>
          プロジェクトの権限
        </button>
      </div>
      {tab === "users" ? (
        <div role="tabpanel" id="panel-users" aria-labelledby="tab-users">
          <UsersTab me={me} users={users} reload={loadUsers} />
        </div>
      ) : (
        <div role="tabpanel" id="panel-members" aria-labelledby="tab-members">
          <MembersTab users={users ?? []} />
        </div>
      )}
    </Dialog>
  );
}

function UsersTab({ me, users, reload }: { me: string; users: AuthUser[] | null; reload(): void }) {
  const { push, reportError } = useToasts();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [deleteFor, setDeleteFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      push("success", label);
      reload();
      return true;
    } catch (err) {
      reportError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <form
        className="admin-create"
        aria-label="利用者を追加"
        onSubmit={(e) => {
          e.preventDefault();
          void run(`利用者「${name}」を追加しました`, () =>
            admin("createUser", { input: { name: name.trim(), password, ...(displayName.trim() ? { displayName: displayName.trim() } : {}), admin: isAdmin } }),
          ).then((ok) => {
            if (ok) {
              setName("");
              setDisplayName("");
              setPassword("");
              setIsAdmin(false);
            }
          });
        }}
      >
        <h3 className="section-title">利用者を追加</h3>
        <div className="row wrap">
          <label className="field">
            <span>ログイン名</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            <span>表示名（任意）</span>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            <span>初期パスワード（8 文字以上）</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label className="check">
            <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
            管理者
          </label>
          <button type="submit" className="btn primary" disabled={busy || name.trim() === "" || password.length < 8}>
            追加
          </button>
        </div>
      </form>
      <h3 className="section-title">利用者（{users?.length ?? "…"}）</h3>
      {users === null ? (
        <p className="muted small">読み込み中…</p>
      ) : (
        <table className="table admin-table">
          <thead>
            <tr>
              <th>ログイン名</th>
              <th>表示名</th>
              <th>状態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const self = u.name === me;
              return (
                <tr key={u.name} className={u.disabled ? "disabled-row" : undefined}>
                  <td className="mono">
                    {u.name}
                    {self && <span className="badge">あなた</span>}
                  </td>
                  <td>{u.displayName}</td>
                  <td>
                    {u.admin && <span className="badge good-badge">管理者</span>} {u.disabled && <span className="badge warn">無効</span>}
                    {!u.hasPassword && <span className="badge">パスワードなし</span>}
                  </td>
                  <td>
                    <div className="row wrap">
                      <button type="button" className="btn small" disabled={busy} onClick={() => (setResetFor(u.name), setResetPw(""))}>
                        パスワードを再設定
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled={busy || self}
                        title={self ? SELF_REASON : undefined}
                        onClick={() => void run(u.disabled ? `「${u.name}」を有効にしました` : `「${u.name}」を無効にしました`, () => admin("updateUser", { name: u.name, patch: { disabled: !u.disabled } }))}
                      >
                        {u.disabled ? "有効にする" : "無効にする"}
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        disabled={busy || (self && u.admin)}
                        title={self && u.admin ? SELF_REASON : undefined}
                        onClick={() => void run(u.admin ? `「${u.name}」を管理者から外しました` : `「${u.name}」を管理者にしました`, () => admin("updateUser", { name: u.name, patch: { admin: !u.admin } }))}
                      >
                        {u.admin ? "管理者から外す" : "管理者にする"}
                      </button>
                      <button type="button" className="btn small danger" disabled={busy || self} title={self ? SELF_REASON : undefined} onClick={() => setDeleteFor(u.name)}>
                        削除
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {resetFor && (
        <Dialog
          title={`「${resetFor}」のパスワードを再設定`}
          className="small-dialog"
          onClose={() => setResetFor(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setResetFor(null)}>
                キャンセル
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || resetPw.length < 8}
                onClick={() => {
                  const n = resetFor;
                  void run(`「${n}」のパスワードを再設定しました（その人のログインは無効になりました）`, () => admin("setPassword", { name: n, password: resetPw })).then((ok) => ok && setResetFor(null));
                }}
              >
                再設定
              </button>
            </>
          }
        >
          <label className="field">
            <span>新しいパスワード（8 文字以上）</span>
            <input className="input" type="password" autoComplete="new-password" value={resetPw} onChange={(e) => setResetPw(e.target.value)} />
          </label>
        </Dialog>
      )}
      {deleteFor && (
        <Dialog
          title={`利用者「${deleteFor}」を削除しますか？`}
          className="small-dialog"
          onClose={() => setDeleteFor(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDeleteFor(null)}>
                やめる
              </button>
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                onClick={() => {
                  const n = deleteFor;
                  void run(`「${n}」を削除しました`, () => admin("deleteUser", { name: n })).then(() => setDeleteFor(null));
                }}
              >
                削除する
              </button>
            </>
          }
        >
          <p>アカウントと権限の割り当てを削除します。履歴やレビューに残った名前は消えません。元に戻せません。</p>
        </Dialog>
      )}
    </div>
  );
}

function MembersTab({ users }: { users: AuthUser[] }) {
  const { push, reportError } = useToasts();
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [projectId, setProjectId] = useState<string>("");
  const [members, setMembers] = useState<Membership[] | null>(null);
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [newUser, setNewUser] = useState("");
  const [newRole, setNewRole] = useState<Role>("translator");
  const [pickFor, setPickFor] = useState<Membership | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    admin("projects")
      .then((p) => {
        const list = p as { id: string; name: string }[];
        setProjects(list);
        if (list[0]) setProjectId(list[0].id);
      })
      .catch((err: unknown) => reportError(err, "プロジェクトの一覧を読めませんでした"));
  }, [reportError]);

  const load = useCallback(() => {
    if (!projectId) return;
    admin("listMemberships", { projectId })
      .then((m) => setMembers(m as Membership[]))
      .catch((err: unknown) => reportError(err, "権限の一覧を読めませんでした"));
  }, [projectId, reportError]);

  useEffect(() => {
    setMembers(null);
    setInfo(null);
    load();
    if (projectId) {
      // 言語の一覧（担当の言語を選ぶため）。管理者はどのプロジェクトも開ける
      createApi({ project: projectId })
        .info()
        .then(setInfo)
        .catch((err: unknown) => reportError(err, "プロジェクトの言語を読めませんでした"));
    }
  }, [projectId, load, reportError]);

  const set = async (user: string, role: Role, languages: string[] | undefined, label: string) => {
    setBusy(true);
    try {
      await admin("setMembership", { projectId, user, role, ...(languages && languages.length ? { languages } : {}) });
      push("success", label);
      load();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (user: string) => {
    setBusy(true);
    try {
      await admin("removeMembership", { projectId, user });
      push("success", `「${user}」の割り当てを外しました`);
      load();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const assigned = useMemo(() => new Set((members ?? []).map((m) => m.user)), [members]);
  const candidates = users.filter((u) => !assigned.has(u.name));
  const langLabel = (id: string) => info?.languages.find((l) => l.id === id)?.label ?? id;

  return (
    <div>
      <div className="row">
        <label className="field">
          <span>プロジェクト</span>
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="プロジェクト">
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.id}）
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">管理者はすべてのプロジェクトで「管理」として扱われます。割り当てのない利用者はプロジェクトを開けません。</p>
      {members === null ? (
        <p className="muted small">読み込み中…</p>
      ) : (
        <table className="table admin-table">
          <thead>
            <tr>
              <th>利用者</th>
              <th>役割</th>
              <th>担当の言語</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  割り当てはありません。
                </td>
              </tr>
            )}
            {members.map((m) => (
              <tr key={m.user}>
                <td className="mono">{m.user}</td>
                <td>
                  <select
                    className="input small"
                    aria-label={`${m.user} の役割`}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => void set(m.user, e.target.value as Role, m.languages, `「${m.user}」の役割を変えました`)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}（{r}）
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <span className="small">{m.languages && m.languages.length ? m.languages.map(langLabel).join("、") : "すべての言語"}</span>{" "}
                  <button type="button" className="btn small" disabled={busy || !info} onClick={() => setPickFor(m)} aria-label={`${m.user} の担当の言語を選ぶ`}>
                    言語を選ぶ
                  </button>
                </td>
                <td>
                  <button type="button" className="btn small danger" disabled={busy} onClick={() => void remove(m.user)}>
                    外す
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="row wrap admin-add-member"
        aria-label="利用者を割り当てる"
        onSubmit={(e) => {
          e.preventDefault();
          if (newUser) void set(newUser, newRole, undefined, `「${newUser}」を割り当てました`).then(() => setNewUser(""));
        }}
      >
        <select className="input small" aria-label="割り当てる利用者" value={newUser} onChange={(e) => setNewUser(e.target.value)}>
          <option value="">利用者を選ぶ…</option>
          {candidates.map((u) => (
            <option key={u.name} value={u.name}>
              {u.displayName && u.displayName !== u.name ? `${u.displayName}（${u.name}）` : u.name}
            </option>
          ))}
        </select>
        <select className="input small" aria-label="割り当てる役割" value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}（{r}）
            </option>
          ))}
        </select>
        <button type="submit" className="btn small primary" disabled={busy || !newUser}>
          割り当てる
        </button>
      </form>
      {pickFor && info && (
        <LanguagePicker
          selectOnly
          allowEmpty
          title={`${pickFor.user} の担当の言語（選ばなければすべて）`}
          languages={info.languages}
          projectSets={info.languageSets}
          userSets={{}}
          visible={pickFor.languages ?? []}
          pins={[]}
          onApply={(langs) => void set(pickFor.user, pickFor.role, langs, `「${pickFor.user}」の担当の言語を変えました`)}
          onSaveSet={() => {}}
          onDeleteSet={() => {}}
          onClose={() => setPickFor(null)}
        />
      )}
    </div>
  );
}
