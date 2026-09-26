/**
 * @module @kb-labs/core-registry/registry
 * EntityRegistry — the single entry point that all services use.
 *
 * Replaces both PluginRegistry (cli-core) and CliAPIImpl (cli-api).
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import { DiscoveryManager, type DiscoveredPlugin, type DiagnosticEvent } from '@kb-labs/core-discovery';
import { EntityCatalog } from './catalog/entity-catalog.js';
import { SnapshotManager } from './snapshot/snapshot-manager.js';
import { HealthAggregator, resetGitInfoCache } from './health/health-aggregator.js';
import { generateOpenAPISpec } from './generators/openapi-spec.js';
import { generateStudioRegistry } from './generators/studio-registry.js';
import { buildDiagnosticReport } from './diagnostics/reporter.js';
import {
  enablePlugin as enablePluginState,
  disablePlugin as disablePluginState,
} from './state/plugin-state.js';
import type {
  IEntityRegistry,
  RegistryOptions,
  PluginBrief,
  RegistrySnapshot,
  RegistryDiff,
  EntityEntry,
  EntityRef,
  EntityFilter,
  EntityKind,
  OpenAPISpec,
  StudioRegistry,
  SystemHealthSnapshot,
  SystemHealthOptions,
  DiagnosticReport,
} from './types.js';

const PLATFORM_VERSION = '1.0.0';

export class EntityRegistry implements IEntityRegistry {
  private readonly root: string;
  private readonly discovery: DiscoveryManager;
  private readonly snapshotMgr: SnapshotManager;
  private readonly health: HealthAggregator;
  private readonly catalog = new EntityCatalog();

  private plugins: DiscoveredPlugin[] = [];
  private manifests = new Map<string, ManifestV3>();
  private diagnosticEvents: DiagnosticEvent[] = [];
  private attemptedPluginCount = 0;
  private changeListeners: Array<(diff: RegistryDiff) => void> = [];
  private rev = 0;
  private initialized = false;

  constructor(private readonly opts: RegistryOptions) {
    this.root = opts.root ?? process.cwd();

    this.discovery = new DiscoveryManager({
      root: this.root,
      platformRoot: opts.platformRoot,
      importTimeoutMs: opts.importTimeoutMs,
      verifyIntegrity: opts.verifyIntegrity,
    });

    this.snapshotMgr = new SnapshotManager({
      root: this.root,
      ttlMs: opts.cache?.ttlMs,
      platformVersion: opts.platformVersion ?? PLATFORM_VERSION,
      cache: opts.cache?.adapter,
      cacheSnapshotKey: opts.cache?.snapshotKey,
    });

    this.health = new HealthAggregator({
      getSnapshot: () => this.snapshot(),
      listPlugins: () => this.listPlugins(),
      getManifest: (id) => this.manifests.get(id),
      root: this.root,
      platformVersion: opts.platformVersion ?? PLATFORM_VERSION,
    });
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async initialize(): Promise<void> {
    // Try loading from snapshot first (fast path)
    const cached = await this.snapshotMgr.load();
    if (
      cached && !cached.stale && !cached.corrupted && cached.manifests.length > 0
      // A snapshot written before discovery recorded scope/origin cannot restore them.
      && cached.manifests.every(e => typeof e.origin === 'string' && typeof e.scope === 'string')
    ) {
      this.applySnapshot(cached);
      this.initialized = true;
      return;
    }

    // Full discovery
    await this.refresh();
    this.initialized = true;
  }

  async refresh(): Promise<void> {
    const oldPlugins = new Map(this.plugins.map(p => [p.id, p]));

    const result = await this.discovery.discover();
    this.plugins = result.plugins;
    this.manifests = result.manifests;
    this.diagnosticEvents = result.diagnostics;

    if (process.env.KB_DEBUG === 'true') {
      const diagLine = JSON.stringify({
        event: 'kb.diag.discovery',
        v: 1,
        data: {
          loaded: result.plugins.map(p => ({ id: p.id, version: p.version, source: p.source.kind })),
          skipped: result.diagnostics
            .filter(d => d.severity === 'error' || d.severity === 'warning')
            .map(d => ({ code: d.code, message: d.message, pluginId: d.context?.pluginId })),
        },
        ts: Date.now(),
      });
      process.stdout.write(diagLine + '\n');
    }
    // Track total attempted (loaded + failed) for accurate diagnostic reports
    const failedCount = result.diagnostics.filter(
      e => e.severity === 'error' && e.context?.pluginId,
    ).length;
    this.attemptedPluginCount = result.plugins.length + failedCount;
    this.rev++;

    // Rebuild entity catalog
    this.catalog.rebuild(this.plugins, this.manifests);

    // Persist snapshot
    const snap = this.buildSnapshot();
    await this.snapshotMgr.persist(snap);

    // Notify listeners
    const diff = this.computeDiff(oldPlugins);
    if (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0) {
      for (const cb of this.changeListeners) {
        try { cb(diff); } catch { /* listener error is non-fatal */ }
      }
    }
  }

  async dispose(): Promise<void> {
    this.changeListeners = [];
    resetGitInfoCache();
  }

  // =========================================================================
  // Plugin-level API
  // =========================================================================

  listPlugins(): PluginBrief[] {
    return this.plugins.map(p => ({
      id: p.id,
      version: p.version,
      source: p.source,
      display: p.display,
    }));
  }

  getManifest(pluginId: string): ManifestV3 | null {
    return this.manifests.get(pluginId) ?? null;
  }

  getOpenAPISpec(pluginId: string): OpenAPISpec | null {
    const manifest = this.manifests.get(pluginId);
    if (!manifest?.rest?.routes?.length) {return null;}
    return generateOpenAPISpec(manifest);
  }

  getStudioRegistry(): StudioRegistry {
    return generateStudioRegistry(this.listPlugins(), this.manifests);
  }

  // =========================================================================
  // Entity Catalog
  // =========================================================================

  queryEntities(filter: EntityFilter): EntityEntry[] {
    return this.catalog.query(filter);
  }

  getEntity(ref: EntityRef): EntityEntry | null {
    return this.catalog.get(ref);
  }

  getEntityKinds(): EntityKind[] {
    return this.catalog.getKinds();
  }

  // =========================================================================
  // Snapshot
  // =========================================================================

  snapshot(): RegistrySnapshot {
    if (this.plugins.length === 0 && !this.initialized) {
      return this.snapshotMgr.createEmpty();
    }
    return this.buildSnapshot();
  }

  onChange(cb: (diff: RegistryDiff) => void): () => void {
    this.changeListeners.push(cb);
    return () => {
      this.changeListeners = this.changeListeners.filter(l => l !== cb);
    };
  }

  // =========================================================================
  // Health & Diagnostics
  // =========================================================================

  async getSystemHealth(opts?: SystemHealthOptions): Promise<SystemHealthSnapshot> {
    return this.health.getSystemHealth(opts);
  }

  getDiagnostics(): DiagnosticReport {
    return buildDiagnosticReport(
      this.diagnosticEvents,
      this.attemptedPluginCount,
      this.plugins.length,
    );
  }

  // =========================================================================
  // State
  // =========================================================================

  async enablePlugin(pluginId: string): Promise<void> {
    await enablePluginState(this.root, pluginId);
  }

  async disablePlugin(pluginId: string): Promise<void> {
    await disablePluginState(this.root, pluginId);
  }

  // =========================================================================
  // Private
  // =========================================================================

  private buildSnapshot(): RegistrySnapshot {
    const generatedAt = new Date().toISOString();
    const ttlMs = this.opts.cache?.ttlMs ?? 60_000;

    return {
      schema: 'kb.registry/1',
      rev: this.rev,
      version: String(this.rev),
      generatedAt,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      ttlMs,
      partial: false,
      stale: false,
      source: {
        cwd: this.root,
        platformVersion: this.opts.platformVersion ?? PLATFORM_VERSION,
      },
      plugins: this.plugins.map(p => ({
        id: p.id,
        version: p.version,
        source: p.source,
      })),
      manifests: this.plugins
        .filter(p => this.manifests.has(p.id))
        .map(p => ({
          pluginId: p.id,
          manifest: this.manifests.get(p.id)!,
          pluginRoot: p.packageRoot,
          source: p.source,
          packageName: p.packageName,
          scope: p.scope,
          origin: p.origin,
          manifestPath: p.manifestPath,
          manifestKind: p.manifestKind,
        })),
      diagnostics: this.diagnosticEvents,
      ts: Date.now(),
    };
  }

  private applySnapshot(snap: RegistrySnapshot): void {
    this.rev = snap.rev;
    this.manifests.clear();
    this.plugins = [];

    for (const entry of snap.manifests) {
      // Validate required fields before applying
      if (!entry.pluginId || !entry.manifest?.id || !entry.manifest?.version) {
        continue;
      }
      this.manifests.set(entry.pluginId, entry.manifest);
      this.plugins.push({
        id: entry.pluginId,
        version: entry.manifest.version,
        packageRoot: entry.pluginRoot,
        packageName: entry.packageName,
        scope: entry.scope,
        origin: entry.origin,
        manifestPath: entry.manifestPath,
        manifestKind: entry.manifestKind,
        source: entry.source,
        display: entry.manifest.display
          ? { name: entry.manifest.display.name, description: entry.manifest.display.description }
          : undefined,
        provides: [],
      });
    }

    this.attemptedPluginCount = this.plugins.length;
    this.diagnosticEvents = snap.diagnostics ?? [];
    this.catalog.rebuild(this.plugins, this.manifests);
  }

  private computeDiff(oldPlugins: Map<string, DiscoveredPlugin>): RegistryDiff {
    const added: PluginBrief[] = [];
    const removed: PluginBrief[] = [];
    const changed: PluginBrief[] = [];
    const newIds = new Set(this.plugins.map(p => p.id));

    for (const p of this.plugins) {
      const brief: PluginBrief = { id: p.id, version: p.version, source: p.source, display: p.display };
      const old = oldPlugins.get(p.id);
      if (!old) { added.push(brief); continue; }
      if (old.version !== p.version) { changed.push(brief); }
    }

    for (const [id, old] of oldPlugins) {
      if (!newIds.has(id)) {
        removed.push({ id, version: old.version, source: old.source, display: old.display });
      }
    }

    return { added, removed, changed };
  }
}
