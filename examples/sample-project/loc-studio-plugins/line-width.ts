// 会話ウィンドウに収まるかを確かめるバリデータ。
// このファイルをプラグインフォルダに置くだけで読み込まれる。アプリの再ビルドも、このファイルのビルドも不要。
import type { Plugin, ValidationIssue } from "@loc-studio/sdk";

const plugin: Plugin = {
  name: "mystudio-line-width",
  version: "1.0.0",
  validators: [
    {
      id: "mystudio.lineWidth",
      label: "1 行の幅と行数",
      version: "1",
      severity: "warning",
      validate({ value, options }) {
        const { maxWidth, maxLines } = options as { maxWidth: number; maxLines: number };
        const lines = value.split("\n");
        const issues: ValidationIssue[] = [];
        if (lines.length > maxLines) {
          issues.push({
            code: "too-many-lines",
            message: `${lines.length} 行あります（上限 ${maxLines} 行）`,
          });
        }
        let offset = 0;
        lines.forEach((line, i) => {
          if (line.length > maxWidth) {
            issues.push({
              code: "line-too-long",
              message: `${i + 1} 行目が ${line.length} 文字です（上限 ${maxWidth} 文字）`,
              range: { start: offset + maxWidth, end: offset + line.length },
            });
          }
          offset += line.length + 1;
        });
        return issues;
      },
    },
  ],
};

export default plugin;
