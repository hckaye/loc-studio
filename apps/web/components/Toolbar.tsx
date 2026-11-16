"use client";
import { useEffect, useRef, useState } from "react";
import type { ActionInfo } from "@loc-studio/server";
import { Chip } from "@/components/EnumSelect";
import type { ToolbarFilters } from "@/lib/client/filters";
import { cellIdOf, columnAppliesTo, columnLabel, enumOptions, gridKind, SEVERITY_LABEL, type ColumnDef, type LanguageDef, type Severity } from "@/lib/client/model";

/* ツールバー: 検索、列の値での絞り込み、切り替え、言語の選択、表示密度、保存。 */

export { EMPTY_FILTERS, type ToolbarFilters } from "@/lib/client/filters";

export interface ToolbarProps {
  columns: ColumnDef[];
  languages: LanguageDef[];
  visibleLanguages: string[];
  filters: ToolbarFilters;
  onFilters(f: ToolbarFilters): void;
  onOpenLanguages(): void;
  density: 1 | 3 | 5;
  onDensity(d: 1 | 3 | 5): void;
  unsaved: number;
  onSave(): void;
  showDetail: boolean;
  onToggleDetail(): void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** target: "file" のアクション（このリソースが対象）。 */
  fileActions: ActionInfo[];
  onFileAction(a: ActionInfo): void;
  /** 絞り込みに合う行すべてにアクションを実行する操作（「一括アクション」）。 */
  matchActions?: React.ReactNode;
  onReload(): void;
  onDiscardAll(): void;
  /** 行の追加・キーの変更・削除を始める（対象の行は呼び出し側が選択から決める）。 */
  onStructure?(kind: "add" | "rename" | "remove"): void;
  /** 行の構成を変えられないときの理由。 */
  structureDisabledReason?: string | undefined;
  /** 編集できないときの理由（読み取り専用など）。 */
  editDisabledReason?: string | undefined;
  runDisabledReason?: string | undefined;
  /** 検索欄のとなりに置く操作（条件、お気に入り）。 */
  findControls?: React.ReactNode;
  /** 言語のボタンのとなりに置く操作（検索ビュー、列の表示）。 */
  viewControls?: React.ReactNode;
}

function ActionsMenu({ actions, onRun, disabledReason }: { actions: ActionInfo[]; onRun(a: ActionInfo): void; disabledReason?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="popover-anchor" ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button type="button" className="btn small" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        アクション ▾
      </button>
      {open && (
        <div className="popover right menu-pop" role="menu" aria-label="このリソースのアクション">
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={disabledReason !== undefined}
              title={disabledReason}
              onClick={() => {
                setOpen(false);
                onRun(a);
              }}
            >
              {a.icon && [...a.icon].length <= 2 ? `${a.icon} ` : ""}
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const ROW_ITEMS = [
  { kind: "add", label: "行を追加…" },
  { kind: "rename", label: "キーを変更…" },
  { kind: "remove", label: "選択した行を削除…" },
] as const;

function RowsMenu({ onChoose, disabledReason }: { onChoose(kind: "add" | "rename" | "remove"): void; disabledReason?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="popover-anchor" ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button type="button" className="btn small" aria-haspopup="menu" aria-expanded={open} disabled={disabledReason !== undefined} title={disabledReason} onClick={() => setOpen((o) => !o)}>
        行 ▾
      </button>
      {open && (
        <div className="popover right menu-pop" role="menu" aria-label="行の操作">
          {ROW_ITEMS.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onChoose(item.kind);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPopover({ col, languages, values, onChange }: { col: ColumnDef; languages: LanguageDef[]; values: Record<string, string[]>; onChange(cellId: string, vals: string[]): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = enumOptions(col) ?? [];
  const cells = col.scope === "entry" ? [{ cellId: col.id, label: "" }] : languages.filter((l) => columnAppliesTo(col, l.id)).map((l) => ({ cellId: cellIdOf(col, l.id), label: l.label }));
  const active = cells.reduce((n, c) => n + (values[c.cellId]?.length ? 1 : 0), 0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="popover-anchor" ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button type="button" className={`btn small${active ? " on" : ""}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {columnLabel(col)}
        {active > 0 && <span className="count-badge">{active}</span>} ▾
      </button>
      {open && (
        <div className="popover" role="group" aria-label={`${columnLabel(col)} で絞り込む`}>
          {cells.length === 0 && <p className="muted small">表示中の言語にこの列はありません。</p>}
          {cells.map((c) => {
            const sel = values[c.cellId] ?? [];
            return (
              <fieldset key={c.cellId} className="filter-set">
                {c.label && <legend>{c.label}</legend>}
                {options.map((o) => (
                  <label key={o.value} className="check">
                    <input
                      type="checkbox"
                      checked={sel.includes(o.value)}
                      onChange={(e) => onChange(c.cellId, e.target.checked ? [...sel, o.value] : sel.filter((v) => v !== o.value))}
                    />
                    <Chip option={o} />
                  </label>
                ))}
              </fieldset>
            );
          })}
          {active > 0 && (
            <button type="button" className="btn small" onClick={() => cells.forEach((c) => onChange(c.cellId, []))}>
              解除
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 文字・数値の列の「含む」絞り込み。入力が止まってから反映する。 */
function ContainsPopover({ col, languages, contains, onChange }: { col: ColumnDef; languages: LanguageDef[]; contains: Record<string, string>; onChange(cellId: string, text: string): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cells = col.scope === "entry" ? [{ cellId: col.id, label: "" }] : languages.filter((l) => columnAppliesTo(col, l.id)).map((l) => ({ cellId: cellIdOf(col, l.id), label: l.label }));
  const active = cells.filter((c) => (contains[c.cellId] ?? "") !== "").length;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    const pending = Object.entries(drafts);
    if (pending.length === 0) return;
    const t = setTimeout(() => {
      for (const [cellId, text] of pending) onChangeRef.current(cellId, text);
      setDrafts({});
    }, 300);
    return () => clearTimeout(t);
  }, [drafts]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="popover-anchor" ref={ref} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button type="button" className={`btn small${active ? " on" : ""}`} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {columnLabel(col)}
        {active > 0 && <span className="count-badge">{active}</span>} ▾
      </button>
      {open && (
        <div className="popover" role="group" aria-label={`${columnLabel(col)} で絞り込む`}>
          {cells.length === 0 && <p className="muted small">表示中の言語にこの列はありません。</p>}
          {cells.map((c) => (
            <label key={c.cellId} className="field">
              <span>{c.label ? `${c.label}: ` : ""}この文字を含む</span>
              <input
                type="search"
                className="input small"
                aria-label={`${columnLabel(col)}${c.label ? `（${c.label}）` : ""} に含む文字`}
                value={drafts[c.cellId] ?? contains[c.cellId] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [c.cellId]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const ISSUE_LEVELS: Severity[] = ["error", "warning", "info"];

export function Toolbar(props: ToolbarProps) {
  const { filters, onFilters } = props;
  const [search, setSearch] = useState(filters.search);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  useEffect(() => setSearch(filters.search), [filters.search]);
  // 入力が止まってから検索する
  useEffect(() => {
    if (search === filtersRef.current.search) return;
    const t = setTimeout(() => onFilters({ ...filtersRef.current, search }), 300);
    return () => clearTimeout(t);
  }, [search, onFilters]);

  const visibleLangs = props.languages.filter((l) => props.visibleLanguages.includes(l.id));
  const enumCols = props.columns.filter((c) => enumOptions(c) !== undefined);
  // 文字・数値の値を持つ列（ファイルの中の列、列ソースの列、計算列）は「含む」で絞り込む。
  const textCols = props.columns.filter((c) => (c.kind === "meta" || c.kind === "computed") && ["string", "number", "computed"].includes(gridKind(c)));
  const toggle = (k: "onlyUntranslated" | "onlyIssues" | "onlyStale" | "onlyUnsaved", label: string, title: string) => (
    <button type="button" className={`btn small toggle${filters[k] ? " on" : ""}`} aria-pressed={filters[k]} title={title} onClick={() => onFilters({ ...filters, [k]: !filters[k] })}>
      {label}
    </button>
  );

  return (
    <div className="toolbar" role="toolbar" aria-label="表の操作">
      <input
        ref={props.searchRef}
        type="search"
        className="input search"
        placeholder="キーと本文を検索（Ctrl+F）"
        aria-label="検索"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onFilters({ ...filters, search });
        }}
      />
      {props.findControls}
      <span className="tb-sep" />
      {enumCols.map((c) => (
        <FilterPopover
          key={c.id}
          col={c}
          languages={visibleLangs}
          values={filters.values}
          onChange={(cellId, vals) => {
            const values = { ...filters.values };
            if (vals.length) values[cellId] = vals;
            else delete values[cellId];
            onFilters({ ...filters, values });
          }}
        />
      ))}
      {textCols.map((c) => (
        <ContainsPopover
          key={c.id}
          col={c}
          languages={visibleLangs}
          contains={filters.contains}
          onChange={(cellId, text) => {
            const contains = { ...filtersRef.current.contains };
            if (text.trim() !== "") contains[cellId] = text.trim();
            else delete contains[cellId];
            onFilters({ ...filtersRef.current, contains });
          }}
        />
      ))}
      {toggle("onlyUntranslated", "未翻訳のみ", "表示中の言語のどれかの本文が空の行")}
      {toggle("onlyIssues", "問題あり", `${SEVERITY_LABEL[filters.issueLevel]}以上の検証結果がある行`)}
      {filters.onlyIssues && (
        <select className="input small" aria-label="問題の重さ" value={filters.issueLevel} onChange={(e) => onFilters({ ...filters, issueLevel: e.target.value as Severity })}>
          {ISSUE_LEVELS.map((s) => (
            <option key={s} value={s}>
              {SEVERITY_LABEL[s]}以上
            </option>
          ))}
        </select>
      )}
      {toggle("onlyStale", "要確認", "変更ありのレビューや、基の本文が変わった本文がある行")}
      {toggle("onlyUnsaved", "未保存", "未保存の本文がある行")}
      <span className="tb-grow" />
      {props.onStructure && <RowsMenu onChoose={props.onStructure} disabledReason={props.structureDisabledReason} />}
      {props.matchActions}
      {props.fileActions.length > 0 && <ActionsMenu actions={props.fileActions} onRun={props.onFileAction} disabledReason={props.runDisabledReason} />}
      <button type="button" className="btn small" onClick={props.onReload} title="リソースを読み直す（外部で書き換えたとき）">
        再読み込み
      </button>
      {props.viewControls}
      <button type="button" className="btn small" onClick={props.onOpenLanguages} aria-label={`言語の表示を選ぶ（${props.visibleLanguages.length} / ${props.languages.length}）`}>
        言語 {props.visibleLanguages.length} / {props.languages.length}
      </button>
      <div className="seg" role="group" aria-label="表示密度">
        {([1, 3, 5] as const).map((d) => (
          <button key={d} type="button" className={`seg-btn${props.density === d ? " on" : ""}`} aria-pressed={props.density === d} title={`${d} 行表示`} onClick={() => props.onDensity(d)}>
            {d}
          </button>
        ))}
      </div>
      <button type="button" className={`btn small${props.showDetail ? " on" : ""}`} aria-pressed={props.showDetail} onClick={props.onToggleDetail}>
        詳細
      </button>
      <button
        type="button"
        className="btn small"
        disabled={props.unsaved === 0 || props.editDisabledReason !== undefined}
        onClick={props.onDiscardAll}
        title={props.editDisabledReason ?? "このリソースの未保存の変更をすべて取り消す"}
      >
        取り消す
      </button>
      <button
        type="button"
        className="btn small primary"
        disabled={props.unsaved === 0 || props.editDisabledReason !== undefined}
        onClick={props.onSave}
        title={props.editDisabledReason ?? "このリソースを保存（Ctrl+S）"}
      >
        保存{props.unsaved > 0 ? `（${props.unsaved}）` : ""}
      </button>
    </div>
  );
}
