/**
 * バリデータをセルに適用する。
 *
 * どのバリデータをどのセルに当てるか（列と言語の絞り込み）、問題の重さの決め方、
 * バリデータの失敗の扱い、結果のキャッシュの鍵をここで決める。
 */
import { createHash } from "node:crypto";
import type { Severity, TextToken, ValidateContext, ValidationIssue } from "@loc-studio/sdk";
import type { CellValidation, ResolvedIssue, ResolvedValidator, ValidationTarget } from "./types.js";

export interface RunValidatorsOptions {
  /** 本文をトークンに分ける（プロジェクトの記法）。 */
  tokenize(text: string): TextToken[];
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };

/** severity が threshold 以上の重さか（error > warning > info）。 */
export function severityAtLeast(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

function isSeverity(v: unknown): v is Severity {
  return v === "error" || v === "warning" || v === "info";
}

/** このバリデータをこのセルに当てるか。 */
export function validatorApplies(rv: ResolvedValidator, target: ValidationTarget): boolean {
  const columns = rv.columns ?? rv.validator.columns;
  if (columns) {
    if (!columns.includes(target.column.id)) return false;
  } else if (target.column.kind !== "text") {
    return false;
  }
  const languages = rv.languages ?? rv.validator.languages;
  if (languages) {
    // 言語を持たないセル（scope: entry の列）は、言語で絞っているバリデータの対象外。
    if (!target.language || !languages.includes(target.language.id)) return false;
  }
  return true;
}

function resolveSeverity(rv: ResolvedValidator, issue: ValidationIssue): Severity {
  // 設定（プロジェクトの判断）が最優先。次に問題ごとの指定、バリデータの既定。
  if (rv.severity) return rv.severity;
  if (isSeverity(issue.severity)) return issue.severity;
  if (rv.validator.severity) return rv.validator.severity;
  return "error";
}

function failureIssue(validatorId: string, err: unknown): ResolvedIssue {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    code: "validator-failed",
    severity: "error",
    validatorId,
    message: `バリデータ「${validatorId}」の実行に失敗しました: ${detail}`,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

/**
 * 対象のセルにバリデータを当てる。
 * 戻り値は対象と同じ順・同じ数（問題のないセルも issues が空で入る）。
 */
export async function runValidators(
  targets: ValidationTarget[],
  validators: ResolvedValidator[],
  opts: RunValidatorsOptions,
): Promise<CellValidation[]> {
  const { signal } = opts;
  throwIfAborted(signal);

  // 同じ本文（原文は多くの言語で共有される）を何度も分けないよう、実行中だけ覚えておく。
  const tokenCache = new Map<string, TextToken[]>();
  const tokensOf = (text: string): TextToken[] => {
    let tokens = tokenCache.get(text);
    if (!tokens) {
      tokens = opts.tokenize(text);
      tokenCache.set(text, tokens);
    }
    return tokens;
  };

  const results: CellValidation[] = [];
  const total = targets.length;
  for (const target of targets) {
    throwIfAborted(signal);
    const issues: ResolvedIssue[] = [];
    const applicable = validators.filter((rv) => validatorApplies(rv, target));
    if (applicable.length > 0) {
      const ctxBase: Omit<ValidateContext, "options"> = {
        entry: target.entry,
        column: target.column,
        value: target.value,
        tokens: tokensOf(target.value),
        row: target.row,
      };
      if (target.language) ctxBase.language = target.language;
      if (target.base) {
        ctxBase.base = {
          language: target.base.language,
          value: target.base.value,
          tokens: tokensOf(target.base.value),
        };
      }
      for (const rv of applicable) {
        throwIfAborted(signal);
        const id = rv.validator.id;
        let found: ValidationIssue[];
        try {
          found = await rv.validator.validate({ ...ctxBase, options: rv.options });
          if (!Array.isArray(found)) throw new Error("結果が配列ではありません");
        } catch (err) {
          // 中断はバリデータの失敗ではない。実行全体を止める。
          if (signal?.aborted) throw signal.reason;
          issues.push(failureIssue(id, err));
          continue;
        }
        for (const issue of found) {
          issues.push({ ...issue, severity: resolveSeverity(rv, issue), validatorId: id });
        }
      }
    }
    results.push({ target, issues });
    opts.onProgress?.(results.length, total);
  }
  return results;
}

/** 結果のキャッシュの鍵。入力が 1 つでも違えば違う鍵になる。 */
export function validationCacheKey(rv: ResolvedValidator, target: ValidationTarget): string {
  const material = stableStringify([
    "loc-studio/validation/1",
    rv.validator.id,
    rv.validator.version,
    rv.options ?? null,
    { severity: rv.severity ?? null, languages: rv.languages ?? null, columns: rv.columns ?? null },
    target.column.id,
    target.language?.id ?? null,
    target.value,
    target.base ? [target.base.language.id, target.base.value] : null,
  ]);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** 集計。cells は問題が 1 つ以上あるセルの数。 */
export function summarizeValidation(results: CellValidation[]): {
  error: number;
  warning: number;
  info: number;
  byCode: Record<string, number>;
  cells: number;
} {
  const summary = { error: 0, warning: 0, info: 0, byCode: {} as Record<string, number>, cells: 0 };
  for (const r of results) {
    if (r.issues.length > 0) summary.cells++;
    for (const issue of r.issues) {
      summary[issue.severity]++;
      summary.byCode[issue.code] = (summary.byCode[issue.code] ?? 0) + 1;
    }
  }
  return summary;
}

/**
 * キーを並べ替えた JSON。ハッシュの材料にするため、キーの順序で結果が変わらないようにする。
 * JSON.stringify と同じく、オブジェクトの undefined・関数は省き、配列の中では null にする。
 * 最上位が undefined のときは "null"。
 */
export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const walk = (v: unknown, inArray: boolean): string | undefined => {
    if (v !== null && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON === "function") {
      v = (v as { toJSON: () => unknown }).toJSON();
    }
    if (v === undefined || typeof v === "function" || typeof v === "symbol") return inArray ? "null" : undefined;
    if (v === null) return "null";
    if (typeof v === "bigint") throw new TypeError(`bigint は文字列にできません: ${v}`);
    if (typeof v !== "object") return JSON.stringify(v);
    if (seen.has(v)) throw new TypeError("循環参照があるため文字列にできません");
    seen.add(v);
    let out: string;
    if (Array.isArray(v)) {
      out = `[${v.map((item) => walk(item, true)).join(",")}]`;
    } else {
      const parts: string[] = [];
      for (const key of Object.keys(v).sort()) {
        const s = walk((v as Record<string, unknown>)[key], false);
        if (s !== undefined) parts.push(`${JSON.stringify(key)}:${s}`);
      }
      out = `{${parts.join(",")}}`;
    }
    seen.delete(v);
    return out;
  };
  return walk(value, false) ?? "null";
}
