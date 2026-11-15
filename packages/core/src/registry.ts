import type {
  Action,
  CellRenderer,
  ColumnDef,
  ColumnSource,
  Format,
  Generator,
  Plugin,
  TextSyntax,
  TreeProvider,
  Validator,
} from "@loc-studio/sdk";
import type { ExtensionKind, LoadedPlugin, PluginOrigin } from "./types.js";

/** 拡張ポイントの種類と、その実装の型の対応。 */
export interface ExtensionTypeMap {
  tree: TreeProvider;
  format: Format;
  syntax: TextSyntax;
  source: ColumnSource;
  column: ColumnDef;
  generator: Generator;
  action: Action;
  validator: Validator;
  renderer: CellRenderer;
}

/** 種類と、Plugin のどの欄に並ぶかの対応。 */
export const EXTENSION_FIELDS = {
  tree: "trees",
  format: "formats",
  syntax: "syntaxes",
  source: "sources",
  column: "columns",
  generator: "generators",
  action: "actions",
  validator: "validators",
  renderer: "renderers",
} as const satisfies Record<ExtensionKind, keyof Plugin>;

export const EXTENSION_KINDS = Object.keys(EXTENSION_FIELDS) as ExtensionKind[];

export interface RegistryEntry<K extends ExtensionKind = ExtensionKind> {
  id: string;
  pluginName: string;
  origin: PluginOrigin;
  value: ExtensionTypeMap[K];
}

const describeOrigin = (name: string, origin: PluginOrigin): string =>
  `"${name}"（${origin.layer}${origin.path ? `: ${origin.path}` : ""}）`;

/**
 * 実装を種類と id で引くための登録簿。
 * 呼び出し側が builtin → app → project → local の順に登録するので、同じ id は後の層が勝つ。
 */
export class PluginRegistry {
  readonly warnings: string[] = [];
  private readonly entries = new Map<ExtensionKind, Map<string, RegistryEntry>>();
  private readonly loaded: LoadedPlugin[] = [];

  constructor() {
    for (const kind of EXTENSION_KINDS) this.entries.set(kind, new Map());
  }

  register(plugin: Plugin, origin: PluginOrigin, opts?: { deny?: ExtensionKind[] }): void {
    const deny = new Set(opts?.deny ?? []);
    this.loaded.push({ plugin, origin });
    for (const kind of EXTENSION_KINDS) {
      const list = plugin[EXTENSION_FIELDS[kind]] as { id: string }[] | undefined;
      if (!list) continue;
      const map = this.table(kind);
      for (const value of list) {
        if (deny.has(kind)) {
          this.warnings.push(
            `${kind} "${value.id}"（プラグイン ${describeOrigin(plugin.name, origin)}）は設定で禁止されているため登録しませんでした。`,
          );
          continue;
        }
        const prev = map.get(value.id);
        if (prev) {
          this.warnings.push(
            `${kind} "${value.id}" をプラグイン ${describeOrigin(plugin.name, origin)} が上書きしました（元はプラグイン ${describeOrigin(prev.pluginName, prev.origin)}）。`,
          );
        }
        map.set(value.id, { id: value.id, pluginName: plugin.name, origin, value: value as never });
      }
    }
  }

  get<K extends ExtensionKind>(kind: K, id: string): ExtensionTypeMap[K] | undefined {
    return this.table(kind).get(id)?.value as ExtensionTypeMap[K] | undefined;
  }

  require<K extends ExtensionKind>(kind: K, id: string): ExtensionTypeMap[K] {
    const value = this.get(kind, id);
    if (value === undefined) {
      const ids = [...this.table(kind).keys()];
      const available = ids.length > 0 ? ids.map((i) => `"${i}"`).join(", ") : "（なし）";
      throw new Error(`${kind} "${id}" は登録されていません。使える ${kind}: ${available}`);
    }
    return value;
  }

  list<K extends ExtensionKind>(kind: K): RegistryEntry<K>[] {
    return [...this.table(kind).values()] as RegistryEntry<K>[];
  }

  plugins(): LoadedPlugin[] {
    return [...this.loaded];
  }

  private table(kind: ExtensionKind): Map<string, RegistryEntry> {
    const map = this.entries.get(kind);
    if (!map) throw new Error(`拡張ポイントの種類 "${String(kind)}" はありません。`);
    return map;
  }
}
