"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { chipColors } from "@/lib/client/colors";
import { optionLabel, type EnumOption } from "@/lib/client/model";

/* 選択肢のチップ（ラベル＋色）。 */
export function Chip({ option, fallback, stale }: { option: EnumOption | undefined; fallback?: string; stale?: boolean }) {
  const c = chipColors(option?.color);
  const label = option ? optionLabel(option) : fallback ?? "";
  return (
    <span className="chip" style={{ color: c.fg, background: c.bg, borderColor: c.border }}>
      <span className="chip-dot" style={{ background: c.fg }} aria-hidden="true" />
      <span className="chip-label">{label}</span>
      {stale && (
        <span className="chip-stale" title="対象の値が変わっています（変更あり）">
          変更あり
        </span>
      )}
    </span>
  );
}

export interface EnumSelectProps {
  options: EnumOption[];
  value: string | undefined;
  onChoose(value: string): void;
  label: string;
  disabled?: boolean;
  stale?: boolean;
  /** 表のセルの中に置く（枠なしの見た目）。 */
  inCell?: boolean;
  /** ツールチップ（無効のときの理由など）。 */
  title?: string | undefined;
  /** その選択肢を選べないときの理由（遷移や役割の制限）。理由のある選択肢は、理由つきで選べなくする。 */
  optionProblem?(option: EnumOption): string | undefined;
}

/** ドロップダウン。リストは body に出すので、表のセルで切れない。 */
export function EnumSelect({ options, value, onChoose, label, disabled, stale, inCell, title, optionProblem }: EnumSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const current = options.find((o) => o.value === value);

  const openList = () => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const height = Math.min(options.length * 30 + 8, 320);
    const below = r.bottom + height < window.innerHeight;
    setPos({ left: Math.min(r.left, window.innerWidth - 200), top: below ? r.bottom + 2 : Math.max(4, r.top - height - 2), minWidth: Math.max(r.width, 140) });
  }, [open, options.length]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (listRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const choose = (o: EnumOption) => {
    if (optionProblem?.(o) !== undefined) return;
    setOpen(false);
    btnRef.current?.focus();
    if (o.value !== value) onChoose(o.value);
  };

  const onListKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[active];
      if (o) choose(o);
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      setOpen(false);
      btnRef.current?.focus();
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={inCell ? "enum-btn enum-btn-cell" : "enum-btn"}
        data-cell-primary=""
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${current ? optionLabel(current) : value ?? "未設定"}`}
        disabled={disabled}
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);
          else openList();
        }}
      >
        <Chip option={current} fallback={value ?? "—"} {...(stale ? { stale } : {})} />
        <span className="enum-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={listRef}
            className="enum-list"
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            style={{ left: pos.left, top: pos.top, minWidth: pos.minWidth }}
            onKeyDown={onListKey}
            aria-activedescendant={`enum-opt-${active}`}
          >
            {options.map((o, i) => {
              const problem = optionProblem?.(o);
              return (
                <li
                  key={o.value}
                  id={`enum-opt-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={problem !== undefined}
                  title={problem}
                  className={`enum-option${i === active ? " active" : ""}${o.value === value ? " selected" : ""}${problem !== undefined ? " disabled" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={() => choose(o)}
                >
                  <Chip option={o} />
                  {o.requireComment && <span className="muted small">コメント必須</span>}
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </>
  );
}
