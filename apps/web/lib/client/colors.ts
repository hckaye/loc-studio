/*
 * 選択肢の color の値を CSS の色にする。プラグインはよく使う色の名前（gray、green など）を書くので、
 * その名前は配色に合わせた色に置き換え、それ以外（#rrggbb など）は CSS の色としてそのまま使う。
 */
const NAMED: Record<string, { fg: string; bg: string; border: string }> = {
  gray: { fg: "var(--chip-gray-fg)", bg: "var(--chip-gray-bg)", border: "var(--chip-gray-border)" },
  grey: { fg: "var(--chip-gray-fg)", bg: "var(--chip-gray-bg)", border: "var(--chip-gray-border)" },
  ink: { fg: "var(--chip-ink-fg)", bg: "var(--chip-ink-bg)", border: "var(--chip-ink-border)" },
  black: { fg: "var(--chip-ink-fg)", bg: "var(--chip-ink-bg)", border: "var(--chip-ink-border)" },
  amber: { fg: "var(--warn)", bg: "var(--warn-bg)", border: "var(--warn-border)" },
  yellow: { fg: "var(--warn)", bg: "var(--warn-bg)", border: "var(--warn-border)" },
  orange: { fg: "var(--warn)", bg: "var(--warn-bg)", border: "var(--warn-border)" },
  red: { fg: "var(--error)", bg: "var(--error-bg)", border: "var(--error-border)" },
  green: { fg: "var(--good)", bg: "var(--good-bg)", border: "var(--good-border)" },
  blue: { fg: "var(--accent)", bg: "var(--selected)", border: "var(--accent-border)" },
  purple: { fg: "var(--chip-purple-fg)", bg: "var(--chip-purple-bg)", border: "var(--chip-purple-border)" },
};

export interface ChipColors {
  fg: string;
  bg: string;
  border: string;
}

export function chipColors(color: string | undefined): ChipColors {
  if (!color) return NAMED["gray"]!;
  const named = NAMED[color.toLowerCase()];
  if (named) return named;
  // 任意の CSS の色: 文字と線はその色、地は薄く
  return { fg: color, bg: `color-mix(in srgb, ${color} 14%, var(--bg))`, border: `color-mix(in srgb, ${color} 45%, var(--bg))` };
}
