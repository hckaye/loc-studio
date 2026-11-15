"use client";
import { memo, useEffect, useRef, useState } from "react";
import type { ActionInfo, CellInfo, ProjectInfo, RowInfo } from "@loc-studio/server";
import { EnumSelect } from "@/components/EnumSelect";
import { canEditCell, canGenerate, canRunAction, optionProblem } from "@/lib/client/permissions";
import { DisplayValue } from "./display";
import { RenderedCell } from "./renderers";
import {
  displayValue,
  enumDefault,
  enumOptions,
  SEVERITY_LABEL,
  textValue,
  worstSeverity,
  type GridColumn,
} from "@/lib/client/model";

/* 表のセルの中身。列の種類ごとに出し分ける。 */

export interface CellHandlers {
  onEnumChoose(row: RowInfo, gc: GridColumn, value: string): void;
  onReviewChoose(row: RowInfo, gc: GridColumn, verdict: string): void;
  onCommitMeta(row: RowInfo, gc: GridColumn, value: unknown): void;
  /** 独自描画の setValue 用（保存が終わるまで待てる）。 */
  setCellValue?(row: RowInfo, gc: GridColumn, value: unknown): Promise<unknown>;
  onGenerate(row: RowInfo, gc: GridColumn): void;
  onRunAction(row: RowInfo, gc: GridColumn, action: ActionInfo): void;
  onCancelEdit(): void;
}

/** アクション列に並べるアクション（列の actions、対象、言語で絞る）。 */
export function actionsForColumn(info: ProjectInfo, gc: GridColumn): ActionInfo[] {
  const ids = gc.col.actions;
  return info.actions.filter((a) => {
    if (ids ? !ids.includes(a.id) : a.target !== "cell" && a.target !== "row") return false;
    if (a.target !== "cell" && a.target !== "row") return false;
    if (a.languages && gc.language !== undefined && !a.languages.includes(gc.language)) return false;
    if (!ids && a.columns && !a.columns.includes(gc.col.id)) return false;
    return true;
  });
}

/** ほかの人が書いた未保存の編集なら「○○さんが編集中」。 */
export function draftByOther(cell: CellInfo | undefined, me: string | undefined): string | undefined {
  return cell?.draft && cell.draftBy && me !== undefined && cell.draftBy !== me ? cell.draftBy : undefined;
}

export function TextMarks({ cell, me }: { cell: CellInfo | undefined; me?: string }) {
  if (!cell) return null;
  const other = draftByOther(cell, me);
  return (
    <span className="marks">
      {cell.draft && (
        <span
          className={`mark mark-unsaved${other ? " other" : ""}`}
          title={other ? `${other}さんが編集中（未保存）` : "未保存の変更があります"}
          aria-label={other ? `${other}さんが編集中` : "未保存"}
        >
          ●
        </span>
      )}
      {cell.needsRecheck && (
        <span className="mark mark-recheck" title="基になる言語の本文が変わりました（要確認）" aria-label="要確認">
          ↻
        </span>
      )}
      <IssueMark issues={cell.issues} />
    </span>
  );
}

function InlineEditor({ initial, kind, date, onCommit, onCancel }: { initial: string; kind: "string" | "number"; date?: boolean; onCommit(v: unknown): void; onCancel(): void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    if (done.current) return;
    done.current = true;
    if (kind === "number") {
      if (value.trim() === "") return onCommit(null);
      const n = Number(value);
      if (Number.isNaN(n)) {
        done.current = false;
        ref.current?.setCustomValidity("数値を入力してください");
        ref.current?.reportValidity();
        return;
      }
      onCommit(n);
    } else if (date && value === "") onCommit(null); // 日付を空にしたら、値を消す
    else onCommit(value);
  };
  return (
    <input
      ref={ref}
      className="inline-input"
      aria-label="値を編集"
      {...(date ? { type: "date" } : {})}
      value={value}
      inputMode={kind === "number" ? "decimal" : undefined}
      onChange={(e) => {
        e.target.setCustomValidity("");
        setValue(e.target.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!done.current) {
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}

export interface CellContentProps {
  info: ProjectInfo;
  row: RowInfo;
  gc: GridColumn;
  editing: boolean;
  handlers: CellHandlers;
  actions: ActionInfo[];
  resourceId?: string;
}

/** 文字・数値・計算・生成の列の値（独自描画 → 同梱の見せ方 → そのまま、の順）。 */
export function ValueView({ info, row, gc, handlers, resourceId, className }: { info: ProjectInfo; row: RowInfo; gc: GridColumn; handlers?: CellHandlers; resourceId?: string; className?: string }) {
  const cell = row.cells[gc.cellId];
  const plain = gc.col.display ? (
    <DisplayValue kind={gc.col.display} value={cell?.value} {...(gc.col.options ? { options: gc.col.options } : {})} />
  ) : (
    <span className={className ?? "cell-value"}>{displayValue(cell?.value)}</span>
  );
  if (!gc.col.renderer) return plain;
  const readOnly = gc.kind === "computed" || gc.kind === "generated" || !canEditCell(info, gc).ok || !handlers?.setCellValue;
  const lang = gc.language ? info.languages.find((l) => l.id === gc.language) : undefined;
  return (
    <RenderedCell
      rendererId={gc.col.renderer}
      fallback={plain}
      ctx={{
        value: cell?.value,
        ...(cell?.error ? { error: cell.error } : {}),
        column: { id: gc.col.id, ...(gc.col.label ? { label: gc.col.label } : {}), ...(gc.col.type ? { type: gc.col.type } : {}), ...(gc.col.options ? { options: gc.col.options } : {}) },
        ...(lang ? { language: { id: lang.id, label: lang.label } } : {}),
        entryKey: row.key,
        resourceId: resourceId ?? "",
        readOnly,
        ...(readOnly ? {} : { setValue: async (v: unknown) => void (await handlers!.setCellValue!(row, gc, v)) }),
      }}
    />
  );
}

/** 検証で見つかった問題の印（いちばん重い問題の記号。ツールチップに全件）。 */
export function IssueMark({ issues }: { issues: CellInfo["issues"] }) {
  const worst = worstSeverity(issues);
  if (!worst) return null;
  const title = issues!.map((i) => `[${SEVERITY_LABEL[i.severity]}] ${i.message}`).join("\n");
  return (
    <span className={`mark mark-${worst}`} title={title} aria-label={`${SEVERITY_LABEL[worst]}: ${issues!.length} 件`}>
      {worst === "error" ? "!" : worst === "warning" ? "▲" : "i"}
    </span>
  );
}

/** セルの中身と、本文以外の列の検証の印（本文の印は TextMarks が出す）。 */
export const CellContent = memo(function CellContent(props: CellContentProps) {
  const issues = props.gc.kind === "text" ? undefined : props.row.cells[props.gc.cellId]?.issues;
  return (
    <>
      <CellBody {...props} />
      {issues && issues.length > 0 && (
        <span className="marks">
          <IssueMark issues={issues} />
        </span>
      )}
    </>
  );
});

const CellBody = memo(function CellBody({ info, row, gc, editing, handlers, actions, resourceId }: CellContentProps) {
  const cell = row.cells[gc.cellId];
  const allowed = canEditCell(info, gc);
  switch (gc.kind) {
    case "key":
      return <span className="cell-key">{row.key}</span>;
    case "text": {
      const v = textValue(cell);
      return (
        <>
          <span className={v === "" ? "cell-text empty" : "cell-text"}>{v === "" ? "（未翻訳）" : v}</span>
          <TextMarks cell={cell} me={info.user.name} />
        </>
      );
    }
    case "enum":
    case "review": {
      const options = enumOptions(gc.col) ?? [];
      const raw = cell?.value;
      const value = raw === undefined || raw === null || raw === "" ? enumDefault(gc.col) : String(raw);
      if (gc.kind === "enum" && gc.col.renderer) return <ValueView info={info} row={row} gc={gc} handlers={handlers} {...(resourceId ? { resourceId } : {})} />;
      return (
        <EnumSelect
          inCell
          options={options}
          value={value}
          label={gc.col.label ?? gc.col.id}
          {...(cell?.stale ? { stale: true } : {})}
          {...(!allowed.ok ? { disabled: true, title: allowed.reason } : {})}
          optionProblem={(o) => optionProblem(info, gc.col, o, raw)}
          onChoose={(v) => (gc.kind === "review" ? handlers.onReviewChoose(row, gc, v) : handlers.onEnumChoose(row, gc, v))}
        />
      );
    }
    case "string":
    case "number":
      if (editing && allowed.ok) {
        return (
          <InlineEditor
            initial={displayValue(cell?.value)}
            kind={gc.kind}
            {...(gc.col.type === "date" ? { date: true } : {})}
            onCommit={(v) => handlers.onCommitMeta(row, gc, v)}
            onCancel={handlers.onCancelEdit}
          />
        );
      }
      return <ValueView info={info} row={row} gc={gc} handlers={handlers} className={gc.kind === "number" ? "cell-value num" : "cell-value"} {...(resourceId ? { resourceId } : {})} />;
    case "boolean":
      return (
        <input
          type="checkbox"
          data-cell-primary=""
          aria-label={gc.col.label ?? gc.col.id}
          checked={cell?.value === true}
          disabled={!allowed.ok}
          title={allowed.reason}
          onChange={(e) => handlers.onCommitMeta(row, gc, e.target.checked)}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      );
    case "generated": {
      const run = canGenerate(info, gc.col.id);
      const state = cell?.generated ?? (cell?.value ? "fresh" : "missing");
      const label = state === "fresh" ? "最新" : state === "stale" ? "古い" : "未生成";
      return (
        <>
          {gc.col.renderer || gc.col.display ? (
            <span className="cell-grow">
              <ValueView info={info} row={row} gc={gc} handlers={handlers} {...(resourceId ? { resourceId } : {})} />
            </span>
          ) : (
            <span className={`cell-text gen-${state}`}>{displayValue(cell?.value)}</span>
          )}
          <span className="gen-tools">
            <span className={`gen-badge gen-badge-${state}`} title={`生成結果: ${label}`}>
              {label}
            </span>
            <button
              type="button"
              className="mini-btn"
              data-cell-primary=""
              aria-label={`${gc.col.label ?? gc.col.id} を生成`}
              title={run.ok ? "生成" : run.reason}
              disabled={!run.ok}
              onClick={(e) => {
                e.stopPropagation();
                handlers.onGenerate(row, gc);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              ⟳
            </button>
          </span>
        </>
      );
    }
    case "actions":
      return (
        <span className="cell-actions">
          {actions.length === 0 && <span className="muted small">—</span>}
          {actions.map((a, i) => {
            const run = canRunAction(info, a.id);
            return (
              <button
                key={a.id}
                type="button"
                className="mini-btn"
                {...(i === 0 ? { "data-cell-primary": "" } : {})}
                title={run.ok ? a.label : run.reason}
                aria-label={a.label}
                disabled={!run.ok}
                onClick={(e) => {
                  e.stopPropagation();
                  handlers.onRunAction(row, gc, a);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {a.icon && [...a.icon].length <= 2 ? a.icon : a.label}
              </button>
            );
          })}
        </span>
      );
    case "computed":
    default:
      return (
        <>
          <span className="cell-grow">
            <ValueView info={info} row={row} gc={gc} handlers={handlers} className={`cell-value readonly${gc.col.type === "number" ? " num" : ""}`} {...(resourceId ? { resourceId } : {})} />
          </span>
          {cell?.error && (
            <span className="marks">
              <span className="mark mark-error" title={cell.error} aria-label={`計算できませんでした: ${cell.error}`}>
                !
              </span>
            </span>
          )}
        </>
      );
  }
});
