import { describe, expect, it } from "vitest";
import { EMPTY_FILTERS, isFiltering, normalizeFilters, toRowFilter } from "@/lib/client/filters";
import { applySuggestion, builderToText, conditionToText, defaultCondition, describeCondition, opsFor, queryFields, quoteValue, suggest } from "@/lib/client/query-text";
import { makeInfo } from "@/test/fixtures";

const info = makeInfo();
const fields = queryFields(info);
const field = (name: string) => fields.find((f) => f.name === name)!;
/** カーソルを式の最後に置いたときの候補の表示名。 */
const labels = (text: string) => suggest(text, text.length, fields, info).items.map((i) => i.label);

describe("条件に使える欄", () => {
  it("設定の列（アクション列を除く）を並び順どおりに出し、そのあとに組み込みの欄を出す", () => {
    expect(fields.map((f) => [f.name, f.type, f.perLanguage])).toEqual([
      ["key", "text", false],
      ["note", "text", false],
      ["text", "text", true],
      ["status", "enum", true],
      ["review", "enum", true],
      ["maxLen", "number", false],
      ["back", "text", true],
      // 列に "key" があるので、組み込みの key は出さない。
      ["resource", "text", false],
      ["issues", "severity", true],
      ["issueCode", "code", true],
      ["stale", "flag", true],
      ["unsaved", "flag", true],
    ]);
  });

  it("選択式の列は選択肢（値と表示名）を持ち、言語を限った列はその言語だけを持つ", () => {
    expect(field("status").options).toEqual([
      { value: "todo", label: "未着手" },
      { value: "done", label: "完了" },
    ]);
    expect(field("status").languages).toEqual(["ja", "en"]);
    expect(field("back").languages).toEqual(["en"]);
    expect(field("issues").options?.map((o) => o.value)).toEqual(["none", "info", "warning", "error"]);
  });

  it("欄の種類ごとに、選べる比べ方が決まる", () => {
    expect(opsFor(field("status")).map((o) => o.id)).toEqual(["eq", "ne", "ge", "le"]);
    expect(opsFor(field("text")).map((o) => o.id)).toEqual(["contains", "notContains", "eq", "ne", "empty", "notEmpty"]);
    expect(opsFor(field("maxLen")).map((o) => o.id)).toEqual(["eq", "ne", "gt", "ge", "lt", "le", "empty", "notEmpty"]);
    expect(opsFor(field("stale")).map((o) => o.id)).toEqual(["yes", "no"]);
  });
});

describe("組み立てた条件から式を作る", () => {
  it("欄、言語、比べ方、値を式にする。文字の欄の値は引用符で囲み、選択式と数はそのまま書く", () => {
    expect(conditionToText({ field: "status", language: "ja", op: "eq", value: "done" }, fields)).toBe("status@ja = done");
    expect(conditionToText({ field: "status", language: "any", op: "ne", value: "todo" }, fields)).toBe("status@any != todo");
    expect(conditionToText({ field: "text", language: "en", op: "empty", value: "" }, fields)).toBe("text@en is empty");
    expect(conditionToText({ field: "text", language: "all", op: "contains", value: "Save your" }, fields)).toBe('text@all ~ "Save your"');
    // 数字だけでも、文字の欄では文字として比べる。
    expect(conditionToText({ field: "note", language: "", op: "eq", value: "12" }, fields)).toBe('note = "12"');
    expect(conditionToText({ field: "maxLen", language: "", op: "ge", value: "6" }, fields)).toBe("maxLen >= 6");
    expect(conditionToText({ field: "issues", language: "en", op: "ge", value: "warning" }, fields)).toBe("issues@en >= warning");
    expect(conditionToText({ field: "stale", language: "any", op: "yes", value: "" }, fields)).toBe("stale@any");
    expect(conditionToText({ field: "unsaved", language: "ja", op: "no", value: "" }, fields)).toBe("not unsaved@ja");
    // 言語を選んでいなければ、どれかの言語。
    expect(conditionToText({ field: "status", language: "", op: "eq", value: "done" }, fields)).toBe("status@any = done");
    expect(conditionToText({ field: "nope", language: "", op: "eq", value: "x" }, fields)).toBeUndefined();
  });

  it("引用符やバックスラッシュを含む値は、エスケープして囲む。予約語と空の値も囲む", () => {
    expect(quoteValue("done")).toBe("done");
    expect(quoteValue("")).toBe('""');
    expect(quoteValue("and")).toBe('"and"');
    expect(quoteValue('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
    expect(quoteValue("a=b")).toBe('"a=b"');
    expect(quoteValue("12", true)).toBe('"12"');
  });

  it("条件を and か or でつなぐ。「でない」の条件は、かっこで囲む", () => {
    const conditions = [
      { field: "status", language: "ja", op: "eq", value: "done" },
      { field: "text", language: "en", op: "empty", value: "" },
      { field: "stale", language: "any", op: "no", value: "" },
    ];
    expect(builderToText({ join: "and", conditions }, fields)).toBe("status@ja = done and text@en is empty and (not stale@any)");
    expect(builderToText({ join: "or", conditions: conditions.slice(0, 2) }, fields)).toBe("status@ja = done or text@en is empty");
    expect(builderToText({ join: "and", conditions: conditions.slice(2) }, fields)).toBe("not stale@any");
    expect(builderToText({ join: "and", conditions: [] }, fields)).toBe("");
  });

  it("新しい条件は、その欄の最初の比べ方と最初の選択肢から始める（問題の重さは「警告以上」）", () => {
    expect(defaultCondition(field("status"))).toEqual({ field: "status", language: "any", op: "eq", value: "todo" });
    expect(defaultCondition(field("status"), "en")).toEqual({ field: "status", language: "en", op: "eq", value: "todo" });
    expect(defaultCondition(field("note"))).toEqual({ field: "note", language: "", op: "contains", value: "" });
    expect(defaultCondition(field("issues"))).toEqual({ field: "issues", language: "any", op: "ge", value: "warning" });
  });

  it("条件を、列と選択肢の表示名で読める文にする", () => {
    expect(describeCondition({ field: "status", language: "en", op: "eq", value: "done" }, fields, info)).toBe("状態（英語）が次と同じ「完了」");
    expect(describeCondition({ field: "text", language: "any", op: "empty", value: "" }, fields, info)).toBe("text（どれかの言語）が空");
  });
});

describe("式の補完", () => {
  it("欄を書く場所では、欄を出す。言語ごとの欄は「@」まで入れて、続けて言語を選ばせる", () => {
    const items = suggest("", 0, fields, info).items;
    expect(items.map((i) => i.label)).toEqual(["key", "note", "text@", "status@", "review@", "maxLen", "back@", "resource", "issues@", "issueCode@", "stale@", "unsaved@", "not", "("]);
    expect(items.find((i) => i.label === "status@")).toEqual({ label: "status@", detail: "状態（言語ごと）", insert: "status@" });
    expect(items.find((i) => i.label === "note")).toEqual({ label: "note", detail: "メモ", insert: "note " });
  });

  it("入力の途中では、前から合うものを先に、表示名に合うものも出す", () => {
    expect(labels("st")).toEqual(["status@", "stale@"]);
    // 表示名（「状態」）でも探せる。
    expect(labels("状")).toEqual(["status@"]);
    expect(labels("status@ja = done and re")).toEqual(["review@", "resource"]);
  });

  it("「列@」のあとは、その列のある言語と、any / all を出す", () => {
    const items = suggest("status@", 7, fields, info).items;
    expect(items.map((i) => [i.label, i.detail])).toEqual([
      ["status@ja", "状態（日本語）"],
      ["status@en", "状態（英語）"],
      ["status@any", "状態（どれかの言語）"],
      ["status@all", "状態（すべての言語）"],
    ]);
    expect(labels("back@")).toEqual(["back@en", "back@any", "back@all"]);
    expect(labels("status@e")).toEqual(["status@en"]);
  });

  it("欄のあとは、その欄の種類に合う比べ方を出す", () => {
    expect(labels("status@ja ")).toEqual(["=", "!=", "in (…)", ">=", "<=", ">", "<", "and", "or"]);
    expect(labels("note ")).toEqual(["~", "!~", "=", "!=", "is empty", "is not empty", "in (…)", "and", "or"]);
    expect(labels("stale@ja ")).toEqual(["= true", "= false", "and", "or"]);
    expect(labels("note is ")).toEqual(["empty", "not empty"]);
  });

  it("比べ方のあとは、選択式の列の選択肢（表示名つき）や、問題の重さを出す", () => {
    expect(suggest("status@ja = ", 12, fields, info).items).toEqual([
      { label: "todo", detail: "未着手", insert: "todo " },
      { label: "done", detail: "完了", insert: "done " },
    ]);
    // 前から合う done が先。途中に d のある todo は、そのあと。
    expect(labels("status@ja = d")).toEqual(["done", "todo"]);
    expect(labels("status@ja = do")).toEqual(["done", "todo"]);
    expect(labels("status@ja = don")).toEqual(["done"]);
    // 表示名でも探せる。
    expect(labels("status@ja = 完")).toEqual(["done"]);
    expect(labels("issues@en >= ")).toEqual(["none", "info", "warning", "error"]);
    expect(labels("review@en in (")).toEqual(["none", "back", "ok"]);
    expect(labels("review@en in (none, ")).toEqual(["none", "back", "ok"]);
    // 文字の欄には、値の候補はない。
    expect(labels("note = ")).toEqual([]);
  });

  it("条件のあとは、and / or を出す。かっこの中でも同じように進む", () => {
    expect(labels("status@ja = done ")).toEqual(["and", "or"]);
    expect(labels("text@en is empty ")).toEqual(["and", "or"]);
    expect(labels("review@en in (none, ok) ")).toEqual(["and", "or"]);
    expect(labels("(status@ja = done or note ~ x) ")).toEqual(["and", "or"]);
    expect(labels("status@ja = done and (")).toContain("text@");
    expect(labels("not ")).toContain("stale@");
  });

  it("候補を入れると、書きかけの語を置き換えて、カーソルをそのあとに置く", () => {
    const text = "status@ja = done and re";
    const result = suggest(text, text.length, fields, info);
    expect(applySuggestion(text, result, result.items[0]!)).toEqual({ text: "status@ja = done and review@", caret: 28 });
    // 式の途中でも、カーソルの位置の語だけを置き換える。
    const middle = suggest("st and note ~ x", 2, fields, info);
    expect(applySuggestion("st and note ~ x", middle, middle.items[1]!)).toEqual({ text: "stale@ and note ~ x", caret: 6 });
  });
});

describe("絞り込みをサービス層に送る形にする", () => {
  it("条件がなければ空。入っている条件だけを送る", () => {
    expect(toRowFilter(EMPTY_FILTERS, ["ja", "en"])).toEqual({});
    expect(isFiltering(EMPTY_FILTERS, ["ja"])).toBe(false);
    const filters = {
      ...EMPTY_FILTERS,
      search: "  save ",
      values: { "status@en": ["done"], "status@ja": [] },
      contains: { note: "memo" },
      onlyIssues: true,
      issueLevel: "error" as const,
      onlyStale: true,
      where: " text@en is empty ",
    };
    expect(toRowFilter(filters, ["ja", "en"])).toEqual({
      search: "save",
      filters: [
        { cellId: "status@en", values: ["done"] },
        { cellId: "note", contains: "memo" },
      ],
      where: "text@en is empty",
      onlyIssues: "error",
      onlyStale: true,
    });
    expect(isFiltering(filters, ["ja", "en"])).toBe(true);
  });

  it("表示していない言語の列の条件は送らない", () => {
    const filters = { ...EMPTY_FILTERS, values: { "status@en": ["done"] }, contains: { "back@en": "x", note: "memo" } };
    expect(toRowFilter(filters, ["ja"])).toEqual({ filters: [{ cellId: "note", contains: "memo" }] });
  });

  it("保存してあった絞り込みの、欠けた項目や形の違う値は、既定に戻す", () => {
    expect(normalizeFilters(undefined)).toEqual(EMPTY_FILTERS);
    expect(normalizeFilters("x")).toEqual(EMPTY_FILTERS);
    // where のなかった古い版の形。
    expect(normalizeFilters({ search: "a", onlyStale: true, values: { "status@ja": ["done"], bad: "x" }, issueLevel: "fatal" })).toEqual({
      ...EMPTY_FILTERS,
      search: "a",
      onlyStale: true,
      values: { "status@ja": ["done"] },
    });
    const builder = { join: "or" as const, conditions: [{ field: "note", language: "", op: "contains", value: "x" }] };
    expect(normalizeFilters({ where: 'note ~ "x"', builder })).toEqual({ ...EMPTY_FILTERS, where: 'note ~ "x"', builder });
    expect(normalizeFilters({ where: "a", builder: { join: "xor", conditions: [] } }).builder).toBeNull();
  });
});
