import type { TextToken, ValidateContext, ValidationIssue, Validator } from "@loc-studio/sdk";

const isNonText = (t: TextToken): boolean => t.kind !== "text";

/** 変数・タグ・制御コードの出現を値ごとにまとめる（出現順を保つ）。 */
function groupTokens(tokens: TextToken[], ignoreTags: boolean): Map<string, TextToken[]> {
  const groups = new Map<string, TextToken[]>();
  for (const t of tokens) {
    if (!isNonText(t) || (ignoreTags && t.kind === "tag")) continue;
    const list = groups.get(t.value);
    if (list) list.push(t);
    else groups.set(t.value, [t]);
  }
  return groups;
}

/** 基の言語と、変数・タグ・制御コードの過不足がないか。 */
export const placeholdersValidator: Validator = {
  id: "builtin.placeholders",
  label: "変数・タグの過不足",
  version: "1",
  severity: "error",
  validate(ctx) {
    if (!ctx.base || ctx.value === "") return [];
    const ignoreTags = ctx.options["ignoreTags"] === true;
    const baseGroups = groupTokens(ctx.base.tokens, ignoreTags);
    const valueGroups = groupTokens(ctx.tokens, ignoreTags);
    const issues: ValidationIssue[] = [];
    for (const [value, baseList] of baseGroups) {
      const have = valueGroups.get(value)?.length ?? 0;
      if (have < baseList.length) {
        issues.push({
          code: "placeholder-missing",
          message: `原文にある ${value} が足りません（原文 ${baseList.length} 個、訳文 ${have} 個）。`,
        });
      }
    }
    for (const [value, list] of valueGroups) {
      const baseCount = baseGroups.get(value)?.length ?? 0;
      const first = list[baseCount];
      if (first) {
        issues.push({
          code: "placeholder-extra",
          message: `原文にない ${value} があります（原文 ${baseCount} 個、訳文 ${list.length} 個）。`,
          range: { ...first.range },
        });
      }
    }
    return issues;
  },
};

/** タグの対応と入れ子が正しいか。 */
export const tagBalanceValidator: Validator = {
  id: "builtin.tagBalance",
  label: "タグの対応",
  version: "1",
  severity: "error",
  validate(ctx) {
    const rawVoid = ctx.options["voidTags"];
    const voidTags = new Set(
      (Array.isArray(rawVoid) ? rawVoid.filter((v): v is string => typeof v === "string") : ["br"]).map((v) =>
        v.toLowerCase(),
      ),
    );
    const issues: ValidationIssue[] = [];
    const stack: { name: string; token: TextToken }[] = [];
    for (const t of ctx.tokens) {
      if (t.kind !== "tag") continue;
      const m = /^<(\/?)([A-Za-z0-9]+)/.exec(t.value);
      if (!m) continue;
      const closing = m[1] === "/";
      const name = (m[2] ?? "").toLowerCase();
      if (closing) {
        const top = stack[stack.length - 1];
        if (top && top.name === name) {
          stack.pop();
        } else {
          issues.push({
            code: "tag-unexpected-close",
            message: `${t.value} に対応する開始タグがないか、入れ子の順序が正しくありません。`,
            range: { ...t.range },
          });
        }
        continue;
      }
      if (t.value.endsWith("/>") || voidTags.has(name)) continue;
      stack.push({ name, token: t });
    }
    for (const { token } of stack) {
      issues.push({
        code: "tag-unclosed",
        message: `${token.value} が閉じられていません。`,
        range: { ...token.range },
      });
    }
    return issues;
  },
};

function resolveLimit(ctx: ValidateContext): number | undefined {
  const max = ctx.options["max"];
  if (typeof max === "number") return Number.isFinite(max) ? max : undefined;
  const metaKey = typeof ctx.options["metaKey"] === "string" ? ctx.options["metaKey"] : "maxLength";
  const raw = ctx.entry.meta?.[metaKey];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** 文字数の上限（Unicode のコードポイント数で数える）。 */
export const maxLengthValidator: Validator = {
  id: "builtin.maxLength",
  label: "文字数の上限",
  version: "1",
  severity: "error",
  validate(ctx) {
    const limit = resolveLimit(ctx);
    if (limit === undefined) return [];
    const countAll = ctx.options["count"] === "all";
    const counted = countAll
      ? ctx.value
      : ctx.tokens
          .filter((t) => t.kind === "text")
          .map((t) => t.value)
          .join("");
    const length = Array.from(counted).length;
    if (length <= limit) return [];
    const issue: ValidationIssue = {
      code: "too-long",
      message: `文字数が上限を超えています（${length} 文字、上限 ${limit} 文字）。`,
    };
    if (countAll) {
      // 上限を超えた最初のコードポイントの位置（UTF-16 の添字）から末尾まで。
      let index = 0;
      let seen = 0;
      for (const ch of ctx.value) {
        if (seen >= Math.max(0, limit)) break;
        index += ch.length;
        seen++;
      }
      issue.range = { start: index, end: ctx.value.length };
    }
    return [issue];
  },
};

/** 前後の空白と、連続した半角スペース。 */
export const whitespaceValidator: Validator = {
  id: "builtin.whitespace",
  label: "空白",
  version: "1",
  severity: "warning",
  validate(ctx) {
    const v = ctx.value;
    if (v === "") return [];
    const issues: ValidationIssue[] = [];
    const lead = /^\s+/.exec(v)?.[0].length ?? 0;
    const trail = lead === v.length ? 0 : (/\s+$/.exec(v)?.[0].length ?? 0);
    if (lead > 0) {
      issues.push({
        code: "leading-space",
        message: "先頭に空白があります。",
        range: { start: 0, end: lead },
        fix: { label: "先頭の空白を削除", value: v.slice(lead) },
      });
    }
    if (trail > 0) {
      issues.push({
        code: "trailing-space",
        message: "末尾に空白があります。",
        range: { start: v.length - trail, end: v.length },
        fix: { label: "末尾の空白を削除", value: v.slice(0, v.length - trail) },
      });
    }
    // 前後の空白は別の指摘になるので、連続スペースは本文の内側だけを見る。
    const inner = v.slice(lead, v.length - trail);
    const dbl = / {2,}/.exec(inner);
    if (dbl) {
      const start = lead + dbl.index;
      issues.push({
        code: "double-space",
        message: "半角スペースが連続しています。",
        range: { start, end: start + dbl[0].length },
        fix: { label: "連続スペースを 1 つにする", value: v.replace(/ {2,}/g, " ") },
      });
    }
    return issues;
  },
};

/** 未翻訳（空、または原文のまま）。 */
export const untranslatedValidator: Validator = {
  id: "builtin.untranslated",
  label: "未翻訳",
  version: "1",
  severity: "warning",
  validate(ctx) {
    const base = ctx.base;
    if (!base) return [];
    if (ctx.value.trim() === "") {
      return base.value.trim() === "" ? [] : [{ code: "empty", message: "訳文が空です。" }];
    }
    if (ctx.value === base.value) {
      const hasLetter = base.tokens.some((t) => t.kind === "text" && /\p{L}/u.test(t.value));
      if (hasLetter) return [{ code: "same-as-base", message: "原文と同じです。未翻訳の可能性があります。" }];
    }
    return [];
  },
};

export const builtinValidators: Validator[] = [
  placeholdersValidator,
  tagBalanceValidator,
  maxLengthValidator,
  whitespaceValidator,
  untranslatedValidator,
];
