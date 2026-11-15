import type {
  ColumnDef,
  Entry,
  EntryData,
  LanguageDef,
  LanguageId,
  ResourceRef,
  RowReader,
} from "@loc-studio/sdk";
import { FILE_SOURCE } from "./columns.js";
import type { Project } from "./project.js";
import type { CellValidation, ResolvedValidator, ValidationTarget } from "./types.js";
import { cellValueText, runResourceValidators, runValidators, validatedMetaColumns } from "./validation.js";

export interface ValidateScope {
  /** 対象の言語。省略時はプロジェクトの全言語。 */
  languages?: LanguageId[];
  signal?: AbortSignal;
}

export interface ResourceValidation {
  resource: ResourceRef;
  results: CellValidation[];
}

/** 同じ行のほかの列・ほかの言語を読むための窓口を、ファイルから読んだ 1 行分のデータで作る。 */
function rowReader(data: EntryData): RowReader {
  return {
    text: (language) => data.text[language],
    get: (columnId, language) =>
      language === undefined ? data.meta?.[columnId] : data.languageMeta?.[language]?.[columnId],
  };
}

/**
 * 1 つのリソースから、バリデーションの対象になるセルを作る。
 * 対象は、本文（kind: "text"）の列と、バリデータが名指しした列のうちリソースの中に値がある列（出所 file）。
 * 列ソースの列（ステータスなど）は、共有 DB を開くサービス層（画面と、CLI の status など）で確かめる。
 */
export function buildValidationTargets(
  resource: ResourceRef,
  entries: EntryData[],
  languages: LanguageDef[],
  columns: ColumnDef[],
  scope: ValidateScope = {},
  validators: ResolvedValidator[] = [],
): ValidationTarget[] {
  const byId = new Map(languages.map((language) => [language.id, language]));
  const wanted = scope.languages ? new Set(scope.languages) : undefined;
  const textColumns = columns.filter((column) => column.kind === "text");
  const fileColumns = validatedMetaColumns(columns, validators).filter((c) => c.source === undefined || c.source === FILE_SOURCE);
  const targets: ValidationTarget[] = [];

  for (const data of entries) {
    const entry: Entry = { key: data.key, stableId: data.stableId, resource, meta: data.meta };
    const row = rowReader(data);
    for (const column of textColumns) {
      for (const language of languages) {
        if (wanted && !wanted.has(language.id)) continue;
        if (column.languages && !column.languages.includes(language.id)) continue;
        const baseLanguage = language.basedOn ? byId.get(language.basedOn) : undefined;
        const baseValue = baseLanguage ? data.text[baseLanguage.id] : undefined;
        targets.push({
          entry,
          column,
          language,
          // ファイルにその言語の列がない場合も「空の本文」として扱い、未翻訳の検出に任せる。
          value: data.text[language.id] ?? "",
          base:
            baseLanguage && baseValue !== undefined
              ? { language: baseLanguage, value: baseValue }
              : undefined,
          row,
        });
      }
    }
    for (const column of fileColumns) {
      for (const language of column.scope === "entry" ? [undefined] : languages) {
        if (language && wanted && !wanted.has(language.id)) continue;
        if (language && column.languages && !column.languages.includes(language.id)) continue;
        const raw = language ? data.languageMeta?.[language.id]?.[column.id] : data.meta?.[column.id];
        targets.push({ entry, column, ...(language ? { language } : {}), value: cellValueText(raw), ...(raw !== undefined && raw !== null ? { raw } : {}), row });
      }
    }
  }
  return targets;
}

/** 1 つのリソースを、設定で選ばれたバリデータで確かめる。 */
export async function validateResource(
  project: Project,
  resource: ResourceRef,
  scope: ValidateScope = {},
): Promise<ResourceValidation> {
  const { document, format } = await project.readDocument(resource);
  const validators = project.resolveValidators();
  const columns = project.columns();
  const targets = buildValidationTargets(resource, document.entries, project.languages, columns, scope, validators);
  const results = await runValidators(targets, validators, {
    tokenize: project.tokenizer(format),
    signal: scope.signal,
  });

  // リソース全体を見るバリデータ。見つけた問題は、そのセルの結果に足す（対象になかったセルなら結果を足す）。
  if (validators.some((rv) => typeof rv.validator.validateResource === "function")) {
    const rows = await project.host.project.rows(resource.id);
    const { issues, problems } = await runResourceValidators({ resource, rows, languages: project.languages, columns }, validators);
    for (const p of problems) project.host.log(p);
    const cellOf = (key: string, columnId: string, language: LanguageId | undefined): string => `${key}\u0000${columnId}\u0000${language ?? ""}`;
    const byCell = new Map(results.map((r) => [cellOf(r.target.entry.key, r.target.column.id, r.target.language?.id), r]));
    const wanted = scope.languages ? new Set(scope.languages) : undefined;
    const rowOf = new Map(rows.map((r) => [r.entry.key, r]));
    for (const { key, columnId, language, ...issue } of issues) {
      if (language !== undefined && wanted && !wanted.has(language)) continue;
      let cell = byCell.get(cellOf(key, columnId, language));
      if (!cell) {
        const column = columns.find((c) => c.id === columnId)!;
        const snapshot = rowOf.get(key)!;
        const languageDef = language !== undefined ? project.language(language) : undefined;
        const raw = column.kind === "text" ? snapshot.row.text(language!) : snapshot.row.get(columnId, language);
        cell = { target: { entry: snapshot.entry, column, ...(languageDef ? { language: languageDef } : {}), value: cellValueText(raw), row: snapshot.row }, issues: [] };
        byCell.set(cellOf(key, columnId, language), cell);
        results.push(cell);
      }
      cell.issues.push(issue);
    }
  }
  return { resource, results };
}

/** プロジェクト全体（または指定したリソース）を確かめる。 */
export async function validateProject(
  project: Project,
  scope: ValidateScope & { resources?: ResourceRef[] } = {},
): Promise<ResourceValidation[]> {
  const resources = scope.resources ?? (await project.resources());
  const out: ResourceValidation[] = [];
  for (const resource of resources) {
    scope.signal?.throwIfAborted();
    out.push(await validateResource(project, resource, scope));
  }
  return out;
}
