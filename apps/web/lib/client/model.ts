import type { CellInfo, IssueInfo, ProjectInfo } from "@loc-studio/server";

/* 画面で使う型と、設定（ProjectInfo）から表の列を組み立てる処理。言語や列の ID は決め打ちしない。 */

export type ColumnDef = ProjectInfo["columns"][number];
export type LanguageDef = ProjectInfo["languages"][number];
export type ColumnType = NonNullable<ColumnDef["type"]>;
export type EnumOption = Extract<ColumnType, { enum: unknown }>["enum"][number];
export type Severity = IssueInfo["severity"];

export function cellIdOf(col: ColumnDef, language?: string): string {
  return col.scope === "language" && language !== undefined ? `${col.id}@${language}` : col.id;
}

export function enumOptions(col: ColumnDef): EnumOption[] | undefined {
  const t = col.type;
  if (t && typeof t === "object" && "enum" in t) return t.enum;
  return undefined;
}

export function enumDefault(col: ColumnDef): string | undefined {
  const t = col.type;
  if (t && typeof t === "object" && "enum" in t) return t.default;
  return undefined;
}

export function optionLabel(o: EnumOption): string {
  return o.label ?? o.value;
}

export function findOption(col: ColumnDef, value: unknown): EnumOption | undefined {
  const opts = enumOptions(col);
  if (!opts) return undefined;
  const v = value === undefined || value === null || value === "" ? enumDefault(col) : value;
  return opts.find((o) => o.value === v);
}

/** 列の表示名。名前のない本文の列とキーの列は、表の見出しと同じ「本文」「キー」にする（ほかは列の ID）。 */
export function columnLabel(col: ColumnDef): string {
  return col.label ?? (col.kind === "text" ? "本文" : col.kind === "key" ? "キー" : col.id);
}

export function isEnumColumn(col: ColumnDef): boolean {
  return enumOptions(col) !== undefined;
}

/** その言語に出す列か（ColumnDef.languages）。 */
export function columnAppliesTo(col: ColumnDef, language: string): boolean {
  return !col.languages || col.languages.includes(language);
}

export type GridColumnKind = "key" | "text" | "enum" | "review" | "string" | "number" | "boolean" | "generated" | "actions" | "computed";

export function gridKind(col: ColumnDef): GridColumnKind {
  switch (col.kind) {
    case "key":
      return "key";
    case "text":
      return "text";
    case "review":
      return "review";
    case "generated":
      return "generated";
    case "actions":
      return "actions";
    case "computed":
      return "computed";
    default: {
      if (isEnumColumn(col)) return "enum";
      if (col.type === "number") return "number";
      if (col.type === "boolean") return "boolean";
      return "string";
    }
  }
}

/** 表の 1 列（言語ごとの列は言語の数だけ展開したもの）。 */
export interface GridColumn {
  /** セルの ID（entry スコープは列 ID、language スコープは 列 ID@言語 ID）。 */
  cellId: string;
  col: ColumnDef;
  kind: GridColumnKind;
  language?: string;
  groupId: string;
  width: number;
}

export interface GridGroup {
  id: string;
  kind: "common" | "language";
  language?: LanguageDef;
  label: string;
  columns: GridColumn[];
  pinned: boolean;
  /** ピン留めされているが、幅の上限のため一時的に外している。 */
  pinSuspended?: boolean;
  /** 一部の列だけ固定した言語の、固定した部分（pinned）と残り（rest）。 */
  part?: "pinned" | "rest";
  width: number;
}

export const COMMON_GROUP_ID = "@common";

const DEFAULT_WIDTH: Record<GridColumnKind, number> = {
  key: 200,
  text: 300,
  enum: 112,
  // 判定の横に、最新の投稿のコメントと投稿者を出すので、選択式の列より広くする。
  review: 180,
  string: 130,
  number: 90,
  boolean: 70,
  generated: 240,
  actions: 130,
  computed: 140,
};

export function defaultWidth(kind: GridColumnKind): number {
  return DEFAULT_WIDTH[kind];
}

export const MIN_COL_WIDTH = 48;

/** 言語グループの列: 本文の列が先、続いてその言語の列を設定の順に。 */
export function languageColumns(info: ProjectInfo, language: string): ColumnDef[] {
  const langCols = info.columns.filter((c) => c.scope === "language" && columnAppliesTo(c, language));
  const texts = langCols.filter((c) => c.kind === "text");
  const others = langCols.filter((c) => c.kind !== "text");
  return [...texts, ...others];
}

export function commonColumns(info: ProjectInfo): ColumnDef[] {
  return info.columns.filter((c) => c.scope === "entry");
}

/** 本文の列（最初の kind: "text" の列）。 */
export function textColumnOf(info: ProjectInfo): ColumnDef | undefined {
  return info.columns.find((c) => c.kind === "text");
}

export interface LayoutInput {
  info: ProjectInfo;
  visibleLanguages: string[];
  pinnedLanguages: string[];
  widths: Record<string, number>;
  /** 一部の列だけを固定する言語（言語 ID → 列 ID）。pinnedLanguages に入っている言語だけに効く。 */
  partialPins?: Record<string, string[]>;
  /** 表の見える幅。固定列の上限の計算に使う。0 なら上限を見ない。 */
  viewportWidth: number;
  /** 隠す列（列の ID）。キーの列は隠さない。 */
  hiddenColumns?: string[];
}

export interface GridLayout {
  groups: GridGroup[];
  /** 固定（共通 ＋ ピン留めの言語）の列が先、続いて横スクロールする列。 */
  frozen: GridColumn[];
  scrolling: GridColumn[];
  all: GridColumn[];
  frozenWidth: number;
  totalWidth: number;
  /** 幅の上限を超えたので外したピン。 */
  autoUnpinned: string[];
  effectivePins: string[];
}

export function buildLayout(input: LayoutInput): GridLayout {
  const { info, widths } = input;
  const langById = new Map(info.languages.map((l) => [l.id, l] as const));
  const mk = (col: ColumnDef, groupId: string, language?: string): GridColumn => {
    const kind = gridKind(col);
    const cellId = cellIdOf(col, language);
    return { cellId, col, kind, groupId, width: widths[cellId] ?? DEFAULT_WIDTH[kind], ...(language !== undefined ? { language } : {}) };
  };
  const hidden = new Set(input.hiddenColumns ?? []);
  const shown = (c: ColumnDef): boolean => c.kind === "key" || !hidden.has(c.id);
  const commonCols = commonColumns(info)
    .filter(shown)
    .map((c) => mk(c, COMMON_GROUP_ID));
  const common: GridGroup = {
    id: COMMON_GROUP_ID,
    kind: "common",
    label: "共通",
    columns: commonCols,
    // grid.pinCommon が false なら共通グループもほかの列と一緒に横スクロールする
    pinned: info.grid.pinCommon !== false,
    width: sum(commonCols),
  };
  // 設定の言語の並びを保つ
  const visible = info.languages.filter((l) => input.visibleLanguages.includes(l.id));
  const langGroups: GridGroup[] = visible
    .map((l): GridGroup => {
      const cols = languageColumns(info, l.id)
        .filter(shown)
        .map((c) => mk(c, `lang:${l.id}`, l.id));
      return { id: `lang:${l.id}`, kind: "language", language: l, label: l.label, columns: cols, pinned: false, width: sum(cols) };
    })
    // 列をすべて隠した言語は、グループごと出さない。
    .filter((g) => g.columns.length > 0);
  // ピン: 指定された順（ピンした順）に固定側に並べる。一部の列だけ固定する言語は、その列だけを固定側に出す。
  const partial = input.partialPins ?? {};
  const pinnedPart = (g: GridGroup): GridColumn[] => {
    const ids = partial[g.language!.id];
    if (!ids || ids.length === 0) return g.columns;
    const cols = g.columns.filter((c) => ids.includes(c.col.id));
    return cols.length > 0 ? cols : g.columns;
  };
  let pins = input.pinnedLanguages.filter((id) => langGroups.some((g) => g.language?.id === id));
  const autoUnpinned: string[] = [];
  if (input.viewportWidth > 0) {
    const limit = input.viewportWidth * info.grid.maxPinnedRatio;
    const widthOf = (ids: string[]) =>
      (common.pinned ? common.width : 0) +
      ids.reduce((s, id) => {
        const g = langGroups.find((x) => x.language?.id === id);
        return s + (g ? sum(pinnedPart(g)) : 0);
      }, 0);
    // 共通グループは外さない。ピンは後ろから外す。
    while (pins.length > 0 && widthOf(pins) > limit) {
      autoUnpinned.unshift(pins[pins.length - 1]!);
      pins = pins.slice(0, -1);
    }
  }
  const pinnedGroups: GridGroup[] = [];
  const restGroups: GridGroup[] = [];
  for (const id of pins) {
    const g = langGroups.find((x) => x.language?.id === id)!;
    const cols = pinnedPart(g);
    if (cols.length === g.columns.length) pinnedGroups.push({ ...g, pinned: true });
    else pinnedGroups.push({ ...g, columns: cols, width: sum(cols), pinned: true, part: "pinned" });
  }
  for (const g of langGroups) {
    const id = g.language!.id;
    if (!pins.includes(id)) {
      restGroups.push(autoUnpinned.includes(id) ? { ...g, pinSuspended: true } : g);
      continue;
    }
    const frozenIds = new Set(pinnedPart(g).map((c) => c.cellId));
    const rest = g.columns.filter((c) => !frozenIds.has(c.cellId));
    if (rest.length > 0) restGroups.push({ ...g, id: `${g.id}:rest`, columns: rest, width: sum(rest), part: "rest" });
  }
  const frozenGroups = common.pinned ? [common, ...pinnedGroups] : pinnedGroups;
  const scrollGroups = common.pinned ? restGroups : [common, ...restGroups];
  const groups = [...frozenGroups, ...scrollGroups];
  const frozen = frozenGroups.flatMap((g) => g.columns);
  const scrolling = scrollGroups.flatMap((g) => g.columns);
  const frozenWidth = sum(frozen);
  void langById;
  return {
    groups,
    frozen,
    scrolling,
    all: [...frozen, ...scrolling],
    frozenWidth,
    totalWidth: frozenWidth + sum(scrolling),
    autoUnpinned,
    effectivePins: pins,
  };
}

function sum(cols: { width: number }[]): number {
  return cols.reduce((s, c) => s + c.width, 0);
}

/** 初期のピン（LanguageDef.pinned）。true はグループ全体、列 ID の配列はその列だけ（initialPartialPins）。 */
export function initialPins(info: ProjectInfo): string[] {
  return info.languages.filter((l) => l.pinned === true || (Array.isArray(l.pinned) && l.pinned.length > 0)).map((l) => l.id);
}

export function initialPartialPins(info: ProjectInfo): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const l of info.languages) if (Array.isArray(l.pinned) && l.pinned.length > 0) out[l.id] = l.pinned;
  return out;
}

const SEVERITY_ORDER: Severity[] = ["error", "warning", "info"];

export function worstSeverity(issues: IssueInfo[] | undefined): Severity | undefined {
  if (!issues || issues.length === 0) return undefined;
  for (const s of SEVERITY_ORDER) if (issues.some((i) => i.severity === s)) return s;
  return undefined;
}

export const SEVERITY_LABEL: Record<Severity, string> = { error: "エラー", warning: "警告", info: "情報" };

export function textValue(cell: CellInfo | undefined): string {
  const v = cell?.value;
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : String(v);
}

export function displayValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** 進捗を出す列: 設定の grid.progressColumn。なければ最初のレビュー列、それもなければ最初の enum の列。 */
export function progressColumn(info: ProjectInfo): ColumnDef | undefined {
  const configured = info.grid.progressColumn !== undefined ? info.columns.find((c) => c.id === info.grid.progressColumn) : undefined;
  return configured ?? info.columns.find((c) => c.kind === "review" && isEnumColumn(c)) ?? info.columns.find((c) => isEnumColumn(c));
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
