"use client";
import type { WebSession } from "@/components/Studio";
import { UserMenu } from "@/components/web/UserMenu";

export interface ProjectSummary {
  id: string;
  name: string;
  role?: string;
  roleLabel?: string;
  languages?: string[];
}

/* ログインのあとのプロジェクトの一覧（Web モード）。開けるものだけが並ぶ。 */
export function ProjectList({ projects, session, onOpen, loading, error }: { projects: ProjectSummary[]; session: WebSession; onOpen(id: string): void; loading?: boolean; error?: string | null }) {
  return (
    <main className="open-project">
      <div className="open-card">
        <div className="row">
          <h1 className="open-title grow">
            <span className="logo" aria-hidden="true">
              ◧
            </span>{" "}
            loc-studio
          </h1>
          <UserMenu session={session} />
        </div>
        <h2 className="section-title">プロジェクト</h2>
        {error && (
          <p className="hint-error" role="alert">
            {error}
          </p>
        )}
        {projects.length === 0 ? (
          <p className="muted">開けるプロジェクトがありません。管理者に権限の割り当てを頼んでください。</p>
        ) : (
          <ul className="recent-list project-list">
            {projects.map((p) => (
              <li key={p.id}>
                <button type="button" className="recent-btn project-btn" onClick={() => onOpen(p.id)} disabled={loading}>
                  <span className="project-btn-name">{p.name}</span>
                  <span className="muted small mono">{p.id}</span>
                  {p.role && <span className="badge">{p.roleLabel ?? p.role}</span>}
                  {p.languages && <span className="muted small">担当: {p.languages.join(", ")}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
