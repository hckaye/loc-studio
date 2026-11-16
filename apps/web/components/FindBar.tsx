"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProjectInfo } from "@loc-studio/server";
import { columnLabel, type ColumnDef } from "@/lib/client/model";
import type { Favorite } from "@/lib/client/prefs";
import {
  applySuggestion,
  builderToText,
  defaultCondition,
  opsFor,
  queryFields,
  suggest,
  type BuilderCondition,
  type BuilderState,
  type QueryFieldInfo,
  type SuggestResult,
} from "@/lib/client/query-text";

/*
 * ツールバーの「条件」「お気に入り」「列」。
 * - 条件: 欄・言語・比べ方・値を選んで条件を組み立てる（式の書き方を知らなくてよい）。式を直接書くこともでき、そのときは補完が出る。
 * - お気に入り: いまの絞り込みと並べ替えに名前を付けて覚える（その PC に保存）。
 * - 列: 列ごとに表示するかを選ぶ。組み合わせに名前を付けて覚えられる。
 */

/** 外側を押すか Escape で閉じる、ボタンの下の小さな窓。 */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setOpen(false);
  };
  return { open, setOpen, ref, onKeyDown };
}

// ---------------------------------------------------------------------------
// 条件
// ---------------------------------------------------------------------------

export interface QueryPanelProps {
  info: ProjectInfo;
  where: string;
  builder: BuilderState | null;
  /** 条件を当てる。builder は、組み立てた条件を当てたときの並び（式を手で書いたときは null）。 */
  onApply(where: string, builder: BuilderState | null): void;
  /** 式をサーバーで確かめる。正しければ null、誤りがあればその説明。 */
  validate(where: string): Promise<string | null>;
}

const LANGUAGE_ANY = "any";
const LANGUAGE_ALL = "all";

function ConditionRow({
  cond,
  fields,
  info,
  index,
  onChange,
  onRemove,
}: {
  cond: BuilderCondition;
  fields: QueryFieldInfo[];
  info: ProjectInfo;
  index: number;
  onChange(next: BuilderCondition): void;
  onRemove(): void;
}) {
  const field = fields.find((f) => f.name === cond.field) ?? fields[0]!;
  const ops = opsFor(field);
  const op = ops.find((o) => o.id === cond.op) ?? ops[0]!;
  const n = index + 1;
  const langLabel = (id: string) => info.languages.find((l) => l.id === id)?.label ?? id;
  return (
    <div className="query-row" role="group" aria-label={`条件 ${n}`}>
      <select
        className="input small"
        aria-label={`条件 ${n} の欄`}
        value={field.name}
        onChange={(e) => {
          const next = fields.find((f) => f.name === e.target.value);
          // 言語ごとの欄どうしなら、選んでいた言語を引き継ぐ。
          if (next) onChange(defaultCondition(next, next.perLanguage && field.perLanguage ? cond.language : undefined));
        }}
      >
        <optgroup label="列">
          {fields
            .filter((f) => !f.builtin)
            .map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
        </optgroup>
        <optgroup label="そのほか">
          {fields
            .filter((f) => f.builtin)
            .map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
        </optgroup>
      </select>
      {field.perLanguage && (
        <select className="input small" aria-label={`条件 ${n} の言語`} value={cond.language || LANGUAGE_ANY} onChange={(e) => onChange({ ...cond, language: e.target.value })}>
          <option value={LANGUAGE_ANY}>表示中のどれかの言語</option>
          <option value={LANGUAGE_ALL}>表示中のすべての言語</option>
          {field.languages.map((l) => (
            <option key={l} value={l}>
              {langLabel(l)}
            </option>
          ))}
        </select>
      )}
      <select className="input small" aria-label={`条件 ${n} の比べ方`} value={op.id} onChange={(e) => onChange({ ...cond, op: e.target.value })}>
        {ops.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {op.needsValue &&
        (field.options ? (
          <select className="input small" aria-label={`条件 ${n} の値`} value={cond.value} onChange={(e) => onChange({ ...cond, value: e.target.value })}>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input small query-value"
            type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
            aria-label={`条件 ${n} の値`}
            placeholder={field.type === "code" ? "問題の種類（例: too-long）" : "値"}
            value={cond.value}
            onChange={(e) => onChange({ ...cond, value: e.target.value })}
          />
        ))}
      <button type="button" className="icon-btn" aria-label={`条件 ${n} を削除`} title="この条件を削除" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

/** 式の入力欄。カーソルの位置に合わせて、入れられるもの（欄、比べ方、値、and / or）を出す。 */
function QueryTextInput({ value, onChange, fields, info, onSubmit }: { value: string; onChange(v: string): void; fields: QueryFieldInfo[]; info: ProjectInfo; onSubmit(): void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [active, setActive] = useState(0);
  const caretRef = useRef<number | null>(null);
  const refresh = (text: string, caret: number) => {
    const r = suggest(text, caret, fields, info);
    setResult(r.items.length > 0 ? r : null);
    setActive(0);
  };
  // 候補を入れたあと、カーソルを入れた文字の後ろに置く。
  useLayoutEffect(() => {
    if (caretRef.current === null || !inputRef.current) return;
    inputRef.current.setSelectionRange(caretRef.current, caretRef.current);
    caretRef.current = null;
  }, [value]);
  const accept = (index: number) => {
    const item = result?.items[index];
    if (!result || !item) return;
    const next = applySuggestion(value, result, item);
    caretRef.current = next.caret;
    onChange(next.text);
    refresh(next.text, next.caret);
  };
  return (
    <div className="query-text">
      <input
        ref={inputRef}
        type="text"
        className="input mono"
        aria-label="条件式"
        role="combobox"
        aria-expanded={result !== null}
        aria-controls="query-suggestions"
        aria-autocomplete="list"
        aria-activedescendant={result ? `query-suggestion-${active}` : undefined}
        placeholder='例: textStatus@ja = done and text@en is empty'
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onFocus={(e) => refresh(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onClick={(e) => refresh(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === " " && e.ctrlKey) {
            e.preventDefault();
            refresh(value, e.currentTarget.selectionStart ?? value.length);
            return;
          }
          if (!result) {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(result.items.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            accept(active);
          } else if (e.key === "Escape") {
            // 候補だけを閉じる（窓は閉じない）。
            e.preventDefault();
            e.stopPropagation();
            setResult(null);
          }
        }}
      />
      {result && (
        <ul className="query-suggestions" id="query-suggestions" role="listbox" aria-label="入れられるもの">
          {result.items.map((item, i) => (
            <li
              key={`${item.label}-${i}`}
              id={`query-suggestion-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : undefined}
              // mousedown で入力欄のフォーカスを失わないようにする
              onMouseDown={(e) => {
                e.preventDefault();
                accept(i);
              }}
            >
              <span className="mono">{item.label}</span>
              {item.detail && <span className="muted small">{item.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QueryPanel({ info, where, builder, onApply, validate }: QueryPanelProps) {
  const pop = usePopover();
  const fields = useMemo(() => queryFields(info), [info]);
  const firstField = fields[0];
  const [mode, setMode] = useState<"build" | "text">("build");
  const [state, setState] = useState<BuilderState>({ join: "and", conditions: [] });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 開くたびに、いま当てている条件から始める。
  const openPanel = () => {
    if (builder) {
      setMode("build");
      setState(builder);
      setText(builderToText(builder, fields));
    } else if (where.trim() !== "") {
      setMode("text");
      setText(where);
      setState({ join: "and", conditions: [] });
    } else {
      setMode("build");
      setState({ join: "and", conditions: firstField ? [defaultCondition(firstField)] : [] });
      setText("");
    }
    setError(null);
    pop.setOpen(true);
  };

  const built = builderToText(state, fields);
  const current = mode === "build" ? built : text.trim();

  const apply = async () => {
    setBusy(true);
    try {
      const problem = current === "" ? null : await validate(current);
      if (problem !== null) {
        setError(problem);
        return;
      }
      onApply(current, mode === "build" && current !== "" ? state : null);
      pop.setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const setCondition = (i: number, next: BuilderCondition) => {
    setError(null);
    setState((s) => ({ ...s, conditions: s.conditions.map((c, j) => (j === i ? next : c)) }));
  };

  const active = where.trim() !== "";
  return (
    <div className="popover-anchor" ref={pop.ref} onKeyDown={pop.onKeyDown}>
      <button
        type="button"
        className={`btn small${active ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        title={active ? `条件: ${where}` : "列の値、空かどうか、検証の問題などを組み合わせて絞り込む"}
        onClick={() => (pop.open ? pop.setOpen(false) : openPanel())}
      >
        条件{active && <span className="count-badge">{builder ? builder.conditions.length : "式"}</span>} ▾
      </button>
      {pop.open && (
        <div className="popover query-panel" role="dialog" aria-label="条件で絞り込む">
          <div className="seg" role="group" aria-label="条件の作り方">
            <button type="button" className={`seg-btn${mode === "build" ? " on" : ""}`} aria-pressed={mode === "build"} onClick={() => (setMode("build"), setError(null))}>
              選んで組み立てる
            </button>
            <button
              type="button"
              className={`seg-btn${mode === "text" ? " on" : ""}`}
              aria-pressed={mode === "text"}
              onClick={() => {
                // 組み立てた条件があれば、その式から書き始められるようにする。
                if (mode === "build" && built !== "") setText(built);
                setMode("text");
                setError(null);
              }}
            >
              式で書く
            </button>
          </div>
          {mode === "build" ? (
            <>
              {state.conditions.length > 1 && (
                <label className="field query-join">
                  <span>条件のつなぎ方</span>
                  <select className="input small" aria-label="条件のつなぎ方" value={state.join} onChange={(e) => setState((s) => ({ ...s, join: e.target.value as "and" | "or" }))}>
                    <option value="and">すべての条件に合う行</option>
                    <option value="or">どれかの条件に合う行</option>
                  </select>
                </label>
              )}
              {state.conditions.length === 0 && <p className="muted small">条件がありません。「条件を足す」で始めます。</p>}
              {state.conditions.map((c, i) => (
                <ConditionRow
                  key={i}
                  cond={c}
                  fields={fields}
                  info={info}
                  index={i}
                  onChange={(next) => setCondition(i, next)}
                  onRemove={() => setState((s) => ({ ...s, conditions: s.conditions.filter((_, j) => j !== i) }))}
                />
              ))}
              <button
                type="button"
                className="btn small"
                disabled={!firstField}
                onClick={() => firstField && setState((s) => ({ ...s, conditions: [...s.conditions, defaultCondition(firstField)] }))}
              >
                ＋ 条件を足す
              </button>
              {built !== "" && (
                <p className="muted small query-preview">
                  式: <span className="mono">{built}</span>
                </p>
              )}
            </>
          ) : (
            <>
              <QueryTextInput
                value={text}
                onChange={(v) => {
                  setText(v);
                  setError(null);
                }}
                fields={fields}
                info={info}
                onSubmit={() => void apply()}
              />
              <p className="muted small">
                入力に合わせて、入れられるものが出ます（↑↓ で選び、Enter か Tab で入れる。Ctrl+Space でもう一度出す）。and / or / not とかっこでつなげます。
              </p>
            </>
          )}
          {error !== null && (
            <p className="hint-error" role="alert">
              {error}
            </p>
          )}
          <div className="row query-foot">
            <button
              type="button"
              className="btn small"
              disabled={!active}
              onClick={() => {
                onApply("", null);
                pop.setOpen(false);
              }}
            >
              条件を外す
            </button>
            <span className="tb-grow" />
            <button type="button" className="btn small primary" disabled={busy} onClick={() => void apply()}>
              {busy ? "確かめています…" : "この条件で絞り込む"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// お気に入り
// ---------------------------------------------------------------------------

export interface FavoritesMenuProps {
  favorites: Favorite[];
  onApply(favorite: Favorite): void;
  /** いまの絞り込みと並べ替えを、この名前で覚える。includeColumns: 列と言語の表示も覚える。 */
  onSave(name: string, includeColumns: boolean): void;
  onDelete(id: string): void;
}

export function FavoritesMenu({ favorites, onApply, onSave, onDelete }: FavoritesMenuProps) {
  const pop = usePopover();
  const [name, setName] = useState("");
  const [includeColumns, setIncludeColumns] = useState(false);
  const trimmed = name.trim();
  const overwrite = favorites.some((f) => f.name === trimmed);
  const save = () => {
    if (trimmed === "") return;
    onSave(trimmed, includeColumns);
    setName("");
  };
  return (
    <div className="popover-anchor" ref={pop.ref} onKeyDown={pop.onKeyDown}>
      <button type="button" className="btn small" aria-haspopup="dialog" aria-expanded={pop.open} title="絞り込みと並べ替えに名前を付けて覚える（この PC に保存）" onClick={() => pop.setOpen(!pop.open)}>
        ★ お気に入り{favorites.length > 0 && <span className="count-badge">{favorites.length}</span>} ▾
      </button>
      {pop.open && (
        <div className="popover favorites-panel" role="dialog" aria-label="お気に入りの条件">
          {favorites.length === 0 && <p className="muted small">まだありません。絞り込んでから、下で名前を付けて保存します。</p>}
          <ul className="plain-list favorites-list">
            {favorites.map((f) => (
              <li key={f.id} className="row">
                <button
                  type="button"
                  className="menu-item grow"
                  title={`${f.view === "search" ? "プロジェクト全体の検索ビューで開く" : "いまのリソースに当てる"}${f.columns ? "（列と言語の表示も戻す）" : ""}`}
                  onClick={() => {
                    onApply(f);
                    pop.setOpen(false);
                  }}
                >
                  {f.view === "search" ? "🔎 " : ""}
                  {f.name}
                </button>
                <button type="button" className="icon-btn" aria-label={`お気に入り「${f.name}」を削除`} title="削除" onClick={() => onDelete(f.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="favorites-save">
            <label className="field">
              <span>いまの条件を保存</span>
              <input
                type="text"
                className="input small"
                aria-label="お気に入りの名前"
                placeholder="名前（例: 未レビューの英語）"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) save();
                }}
              />
            </label>
            <label className="check">
              <input type="checkbox" checked={includeColumns} onChange={(e) => setIncludeColumns(e.target.checked)} />
              列と言語の表示も覚える
            </label>
            <button type="button" className="btn small primary" disabled={trimmed === ""} onClick={save}>
              {overwrite ? "上書きして保存" : "保存"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 列の表示
// ---------------------------------------------------------------------------

export interface ColumnsMenuProps {
  columns: ColumnDef[];
  /** 隠している列の ID。 */
  hidden: string[];
  onChange(hidden: string[]): void;
  /** 列の表示のプリセット（名前 → 隠す列の ID）。 */
  sets: Record<string, string[]>;
  onSaveSet(name: string): void;
  onDeleteSet(name: string): void;
}

/** 隠せる列か。キーの列は、行を見分けるためにいつも出す。 */
export function canHideColumn(col: ColumnDef): boolean {
  return col.kind !== "key";
}

export function ColumnsMenu({ columns, hidden, onChange, sets, onSaveSet, onDeleteSet }: ColumnsMenuProps) {
  const pop = usePopover();
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const hideable = columns.filter(canHideColumn);
  const hiddenCount = hideable.filter((c) => hidden.includes(c.id)).length;
  const sameSet = (ids: string[]) => ids.length === hiddenCount && ids.every((id) => hidden.includes(id));
  return (
    <div className="popover-anchor" ref={pop.ref} onKeyDown={pop.onKeyDown}>
      <button
        type="button"
        className={`btn small${hiddenCount > 0 ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={pop.open}
        aria-label={`表示する列を選ぶ（${hideable.length - hiddenCount} / ${hideable.length}）`}
        onClick={() => pop.setOpen(!pop.open)}
      >
        列 {hideable.length - hiddenCount} / {hideable.length} ▾
      </button>
      {pop.open && (
        <div className="popover right columns-panel" role="dialog" aria-label="表示する列">
          <fieldset className="filter-set">
            <legend>表示する列</legend>
            {columns.map((c) => (
              <label key={c.id} className="check" title={canHideColumn(c) ? undefined : "キーの列は、いつも表示します"}>
                <input
                  type="checkbox"
                  checked={!hidden.includes(c.id) || !canHideColumn(c)}
                  disabled={!canHideColumn(c)}
                  onChange={(e) => onChange(e.target.checked ? hidden.filter((id) => id !== c.id) : [...hidden, c.id])}
                />
                {columnLabel(c)}
                {c.scope === "language" && <span className="muted small">（言語ごと）</span>}
              </label>
            ))}
          </fieldset>
          <button type="button" className="btn small" disabled={hiddenCount === 0} onClick={() => onChange([])}>
            すべて表示
          </button>
          {Object.keys(sets).length > 0 && (
            <ul className="plain-list favorites-list" aria-label="列の表示のプリセット">
              {Object.entries(sets).map(([setName, ids]) => (
                <li key={setName} className="row">
                  <button type="button" className={`menu-item grow${sameSet(ids) ? " on" : ""}`} aria-pressed={sameSet(ids)} onClick={() => onChange(ids)}>
                    {setName}
                  </button>
                  <button type="button" className="icon-btn" aria-label={`列のプリセット「${setName}」を削除`} title="削除" onClick={() => onDeleteSet(setName)}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="favorites-save">
            <label className="field">
              <span>いまの表示をプリセットに保存</span>
              <input type="text" className="input small" aria-label="列のプリセットの名前" placeholder="名前（例: 翻訳用）" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button
              type="button"
              className="btn small"
              disabled={trimmed === ""}
              onClick={() => {
                onSaveSet(trimmed);
                setName("");
              }}
            >
              {trimmed in sets ? "上書きして保存" : "保存"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
