import { describe, expect, it } from "vitest";
import type { Change, FormatContext, LanguageDef, Options } from "@loc-studio/sdk";
import { createDelimitedFormat, csvFormat, tsvFormat } from "./csv.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);
const BOM = "﻿";

const langs = (...ids: string[]): LanguageDef[] => ids.map((id) => ({ id, label: id }));

function ctx(options: Options = {}, languages: LanguageDef[] = langs("ja", "en"), path = "text/main.csv"): FormatContext {
  return { resource: { id: path, path, name: path.split("/").pop() ?? path }, languages, options };
}

function apply(src: string, changes: Change[], c: FormatContext = ctx()): string {
  return dec(csvFormat.apply(enc(src), changes, c));
}

const setText = (key: string, language: string, value: unknown): Change => ({
  type: "set",
  key,
  field: { kind: "text", language },
  value,
});

describe("match", () => {
  it("拡張子で判定する（大文字小文字を区別しない）", () => {
    const r = (path: string) => ({ id: path, path, name: path });
    expect(csvFormat.match(r("a/b.csv"), new Uint8Array())).toBe(true);
    expect(csvFormat.match(r("a/B.CSV"), new Uint8Array())).toBe(true);
    expect(csvFormat.match(r("a/b.tsv"), new Uint8Array())).toBe(false);
    expect(tsvFormat.match(r("a/b.Tsv"), new Uint8Array())).toBe(true);
    expect(csvFormat.id).toBe("builtin.csv");
    expect(tsvFormat.id).toBe("builtin.tsv");
  });
});

describe("変更なしの往復はバイト単位で同一", () => {
  const cases: Record<string, string> = {
    simple: "key,ja,en\na,あ,A\nb,い,B\n",
    bom: BOM + "key,ja,en\r\na,あ,A\r\n",
    crlf: "key,ja,en\r\na,あ,A\r\nb,い,B\r\n",
    mixed: "key,ja,en\r\na,あ,A\nb,い,B\rc,う,C\r\n",
    quotedNewlines: 'key,ja,en\na,"一行目\r\n二行目","x ""y"" z"\nb,"a\nb\rc",B\n',
    blankLines: "key,ja,en\n\na,あ,A\n\r\n\nb,い,B\n\n",
    noTrailingNewline: "key,ja,en\na,あ,A\nb,い,B",
    emptyFile: "",
    emoji: "key,ja,en\na,😀👨‍👩‍👧,🎌\n",
  };
  for (const [name, src] of Object.entries(cases)) {
    it(name, () => {
      const input = enc(src);
      const out = csvFormat.apply(input, [], ctx());
      expect(Buffer.from(out).equals(Buffer.from(input))).toBe(true);
    });
  }

  it("不正な UTF-8 でも変更がなければそのまま返す", () => {
    const input = new Uint8Array([0x6b, 0x2c, 0xff, 0x0a]);
    expect(Array.from(csvFormat.apply(input, [], ctx()))).toEqual(Array.from(input));
  });

  it("不正な UTF-8 は解析時にパス付きの例外", () => {
    const input = new Uint8Array([0x6b, 0x2c, 0xff, 0x0a]);
    expect(() => csvFormat.parse(input, ctx())).toThrow(/text\/main\.csv/);
  });

  it("どこにも影響しない変更（同じキーへの rename）でもバイト単位で同一", () => {
    for (const src of Object.values(cases)) {
      if (src === "") continue;
      expect(apply(src, [{ type: "rename", key: "a", newKey: "a" }])).toBe(src);
    }
  });
});

describe("parse", () => {
  it("基本: 言語 ID と同じ見出しを本文として読む", () => {
    const doc = csvFormat.parse(enc("key,ja,en,note\na,あ,A,x\nb,い,B,y\n"), ctx());
    expect(doc.entries).toEqual([
      { key: "a", text: { ja: "あ", en: "A" }, location: { line: 2 } },
      { key: "b", text: { ja: "い", en: "B" }, location: { line: 3 } },
    ]);
    expect(doc.diagnostics).toEqual([]);
  });

  it("BOM を読み飛ばす", () => {
    const doc = csvFormat.parse(enc(BOM + "key,ja\na,あ\n"), ctx());
    expect(doc.entries[0]).toMatchObject({ key: "a", text: { ja: "あ" } });
  });

  it("引用符、エスケープ、フィールド内の改行と区切り", () => {
    const src = 'key,ja,en\na,"x,y","say ""hi"""\nb,"1\r\n2\n3\r4",B\nc,C,D\n';
    const doc = csvFormat.parse(enc(src), ctx());
    expect(doc.entries.map((e) => e.text)).toEqual([
      { ja: "x,y", en: 'say "hi"' },
      { ja: "1\r\n2\n3\r4", en: "B" },
      { ja: "C", en: "D" },
    ]);
    // 行番号はレコードの開始行。b のフィールドに改行が 3 つあるので c は 7 行目。
    expect(doc.entries.map((e) => e.location?.line)).toEqual([2, 3, 7]);
  });

  it("行番号: 改行の混在、空行", () => {
    const doc = csvFormat.parse(enc("key,ja\r\n\r\na,1\rb,2\n\nc,3"), ctx());
    expect(doc.entries.map((e) => [e.key, e.location?.line])).toEqual([
      ["a", 3],
      ["b", 4],
      ["c", 6],
    ]);
  });

  it("フィールドが足りない行は空として読む", () => {
    const doc = csvFormat.parse(enc("key,ja,en\na\nb,い\n"), ctx());
    expect(doc.entries.map((e) => e.text)).toEqual([
      { ja: "", en: "" },
      { ja: "い", en: "" },
    ]);
  });

  it("空のキーと重複キーは警告", () => {
    const doc = csvFormat.parse(enc("key,ja\na,1\n,2\na,3\nb,4\n"), ctx());
    expect(doc.entries.map((e) => [e.key, e.text.ja])).toEqual([
      ["a", "1"],
      ["b", "4"],
    ]);
    expect(doc.diagnostics).toHaveLength(2);
    expect(doc.diagnostics?.[0]).toMatchObject({ severity: "warning", line: 3 });
    expect(doc.diagnostics?.[1]).toMatchObject({ severity: "warning", line: 4 });
    expect(doc.diagnostics?.[1]?.message).toContain("a");
  });

  it("閉じていない引用符は警告", () => {
    const doc = csvFormat.parse(enc('key,ja\na,"abc\n'), ctx());
    expect(doc.entries[0]?.text.ja).toBe("abc\n");
    expect(doc.diagnostics?.some((d) => d.severity === "warning" && d.line === 2)).toBe(true);
  });

  it("オプション: key / text / columns / stableId", () => {
    const src = "ID,Japanese,English,Speaker,Note_ja,UID\nx,こんにちは,Hello,Alice,丁寧に,u1\ny,さようなら,Bye,,,\n";
    const c = ctx({
      key: "ID",
      text: { ja: "Japanese", en: "English" },
      columns: { speaker: "Speaker", "note@ja": "Note_ja" },
      stableId: "UID",
    });
    const doc = csvFormat.parse(enc(src), c);
    expect(doc.entries).toEqual([
      {
        key: "x",
        stableId: "u1",
        text: { ja: "こんにちは", en: "Hello" },
        meta: { speaker: "Alice" },
        languageMeta: { ja: { note: "丁寧に" } },
        location: { line: 2 },
      },
      {
        key: "y",
        text: { ja: "さようなら", en: "Bye" },
        meta: { speaker: "" },
        languageMeta: { ja: { note: "" } },
        location: { line: 3 },
      },
    ]);
  });

  it("key に指定した列が先頭でなくてもよい", () => {
    const doc = csvFormat.parse(enc("ja,id\nあ,k1\n"), ctx({ key: "id" }));
    expect(doc.entries).toEqual([{ key: "k1", text: { ja: "あ" }, location: { line: 2 } }]);
  });

  it("key の列がなければエラーの診断", () => {
    const doc = csvFormat.parse(enc("a,b\n1,2\n"), ctx({ key: "id" }));
    expect(doc.entries).toEqual([]);
    expect(doc.diagnostics?.[0]?.severity).toBe("error");
    expect(doc.diagnostics?.[0]?.message).toContain("id");
  });

  it("設定にある列が見出しになければ警告", () => {
    const doc = csvFormat.parse(enc("key,ja\na,1\n"), ctx({ text: { ja: "ja", en: "English" } }));
    expect(doc.entries[0]?.text).toEqual({ ja: "1" });
    expect(doc.diagnostics?.[0]).toMatchObject({ severity: "warning", line: 1 });
    expect(doc.diagnostics?.[0]?.message).toContain("English");
  });

  it("delimiter オプション", () => {
    const doc = csvFormat.parse(enc("key;ja\na;x,y\n"), ctx({ delimiter: ";" }));
    expect(doc.entries[0]?.text.ja).toBe("x,y");
  });

  it("空のファイル、見出しだけのファイル", () => {
    expect(csvFormat.parse(enc(""), ctx()).entries).toEqual([]);
    expect(csvFormat.parse(enc("key,ja"), ctx()).entries).toEqual([]);
  });
});

describe("apply: set", () => {
  it("対象のフィールドだけを変える（前後のバイトは同一）", () => {
    const before = BOM + 'key,ja,en\r\na,"あ, い",A\r\nb,う,"B\nB"\r\nc,え,C';
    const target = "う";
    const idx = before.indexOf(target);
    const out = csvFormat.apply(enc(before), [setText("b", "ja", "新しい値")], ctx());
    const prefix = enc(before.slice(0, idx));
    const suffix = enc(before.slice(idx + target.length));
    const newRaw = enc("新しい値");
    expect(Buffer.from(out.subarray(0, prefix.length)).equals(Buffer.from(prefix))).toBe(true);
    expect(Buffer.from(out.subarray(prefix.length, prefix.length + newRaw.length)).equals(Buffer.from(newRaw))).toBe(true);
    expect(Buffer.from(out.subarray(prefix.length + newRaw.length)).equals(Buffer.from(suffix))).toBe(true);
    expect(out.length).toBe(prefix.length + newRaw.length + suffix.length);
  });

  it("多バイト文字の後ろにあるフィールドも正しく置き換える", () => {
    const src = "key,ja,en\n😀,👨‍👩‍👧漢字,A\n漢,字,B\n";
    expect(apply(src, [{ type: "set", key: "漢", field: { kind: "text", language: "en" }, value: "🎌日本" }])).toBe(
      "key,ja,en\n😀,👨‍👩‍👧漢字,A\n漢,字,🎌日本\n",
    );
    expect(apply(src, [setText("😀", "en", "x")])).toBe("key,ja,en\n😀,👨‍👩‍👧漢字,x\n漢,字,B\n");
  });

  it("引用符の規則", () => {
    const src = "key,ja\na,x\n";
    const out = (v: unknown) => apply(src, [setText("a", "ja", v)]);
    expect(out("plain")).toBe("key,ja\na,plain\n");
    expect(out("x,y")).toBe('key,ja\na,"x,y"\n');
    expect(out('say "hi"')).toBe('key,ja\na,"say ""hi"""\n');
    expect(out("1\n2")).toBe('key,ja\na,"1\n2"\n');
    expect(out("1\r2")).toBe('key,ja\na,"1\r2"\n');
    expect(out(" lead")).toBe('key,ja\na," lead"\n');
    expect(out("trail ")).toBe('key,ja\na,"trail "\n');
    expect(out("\ttab")).toBe('key,ja\na,"\ttab"\n');
    expect(out("")).toBe("key,ja\na,\n");
    expect(out(null)).toBe("key,ja\na,\n");
    expect(out(undefined)).toBe("key,ja\na,\n");
    expect(out(42)).toBe("key,ja\na,42\n");
    expect(out(true)).toBe("key,ja\na,true\n");
  });

  it("元が引用符付きなら引用符を保つ", () => {
    expect(apply('key,ja\na,"x"\n', [setText("a", "ja", "y")])).toBe('key,ja\na,"y"\n');
    expect(apply('key,ja\na,"x"\n', [setText("a", "ja", "")])).toBe('key,ja\na,""\n');
  });

  it("足りないフィールドは空で埋める", () => {
    const src = "key,ja,en,fr\na\nb,x\n";
    expect(apply(src, [setText("a", "en", "E")], ctx({}, langs("ja", "en", "fr")))).toBe("key,ja,en,fr\na,,E\nb,x\n");
    expect(apply(src, [setText("b", "fr", "F")], ctx({}, langs("ja", "en", "fr")))).toBe("key,ja,en,fr\na\nb,x,,F\n");
  });

  it("meta / languageMeta の列", () => {
    const src = "key,ja,speaker,note_ja\na,あ,,\n";
    const c = ctx({ columns: { speaker: "speaker", "note@ja": "note_ja" } });
    const out = apply(
      src,
      [
        { type: "set", key: "a", field: { kind: "meta", column: "speaker" }, value: "Bob" },
        { type: "set", key: "a", field: { kind: "meta", column: "note", language: "ja" }, value: "メモ" },
      ],
      c,
    );
    expect(out).toBe("key,ja,speaker,note_ja\na,あ,Bob,メモ\n");
  });

  it("addColumns: never では、列が見出しにない場合に列名とパスを含む例外", () => {
    const never = (o: Options = {}) => ctx({ ...o, addColumns: "never" });
    expect(() => apply("key,ja\na,x\n", [setText("a", "en", "y")], never({ text: { en: "English" } }))).toThrow(
      /English.*text\/main\.csv/,
    );
    expect(() => apply("key,ja\na,x\n", [setText("a", "en", "y")], never())).toThrow(/en.*text\/main\.csv/);
    expect(() =>
      apply(
        "key,ja\na,x\n",
        [{ type: "set", key: "a", field: { kind: "meta", column: "speaker" }, value: "y" }],
        never({ columns: { speaker: "Speaker" } }),
      ),
    ).toThrow(/Speaker.*text\/main\.csv/);
  });

  it("対応のない meta の列は、どの設定でも例外", () => {
    for (const addColumns of ["all-rows", "header-only", "never"]) {
      expect(() =>
        apply(
          "key,ja\na,x\n",
          [{ type: "set", key: "a", field: { kind: "meta", column: "speaker" }, value: "y" }],
          ctx({ addColumns }),
        ),
      ).toThrow(/speaker.*columns.*text\/main\.csv/);
    }
  });

  it("プロジェクトにない言語で、対応もなければ例外", () => {
    expect(() => apply("key,ja\na,x\n", [setText("a", "xx", "y")])).toThrow(/xx.*text\/main\.csv/);
  });

  it("知らないキーは例外", () => {
    expect(() => apply("key,ja\na,x\n", [setText("zzz", "ja", "y")])).toThrow(/zzz/);
    expect(() => apply("key,ja\na,x\n", [{ type: "remove", key: "zzz" }])).toThrow(/zzz/);
    expect(() => apply("key,ja\na,x\n", [{ type: "rename", key: "zzz", newKey: "q" }])).toThrow(/zzz/);
    expect(() =>
      apply("key,ja\na,x\n", [{ type: "add", after: "zzz", entry: { key: "q", text: {} } }]),
    ).toThrow(/zzz/);
  });

  it("重複キーの set は最初のレコードに当たる", () => {
    expect(apply("key,ja\na,1\na,2\n", [setText("a", "ja", "x")])).toBe("key,ja\na,x\na,2\n");
  });

  it("BOM と CRLF を保つ", () => {
    expect(apply(BOM + "key,ja\r\na,x\r\n", [setText("a", "ja", "y")])).toBe(BOM + "key,ja\r\na,y\r\n");
  });
});

describe("apply: rename / remove / add", () => {
  it("rename はキーのフィールドだけを変える", () => {
    expect(apply("key,ja\na,x\nb,y\n", [{ type: "rename", key: "a", newKey: "a2" }])).toBe("key,ja\na2,x\nb,y\n");
    expect(apply('key,ja\n"a",x\n', [{ type: "rename", key: "a", newKey: "a,b" }])).toBe('key,ja\n"a,b",x\n');
  });

  it("rename で既存のキーや空のキーにすると例外", () => {
    expect(() => apply("key,ja\na,x\nb,y\n", [{ type: "rename", key: "a", newKey: "b" }])).toThrow(/b/);
    expect(() => apply("key,ja\na,x\n", [{ type: "rename", key: "a", newKey: "" }])).toThrow();
  });

  it("remove は改行ごと消す", () => {
    expect(apply("key,ja\r\na,x\r\nb,y\r\nc,z\r\n", [{ type: "remove", key: "b" }])).toBe("key,ja\r\na,x\r\nc,z\r\n");
    expect(apply('key,ja\na,"1\n2"\nb,y\n', [{ type: "remove", key: "a" }])).toBe("key,ja\nb,y\n");
  });

  it("remove: 改行のないファイルの最後のレコード", () => {
    expect(apply("key,ja\na,x\nb,y", [{ type: "remove", key: "b" }])).toBe("key,ja\na,x");
  });

  it("remove の後は重複していた次のレコードが有効になる", () => {
    expect(apply("key,ja\na,1\na,2\n", [{ type: "remove", key: "a" }, setText("a", "ja", "x")])).toBe("key,ja\na,x\n");
  });

  it("add: after の後ろに、見出しと同じ数のフィールドで入れる", () => {
    const out = apply("key,ja,en\na,x,X\nb,y,Y\n", [
      { type: "add", after: "a", entry: { key: "n", text: { en: "N" } } },
    ]);
    expect(out).toBe("key,ja,en\na,x,X\nn,,N\nb,y,Y\n");
  });

  it("add: 末尾に、主な改行で入れる", () => {
    expect(apply("key,ja\r\na,x\r\nb,y\n", [{ type: "add", entry: { key: "n", text: { ja: "あ, い" } } }])).toBe(
      'key,ja\r\na,x\r\nb,y\nn,"あ, い"\r\n',
    );
  });

  it("add: 改行のないファイルの末尾に足しても、末尾に改行がない状態を保つ", () => {
    expect(apply("key,ja\r\na,x", [{ type: "add", entry: { key: "n", text: { ja: "N" } } }])).toBe(
      "key,ja\r\na,x\r\nn,N",
    );
    expect(apply("key,ja", [{ type: "add", entry: { key: "n", text: { ja: "N" } } }])).toBe("key,ja\nn,N");
    expect(apply("key,ja\na,x", [{ type: "add", after: "a", entry: { key: "n", text: {} } }])).toBe("key,ja\na,x\nn,");
  });

  it("add: 末尾の空行は末尾に残す", () => {
    expect(apply("key,ja\na,x\n\n", [{ type: "add", entry: { key: "n", text: { ja: "N" } } }])).toBe(
      "key,ja\na,x\nn,N\n\n",
    );
  });

  it("add: meta / languageMeta / stableId", () => {
    const c = ctx({ columns: { speaker: "speaker", "note@ja": "note_ja" }, stableId: "uid" });
    const out = apply(
      "key,ja,speaker,note_ja,uid\n",
      [
        {
          type: "add",
          entry: { key: "n", stableId: "u9", text: { ja: "あ" }, meta: { speaker: "A" }, languageMeta: { ja: { note: "メ" } } },
        },
      ],
      c,
    );
    expect(out).toBe("key,ja,speaker,note_ja,uid\nn,あ,A,メ,u9\n");
  });

  it("add: 既存のキー、空のキー、見出しにない列は例外", () => {
    expect(() => apply("key,ja\na,x\n", [{ type: "add", entry: { key: "a", text: {} } }])).toThrow(/a/);
    expect(() => apply("key,ja\na,x\n", [{ type: "add", entry: { key: "", text: {} } }])).toThrow();
    expect(() =>
      apply("key,ja\na,x\n", [{ type: "add", entry: { key: "n", text: { en: "E" } } }], ctx({ addColumns: "never" })),
    ).toThrow(/en/);
  });

  it("見出しのないファイルへの変更は例外", () => {
    expect(() => apply("", [{ type: "add", entry: { key: "n", text: {} } }])).toThrow(/text\/main\.csv/);
  });
});

describe("apply: 複数の変更の順序", () => {
  it("rename の後の set は新しいキーを使う", () => {
    const out = apply("key,ja\na,x\n", [{ type: "rename", key: "a", newKey: "b" }, setText("b", "ja", "y")]);
    expect(out).toBe("key,ja\nb,y\n");
    expect(() => apply("key,ja\na,x\n", [{ type: "rename", key: "a", newKey: "b" }, setText("a", "ja", "y")])).toThrow(
      /a/,
    );
  });

  it("追加したエントリへの set、after への連鎖", () => {
    const out = apply("key,ja\na,x\nb,y\n", [
      { type: "add", after: "a", entry: { key: "n1", text: {} } },
      { type: "add", after: "n1", entry: { key: "n2", text: {} } },
      setText("n1", "ja", "1"),
      setText("n2", "ja", "2"),
      { type: "remove", key: "b" },
    ]);
    expect(out).toBe("key,ja\na,x\nn1,1\nn2,2\n");
  });

  it("remove の後の add で同じキーを使える", () => {
    const out = apply("key,ja\na,x\nb,y\n", [
      { type: "remove", key: "a" },
      { type: "add", after: "b", entry: { key: "a", text: { ja: "z" } } },
    ]);
    expect(out).toBe("key,ja\nb,y\na,z\n");
  });

  it("同じフィールドへの set は後勝ち", () => {
    expect(apply('key,ja\na,"x"\n', [setText("a", "ja", "1"), setText("a", "ja", "2")])).toBe('key,ja\na,"2"\n');
  });
});

describe("apply: 列の追加", () => {
  const L = langs("ja", "en", "fr", "de");
  const reparse = (out: string, c: FormatContext) =>
    Object.fromEntries(csvFormat.parse(enc(out), c).entries.map((e) => [e.key, e.text]));

  it("text: 対応がなければ言語 ID を見出しにし、全レコードの末尾に空のフィールドを足す", () => {
    const c = ctx({}, L);
    const out = apply("key,ja\r\na,x\r\nb,y\r\n", [setText("a", "en", "A")], c);
    expect(out).toBe("key,ja,en\r\na,x,A\r\nb,y,\r\n");
    expect(reparse(out, c)).toEqual({ a: { ja: "x", en: "A" }, b: { ja: "y", en: "" } });
  });

  it("text: 対応（text）があればその見出しを使う", () => {
    const c = ctx({ text: { ja: "Japanese", en: "English (US)" } }, L);
    const out = apply("key,Japanese\na,x\n", [setText("a", "en", "A")], c);
    expect(out).toBe("key,Japanese,English (US)\na,x,A\n");
    expect(reparse(out, c)).toEqual({ a: { ja: "x", en: "A" } });
  });

  it("text: text があってもその言語の対応がなければ言語 ID を見出しにし、読み戻せる", () => {
    const c = ctx({ text: { ja: "Japanese" } }, L);
    const out = apply("key,Japanese\na,x\n", [setText("a", "fr", "F")], c);
    expect(out).toBe("key,Japanese,fr\na,x,F\n");
    expect(reparse(out, c)).toEqual({ a: { ja: "x", fr: "F" } });
  });

  it("text: 言語 ID の見出しが別の言語の対応に使われていれば例外", () => {
    const c = ctx({ text: { ja: "en" } }, L);
    expect(() => apply("key,en\na,x\n", [setText("a", "en", "A")], c)).toThrow(/en.*text\/main\.csv/);
  });

  it("meta: columns の対応の見出しで足す（引用符の規則も同じ）", () => {
    const c = ctx({ columns: { speaker: "Speaker", "note@en": "Note, EN" } }, L);
    const out = apply(
      "key,ja\na,x\nb,y\n",
      [
        { type: "set", key: "b", field: { kind: "meta", column: "note", language: "en" }, value: "n 1" },
        { type: "set", key: "a", field: { kind: "meta", column: "speaker", }, value: "S" },
      ],
      c,
    );
    expect(out).toBe('key,ja,"Note, EN",Speaker\na,x,,S\nb,y,n 1,\n');
    const doc = csvFormat.parse(enc(out), c);
    expect(doc.entries[0]).toMatchObject({ key: "a", meta: { speaker: "S" }, languageMeta: { en: { note: "" } } });
    expect(doc.entries[1]).toMatchObject({ key: "b", meta: { speaker: "" }, languageMeta: { en: { note: "n 1" } } });
  });

  it("header-only: 見出しと値を入れるレコードにだけ足す", () => {
    const c = ctx({ addColumns: "header-only" }, L);
    const out = apply("key,ja\na,x\nb,y\nc,z\n", [setText("b", "en", "B"), setText("c", "fr", "F")], c);
    expect(out).toBe("key,ja,en,fr\na,x\nb,y,B\nc,z,,F\n");
    expect(reparse(out, c)).toEqual({
      a: { ja: "x", en: "", fr: "" },
      b: { ja: "y", en: "B", fr: "" },
      c: { ja: "z", en: "", fr: "F" },
    });
  });

  it("all-rows: 空行はそのまま、元から短いレコードは手を入れたときだけ全幅に揃える", () => {
    const c = ctx({}, L);
    const src = "key,ja,en\n\na\nb,y,Y\nc,z\n\n";
    const out = apply(src, [setText("c", "fr", "F")], c);
    expect(out).toBe("key,ja,en,fr\n\na\nb,y,Y,\nc,z,,F\n\n");
    expect(reparse(out, c)).toEqual({
      a: { ja: "", en: "", fr: "" },
      b: { ja: "y", en: "Y", fr: "" },
      c: { ja: "z", en: "", fr: "F" },
    });
  });

  it("all-rows: BOM、改行の混在、フィールド内の改行、末尾に改行なし", () => {
    const c = ctx({}, L);
    const src = BOM + 'key,ja\r\na,"1\r\n2"\nb,y\rc,"z"';
    const out = apply(src, [setText("c", "en", "Z")], c);
    expect(out).toBe(BOM + 'key,ja,en\r\na,"1\r\n2",\nb,y,\rc,"z",Z');
    expect(reparse(out, c)).toEqual({ a: { ja: "1\r\n2", en: "" }, b: { ja: "y", en: "" }, c: { ja: "z", en: "Z" } });
  });

  it("見出しより長いレコードがあれば、その余りと重ならない位置に足す", () => {
    const c = ctx({}, L);
    const out = apply("key,ja\na,x,extra\nb,y\n", [setText("b", "en", "B")], c);
    expect(out).toBe("key,ja,,en\na,x,extra,\nb,y,,B\n");
    expect(reparse(out, c)).toEqual({ a: { ja: "x", en: "" }, b: { ja: "y", en: "B" } });
  });

  it("列がない状態で空を入れても何も変わらない", () => {
    const src = "key,ja\na,x\n";
    expect(apply(src, [setText("a", "en", ""), setText("a", "fr", null)], ctx({}, L))).toBe(src);
  });

  it("引用符が閉じていない最後のレコードには区切りを足さない", () => {
    const c = ctx({}, L);
    expect(apply('key,ja\nb,y\na,"x', [setText("b", "en", "B")], c)).toBe('key,ja,en\nb,y,B\na,"x');
    expect(() => apply('key,ja\nb,y\na,"x', [setText("a", "en", "A")], c)).toThrow(/3 行目.*text\/main\.csv/);
  });

  it("複数の新しい列を、rename / remove / add と組み合わせても整合する", () => {
    const c = ctx({}, L);
    const out = apply(
      "key,ja\na,x\nb,y\nc,z",
      [
        setText("a", "en", "A"),
        { type: "rename", key: "b", newKey: "b2" },
        { type: "add", after: "b2", entry: { key: "n", text: { ja: "N", fr: "F" } } },
        setText("b2", "de", "D"),
        { type: "remove", key: "c" },
        setText("a", "en", "A2"),
        { type: "add", entry: { key: "m", text: { de: "M" } } },
      ],
      c,
    );
    // 列は変更が持ち込んだ順（en → fr → de）。
    expect(out).toBe("key,ja,en,fr,de\na,x,A2,,\nb2,y,,,D\nn,N,,F,\nm,,,,M");
    expect(reparse(out, c)).toEqual({
      a: { ja: "x", en: "A2", fr: "", de: "" },
      b2: { ja: "y", en: "", fr: "", de: "D" },
      n: { ja: "N", en: "", fr: "F", de: "" },
      m: { ja: "", en: "", fr: "", de: "M" },
    });
  });

  it("add の stableId の列も足す", () => {
    const c = ctx({ stableId: "uid" }, L);
    const out = apply("key,ja\na,x\n", [{ type: "add", entry: { key: "n", stableId: "u1", text: { ja: "N" } } }], c);
    expect(out).toBe("key,ja,uid\na,x,\nn,N,u1\n");
    expect(csvFormat.parse(enc(out), c).entries[1]).toMatchObject({ key: "n", stableId: "u1" });
  });

  it("TSV", () => {
    const c = ctx({}, L, "a.tsv");
    const out = dec(tsvFormat.apply(enc("key\tja\r\na\tx\r\nb\ty"), [setText("a", "en", "A\tB")], c));
    expect(out).toBe('key\tja\ten\r\na\tx\t"A\tB"\r\nb\ty\t');
    expect(tsvFormat.parse(enc(out), c).entries.map((e) => e.text)).toEqual([
      { ja: "x", en: "A\tB" },
      { ja: "y", en: "" },
    ]);
  });

  it("不正な addColumns は例外", () => {
    expect(() => apply("key,ja\na,x\n", [setText("a", "ja", "y")], ctx({ addColumns: "some" }))).toThrow(/addColumns/);
  });
});

describe("乱択: 列の追加を含む set を参照モデルとバイト単位で比べる", () => {
  for (const [format, delim] of [
    [csvFormat, ","],
    [tsvFormat, "\t"],
  ] as const) {
    for (const mode of ["all-rows", "header-only"] as const) {
      it(`${format.id} / ${mode}`, () => {
        const r = rng((delim === "," ? 1000 : 2000) + (mode === "all-rows" ? 1 : 2));
        const allLangs = ["ja", "en", "fr", "de", "es"] as const;
        const c = ctx({ addColumns: mode }, langs(...allLangs), "rand" + (delim === "," ? ".csv" : ".tsv"));
        type Cell = { raw: string; quoted: boolean };
        const toCell = (v: string, quoted: boolean): Cell => {
          const q = quoted || v.includes(delim) || /["\r\n]/.test(v) || /^\s|\s$/.test(v);
          return { raw: q ? '"' + v.replace(/"/g, '""') + '"' : v, quoted: q };
        };
        for (let round = 0; round < 150; round++) {
          // 見出しは key, ja, en, fr。de と es は見出しにない。
          type Line = { kind: "header" | "blank" | "row"; key?: string; cells: Cell[]; raw: string; eol: string };
          const lines: Line[] = [];
          const headerCells = ["key", "ja", "en", "fr"].map((h) => ({ raw: h, quoted: false }));
          lines.push({ kind: "header", cells: headerCells, raw: headerCells.map((x) => x.raw).join(delim), eol: "" });
          const values: Record<string, Record<string, string>> = {};
          const rows = 1 + Math.floor(r() * 6);
          for (let i = 0; i < rows; i++) {
            const key = `k${i}` + (r() < 0.3 ? "漢" : "");
            const vals: Record<string, string> = { ja: randomValue(r), en: randomValue(r), fr: randomValue(r) };
            const cells = [key, vals.ja!, vals.en!, vals.fr!].map((v) => toCell(v, r() < 0.2));
            if (r() < 0.2) while (cells.length > 1 && cells[cells.length - 1]!.raw === "") cells.pop();
            if (cells.length === 4 && r() < 0.1) cells.push({ raw: "extra", quoted: false });
            values[key] = vals;
            lines.push({ kind: "row", key, cells, raw: cells.map((x) => x.raw).join(delim), eol: "" });
            if (r() < 0.15) lines.push({ kind: "blank", cells: [], raw: "", eol: "" });
          }
          // 最後が空行のまま改行なしで終わるとファイルに現れないので、その形は作らない。
          const trailing = r() < 0.5 || lines[lines.length - 1]!.kind === "blank";
          const eols = ["\n", "\r\n", "\r"];
          lines.forEach((l, i) => {
            l.eol = i < lines.length - 1 || trailing ? eols[Math.floor(r() * eols.length)]! : "";
          });
          const bom = r() < 0.3 ? BOM : "";
          const src = bom + lines.map((l) => l.raw + l.eol).join("");

          // 参照モデルで期待するバイト列を作る。
          const headerWidth = 4;
          const baseWidth = Math.max(headerWidth, ...lines.filter((l) => l.kind === "row").map((l) => l.cells.length));
          const created: string[] = [];
          const edited = new Set<Line>();
          const changes: Change[] = [];
          const expected = structuredClone(values);
          const rowLines = lines.filter((l) => l.kind === "row");
          const n = Math.floor(r() * 5);
          for (let i = 0; i < n; i++) {
            const line = rowLines[Math.floor(r() * rowLines.length)]!;
            const language = allLangs[Math.floor(r() * allLangs.length)]!;
            const value = r() < 0.15 ? "" : randomValue(r);
            changes.push(setText(line.key!, language, value));
            let index = ["ja", "en", "fr"].indexOf(language) + 1;
            if (index === 0) {
              const at = created.indexOf(language);
              if (at < 0) {
                if (value === "") continue;
                created.push(language);
                index = baseWidth + created.length - 1;
                const h = lines[0]!;
                while (h.cells.length < index) h.cells.push({ raw: "", quoted: false });
                h.cells.push({ raw: language, quoted: false });
                edited.add(h);
              } else {
                index = baseWidth + at;
              }
            }
            while (line.cells.length <= index) line.cells.push({ raw: "", quoted: false });
            line.cells[index] = toCell(value, line.cells[index]!.quoted);
            edited.add(line);
            expected[line.key!]![language] = value;
          }
          const full = baseWidth + created.length;
          let want = bom;
          for (const l of lines) {
            if (l.kind === "blank") want += "";
            else if (edited.has(l)) {
              const cells = [...l.cells];
              if (mode === "all-rows" && created.length > 0) while (cells.length < full) cells.push({ raw: "", quoted: false });
              want += cells.map((x) => x.raw).join(delim);
            } else {
              // 手を入れていないレコード: 元のバイト列 + 末尾に足した区切りだけ。
              const w = l.raw === "" ? 0 : l.cells.length;
              want += l.raw;
              if (mode === "all-rows" && created.length > 0 && w >= headerWidth) want += delim.repeat(full - w);
            }
            want += l.eol;
          }

          const out = dec(format.apply(enc(src), changes, c));
          expect(out).toBe(want);
          const reparsed = format.parse(enc(out), c);
          expect(reparsed.entries.map((e) => e.key)).toEqual(rowLines.map((l) => l.key));
          for (const e of reparsed.entries) {
            const exp: Record<string, string> = { ...expected[e.key] };
            for (const lang of created) exp[lang] ??= "";
            expect(e.text).toEqual(exp);
          }
        }
      });
    }
  }
});

describe("TSV", () => {
  it("タブ区切りで読み書きする", () => {
    const src = 'key\tja\ten\na\tあ, い\tA\nb\t"x\ty"\tB\n';
    const doc = tsvFormat.parse(enc(src), ctx({}, langs("ja", "en"), "a.tsv"));
    expect(doc.entries.map((e) => e.text)).toEqual([
      { ja: "あ, い", en: "A" },
      { ja: "x\ty", en: "B" },
    ]);
    const out = dec(
      tsvFormat.apply(enc(src), [setText("a", "en", "with\ttab"), setText("b", "en", "c,d")], ctx({}, langs("ja", "en"), "a.tsv")),
    );
    expect(out).toBe('key\tja\ten\na\tあ, い\t"with\ttab"\nb\t"x\ty"\tc,d\n');
  });

  it("複数文字の区切りも扱える", () => {
    const f = createDelimitedFormat({ id: "x", delimiter: "||", extensions: [".txt"] });
    const src = "key||ja\na||x|y\n";
    expect(f.parse(enc(src), ctx()).entries[0]?.text.ja).toBe("x|y");
    expect(dec(f.apply(enc(src), [setText("a", "ja", "p||q")], ctx()))).toBe('key||ja\na||"p||q"\n');
  });

  it("不正な区切り文字は例外", () => {
    expect(() => csvFormat.parse(enc("a"), ctx({ delimiter: '"' }))).toThrow();
    expect(() => csvFormat.parse(enc("a"), ctx({ delimiter: "" }))).toThrow();
  });
});

describe("create", () => {
  it("設定から見出しを作る", () => {
    const c = ctx({ columns: { speaker: "Speaker", "note@en": "Note EN" } }, langs("ja", "en"));
    const out = csvFormat.create!(
      [
        { key: "a", text: { ja: "あ", en: "A, B" }, meta: { speaker: "S" }, languageMeta: { en: { note: "n" } } },
        { key: "b", text: { ja: 'say "x"' } },
      ],
      c,
    );
    expect(dec(out)).toBe('key,ja,en,Speaker,Note EN\na,あ,"A, B",S,n\nb,"say ""x""",,,\n');
    expect(out[0]).not.toBe(0xef);
  });

  it("key / text / stableId の指定", () => {
    const c = ctx({ key: "ID", text: { en: "English", ja: "Japanese" }, stableId: "UID" }, langs("ja", "en", "fr"));
    const out = dec(csvFormat.create!([{ key: "a", stableId: "u", text: { ja: "あ", en: "A", fr: "F" } }], c));
    // 言語の順は ctx.languages の順。text にない言語は列を作らない。
    expect(out).toBe("ID,Japanese,English,UID\na,あ,A,u\n");
    // 作ったファイルを読み戻せる。
    expect(csvFormat.parse(enc(out), c).entries).toEqual([
      { key: "a", stableId: "u", text: { ja: "あ", en: "A" }, location: { line: 2 } },
    ]);
  });

  it("TSV で作る", () => {
    expect(dec(tsvFormat.create!([{ key: "a", text: { ja: "x\ty" } }], ctx({}, langs("ja"))))).toBe('key\tja\na\t"x\ty"\n');
  });
});

// ---------------------------------------------------------------------------
// 乱択テスト
// ---------------------------------------------------------------------------

/** 再現できるように固定の種から作る乱数（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ["a", "b", "Z", " ", '"', ",", "\t", "\n", "\r\n", "\r", "あ", "漢", "😀", "👨‍👩‍👧", "x y", '""'];

function randomValue(r: () => number): string {
  const len = Math.floor(r() * 6);
  let s = "";
  for (let i = 0; i < len; i++) s += PIECES[Math.floor(r() * PIECES.length)];
  return s;
}

function serializeField(v: string, delim: string, r: () => number): string {
  const must = v.includes(delim) || /["\r\n]/.test(v);
  return must || r() < 0.2 ? '"' + v.replace(/"/g, '""') + '"' : v;
}

describe("乱択: set の後に読み戻すと、変えた値だけが変わっている", () => {
  for (const [format, delim] of [
    [csvFormat, ","],
    [tsvFormat, "\t"],
  ] as const) {
    it(format.id, () => {
      const r = rng(format.id === "builtin.csv" ? 12345 : 67890);
      const languages = langs("ja", "en", "fr");
      const c = ctx({}, languages, "rand" + (delim === "," ? ".csv" : ".tsv"));
      for (let round = 0; round < 150; round++) {
        const rows = 1 + Math.floor(r() * 8);
        const eols = ["\n", "\r\n", "\r"];
        const table: Record<string, Record<string, string>> = {};
        const lines: string[] = ["key" + delim + "ja" + delim + "en" + delim + "fr"];
        const keys: string[] = [];
        for (let i = 0; i < rows; i++) {
          const key = `k${i}` + (r() < 0.3 ? "😀" : "");
          keys.push(key);
          const vals = { ja: randomValue(r), en: randomValue(r), fr: randomValue(r) };
          table[key] = vals;
          // 末尾の空フィールドを省いた短い行もときどき作る（ただし省けるのは空の値だけ）。
          const cells = [key, vals.ja, vals.en, vals.fr].map((v) => serializeField(v, delim, r));
          if (r() < 0.2) while (cells.length > 1 && cells[cells.length - 1] === "") cells.pop();
          lines.push(cells.join(delim));
          if (r() < 0.1) lines.push("");
        }
        let src = r() < 0.3 ? BOM : "";
        lines.forEach((l, i) => {
          src += l;
          if (i < lines.length - 1 || r() < 0.5) src += eols[Math.floor(r() * eols.length)];
        });
        // 最後の行が空行で改行なしだと、ファイルには現れないので取り除かれる。ここでは問題にならない。

        const input = enc(src);
        const parsed = format.parse(input, c);
        expect(parsed.entries.map((e) => e.key)).toEqual(keys);
        for (const e of parsed.entries) expect(e.text).toEqual(table[e.key]);

        const changes: Change[] = [];
        const expected = structuredClone(table);
        const n = Math.floor(r() * 5);
        for (let i = 0; i < n; i++) {
          const key = keys[Math.floor(r() * keys.length)]!;
          const language = (["ja", "en", "fr"] as const)[Math.floor(r() * 3)]!;
          const value = randomValue(r);
          changes.push(setText(key, language, value));
          expected[key]![language] = value;
        }
        const out = format.apply(input, changes, c);
        if (changes.length === 0) expect(Buffer.from(out).equals(Buffer.from(input))).toBe(true);
        expect(dec(out).startsWith(BOM)).toBe(src.startsWith(BOM));
        const reparsed = format.parse(out, c);
        expect(reparsed.entries.map((e) => e.key)).toEqual(keys);
        for (const e of reparsed.entries) expect(e.text).toEqual(expected[e.key]);
        // 行番号以外の構造（空行、末尾の改行）が保たれていること。
        expect(/[\r\n]$/.test(dec(out))).toBe(/[\r\n]$/.test(src));
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 性能
// ---------------------------------------------------------------------------

describe("性能", () => {
  it("50,000 行 × 6 列の解析と、数件の set が十分に速い", () => {
    const languages = langs("ja", "en", "fr", "de", "zh");
    const c = ctx({}, languages);
    const parts: string[] = ["key,ja,en,fr,de,zh\n"];
    for (let i = 0; i < 50_000; i++) {
      parts.push(`key_${i},"日本語の本文 ${i}, 引用符 """,English text ${i},Français ${i},Deutsch ${i},中文 ${i}😀\r\n`);
    }
    const input = enc(parts.join(""));

    const t0 = performance.now();
    const doc = csvFormat.parse(input, c);
    const t1 = performance.now();
    expect(doc.entries).toHaveLength(50_000);
    expect(doc.entries[49_999]?.text.ja).toBe('日本語の本文 49999, 引用符 "');

    const changes: Change[] = [];
    for (let i = 0; i < 20; i++) changes.push(setText(`key_${i * 2500}`, "en", `changed ${i}`));
    changes.push({ type: "add", after: "key_100", entry: { key: "new", text: { ja: "新" } } });
    changes.push({ type: "remove", key: "key_200" });
    const out = csvFormat.apply(input, changes, c);
    const t2 = performance.now();

    expect(t1 - t0).toBeLessThan(5000);
    expect(t2 - t1).toBeLessThan(5000);
    const reparsed = csvFormat.parse(out, c);
    expect(reparsed.entries).toHaveLength(50_000);
    expect(reparsed.entries.find((e) => e.key === "key_2500")?.text.en).toBe("changed 1");
  });
  it("50,000 行に列を 1 つ足し、数件の値を入れるのが十分に速い", () => {
    const c = ctx({}, langs("ja", "en", "fr", "de", "zh", "ko"));
    const parts: string[] = ["key,ja,en,fr,de,zh\n"];
    for (let i = 0; i < 50_000; i++) parts.push(`key_${i},日本語 ${i},"English, ${i}",Français ${i},Deutsch ${i},中文 ${i}\n`);
    const src = parts.join("");
    const input = enc(src);
    const changes: Change[] = [];
    for (let i = 0; i < 10; i++) changes.push(setText(`key_${i * 5000}`, "ko", `한국어 ${i}`));
    changes.push({ type: "rename", key: "key_1", newKey: "renamed" });
    const t0 = performance.now();
    const out = csvFormat.apply(input, changes, c);
    const t1 = performance.now();
    const doc = csvFormat.parse(out, c);
    const t2 = performance.now();
    console.log(`列の追加: apply ${(t1 - t0).toFixed(0)} ms、再解析 ${(t2 - t1).toFixed(0)} ms`);
    expect(t1 - t0).toBeLessThan(5000);
    expect(doc.entries).toHaveLength(50_000);
    expect(doc.entries[5000]?.text.ko).toBe("한국어 1");
    expect(doc.entries[2]?.text.ko).toBe("");
    // 手を入れていないレコードは、末尾に区切りが 1 つ増えただけ。
    expect(out.length - input.length).toBeGreaterThan(50_000);
    expect(dec(out).split("\n")[3]).toBe(src.split("\n")[3] + ",");
  });
});
