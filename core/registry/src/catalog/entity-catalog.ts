/**
 * @module @kb-labs/core-registry/catalog/entity-catalog
 * Unified entity query layer over discovered manifests.
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { EntityKind, DiscoveredPlugin, EntityEntry, EntityRef, EntityFilter } from '@kb-labs/plugin-contracts';
import { extractEntities, type EntityExtractor } from './extractors.js';

/**
 * In-memory catalog of all entities across all plugins.
 * Built from DiscoveredPlugin[] + ManifestV3 map after each refresh.
 */
export class EntityCatalog {
  private entries: EntityEntry[] = [];
  private byKind = new Map<EntityKind, EntityEntry[]>();
  private byPlugin = new Map<string, EntityEntry[]>();
  private byRef = new Map<string, EntityEntry>();
  private customExtractors: EntityExtractor[] = [];

  /** Register a custom entity extractor for new EntityKinds. */
  registerExtractor(extractor: EntityExtractor): void {
    this.customExtractors.push(extractor);
  }

  /** Rebuild the catalog from fresh discovery data. */
  rebuild(
    plugins: DiscoveredPlugin[],
    manifests: Map<string, ManifestV3>,
  ): void {
    this.entries = [];
    this.byKind.clear();
    this.byPlugin.clear();
    this.byRef.clear();

    for (const plugin of plugins) {
      const manifest = manifests.get(plugin.id);
      if (!manifest) {continue;}

      const entities = extractEntities(plugin, manifest, this.customExtractors);

      for (const entity of entities) {
        this.entries.push(entity);

        // Index by kind
        const kindList = this.byKind.get(entity.ref.kind) ?? [];
        kindList.push(entity);
        this.byKind.set(entity.ref.kind, kindList);

        // Index by plugin
        const pluginList = this.byPlugin.get(entity.ref.pluginId) ?? [];
        pluginList.push(entity);
        this.byPlugin.set(entity.ref.pluginId, pluginList);

        // Index by ref key
        this.byRef.set(refKey(entity.ref), entity);
      }
    }
  }

  /** Query entities with filtering. All filters are AND-combined. */
  query(filter: EntityFilter): EntityEntry[] {
    let results: EntityEntry[];

    // Pick the narrowest starting set
    if (filter.pluginId && !filter.kind) {
      results = this.byPlugin.get(filter.pluginId) ?? [];
    } else if (filter.kind && typeof filter.kind === 'string') {
      results = this.byKind.get(filter.kind) ?? [];
    } else {
      results = this.entries;
    }

    // Apply all filters sequentially
    if (filter.kind && Array.isArray(filter.kind)) {
      const kinds = new Set(filter.kind);
      results = results.filter(e => kinds.has(e.ref.kind));
    }
    if (filter.pluginId && filter.kind) {
      // pluginId filter wasn't used as starting set when kind was also provided
      results = results.filter(e => e.ref.pluginId === filter.pluginId);
    }
    if (filter.search) {
      const lower = filter.search.toLowerCase();
      results = results.filter(e =>
        e.ref.entityId.toLowerCase().includes(lower) ||
        e.ref.pluginId.toLowerCase().includes(lower),
      );
    }
    if (filter.verified) {
      results = results.filter(e => e.signature != null);
    }

    return results;
  }

  /** Get a single entity by exact ref. */
  get(ref: EntityRef): EntityEntry | null {
    return this.byRef.get(refKey(ref)) ?? null;
  }

  /** List all entity kinds that have at least one entry. */
  getKinds(): EntityKind[] {
    return [...this.byKind.keys()];
  }

  /** Total entity count. */
  get size(): number {
    return this.entries.length;
  }
}

function refKey(ref: EntityRef): string {
  return `${ref.pluginId}::${ref.kind}::${ref.entityId}`;
}
