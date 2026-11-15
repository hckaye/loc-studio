import type {
  ColumnDef,
  Entry,
  EntryData,
  LanguageDef,
  LanguageId,
  ResourceRef,
  RowReader,
} from "@loc-studio/sdk";
import type { Project } from "./project.js";
import type { CellValidation, ValidationTarget } from "./types.js";
import { runValidators } from "./validation.js";

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
 * いまは本文（kind: "text"）の列だけを対象にする。独自列は、列ソースの実装が入ってから加える。
 */
export function buildValidationTargets(
  resource: ResourceRef,
  entries: EntryData[],
  languages: LanguageDef[],
  columns: ColumnDef[],
  scope: ValidateScope = {},
): ValidationTarget[] {
  const byId = new Map(languages.map((language) => [language.id, language]));
  const wanted = scope.languages ? new Set(scope.languages) : undefined;
  const textColumns = columns.filter((column) => column.kind === "text");
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
  const targets = buildValidationTargets(
    resource,
    document.entries,
    project.languages,
    project.columns(),
    scope,
  );
  const results = await runValidators(targets, project.resolveValidators(), {
    tokenize: project.tokenizer(format),
    signal: scope.signal,
  });
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
