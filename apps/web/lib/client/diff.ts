/* 2 つの本文の簡単な差分（「この時点の値と比べる」用）。短い本文は文字単位、長い本文は行単位。 */

export interface DiffPart {
  type: "same" | "added" | "removed";
  text: string;
}

function lcsDiff(a: string[], b: string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..], b[j..] の最長共通部分列の長さ
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      push("removed", a[i]!);
      i++;
    } else {
      push("added", b[j]!);
      j++;
    }
  }
  while (i < n) push("removed", a[i++]!);
  while (j < m) push("added", b[j++]!);
  return out;
}

export function diffText(before: string, after: string): DiffPart[] {
  if (before === after) return before === "" ? [] : [{ type: "same", text: before }];
  const chars = Array.from(before).length * Array.from(after).length;
  if (chars <= 1_000_000) return lcsDiff(Array.from(before), Array.from(after));
  const split = (s: string) => s.split(/(?<=\n)/);
  return lcsDiff(split(before), split(after));
}
