"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FolderInspection, NewProjectInput } from "@loc-studio/server";
import { postJson } from "@/lib/client/api";

/*
 * 新しいプロジェクトを作る画面（ローカルモード）。
 * フォルダ、名前、言語を選ぶと、設定ファイル（loc-studio.project.json）を書いて、そのまま開く。
 * フォルダにすでに CSV / TSV があれば、その見出しを読み、キーの列と言語ごとの本文の列を選べる。
 * 作るのは同梱の実装を選んだ雛形で、言語や列は、あとから設定ファイル（loc-studio.project.json）で変えられる。
 */

export interface CreatedProject {
  project: string;
  /** 一緒に作った最初のファイル。 */
  resource?: string;
  warnings: string[];
  recentProjects: string[];
}

export interface NewProjectProps {
  /** フォルダの欄に入れておく値。 */
  initialPath?: string;
  onCancel(): void;
  onCreated(result: CreatedProject): void;
  /** 選んだフォルダに、すでにプロジェクトがあったとき（そのプロジェクトを開く）。 */
  onOpenExisting(path: string): void;
  /** 起動の合言葉が無効になった。 */
  onUnauthorized?(): void;
}

interface LanguageRow {
  /** 行を見分ける番号（ID を書き換えても、入力欄を作り直さないため）。 */
  n: number;
  id: string;
  label: string;
}

/** 最初に入れておく言語（例。利用者が自由に書き換える）。 */
const STARTING_LANGUAGES: Omit<LanguageRow, "n">[] = [
  { id: "ja", label: "日本語" },
  { id: "en", label: "English" },
];

const ENCODINGS: { value: string; label: string }[] = [
  { value: "auto", label: "自動（UTF-8。BOM があれば UTF-16）" },
  { value: "utf-8", label: "UTF-8" },
  { value: "shift_jis", label: "Shift_JIS" },
  { value: "utf-16le", label: "UTF-16LE" },
  { value: "utf-16be", label: "UTF-16BE" },
];

const DEFAULT_FIRST_RESOURCE = "text/main.csv";
/** フォルダの欄の入力が止まってから、フォルダを確かめるまでの時間。 */
const INSPECT_DELAY_MS = 300;

/** パスの最後の部分（プロジェクトの名前の初期値にする）。 */
export function folderName(p: string): string {
  const parts = p.trim().split(/[\\/]+/).filter((s) => s !== "");
  const last = parts[parts.length - 1] ?? "";
  // "C:" のようなドライブだけのときは、名前にしない。
  return /^[A-Za-z]:$/.test(last) ? "" : last;
}

/** 言語の ID と同じ見出し（大文字小文字は区別しない）があれば、それを本文の列の初期値にする。 */
function guessHeader(id: string, headers: string[]): string {
  const lower = id.trim().toLowerCase();
  if (lower === "") return "";
  return headers.find((h) => h.trim().toLowerCase() === lower) ?? "";
}

export function NewProject({ initialPath = "", onCancel, onCreated, onOpenExisting, onUnauthorized }: NewProjectProps) {
  const [path, setPath] = useState(initialPath);
  const [name, setName] = useState(folderName(initialPath));
  const nameTouched = useRef(false);
  const counter = useRef(STARTING_LANGUAGES.length);
  const [languages, setLanguages] = useState<LanguageRow[]>(() => STARTING_LANGUAGES.map((l, i) => ({ ...l, n: i })));
  const [source, setSource] = useState(0);
  const [statusColumn, setStatusColumn] = useState(true);
  const [reviewColumn, setReviewColumn] = useState(true);
  const [validators, setValidators] = useState(true);
  const [makeFirst, setMakeFirst] = useState(true);
  const [firstResource, setFirstResource] = useState(DEFAULT_FIRST_RESOURCE);
  const [encoding, setEncoding] = useState("auto");
  const [keyHeader, setKeyHeader] = useState<string | null>(null);
  /** 言語の行の番号 → 利用者が選んだ本文の列（選んでいなければ、推測した列を使う）。 */
  const [chosen, setChosen] = useState<Record<number, string>>({});
  const [folder, setFolder] = useState<FolderInspection | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canPick, setCanPick] = useState(false);
  useEffect(() => setCanPick(typeof window !== "undefined" && typeof window.locStudio?.pickFolder === "function"), []);

  const trimmedPath = path.trim();

  // フォルダを確かめる。入力のたびに呼ばないよう、少し待つ。あとから来た古い応答は捨てる。
  useEffect(() => {
    setFolder(null);
    setFolderError(null);
    if (trimmedPath === "") {
      setInspecting(false);
      return;
    }
    let stale = false;
    setInspecting(true);
    const timer = setTimeout(() => {
      postJson("/api/session/inspect", { path: trimmedPath, encoding }, onUnauthorized ? { onUnauthorized } : {})
        .then((res) => {
          if (stale) return;
          setFolder(res as FolderInspection);
          setInspecting(false);
        })
        .catch((err: unknown) => {
          if (stale) return;
          setFolderError(err instanceof Error ? err.message : String(err));
          setInspecting(false);
        });
    }, INSPECT_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [trimmedPath, encoding, onUnauthorized]);

  const changePath = (value: string) => {
    setPath(value);
    if (!nameTouched.current) setName(folderName(value));
  };

  const pick = async () => {
    const p = await window.locStudio?.pickFolder?.();
    if (p) changePath(p);
  };

  // 見出しの基準にするファイル（見出しを読めた最初のファイル）。
  const reference = useMemo(() => folder?.resources.find((r) => r.headers !== undefined && r.headers.length > 0), [folder]);
  const headers = reference?.headers ?? [];
  const hasFiles = (folder?.totalResources ?? 0) > 0;
  const unreadable = folder?.resources.filter((r) => r.error !== undefined) ?? [];
  const different = reference ? (folder?.resources.filter((r) => r.headers !== undefined && r.headers.join("\u0000") !== headers.join("\u0000")) ?? []) : [];
  const key = keyHeader !== null && headers.includes(keyHeader) ? keyHeader : (headers[0] ?? "");
  const headerOf = (l: LanguageRow): string => {
    const picked = chosen[l.n];
    if (picked !== undefined) return picked === "" || headers.includes(picked) ? picked : "";
    return guessHeader(l.id, headers);
  };

  const updateLanguage = (n: number, patch: Partial<LanguageRow>) => setLanguages((list) => list.map((l) => (l.n === n ? { ...l, ...patch } : l)));
  const addLanguage = () => setLanguages((list) => [...list, { n: counter.current++, id: "", label: "" }]);
  const removeLanguage = (n: number) => {
    setLanguages((list) => list.filter((l) => l.n !== n));
    if (source === n) setSource(languages.find((l) => l.n !== n)?.n ?? 0);
  };

  // 画面で分かる誤り（サーバーでも確かめるが、押す前に伝える）。
  const problems: string[] = [];
  if (trimmedPath === "") problems.push("プロジェクトのフォルダを入力してください。");
  if (name.trim() === "") problems.push("プロジェクトの名前を入力してください。");
  const ids = languages.map((l) => l.id.trim());
  if (ids.some((id) => id === "")) problems.push("言語の ID が空の行があります。");
  const duplicate = ids.find((id, i) => id !== "" && ids.indexOf(id) !== i);
  if (duplicate !== undefined) problems.push(`言語の ID "${duplicate}" が重複しています。`);
  if (hasFiles && reference) {
    const used = new Map<string, string>([[key, "キー"]]);
    for (const l of languages) {
      const h = headerOf(l);
      if (h === "") continue;
      const other = used.get(h);
      if (other !== undefined) {
        problems.push(`列「${h}」を、${other}と言語 "${l.id.trim()}" の本文の両方に選んでいます。`);
        break;
      }
      used.set(h, `言語 "${l.id.trim()}" の本文`);
    }
  }
  if (!hasFiles && makeFirst && firstResource.trim() === "") problems.push("最初のファイルの場所を入力してください。");
  const alreadyProject = folder?.configFile !== undefined;
  const disabled = busy || inspecting || alreadyProject || folderError !== null || problems.length > 0;

  const submit = async () => {
    const sourceRow = languages.find((l) => l.n === source) ?? languages[0];
    const sourceId = sourceRow?.id.trim();
    const input: NewProjectInput = {
      root: trimmedPath,
      name: name.trim(),
      languages: languages.map((l) => {
        const id = l.id.trim();
        const isSource = l.n === sourceRow?.n;
        return {
          id,
          label: l.label.trim(),
          // 原文は表の固定側に置き、ほかの言語は原文をもとに翻訳する。
          ...(isSource ? { pinned: true } : sourceId ? { basedOn: sourceId } : {}),
        };
      }),
      statusColumn,
      reviewColumn,
      validators,
    };
    if (hasFiles) {
      const text: Record<string, string> = {};
      for (const l of languages) {
        const h = headerOf(l);
        if (h !== "") text[l.id.trim()] = h;
      }
      input.mapping = {
        // 先頭の列がキーなら、書かなくても同じ動きになる。
        ...(reference && key !== "" && key !== headers[0] ? { key } : {}),
        ...(Object.keys(text).length > 0 ? { text } : {}),
        ...(encoding !== "auto" ? { encoding } : {}),
      };
    } else if (makeFirst) {
      input.firstResource = firstResource.trim();
    }
    setBusy(true);
    setError(null);
    try {
      const res = (await postJson("/api/session/create", input, onUnauthorized ? { onUnauthorized } : {})) as CreatedProject;
      onCreated(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <main className="open-project">
      <div className="open-card new-project">
        <h1 className="open-title">
          <span className="logo" aria-hidden="true">
            ◧
          </span>{" "}
          新しいプロジェクトを作る
        </h1>
        <form
          className="new-project-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled) void submit();
          }}
        >
          <section className="new-project-section" aria-labelledby="np-folder">
            <h2 className="section-title" id="np-folder">
              1. フォルダ
            </h2>
            <label htmlFor="new-project-path" className="field-label">
              プロジェクトを置くフォルダ。翻訳のテキスト（CSV / TSV）のあるフォルダか、これから作るフォルダを指定します。
            </label>
            <div className="row">
              <input
                id="new-project-path"
                className="input mono grow"
                value={path}
                onChange={(e) => changePath(e.target.value)}
                placeholder="プロジェクトのフォルダの絶対パス"
                autoFocus
              />
              {canPick && (
                <button type="button" className="btn" onClick={() => void pick()}>
                  フォルダを選ぶ…
                </button>
              )}
            </div>
            <div className="new-project-status" role="status" aria-live="polite">
              {inspecting && <span className="muted small">フォルダを確かめています…</span>}
              {folderError && <span className="hint-error">{folderError}</span>}
              {folder && !folder.exists && <span className="muted small">このフォルダはまだありません。プロジェクトを作るときに、一緒に作ります。</span>}
              {folder && folder.exists && alreadyProject && (
                <span className="hint-error">
                  このフォルダには、すでにプロジェクトがあります（{folder.configFile}）。{" "}
                  <button type="button" className="btn small" onClick={() => onOpenExisting(folder.root)}>
                    このプロジェクトを開く
                  </button>
                </span>
              )}
              {folder && folder.exists && !alreadyProject && !hasFiles && <span className="muted small">CSV / TSV のないフォルダです。最初のファイルを一緒に作れます。</span>}
              {folder && folder.exists && !alreadyProject && hasFiles && (
                <span className="muted small">CSV / TSV が {folder.totalResources} 個あります。下の「3. すでにあるファイルの列」で、キーと本文の列を選んでください。</span>
              )}
            </div>
            <label htmlFor="new-project-name" className="field-label">
              プロジェクトの名前
            </label>
            <input
              id="new-project-name"
              className="input"
              value={name}
              onChange={(e) => {
                nameTouched.current = true;
                setName(e.target.value);
              }}
            />
          </section>

          <section className="new-project-section" aria-labelledby="np-languages">
            <h2 className="section-title" id="np-languages">
              2. 言語
            </h2>
            <p className="muted small">
              翻訳する言語を並べます。ID は、ファイルの列やコマンドで使う短い名前です（半角の英数字と - _）。原文に選んだ言語をもとに、ほかの言語を翻訳します。あとから、設定ファイル（loc-studio.project.json）の languages で足せます。
            </p>
            <table className="table new-project-languages">
              <thead>
                <tr>
                  <th scope="col">原文</th>
                  <th scope="col">ID</th>
                  <th scope="col">表示名</th>
                  <th scope="col" aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {languages.map((l, i) => (
                  <tr key={l.n}>
                    <td>
                      <input type="radio" name="new-project-source" aria-label={`${i + 1} 番目の言語を原文にする`} checked={(languages.find((x) => x.n === source) ?? languages[0])?.n === l.n} onChange={() => setSource(l.n)} />
                    </td>
                    <td>
                      <input className="input mono small" aria-label={`${i + 1} 番目の言語の ID`} value={l.id} onChange={(e) => updateLanguage(l.n, { id: e.target.value })} placeholder="ja" />
                    </td>
                    <td>
                      <input className="input small" aria-label={`${i + 1} 番目の言語の表示名`} value={l.label} onChange={(e) => updateLanguage(l.n, { label: e.target.value })} placeholder="日本語" />
                    </td>
                    <td>
                      <button type="button" className="btn small ghost" aria-label={`${i + 1} 番目の言語を外す`} disabled={languages.length <= 1} onClick={() => removeLanguage(l.n)}>
                        外す
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <button type="button" className="btn small" onClick={addLanguage}>
                言語を足す
              </button>
            </div>
          </section>

          {hasFiles ? (
            <section className="new-project-section" aria-labelledby="np-files">
              <h2 className="section-title" id="np-files">
                3. すでにあるファイルの列
              </h2>
              <label htmlFor="new-project-encoding" className="field-label">
                ファイルの文字コード
              </label>
              <select id="new-project-encoding" className="input" value={encoding} onChange={(e) => setEncoding(e.target.value)}>
                {ENCODINGS.map((e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                  </option>
                ))}
              </select>
              {reference ? (
                <>
                  <p className="muted small">
                    <span className="mono">{reference.path}</span> の見出しから選びます。本文の列がまだない言語は「（列なし）」のままにすると、最初に本文を書いたときに、言語の ID を見出しにした列を足します。
                  </p>
                  <label htmlFor="new-project-key" className="field-label">
                    キーの列（行を見分ける ID の列）
                  </label>
                  <select id="new-project-key" className="input" value={key} onChange={(e) => setKeyHeader(e.target.value)}>
                    {headers.map((h, i) => (
                      <option key={`${i}:${h}`} value={h}>
                        {h === "" ? "（見出しなし）" : h}
                      </option>
                    ))}
                  </select>
                  {languages.map((l, i) => (
                    <div key={l.n} className="new-project-map">
                      <label htmlFor={`new-project-text-${l.n}`} className="field-label">
                        {l.label.trim() || l.id.trim() || `${i + 1} 番目の言語`} の本文の列
                      </label>
                      <select id={`new-project-text-${l.n}`} className="input" value={headerOf(l)} onChange={(e) => setChosen((c) => ({ ...c, [l.n]: e.target.value }))}>
                        <option value="">（列なし）</option>
                        {headers
                          .filter((h) => h !== "")
                          .map((h, hi) => (
                            <option key={`${hi}:${h}`} value={h}>
                              {h}
                            </option>
                          ))}
                      </select>
                    </div>
                  ))}
                  {different.length > 0 && (
                    <p className="muted small">
                      見出しの並びが違うファイルが {different.length} 個あります（{different.slice(0, 3).map((r) => r.path).join("、")}
                      {different.length > 3 ? " ほか" : ""}）。同じ名前の列があれば、そのファイルでも同じ対応で読みます。
                    </p>
                  )}
                </>
              ) : (
                <p className="hint-error">ファイルの見出しを読めませんでした。文字コードを選び直してください。</p>
              )}
              {unreadable.length > 0 && (
                <p className="hint-error">
                  読めなかったファイルが {unreadable.length} 個あります: <span className="mono">{unreadable[0]!.path}</span>（{unreadable[0]!.error}）
                </p>
              )}
            </section>
          ) : (
            <section className="new-project-section" aria-labelledby="np-first">
              <h2 className="section-title" id="np-first">
                3. 最初のファイル
              </h2>
              <label className="check">
                <input type="checkbox" checked={makeFirst} onChange={(e) => setMakeFirst(e.target.checked)} />
                <span>テキストを入れる最初のファイルを作る</span>
              </label>
              <label htmlFor="new-project-first" className="field-label">
                ファイルの場所（プロジェクトのフォルダからの相対パス。.csv か .tsv）
              </label>
              <input id="new-project-first" className="input mono" value={firstResource} disabled={!makeFirst} onChange={(e) => setFirstResource(e.target.value)} />
              <p className="muted small">キーの列と、言語ごとの本文の列だけがある、行のないファイルを作ります。ファイルは、あとから足せます。</p>
            </section>
          )}

          <section className="new-project-section" aria-labelledby="np-options">
            <h2 className="section-title" id="np-options">
              4. 使う機能
            </h2>
            <label className="check">
              <input type="checkbox" checked={statusColumn} onChange={(e) => setStatusColumn(e.target.checked)} />
              <span>進捗の列を付ける（未着手、作業中、確定）</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={reviewColumn} onChange={(e) => setReviewColumn(e.target.checked)} />
              <span>レビューの列を付ける（未レビュー、レビュー中、差し戻し、承認）</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={validators} onChange={(e) => setValidators(e.target.checked)} />
              <span>基本の検証を付ける（前後の空白、未翻訳）</span>
            </label>
            <p className="muted small">ここで選んだ内容は、プロジェクトの設定ファイル（loc-studio.project.json）に書かれます。列、選択肢の名前、検証の規則は、あとからそのファイルで変えられます。</p>
          </section>

          {problems.length > 0 && trimmedPath !== "" && (
            <p className="muted small" data-testid="new-project-problem">
              {problems[0]}
            </p>
          )}
          {error && (
            <p className="hint-error" role="alert">
              {error}
            </p>
          )}
          <div className="row new-project-actions">
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              戻る
            </button>
            <span className="grow" />
            <button type="submit" className="btn primary" disabled={disabled}>
              {busy ? "作っています…" : "プロジェクトを作る"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
