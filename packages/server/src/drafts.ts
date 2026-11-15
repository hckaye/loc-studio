/**
 * 未保存の本文の編集（ドラフト）。その PC の DB の cells("core.drafts") に置き、手元にも持つ。
 * CellStore には削除がないため、消したドラフトは値 null で上書きする。
 */
import type { CellStore, CellWrite, LanguageId } from "@loc-studio/sdk";
import type { HistoryCause } from "./api-types.js";

export const DRAFTS_NS = "core.drafts";

export interface Draft {
  resourceId: string;
  key: string;
  language: LanguageId;
  value: string;
  /** ドラフトを作ったときの、リソースに保存されていた本文の版。 */
  savedHash: string;
  cause: HistoryCause;
  causeRef?: string;
  /** 書いた人。 */
  by?: string;
}

interface StoredDraft {
  value: string;
  savedHash: string;
  cause?: HistoryCause;
  causeRef?: string;
  by?: string;
}

const isStored = (v: unknown): v is StoredDraft =>
  typeof v === "object" && v !== null && typeof (v as StoredDraft).value === "string" && typeof (v as StoredDraft).savedHash === "string";

const draftKey = (key: string, language: LanguageId): string => `${key}\u0000${language}`;

export class DraftStore {
  private byResource = new Map<string, Map<string, Draft>>();
  private versions = new Map<string, number>();

  constructor(
    private readonly cells: CellStore,
    private readonly textColumnId: () => string | undefined,
  ) {}

  /** DB から全部読む（起動時と、本文の列が変わったとき）。 */
  async load(): Promise<void> {
    const columnId = this.textColumnId();
    this.byResource = new Map();
    if (columnId === undefined) return;
    for (const c of await this.cells.query({ columnId })) {
      if (!isStored(c.value) || c.language === undefined) continue;
      const d: Draft = {
        resourceId: c.resourceId,
        key: c.entryKey,
        language: c.language,
        value: c.value.value,
        savedHash: c.value.savedHash,
        cause: c.value.cause ?? "manual",
      };
      if (c.value.causeRef !== undefined) d.causeRef = c.value.causeRef;
      const by = c.value.by ?? c.updatedBy;
      if (by !== undefined) d.by = by;
      this.mapFor(c.resourceId).set(draftKey(d.key, d.language), d);
    }
  }

  private mapFor(resourceId: string): Map<string, Draft> {
    let m = this.byResource.get(resourceId);
    if (!m) {
      m = new Map();
      this.byResource.set(resourceId, m);
    }
    return m;
  }

  get(resourceId: string, key: string, language: LanguageId): Draft | undefined {
    return this.byResource.get(resourceId)?.get(draftKey(key, language));
  }

  /** そのリソースのドラフト（キー → 言語 → ドラフト を引くための Map）。 */
  mapOf(resourceId: string): Map<string, Draft> | undefined {
    const m = this.byResource.get(resourceId);
    return m && m.size > 0 ? m : undefined;
  }

  list(resourceId: string): Draft[] {
    return [...(this.byResource.get(resourceId)?.values() ?? [])];
  }

  hasKey(resourceId: string, key: string): boolean {
    const m = this.byResource.get(resourceId);
    if (!m) return false;
    for (const d of m.values()) if (d.key === key) return true;
    return false;
  }

  count(resourceId: string): number {
    return this.byResource.get(resourceId)?.size ?? 0;
  }

  resourcesWithDrafts(): string[] {
    return [...this.byResource.entries()].filter(([, m]) => m.size > 0).map(([id]) => id);
  }

  /** ドラフトの変更のたびに増える（統計のキャッシュの鍵）。 */
  version(resourceId: string): number {
    return this.versions.get(resourceId) ?? 0;
  }

  async put(d: Draft): Promise<void> {
    const columnId = this.requireColumn();
    const stored: StoredDraft = { value: d.value, savedHash: d.savedHash, cause: d.cause };
    if (d.causeRef !== undefined) stored.causeRef = d.causeRef;
    if (d.by !== undefined) stored.by = d.by;
    await this.cells.set([{ resourceId: d.resourceId, entryKey: d.key, columnId, language: d.language, value: stored }]);
    this.mapFor(d.resourceId).set(draftKey(d.key, d.language), { ...d });
    this.bump(d.resourceId);
  }

  async remove(items: { resourceId: string; key: string; language: LanguageId }[]): Promise<void> {
    if (items.length === 0) return;
    const columnId = this.requireColumn();
    const writes: CellWrite[] = items.map((i) => ({ resourceId: i.resourceId, entryKey: i.key, columnId, language: i.language, value: null }));
    await this.cells.set(writes);
    for (const i of items) {
      this.byResource.get(i.resourceId)?.delete(draftKey(i.key, i.language));
      this.bump(i.resourceId);
    }
  }

  /** キーの変更に追従する（新しいキーにすでにドラフトがある言語は、そちらを残す）。 */
  async renameKey(resourceId: string, oldKey: string, newKey: string): Promise<void> {
    const moved = this.list(resourceId).filter((d) => d.key === oldKey);
    if (moved.length === 0) return;
    await this.remove(moved);
    for (const d of moved) {
      if (!this.get(resourceId, newKey, d.language)) await this.put({ ...d, key: newKey });
    }
  }

  /** 消した行のドラフトを捨てる。 */
  async removeKey(resourceId: string, key: string): Promise<void> {
    await this.remove(this.list(resourceId).filter((d) => d.key === key));
  }

  private bump(resourceId: string): void {
    this.versions.set(resourceId, (this.versions.get(resourceId) ?? 0) + 1);
  }

  private requireColumn(): string {
    const id = this.textColumnId();
    if (id === undefined) throw new Error("本文の列（kind: \"text\"）が設定にないため、本文を編集できません。");
    return id;
  }
}
