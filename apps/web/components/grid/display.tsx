"use client";
import { displayValue } from "@/lib/client/model";

/* 同梱の見せ方（ColumnDef.display）。コードを書かずに選べるもの。 */

export type DisplayKind = "link" | "progress" | "color" | "tags";

export { safeHttpUrl } from "@/lib/client/url";
import { safeHttpUrl } from "@/lib/client/url";

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[-+0-9.%\s,/a-z]*\)$/i;
const NAMED = /^[a-z]{3,20}$/i;

/** 安全な CSS の色の書き方だけ受け付ける（#rgb、rgb()/hsl()、色の名前）。 */
export function safeCssColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (HEX.test(s) || NAMED.test(s)) return s;
  if (FUNC.test(s) && !/url|expression|var|[;{}<>"'\\]/i.test(s)) return s;
  return undefined;
}

export function toTags(v: unknown, separator?: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => displayValue(x).trim()).filter(Boolean);
  if (typeof v !== "string") return v === undefined || v === null ? [] : [displayValue(v)];
  const sep = typeof separator === "string" && separator !== "" ? separator : ",";
  return v.split(sep).map((x) => x.trim()).filter(Boolean);
}

export function DisplayValue({ kind, value, options }: { kind: DisplayKind; value: unknown; options?: Record<string, unknown> }) {
  switch (kind) {
    case "link": {
      const url = safeHttpUrl(value);
      const text = displayValue(value);
      if (!url) return <span className="cell-value">{text}</span>;
      return (
        <a className="cell-link" href={url} target="_blank" rel="noopener noreferrer" title={url} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {text}
        </a>
      );
    }
    case "progress": {
      const max = typeof options?.["max"] === "number" && (options["max"] as number) > 0 ? (options["max"] as number) : 1;
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      if (Number.isNaN(n)) return <span className="cell-value muted">{displayValue(value)}</span>;
      const ratio = Math.max(0, Math.min(1, n / max));
      const pct = Math.round(ratio * 100);
      return (
        <span className="cell-progress" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={n} aria-label={`${pct}%`} title={max === 1 ? `${pct}%` : `${n} / ${max}`}>
          <span className="bar">
            <span className="fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="pct">{max === 1 ? `${pct}%` : `${n}/${max}`}</span>
        </span>
      );
    }
    case "color": {
      const c = safeCssColor(value);
      return (
        <span className="cell-color">
          {c && <span className="swatch" style={{ background: c }} aria-hidden="true" />}
          <span className="cell-value">{displayValue(value)}</span>
        </span>
      );
    }
    case "tags": {
      const tags = toTags(value, options?.["separator"]);
      return (
        <span className="cell-tags">
          {tags.map((t, i) => (
            <span key={`${t}-${i}`} className="tag">
              {t}
            </span>
          ))}
        </span>
      );
    }
    default:
      return <span className="cell-value">{displayValue(value)}</span>;
  }
}
