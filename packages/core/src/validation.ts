/**
 * バリデータをセルに適用する。
 *
 * どのバリデータをどのセルに当てるか（列と言語の絞り込み）、問題の重さの決め方、
 * バリデータの失敗の扱い、結果のキャッシュの鍵をここで決める。
 */
import { createHash } from "node:crypto";
import type { ColumnDef, LanguageDef, LanguageId, ResourceRef, RowSnapshot, Severity, TextToken, ValidateContext, ValidationIssue } from "@loc-studio/sdk";
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

/** セルの値を、バリデータに渡す文字列にする（値のないセルは ""）。 */
export function cellValueText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : typeof value === "object" ? stableStringify(value) : String(value);
}

/**
 * 本文以外で、セルごとのバリデータを当てる列。値を持つ列（kind: "meta"）のうち、
 * どれかのバリデータ（か、設定の validators の columns）が名指ししたもの。
 */
export function validatedMetaColumns(columns: ColumnDef[], validators: ResolvedValidator[]): ColumnDef[] {
  const named = new Set<string>();
  for (const rv of validators) {
    if (typeof rv.validator.validate !== "function") continue;
    for (const id of rv.columns ?? rv.validator.columns ?? []) named.add(id);
  }
  return columns.filter((c) => c.kind === "meta" && named.has(c.id));
}

/** このバリデータをこのセルに当てるか。 */
export function validatorApplies(rv: ResolvedValidator, target: ValidationTarget): boolean {
  if (typeof rv.validator.validate !== "function") return false;
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
      if (target.raw !== undefined) ctxBase.raw = target.raw;
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
          found = await rv.validator.validate!({ ...ctxBase, options: rv.options });
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

/** リソース全体を見るバリデータが見つけた問題。どのセルの問題かが決まったもの。 */
export interface ResolvedResourceIssue extends ResolvedIssue {
  key: string;
  columnId: string;
  language?: LanguageId;
}

export interface ResourceValidationInput {
  resource: ResourceRef;
  rows: RowSnapshot[];
  languages: LanguageDef[];
  columns: ColumnDef[];
}

/**
 * リソース全体を見るバリデータ（validateResource）を呼ぶ。
 * セルを特定できない問題（行がない、列がない、言語ごとの列なのに言語がない）は捨てて problems に理由を入れる。
 * バリデータの失敗も problems に入れ、ほかのバリデータは続ける。
 */
export async function runResourceValidators(
  input: ResourceValidationInput,
  validators: ResolvedValidator[],
): Promise<{ issues: ResolvedResourceIssue[]; problems: string[] }> {
  const issues: ResolvedResourceIssue[] = [];
  const problems: string[] = [];
  const byId = new Map(input.columns.map((c) => [c.id, c]));
  const textColumn = input.columns.find((c) => c.kind === "text");
  const languageIds = new Set(input.languages.map((l) => l.id));
  const keys = new Set(input.rows.map((r) => r.entry.key));
  for (const rv of validators) {
    if (typeof rv.validator.validateResource !== "function") continue;
    const id = rv.validator.id;
    let found;
    try {
      found = await rv.validator.validateResource({ ...input, options: rv.options });
      if (!Array.isArray(found)) throw new Error("結果が配列ではありません");
    } catch (err) {
      problems.push(`バリデータ「${id}」の validateResource が失敗しました（${input.resource.path}）: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const languages = rv.languages ?? rv.validator.languages;
    let dropped = 0;
    for (const issue of found) {
      const column = issue.columnId !== undefined ? byId.get(issue.columnId) : textColumn;
      const languageOk = column?.scope === "language" ? issue.language !== undefined && languageIds.has(issue.language) : true;
      if (!column || !keys.has(issue.key) || !languageOk) {
        dropped++;
        continue;
      }
      const language = column.scope === "language" ? issue.language : undefined;
      // 設定の columns / languages の絞り込みは、見つけた問題のセルに当てる。
      if (rv.columns && !rv.columns.includes(column.id)) continue;
      if (languages && (language === undefined || !languages.includes(language))) continue;
      const { key, columnId: _c, language: _l, ...rest } = issue;
      const resolved: ResolvedResourceIssue = { ...rest, key, columnId: column.id, severity: resolveSeverity(rv, issue), validatorId: id };
      if (language !== undefined) resolved.language = language;
      issues.push(resolved);
    }
    if (dropped > 0) {
      problems.push(`バリデータ「${id}」が返した問題のうち ${dropped} 件は、セルを特定できないため捨てました（key、columnId、language を確かめてください。${input.resource.path}）。`);
    }
  }
  return { issues, problems };
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
