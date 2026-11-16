"use client";
import { useEffect, useRef, useState } from "react";
import type { ActionInfo } from "@loc-studio/server";
import { Chip } from "@/components/EnumSelect";
import type { ToolbarFilters } from "@/lib/client/filters";
import { cellIdOf, columnAppliesTo, columnLabel, enumOptions, gridKind, SEVERITY_LABEL, type ColumnDef, type LanguageDef, type Severity } from "@/lib/client/model";

/* ツールバー: 上の段に検索と絞り込み、下の段に行とリソースの操作、表示、保存。役目ごとのまとまりに見出しを付ける。 */

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
  /** 探す範囲。resource: 開いているリソースの表。project: プロジェクト全体の結果（検索結果の表示）。検索欄と絞り込みは、どちらにも同じものが効く。 */
  scope: "resource" | "project";
  onScope(scope: "resource" | "project"): void;
  /** target: "file" のアクション（このリソースが対象）。 */
  fileActions: ActionInfo[];
  onFileAction(a: ActionInfo): void;
  /** 絞り込みに合う行すべてにアクションを実行する操作（「一括アクション」）。 */
  matchActions?: React.ReactNode;
  onReload(): void;
  onDiscardAll(): void;
  /** 行の追加・削除を始める（対象の行は呼び出し側が選択から決める）。キーの変更は、キーのセルのダブルクリックか、右クリックのメニューから。 */
  onStructure?(kind: "add" | "remove"): void;
  /** 選んでいる行の数（「行を削除」に出す。0 なら、削除は押せない）。 */
  selectedRows?: number;
  /** 行の構成を変えられないときの理由。 */
  structureDisabledReason?: string | undefined;
  /** 編集できないときの理由（読み取り専用など）。 */
  editDisabledReason?: string | undefined;
  runDisabledReason?: string | undefined;
  /** 検索欄のとなりに置く操作（条件、お気に入り）。 */
  findControls?: React.ReactNode;
  /** 言語のボタンのとなりに置く操作（列の表示）。 */
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
      <button type="button" className="btn small" aria-haspopup="menu" aria-expanded={open} title="このリソース全体を対象にしたアクションを実行する" onClick={() => setOpen((o) => !o)}>
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
      <button type="button" className={`btn small${active ? " on" : ""}`} aria-haspopup="true" aria-expanded={open} title={`「${columnLabel(col)}」の列の値を選んで、行を絞り込む`} onClick={() => setOpen((o) => !o)}>
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
      <button type="button" className={`btn small${active ? " on" : ""}`} aria-haspopup="true" aria-expanded={open} title={`「${columnLabel(col)}」の列に含む文字で、行を絞り込む`} onClick={() => setOpen((o) => !o)}>
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

  // 効いている絞り込みの数（検索、条件、列の値、含む、行の状態）。「絞り込みを解除」に出す。
  const activeCount =
    (filters.search.trim() !== "" ? 1 : 0) +
    (filters.where.trim() !== "" ? 1 : 0) +
    Object.values(filters.values).filter((v) => v.length > 0).length +
    Object.values(filters.contains).filter((v) => v !== "").length +
    [filters.onlyUntranslated, filters.onlyIssues, filters.onlyStale, filters.onlyUnsaved].filter(Boolean).length;
  // 「問題あり」で数える重さは、解除しても選んだまま残す。
  const clearAll = () => {
    setSearch("");
    onFilters({ ...filters, search: "", where: "", builder: null, values: {}, contains: {}, onlyUntranslated: false, onlyIssues: false, onlyStale: false, onlyUnsaved: false });
  };
  const hasColumnFilters = enumCols.length + textCols.length > 0;

  /*
   * 上の段は「行を探す・絞り込む」、下の段は「行と表への操作」。それぞれ、役目ごとのまとまりに見出しを付ける。
   * ボタンの名前だけでは役目が分からないもの（列の名前、行の状態）は、見出しとツールチップで何をするボタンかを示す。
   */
  return (
    <div className="toolbar" role="toolbar" aria-label="表の操作">
      <div className="tb-row">
        <div className="tb-group" role="group" aria-label="検索と条件">
          <span className="tb-caption" aria-hidden="true">
            検索
          </span>
          <input
            ref={props.searchRef}
            type="search"
            className="input search"
            placeholder={props.scope === "project" ? "キーと本文を検索（プロジェクト全体）" : "キーと本文を検索（このファイル）"}
            aria-label="検索"
            title="キーと、表示中の言語の本文から探す（Ctrl+F。プロジェクト全体から探すときは Ctrl+Shift+F）"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onFilters({ ...filters, search });
            }}
          />
          <div className="seg" role="group" aria-label="探す範囲">
            <button
              type="button"
              className={`seg-btn${props.scope === "resource" ? " on" : ""}`}
              aria-pressed={props.scope === "resource"}
              title="開いているファイル（リソース）の中だけを探して、表に出す（Ctrl+F）"
              onClick={() => props.onScope("resource")}
            >
              このファイル
            </button>
            <button
              type="button"
              className={`seg-btn${props.scope === "project" ? " on" : ""}`}
              aria-pressed={props.scope === "project"}
              title="プロジェクトのすべてのファイルから探して、合う行を 1 つの表に集める（Ctrl+Shift+F。件数、集計、CSV への書き出しもここから）"
              onClick={() => props.onScope("project")}
            >
              全体
            </button>
          </div>
          {props.findControls}
        </div>
        {hasColumnFilters && (
          <div className="tb-group" role="group" aria-label="列の値で絞り込む">
            <span className="tb-caption" aria-hidden="true" title="列を選ぶと、その列の値で行を絞り込めます">
              列の値で絞り込む
            </span>
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
          </div>
        )}
        <div className="tb-group" role="group" aria-label="行の状態で絞り込む">
          <span className="tb-caption" aria-hidden="true" title="押したボタンの状態に当てはまる行だけを表示します（もう一度押すと外れます）">
            行の状態で絞り込む
          </span>
          {toggle("onlyUntranslated", "未翻訳のみ", "表示中の言語のどれかの本文が空の行だけを表示する")}
          {toggle("onlyIssues", "問題あり", `検証で、${SEVERITY_LABEL[filters.issueLevel]}以上の問題が見つかった行だけを表示する`)}
          {filters.onlyIssues && (
            <select
              className="input small"
              aria-label="問題の重さ"
              title="「問題あり」で数える問題の重さ"
              value={filters.issueLevel}
              onChange={(e) => onFilters({ ...filters, issueLevel: e.target.value as Severity })}
            >
              {ISSUE_LEVELS.map((s) => (
                <option key={s} value={s}>
                  {SEVERITY_LABEL[s]}以上
                </option>
              ))}
            </select>
          )}
          {toggle("onlyStale", "要確認", "レビューのあとで対象の値が変わった行と、基の言語の本文が変わった行だけを表示する")}
          {toggle("onlyUnsaved", "未保存", "まだ保存していない本文の変更がある行だけを表示する")}
        </div>
        {activeCount > 0 && (
          <button type="button" className="btn small tb-clear" title="検索、条件、列の値、行の状態の絞り込みをすべて外す" onClick={clearAll}>
            絞り込みを解除（{activeCount}）
          </button>
        )}
      </div>
      <div className="tb-row">
        <div className="tb-group" role="group" aria-label="行とリソースの操作">
          <span className="tb-caption" aria-hidden="true">
            操作
          </span>
          {props.onStructure && (
            <>
              <button
                type="button"
                className="btn small"
                disabled={props.structureDisabledReason !== undefined}
                title={props.structureDisabledReason ?? "選んでいる行の後ろに、新しい行を追加する（行を選んでいなければ、末尾に追加する）"}
                onClick={() => props.onStructure!("add")}
              >
                ＋ 行を追加
              </button>
              <button
                type="button"
                className="btn small"
                disabled={props.structureDisabledReason !== undefined || (props.selectedRows ?? 0) === 0}
                title={props.structureDisabledReason ?? ((props.selectedRows ?? 0) === 0 ? "削除する行を選んでください" : `選んでいる ${props.selectedRows} 行を削除する（確かめてから消します。Ctrl / Shift を押しながら選ぶと、複数の行を選べます）`)}
                onClick={() => props.onStructure!("remove")}
              >
                行を削除{(props.selectedRows ?? 0) > 1 ? `（${props.selectedRows}）` : ""}
              </button>
            </>
          )}
          {props.matchActions}
          {props.fileActions.length > 0 && <ActionsMenu actions={props.fileActions} onRun={props.onFileAction} disabledReason={props.runDisabledReason} />}
          <button type="button" className="btn small" onClick={props.onReload} title="このリソースをファイルから読み直す（アプリの外で書き換えたとき）">
            再読み込み
          </button>
        </div>
        <div className="tb-group" role="group" aria-label="表示">
          <span className="tb-caption" aria-hidden="true">
            表示
          </span>
          {props.viewControls}
          <button
            type="button"
            className="btn small"
            onClick={props.onOpenLanguages}
            aria-label={`言語の表示を選ぶ（${props.visibleLanguages.length} / ${props.languages.length}）`}
            title="表に出す言語を選ぶ（表示中の数 / 全体の数）"
          >
            言語 {props.visibleLanguages.length} / {props.languages.length}
          </button>
          <span className="tb-label" aria-hidden="true">
            行の高さ
          </span>
          <div className="seg" role="group" aria-label="表示密度">
            {([1, 3, 5] as const).map((d) => (
              <button
                key={d}
                type="button"
                className={`seg-btn${props.density === d ? " on" : ""}`}
                aria-pressed={props.density === d}
                aria-label={`${d} 行表示`}
                title={`1 つの行に、本文を ${d} 行まで表示する`}
                onClick={() => props.onDensity(d)}
              >
                {d} 行
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`btn small${props.showDetail ? " on" : ""}`}
            aria-pressed={props.showDetail}
            title="選択した行の、全言語の本文、検証結果、レビューの投稿、変更履歴を右に表示する"
            onClick={props.onToggleDetail}
          >
            詳細
          </button>
        </div>
        <span className="tb-grow" />
        <div className="tb-group" role="group" aria-label="保存">
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
      </div>
    </div>
  );
}
