/**
 * node:sqlite の「実験的機能」の警告だけを捨てる。ほかの警告はそのまま出す。
 * node:sqlite を import する前に呼ぶこと（警告は import 時に出る）。
 */
type EmitWarning = typeof process.emitWarning;

export function isSqliteExperimentalWarning(warning: unknown, typeOrOptions?: unknown): boolean {
  const name =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeOrOptions && typeof typeOrOptions === "object" && "type" in typeOrOptions
        ? String((typeOrOptions as { type?: unknown }).type)
        : warning instanceof Error
          ? warning.name
          : undefined;
  const message = warning instanceof Error ? warning.message : String(warning);
  return name === "ExperimentalWarning" && /SQLite/i.test(message);
}

export function suppressSqliteWarning(proc: NodeJS.Process = process): void {
  const original: EmitWarning = proc.emitWarning.bind(proc);
  const filtered = ((warning: unknown, ...rest: unknown[]) => {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...a: unknown[]) => void)(warning, ...rest);
  }) as EmitWarning;
  proc.emitWarning = filtered;
}
