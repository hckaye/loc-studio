/* setCell の競合（conflict）の data から、いまの値と版を取り出す。data の形はサービス層に任せ、よくある形を順に見る。 */
export interface ConflictCurrent {
  value: unknown;
  version?: number;
  updatedBy?: string;
  updatedAt?: string;
}

export function conflictCurrent(data: unknown): ConflictCurrent | undefined {
  if (Array.isArray(data)) return conflictCurrent(data[0]);
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if ("current" in d) return conflictCurrent(d["current"]);
    if ("cell" in d && d["cell"] && typeof d["cell"] === "object" && !("value" in d)) return conflictCurrent(d["cell"]);
    if ("value" in d || "version" in d || "actual" in d) {
      const version = typeof d["version"] === "number" ? d["version"] : typeof d["actual"] === "number" ? d["actual"] : undefined;
      return {
        value: d["value"],
        ...(version !== undefined ? { version } : {}),
        ...(typeof d["updatedBy"] === "string" ? { updatedBy: d["updatedBy"] } : {}),
        ...(typeof d["updatedAt"] === "string" ? { updatedAt: d["updatedAt"] } : {}),
      };
    }
  }
  return undefined;
}
