"use client";
import { useEffect, useRef, useState } from "react";
import type { ActionInfo } from "@loc-studio/server";
import { Chip } from "@/components/EnumSelect";
import { cellIdOf, columnAppliesTo, columnLabel, enumOptions, type ColumnDef, type LanguageDef } from "@/lib/client/model";

/* ツールバー: 検索、列の値での絞り込み、切り替え、言語の選択、表示密度、保存。 */

export interface ToolbarFilters {
  search: string;
  values: Record<string, string[]>;
  onlyUntranslated: boolean;
  onlyIssues: boolean;
  onlyStale: boolean;
  onlyUnsaved: boolean;
}

export const EMPTY_FILTERS: ToolbarFilters = { search: "", values: {}, onlyUntranslated: false, onlyIssues: false, onlyStale: false, onlyUnsaved: false };

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
  onReload(): void;
  onDiscardAll(): void;
  /** 編集できないときの理由（読み取り専用など）。 */
  editDisabledReason?: string | undefined;
  runDisabledReason?: string | undefined;
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
      {toggle("onlyUntranslated", "未翻訳のみ", "表示中の言語のどれかの本文が空の行")}
      {toggle("onlyIssues", "問題あり", "警告以上の検証結果がある行")}
      {toggle("onlyStale", "要確認", "変更ありのレビューや、基の本文が変わった本文がある行")}
      {toggle("onlyUnsaved", "未保存", "未保存の本文がある行")}
      <span className="tb-grow" />
      {props.fileActions.length > 0 && <ActionsMenu actions={props.fileActions} onRun={props.onFileAction} disabledReason={props.runDisabledReason} />}
      <button type="button" className="btn small" onClick={props.onReload} title="リソースを読み直す（外部で書き換えたとき）">
        再読み込み
      </button>
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
