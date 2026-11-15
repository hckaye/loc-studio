// フォルダ形式のプラグイン。素の JavaScript で書いた例で、import は何も要らない。
// ゲームのフォントに入っていない文字が本文に混ざっていないかを確かめる。
export default {
  validators: [
    {
      id: "mystudio.forbiddenChars",
      label: "使えない文字",
      version: "1",
      severity: "error",
      validate({ value, options }) {
        const forbidden = new Set(Array.from(String(options.chars ?? "")));
        const issues = [];
        let index = 0;
        for (const ch of value) {
          if (forbidden.has(ch)) {
            issues.push({
              code: "forbidden-char",
              message: `使えない文字「${ch}」があります`,
              range: { start: index, end: index + ch.length },
            });
          }
          index += ch.length;
        }
        return issues;
      },
    },
  ],
};
