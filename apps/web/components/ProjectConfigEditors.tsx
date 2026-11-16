"use client";
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef, FormatUse, LanguageDef, ValidatorUse } from "@loc-studio/sdk";
import type { AvailableExtensions } from "@loc-studio/server";
import { postJson } from "@/lib/client/api";
import {
  columnIdOf,
  columnKindOf,
  columnProblems,
  columnUseOf,
  defaultColumnEntries,
  languageProblems,
  MAPPING_ENCODINGS,
  mappingProblems,
  newColumnEntry,
  newLanguage,
  parseEntryJson,
  readMapping,
  suggestColumnId,
  validatorUseOf,
  withSeverity,
  writeMapping,
  type ColumnEntry,
  type DelimitedMapping,
  type ValidatorEntry,
} from "@/lib/client/config-edit";

/*
 * 設定の画面の、プロジェクト設定の編集（言語、列、検証、CSV / TSV の列の対応）。
 * どれも、いまの設定を手元で書き換え、「保存」で設定の項目（languages など）をまるごと置き換える。
 * 画面に欄のない項目（選択肢、オプションなど）は「詳細」で JSON のまま書ける。保存した設定は、サーバーが読み直して確かめる。
 */

interface EditorProps {
  /** 変えられない理由があるとき（コードの設定にある、権限がない）は true。 */
  locked: boolean;
  busy: boolean;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

function Problems({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="plain-list small hint-error" role="alert">
      {problems.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

/** 1 つの項目を JSON のまま書き換える欄。 */
function JsonDetail({ label, value, allowString, disabled, onApply }: { label: string; value: unknown; allowString: boolean; disabled: boolean; onApply(value: unknown): void }) {
  const initial = JSON.stringify(value, null, 2);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(initial), [initial]);
  return (
    <div className="config-detail">
      <textarea className="input mono" rows={Math.min(14, Math.max(3, text.split("\n").length))} aria-label={label} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} />
      <button
        type="button"
        className="btn small"
        disabled={disabled || text === initial}
        onClick={() => {
          const r = parseEntryJson(text, allowString);
          if ("error" in r) return setError(r.error);
          setError(null);
          onApply(r.value);
        }}
      >
        この内容にする
      </button>
      {error && <span className="hint-error">{error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 言語
// ---------------------------------------------------------------------------

export function LanguagesEditor({ languages, locked, busy, onSave }: EditorProps & { languages: LanguageDef[]; onSave(languages: LanguageDef[]): void }) {
  const [draft, setDraft] = useState<LanguageDef[]>(languages);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const original = useMemo(() => languages.map((l) => l.id), [languages]);
  const problems = languageProblems(draft, original);
  const off = locked || busy;
  const patch = (i: number, change: (l: LanguageDef) => LanguageDef) => setDraft((d) => d.map((l, j) => (j === i ? change(l) : l)));

  return (
    <>
      <table className="table small config-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>表示名</th>
            <th>基にする言語</th>
            <th>固定</th>
            <th>並びと削除</th>
          </tr>
        </thead>
        <tbody>
          {draft.map((l, i) => (
            <tr key={l.id}>
              <td className="mono">{l.id}</td>
              <td>
                <input className="input" aria-label={`${l.id} の表示名`} value={l.label} disabled={off} onChange={(e) => patch(i, (x) => ({ ...x, label: e.target.value }))} />
              </td>
              <td>
                <select
                  className="input"
                  aria-label={`${l.id} の基にする言語`}
                  value={l.basedOn ?? ""}
                  disabled={off}
                  onChange={(e) =>
                    patch(i, (x) => {
                      const { basedOn: _basedOn, ...rest } = x;
                      return e.target.value === "" ? rest : { ...rest, basedOn: e.target.value };
                    })
                  }
                >
                  <option value="">（原文）</option>
                  {draft
                    .filter((o) => o.id !== l.id)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}（{o.id}）
                      </option>
                    ))}
                  {l.basedOn !== undefined && !draft.some((o) => o.id === l.basedOn) && <option value={l.basedOn}>{l.basedOn}（ありません）</option>}
                </select>
              </td>
              <td>
                {Array.isArray(l.pinned) ? (
                  <span className="muted" title="固定する列が設定ファイルで決められています">
                    列ごと
                  </span>
                ) : (
                  <input
                    type="checkbox"
                    aria-label={`${l.id} を表の固定側に置く`}
                    checked={l.pinned === true}
                    disabled={off}
                    onChange={(e) =>
                      patch(i, (x) => {
                        const { pinned: _pinned, ...rest } = x;
                        return e.target.checked ? { ...rest, pinned: true } : rest;
                      })
                    }
                  />
                )}
              </td>
              <td className="config-row-buttons">
                <button type="button" className="btn small" aria-label={`${l.id} を上へ`} disabled={off || i === 0} onClick={() => setDraft((d) => move(d, i, i - 1))}>
                  ↑
                </button>
                <button type="button" className="btn small" aria-label={`${l.id} を下へ`} disabled={off || i === draft.length - 1} onClick={() => setDraft((d) => move(d, i, i + 1))}>
                  ↓
                </button>
                <button type="button" className="btn small" aria-label={`${l.id} を削除`} disabled={off} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!locked && (
        <div className="setting-row">
          <input className="input mono" aria-label="追加する言語の ID" placeholder="ID（例: en）" value={newId} disabled={busy} onChange={(e) => setNewId(e.target.value)} />
          <input className="input" aria-label="追加する言語の表示名" placeholder="表示名（例: 英語）" value={newLabel} disabled={busy} onChange={(e) => setNewLabel(e.target.value)} />
          <button
            type="button"
            className="btn small"
            disabled={busy || newId.trim() === ""}
            onClick={() => {
              setDraft((d) => [...d, newLanguage(d, newId.trim(), newLabel)]);
              setNewId("");
              setNewLabel("");
            }}
          >
            言語を追加
          </button>
        </div>
      )}
      <Problems problems={problems} />
      <p className="muted small">
        言語を消しても、ファイルの中のその言語の本文は消えません。ID を変えたいときや、ここに欄のない項目（読み取り専用、グループなど）は、設定ファイルで変えます。
      </p>
      {!locked && (
        <button type="button" className="btn small primary" disabled={busy || problems.length > 0 || same(draft, languages)} onClick={() => onSave(draft)}>
          言語を保存
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 列
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<ColumnDef["kind"], string> = {
  key: "キー",
  text: "本文",
  meta: "値を持つ列",
  review: "レビュー",
  computed: "計算",
  generated: "生成",
  actions: "アクション",
};

export function ColumnsEditor({
  columns,
  resolved,
  available,
  locked,
  busy,
  onSave,
}: EditorProps & { columns: ColumnEntry[] | undefined; resolved: ColumnDef[]; available: AvailableExtensions["columns"]; onSave(columns: ColumnEntry[]): void }) {
  const initial = useMemo(() => columns ?? defaultColumnEntries(), [columns]);
  const [draft, setDraft] = useState<ColumnEntry[]>(initial);
  const [detail, setDetail] = useState<number | null>(null);
  const [addUse, setAddUse] = useState("");
  const [addId, setAddId] = useState("");
  const problems = columnProblems(draft, available);
  const off = locked || busy;
  const ids = draft.map(columnIdOf);
  const addable = available.find((a) => a.id === addUse);

  return (
    <>
      {columns === undefined && <p className="muted small">設定に列の並び（columns）がないので、既定の 2 列（キーと本文）を使っています。列を足して保存すると、設定に書きます。</p>}
      <table className="table small config-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>表示名</th>
            <th>種類</th>
            <th>並びと削除</th>
          </tr>
        </thead>
        <tbody>
          {draft.map((entry, i) => {
            const id = columnIdOf(entry);
            const use = columnUseOf(entry);
            const kind = columnKindOf(entry, available);
            const label = (entry as { label?: unknown }).label;
            const fallback = resolved.find((c) => c.id === id)?.label ?? available.find((a) => a.id === use)?.label ?? "";
            return (
              <tr key={`${id}-${i}`}>
                <td className="mono">{id || "（なし）"}</td>
                <td>
                  <input
                    className="input"
                    aria-label={`列 ${id} の表示名`}
                    value={typeof label === "string" ? label : ""}
                    placeholder={fallback}
                    disabled={off}
                    onChange={(e) =>
                      setDraft((d) =>
                        d.map((x, j) => {
                          if (j !== i) return x;
                          const { label: _label, ...rest } = x as ColumnEntry & { label?: string };
                          return (e.target.value === "" ? rest : { ...rest, label: e.target.value }) as ColumnEntry;
                        }),
                      )
                    }
                  />
                </td>
                <td>
                  {kind ? KIND_LABEL[kind] : <span className="hint-error">登録されていません</span>}
                  {use !== undefined && <span className="muted mono"> {use}</span>}
                </td>
                <td className="config-row-buttons">
                  <button type="button" className="btn small" aria-label={`列 ${id} を上へ`} disabled={off || i === 0} onClick={() => (setDetail(null), setDraft((d) => move(d, i, i - 1)))}>
                    ↑
                  </button>
                  <button type="button" className="btn small" aria-label={`列 ${id} を下へ`} disabled={off || i === draft.length - 1} onClick={() => (setDetail(null), setDraft((d) => move(d, i, i + 1)))}>
                    ↓
                  </button>
                  <button type="button" className="btn small" aria-label={`列 ${id} の詳細`} aria-expanded={detail === i} onClick={() => setDetail((cur) => (cur === i ? null : i))}>
                    詳細
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    aria-label={`列 ${id} を削除`}
                    disabled={off || kind === "key" || kind === "text"}
                    title={kind === "key" || kind === "text" ? "キーと本文の列は消せません" : undefined}
                    onClick={() => (setDetail(null), setDraft((d) => d.filter((_, j) => j !== i)))}
                  >
                    削除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {detail !== null && draft[detail] !== undefined && (
        <>
          <p className="muted small">
            列 <span className="mono">{columnIdOf(draft[detail]!)}</span> の設定（JSON）。選択肢（type.enum）、対象の言語（languages）、対象の列（of）など、上に欄のない項目を書けます。書き方は docs/CONFIG.md にあります。
          </p>
          <JsonDetail
            label={`列 ${columnIdOf(draft[detail]!)} の設定（JSON）`}
            value={draft[detail]}
            allowString={false}
            disabled={off}
            onApply={(value) => setDraft((d) => d.map((x, j) => (j === detail ? (value as ColumnEntry) : x)))}
          />
        </>
      )}
      {!locked && (
        <div className="setting-row">
          <select
            className="input"
            aria-label="追加する列"
            value={addUse}
            disabled={busy}
            onChange={(e) => {
              setAddUse(e.target.value);
              setAddId(e.target.value === "" ? "" : suggestColumnId(e.target.value, ids));
            }}
          >
            <option value="">追加する列を選ぶ…</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label ?? KIND_LABEL[a.kind]}（{a.id}）
              </option>
            ))}
          </select>
          <input className="input mono" aria-label="追加する列の ID" placeholder="列の ID" value={addId} disabled={busy || !addable} onChange={(e) => setAddId(e.target.value)} />
          <button
            type="button"
            className="btn small"
            disabled={busy || !addable || addId.trim() === ""}
            onClick={() => {
              if (!addable) return;
              setDraft((d) => [...d, newColumnEntry(addable, addId.trim(), d, available)]);
              setAddUse("");
              setAddId("");
            }}
          >
            列を追加
          </button>
        </div>
      )}
      <Problems problems={problems} />
      <p className="muted small">列を消しても、保存してあった値（ステータスやレビューなど）は消えません。同じ ID の列を足し直すと、また見えます。</p>
      {!locked && (
        <button type="button" className="btn small primary" disabled={busy || problems.length > 0 || same(draft, initial)} onClick={() => onSave(draft)}>
          列を保存
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

const SEVERITY_LABEL: Record<NonNullable<ValidatorUse["severity"]>, string> = { error: "エラー", warning: "警告", info: "情報" };

export function ValidatorsEditor({
  validators,
  available,
  locked,
  busy,
  onSave,
}: EditorProps & { validators: ValidatorEntry[] | undefined; available: AvailableExtensions["validators"]; onSave(validators: ValidatorEntry[]): void }) {
  const initial = useMemo(() => validators ?? [], [validators]);
  const [draft, setDraft] = useState<ValidatorEntry[]>(initial);
  const [detail, setDetail] = useState<number | null>(null);
  const [addUse, setAddUse] = useState("");
  const off = locked || busy;

  return (
    <>
      <table className="table small config-table">
        <thead>
          <tr>
            <th>検証</th>
            <th>重さ</th>
            <th>絞り込みとオプション</th>
            <th>削除</th>
          </tr>
        </thead>
        <tbody>
          {draft.map((entry, i) => {
            const use = validatorUseOf(entry);
            const known = available.find((a) => a.id === use);
            const o = typeof entry === "string" ? undefined : entry;
            const notes = [
              o?.languages ? `言語: ${o.languages.join(", ")}` : "",
              o?.columns ? `列: ${o.columns.join(", ")}` : "",
              o?.options && Object.keys(o.options).length > 0 ? "オプションあり" : "",
            ].filter(Boolean);
            const name = `${known?.label ?? use}（${i + 1} 番目）`;
            return (
              <tr key={`${use}-${i}`}>
                <td>
                  {known ? known.label : <span className="hint-error">登録されていません</span>} <span className="muted mono">{use}</span>
                </td>
                <td>
                  <select
                    className="input"
                    aria-label={`${name}の重さ`}
                    value={o?.severity ?? ""}
                    disabled={off}
                    onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? withSeverity(x, (e.target.value || undefined) as ValidatorUse["severity"] | undefined) : x)))}
                  >
                    <option value="">検証の既定</option>
                    {(["error", "warning", "info"] as const).map((s) => (
                      <option key={s} value={s}>
                        {SEVERITY_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="muted">{notes.join(" / ")}</td>
                <td className="config-row-buttons">
                  <button type="button" className="btn small" aria-label={`${name}の詳細`} aria-expanded={detail === i} onClick={() => setDetail((cur) => (cur === i ? null : i))}>
                    詳細
                  </button>
                  <button type="button" className="btn small" aria-label={`${name}を削除`} disabled={off} onClick={() => (setDetail(null), setDraft((d) => d.filter((_, j) => j !== i)))}>
                    削除
                  </button>
                </td>
              </tr>
            );
          })}
          {draft.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                検証を使っていません。
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {detail !== null && draft[detail] !== undefined && (
        <>
          <p className="muted small">
            <span className="mono">{validatorUseOf(draft[detail]!)}</span> の設定（JSON）。オプション（options）、対象の言語（languages）、対象の列（columns）を書けます。
          </p>
          <JsonDetail
            label={`${validatorUseOf(draft[detail]!)} の設定（JSON）`}
            value={typeof draft[detail] === "string" ? { use: draft[detail] } : draft[detail]}
            allowString
            disabled={off}
            onApply={(value) => setDraft((d) => d.map((x, j) => (j === detail ? (value as ValidatorEntry) : x)))}
          />
        </>
      )}
      {!locked && (
        <div className="setting-row">
          <select className="input" aria-label="追加する検証" value={addUse} disabled={busy} onChange={(e) => setAddUse(e.target.value)}>
            <option value="">追加する検証を選ぶ…</option>
            {available.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}（{a.id}）
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn small"
            disabled={busy || addUse === ""}
            onClick={() => {
              setDraft((d) => [...d, addUse]);
              setAddUse("");
            }}
          >
            検証を追加
          </button>
        </div>
      )}
      {!locked && (
        <button type="button" className="btn small primary" disabled={busy || same(draft, initial)} onClick={() => onSave(draft)}>
          検証を保存
        </button>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// CSV / TSV の列の対応
// ---------------------------------------------------------------------------

const ENCODING_LABEL: Record<(typeof MAPPING_ENCODINGS)[number], string> = {
  auto: "自動（UTF-8。BOM があれば UTF-16）",
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16LE",
  "utf-16be": "UTF-16BE",
  shift_jis: "Shift_JIS",
};

export function MappingEditor({
  formats,
  languages,
  inspectRoot,
  locked,
  busy,
  onSave,
}: EditorProps & {
  formats: FormatUse[] | undefined;
  languages: LanguageDef[];
  /** ローカルモードのとき: プロジェクトのフォルダ。ファイルの見出しを、入力の候補に出す。 */
  inspectRoot?: string;
  onSave(formats: FormatUse[] | null): void;
}) {
  const read = useMemo(() => readMapping(formats), [formats]);
  const initial: DelimitedMapping = "mapping" in read ? read.mapping : { key: "", text: {}, encoding: "auto" };
  const [draft, setDraft] = useState<DelimitedMapping>(initial);
  const [headers, setHeaders] = useState<string[]>([]);
  const ids = languages.map((l) => l.id);
  const off = locked || busy;

  // 見出しの候補。入力を助けるだけなので、読めなくても何も出さない（欄にはそのまま書ける）。
  useEffect(() => {
    if (!inspectRoot || "reason" in read) return;
    let alive = true;
    postJson("/api/session/inspect", { path: inspectRoot, ...(draft.encoding !== "auto" ? { encoding: draft.encoding } : {}) })
      .then((r) => {
        const resources = (r as { resources?: { headers?: string[] }[] }).resources ?? [];
        if (alive) setHeaders([...new Set(resources.flatMap((x) => x.headers ?? []))].filter((h) => h !== ""));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectRoot, draft.encoding]);

  if ("reason" in read) return <p className="muted small">{read.reason}</p>;
  const problems = mappingProblems(draft, ids);
  const next = writeMapping(formats, draft, ids);
  const dirty = !same(next, formats ?? null);

  return (
    <>
      <p className="muted small">
        CSV / TSV の見出しの行にある名前を書きます。空のままにすると、キーは先頭の列、本文は言語の ID と同じ見出しの列を使います。
      </p>
      <datalist id="ps-mapping-headers">
        {headers.map((h) => (
          <option key={h} value={h} />
        ))}
      </datalist>
      <div className="setting-row">
        <label htmlFor="ps-mapping-key">キーの列の見出し</label>
        <input id="ps-mapping-key" className="input mono" list="ps-mapping-headers" placeholder="（先頭の列）" value={draft.key} disabled={off} onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))} />
      </div>
      {languages.map((l) => (
        <div className="setting-row" key={l.id}>
          <label htmlFor={`ps-mapping-text-${l.id}`}>
            {l.label}（{l.id}）の本文の列の見出し
          </label>
          <input
            id={`ps-mapping-text-${l.id}`}
            className="input mono"
            list="ps-mapping-headers"
            placeholder={l.id}
            value={draft.text[l.id] ?? ""}
            disabled={off}
            onChange={(e) => setDraft((d) => ({ ...d, text: { ...d.text, [l.id]: e.target.value } }))}
          />
        </div>
      ))}
      <div className="setting-row">
        <label htmlFor="ps-mapping-encoding">ファイルの文字コード</label>
        <select id="ps-mapping-encoding" className="input" value={draft.encoding} disabled={off} onChange={(e) => setDraft((d) => ({ ...d, encoding: e.target.value }))}>
          {MAPPING_ENCODINGS.map((e) => (
            <option key={e} value={e}>
              {ENCODING_LABEL[e]}
            </option>
          ))}
          {!(MAPPING_ENCODINGS as readonly string[]).includes(draft.encoding) && <option value={draft.encoding}>{draft.encoding}</option>}
        </select>
      </div>
      <Problems problems={problems} />
      {!locked && (
        <button type="button" className="btn small primary" disabled={busy || problems.length > 0 || !dirty} onClick={() => onSave(next)}>
          列の対応を保存
        </button>
      )}
    </>
  );
}
