import { describe, expect, it, vi } from "vitest";
import type { ColumnDef, LanguageDef, TextToken, ValidateContext, Validator } from "@loc-studio/sdk";
import type { ResolvedValidator, ValidationTarget } from "./types.js";
import {
  runValidators,
  severityAtLeast,
  stableStringify,
  summarizeValidation,
  validationCacheKey,
  validatorApplies,
} from "./validation.js";

const ja: LanguageDef = { id: "ja", label: "日本語" };
const en: LanguageDef = { id: "en", label: "English", basedOn: "ja" };
const fr: LanguageDef = { id: "fr", label: "Français", basedOn: "ja" };

const textCol: ColumnDef = { id: "text", kind: "text", scope: "language" };
const noteCol: ColumnDef = { id: "note", kind: "meta", scope: "entry" };
const commentCol: ColumnDef = { id: "comment", kind: "meta", scope: "language" };

const row = { text: () => undefined, get: () => undefined };

function target(over: Partial<ValidationTarget> = {}): ValidationTarget {
  return {
    entry: { key: "k1", resource: { id: "a.csv", path: "a.csv", name: "a.csv" } },
    column: textCol,
    language: en,
    value: "Hello {name}",
    base: { language: ja, value: "こんにちは {name}" },
    row,
    ...over,
  };
}

function validator(over: Partial<Validator> = {}): Validator {
  return { id: "v", label: "V", version: "1", validate: () => [], ...over };
}

function rv(v: Partial<Validator> = {}, over: Partial<ResolvedValidator> = {}): ResolvedValidator {
  return { validator: validator(v), options: {}, ...over };
}

/** 空白で区切るだけの簡単なトークナイザ。 */
function tokenize(text: string): TextToken[] {
  const out: TextToken[] = [];
  const re = /\{[^}]*\}|[^{]+/g;
  for (const m of text.matchAll(re)) {
    out.push({
      kind: m[0].startsWith("{") ? "variable" : "text",
      value: m[0],
      range: { start: m.index, end: m.index + m[0].length },
    });
  }
  return out;
}

describe("validatorApplies", () => {
  it("列の指定がなければ本文の列だけ", () => {
    expect(validatorApplies(rv(), target())).toBe(true);
    expect(validatorApplies(rv(), target({ column: commentCol }))).toBe(false);
  });

  it("バリデータ自身の列の指定", () => {
    const r = rv({ columns: ["comment"] });
    expect(validatorApplies(r, target({ column: commentCol }))).toBe(true);
    expect(validatorApplies(r, target())).toBe(false);
  });

  it("設定の列の指定がバリデータの指定より優先", () => {
    const r = rv({ columns: ["comment"] }, { columns: ["text"] });
    expect(validatorApplies(r, target())).toBe(true);
    expect(validatorApplies(r, target({ column: commentCol }))).toBe(false);
  });

  it("言語の指定がなければ全言語、言語のないセルも対象", () => {
    const r = rv({ columns: ["note"] });
    expect(validatorApplies(rv(), target({ language: fr }))).toBe(true);
    expect(validatorApplies(r, target({ column: noteCol, language: undefined }))).toBe(true);
  });

  it("バリデータ自身の言語の指定", () => {
    const r = rv({ languages: ["en"] });
    expect(validatorApplies(r, target())).toBe(true);
    expect(validatorApplies(r, target({ language: fr }))).toBe(false);
  });

  it("設定の言語の指定がバリデータの指定より優先", () => {
    const r = rv({ languages: ["en"] }, { languages: ["fr"] });
    expect(validatorApplies(r, target({ language: fr }))).toBe(true);
    expect(validatorApplies(r, target())).toBe(false);
  });

  it("言語で絞っているとき、言語のないセルは対象外", () => {
    expect(validatorApplies(rv({ columns: ["note"], languages: ["en"] }), target({ column: noteCol, language: undefined }))).toBe(false);
    expect(validatorApplies(rv({ columns: ["note"] }, { languages: ["en"] }), target({ column: noteCol, language: undefined }))).toBe(false);
  });
});

describe("runValidators", () => {
  it("重さ: 設定 > 問題 > バリデータの既定 > error", async () => {
    const issues = [
      { code: "a", message: "a", severity: "info" as const },
      { code: "b", message: "b" },
    ];
    const run = (r: ResolvedValidator) =>
      runValidators([target()], [r], { tokenize }).then((res) => res[0]!.issues.map((i) => i.severity));

    expect(await run(rv({ validate: () => issues, severity: "warning" }, { severity: "error" }))).toEqual(["error", "error"]);
    expect(await run(rv({ validate: () => issues, severity: "warning" }))).toEqual(["info", "warning"]);
    expect(await run(rv({ validate: () => issues }))).toEqual(["info", "error"]);
  });

  it("文脈に本文・トークン・基の本文・設定の値が入る", async () => {
    let seen: ValidateContext | undefined;
    const t = target();
    await runValidators(
      [t],
      [
        rv(
          {
            validate: (ctx) => {
              seen = ctx;
              return [];
            },
          },
          { options: { max: 10 } },
        ),
      ],
      { tokenize },
    );
    expect(seen?.value).toBe("Hello {name}");
    expect(seen?.tokens.map((x) => x.value)).toEqual(["Hello ", "{name}"]);
    expect(seen?.base?.language).toBe(ja);
    expect(seen?.base?.tokens.map((x) => x.kind)).toEqual(["text", "variable"]);
    expect(seen?.options).toEqual({ max: 10 });
    expect(seen?.language).toBe(en);
    expect(seen?.entry).toBe(t.entry);
    expect(seen?.row).toBe(row);
  });

  it("基の本文がなければ base は undefined", async () => {
    let seen: ValidateContext | undefined;
    await runValidators([target({ base: undefined, language: ja })], [rv({ validate: (c) => ((seen = c), []) })], { tokenize });
    expect(seen).toBeDefined();
    expect(seen?.base).toBeUndefined();
  });

  it("同じ本文は 1 回だけトークンに分ける", async () => {
    const spy = vi.fn(tokenize);
    const targets = [target(), target({ language: fr, value: "Bonjour {name}" }), target({ entry: { ...target().entry, key: "k2" } })];
    await runValidators(targets, [rv({ id: "a" }), rv({ id: "b" })], { tokenize: spy });
    // "Hello {name}"、"こんにちは {name}"、"Bonjour {name}" の 3 種類。
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("同期・非同期のバリデータ、validatorId が付く", async () => {
    const res = await runValidators(
      [target()],
      [
        rv({ id: "sync", validate: () => [{ code: "s", message: "同期" }] }),
        rv({
          id: "async",
          validate: async () => {
            await new Promise((r) => setTimeout(r, 1));
            return [{ code: "a", message: "非同期", range: { start: 0, end: 1 } }];
          },
        }),
      ],
      { tokenize },
    );
    expect(res[0]!.issues).toEqual([
      { code: "s", message: "同期", severity: "error", validatorId: "sync" },
      { code: "a", message: "非同期", severity: "error", validatorId: "async", range: { start: 0, end: 1 } },
    ]);
  });

  it("投げる・拒否するバリデータは validator-failed になり、実行は続く", async () => {
    const res = await runValidators(
      [target(), target({ language: fr })],
      [
        rv({
          id: "boom",
          validate: () => {
            throw new Error("壊れた");
          },
        }),
        rv({ id: "reject", validate: () => Promise.reject(new Error("拒否")) }),
        rv({ id: "ok", validate: () => [{ code: "x", message: "x", severity: "info" }] }),
      ],
      { tokenize },
    );
    expect(res).toHaveLength(2);
    for (const r of res) {
      expect(r.issues.map((i) => [i.validatorId, i.code, i.severity])).toEqual([
        ["boom", "validator-failed", "error"],
        ["reject", "validator-failed", "error"],
        ["ok", "x", "info"],
      ]);
      expect(r.issues[0]!.message).toContain("boom");
      expect(r.issues[0]!.message).toContain("壊れた");
      expect(r.issues[1]!.message).toContain("拒否");
    }
  });

  it("配列以外を返すバリデータも失敗として扱う", async () => {
    const res = await runValidators([target()], [rv({ id: "bad", validate: () => null as never })], { tokenize });
    expect(res[0]!.issues[0]?.code).toBe("validator-failed");
  });

  it("対象と同じ順・同じ数で返し、問題のないセルも含む", async () => {
    const targets = [target({ value: "a" }), target({ column: commentCol, value: "b" }), target({ value: "c" })];
    const progress: [number, number][] = [];
    const res = await runValidators(
      targets,
      [rv({ validate: (ctx) => (ctx.value === "c" ? [{ code: "c", message: "c" }] : []) })],
      { tokenize, onProgress: (d, t) => progress.push([d, t]) },
    );
    expect(res.map((r) => r.target)).toEqual(targets);
    expect(res.map((r) => r.issues.length)).toEqual([0, 0, 1]);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("対象もバリデータもなければ空", async () => {
    expect(await runValidators([], [rv()], { tokenize })).toEqual([]);
    expect((await runValidators([target()], [], { tokenize }))[0]!.issues).toEqual([]);
  });

  it("中断されたら中断の理由を投げる", async () => {
    const pre = new AbortController();
    pre.abort(new Error("最初から中断"));
    await expect(runValidators([target()], [rv()], { tokenize, signal: pre.signal })).rejects.toThrow("最初から中断");

    const ac = new AbortController();
    const reason = new Error("途中で中断");
    let calls = 0;
    const p = runValidators(
      Array.from({ length: 10 }, () => target()),
      [
        rv({
          validate: async () => {
            calls++;
            if (calls === 3) ac.abort(reason);
            return [];
          },
        }),
      ],
      { tokenize, signal: ac.signal },
    );
    await expect(p).rejects.toBe(reason);
    expect(calls).toBe(3);
  });

  it("中断でバリデータが拒否しても validator-failed にせず中断する", async () => {
    const ac = new AbortController();
    const p = runValidators(
      [target()],
      [
        rv({
          validate: () => {
            ac.abort(new Error("中断"));
            throw new Error("中断されたので失敗");
          },
        }),
      ],
      { tokenize, signal: ac.signal },
    );
    await expect(p).rejects.toThrow("中断");
  });
});

describe("validationCacheKey", () => {
  it("同じ入力なら同じ鍵（オブジェクトのキー順は無関係）", () => {
    const a = validationCacheKey(rv({}, { options: { a: 1, b: [1, { c: 2, d: 3 }] } }), target());
    const b = validationCacheKey(rv({}, { options: { b: [1, { d: 3, c: 2 }], a: 1 } }), target());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("どれか 1 つ違えば違う鍵", () => {
    const base = validationCacheKey(rv(), target());
    const variants = [
      validationCacheKey(rv({ id: "w" }), target()),
      validationCacheKey(rv({ version: "2" }), target()),
      validationCacheKey(rv({}, { options: { x: 1 } }), target()),
      validationCacheKey(rv({}, { severity: "warning" }), target()),
      validationCacheKey(rv({}, { languages: ["en"] }), target()),
      validationCacheKey(rv({}, { languages: [] }), target()),
      validationCacheKey(rv({}, { columns: ["text"] }), target()),
      validationCacheKey(rv(), target({ column: commentCol })),
      validationCacheKey(rv(), target({ language: fr })),
      validationCacheKey(rv(), target({ language: undefined })),
      validationCacheKey(rv(), target({ value: "Hello {name}!" })),
      validationCacheKey(rv(), target({ base: undefined })),
      validationCacheKey(rv(), target({ base: { language: fr, value: "こんにちは {name}" } })),
      validationCacheKey(rv(), target({ base: { language: ja, value: "こんにちは" } })),
    ];
    for (const v of variants) expect(v).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("区切りの位置がずれても衝突しない", () => {
    const a = validationCacheKey(rv(), target({ value: "ab", base: { language: ja, value: "c" } }));
    const b = validationCacheKey(rv(), target({ value: "a", base: { language: ja, value: "bc" } }));
    expect(a).not.toBe(b);
  });
});

describe("summarizeValidation", () => {
  it("重さ別・コード別の件数と、問題のあるセルの数", async () => {
    const res = await runValidators(
      [target({ value: "a" }), target({ value: "b" }), target({ value: "c" })],
      [
        rv({
          validate: (ctx) =>
            ctx.value === "a"
              ? [
                  { code: "len", message: "", severity: "warning" },
                  { code: "var", message: "" },
                ]
              : ctx.value === "b"
                ? [{ code: "len", message: "", severity: "info" }]
                : [],
        }),
      ],
      { tokenize },
    );
    expect(summarizeValidation(res)).toEqual({ error: 1, warning: 1, info: 1, byCode: { len: 2, var: 1 }, cells: 2 });
    expect(summarizeValidation([])).toEqual({ error: 0, warning: 0, info: 0, byCode: {}, cells: 0 });
  });
});

describe("severityAtLeast", () => {
  it("error > warning > info", () => {
    expect(severityAtLeast("error", "error")).toBe(true);
    expect(severityAtLeast("error", "info")).toBe(true);
    expect(severityAtLeast("warning", "error")).toBe(false);
    expect(severityAtLeast("warning", "warning")).toBe(true);
    expect(severityAtLeast("warning", "info")).toBe(true);
    expect(severityAtLeast("info", "warning")).toBe(false);
    expect(severityAtLeast("info", "info")).toBe(true);
  });
});

describe("stableStringify", () => {
  it("入れ子のオブジェクトのキーを並べ替える", () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("配列の順序は保つ", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
    expect(stableStringify([3, 1, 2])).not.toBe(stableStringify([1, 2, 3]));
  });

  it("JSON と同じ扱い（undefined、関数、toJSON、数値）", () => {
    expect(stableStringify({ a: undefined, b: () => 1, c: null })).toBe('{"c":null}');
    expect(stableStringify([undefined, () => 1])).toBe("[null,null]");
    expect(stableStringify(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
    expect(stableStringify(Number.NaN)).toBe("null");
    expect(stableStringify("a\"b")).toBe('"a\\"b"');
    expect(stableStringify(undefined)).toBe("null");
    const v = { x: [1, "2", true, null, { k: "v" }] };
    expect(JSON.parse(stableStringify(v))).toEqual(v);
  });

  it("同じ値が複数回出るのは循環ではない", () => {
    const shared = { a: 1 };
    expect(stableStringify([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });

  it("循環参照は分かるエラー", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => stableStringify(o)).toThrow(/循環参照/);
  });
});
