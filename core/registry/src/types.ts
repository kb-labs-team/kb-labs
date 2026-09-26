/**
 * @module @kb-labs/core-registry/types
 * Public types for the entity registry.
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { ICache } from '@kb-labs/core-platform/adapters';
import type {
  EntityKind,
  EntitySignature,
  DiagnosticEvent,
  DiscoveredPlugin,
} from '@kb-labs/core-discovery';

// Re-export from core-discovery for consumer convenience
export type { EntityKind, EntitySignature, DiagnosticEvent } from '@kb-labs/core-discovery';
export type { DiagnosticSeverity, DiagnosticCode } from '@kb-labs/core-discovery';

// ---------------------------------------------------------------------------
// Entity Catalog Model
// ---------------------------------------------------------------------------

export interface EntityRef {
  pluginId: string;
  kind: EntityKind;
  entityId: string;
}

export interface EntityEntry<T = unknown> {
  ref: EntityRef;
  declaration: T;
  version: string;
  source: { kind: 'marketplace' | 'local'; path: string };
  integrity?: string;
  signature?: EntitySignature;
  metadata?: Record<string, unknown>;
}

export interface EntityFilter {
  kind?: EntityKind | EntityKind[];
  pluginId?: string;
  search?: string;
  verified?: boolean;
}

// ---------------------------------------------------------------------------
// Plugin Brief (backward compat with cli-api consumers)
// ---------------------------------------------------------------------------

export interface PluginBrief {
  id: string;
  version: string;
  source: { kind: 'marketplace' | 'local'; path: string };
  display?: { name?: string; description?: string };
}

// ---------------------------------------------------------------------------
// Registry Diff
// ---------------------------------------------------------------------------

export interface RegistryDiff {
  added: PluginBrief[];
  removed: PluginBrief[];
  changed: PluginBrief[];
}

// ---------------------------------------------------------------------------
// Snapshot Types
// ---------------------------------------------------------------------------

export interface RegistrySnapshotManifestEntry {
  pluginId: string;
  manifest: ManifestV3;
  pluginRoot: string;
  source: { kind: 'marketplace' | 'local'; path: string };
  /** Discovery facts, so a snapshot restores exactly what discovery found. */
  packageName: DiscoveredPlugin['packageName'];
  scope: DiscoveredPlugin['scope'];
  origin: DiscoveredPlugin['origin'];
  manifestPath: DiscoveredPlugin['manifestPath'];
  manifestKind: DiscoveredPlugin['manifestKind'];
}

export interface RegistrySnapshot {
  schema: 'kb.registry/1';
  rev: number;
  version: string;
  generatedAt: string;
  expiresAt?: string;
  ttlMs?: number;
  partial: boolean;
  stale: boolean;
  source: { cwd: string; platformVersion: string };
  corrupted?: boolean;
  checksum?: string;
  checksumAlgorithm?: 'sha256';
  previousChecksum?: string | null;
  plugins: Array<{
    id: string;
    version: string;
    source: { kind: 'marketplace' | 'local'; path: string };
  }>;
  manifests: RegistrySnapshotManifestEntry[];
  diagnostics?: DiagnosticEvent[];
  ts: number;
}

export type SnapshotWithoutIntegrity = Omit<RegistrySnapshot, 'checksum' | 'checksumAlgorithm' | 'previousChecksum'>;

// ---------------------------------------------------------------------------
// Health Types
// ---------------------------------------------------------------------------

export interface GitInfo {
  sha: string;
  dirty: boolean;
}

export interface SystemHealthSnapshot {
  schema: 'kb.health/1';
  ts: string;
  uptimeSec: number;
  version: {
    kbLabs: string;
    rest: string;
    studio?: string;
    git?: GitInfo;
  };
  registry: {
    total: number;
    withRest: number;
    withStudio: number;
    errors: number;
    generatedAt: string;
    expiresAt?: string;
    partial: boolean;
    stale: boolean;
  };
  status: 'healthy' | 'degraded';
  components: Array<{
    id: string;
    version?: string;
    restRoutes?: number;
    studioWidgets?: number;
    lastError?: string;
  }>;
  meta?: Record<string, unknown>;
}

export interface SystemHealthOptions {
  uptimeSec?: number;
  version?: Partial<SystemHealthSnapshot['version']>;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OpenAPI & Studio
// ---------------------------------------------------------------------------

export interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
  'x-kb-plugin-id'?: string;
}

export interface StudioRegistryEntry {
  id: string;
  version: string;
  display: { name: string; description?: string; icon?: string; category?: string };
  capabilities: {
    hasCommands?: boolean;
    hasRestAPI?: boolean;
    hasUI?: boolean;
    hasJobs?: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface StudioRegistry {
  version: string;
  generated: string;
  plugins: StudioRegistryEntry[];
}

// ---------------------------------------------------------------------------
// Diagnostic Report
// ---------------------------------------------------------------------------

export interface DiagnosticReport {
  events: DiagnosticEvent[];
  summary: {
    errors: number;
    warnings: number;
    totalPlugins: number;
    loadedPlugins: number;
    failedPlugins: number;
  };
  byPlugin: Record<string, DiagnosticEvent[]>;
}

// ---------------------------------------------------------------------------
// Registry Options & Interface
// ---------------------------------------------------------------------------

export interface RegistryOptions {
  /** Workspace root directory (default: process.cwd()) */
  root?: string;
  /**
   * Platform installation root (e.g. ~/kb-platform).
   * When set and different from root, plugins are merged from both lock files:
   * project lock wins, platform lock fills gaps.
   */
  platformRoot?: string;
  /** Cache configuration */
  cache?: {
    ttlMs?: number;
    adapter?: ICache;
    snapshotKey?: string;
  };
  /** Platform version for snapshot metadata */
  platformVersion?: string;
  /** Import timeout for manifest loading (ms) */
  importTimeoutMs?: number;
  /** Whether to verify integrity hashes (default: true) */
  verifyIntegrity?: boolean;
}

export interface IEntityRegistry {
  initialize(): Promise<void>;

  // Plugin-level
  listPlugins(): PluginBrief[];
  getManifest(pluginId: string): ManifestV3 | null;
  getOpenAPISpec(pluginId: string): OpenAPISpec | null;
  getStudioRegistry(): StudioRegistry;

  // Entity catalog (unified, extensible)
  queryEntities(filter: EntityFilter): EntityEntry[];
  getEntity(ref: EntityRef): EntityEntry | null;
  getEntityKinds(): EntityKind[];

  // Snapshot & lifecycle
  snapshot(): RegistrySnapshot;
  refresh(): Promise<void>;
  onChange(cb: (diff: RegistryDiff) => void): () => void;

  // Health & diagnostics
  getSystemHealth(opts?: SystemHealthOptions): Promise<SystemHealthSnapshot>;
  getDiagnostics(): DiagnosticReport;

  // State
  enablePlugin(pluginId: string): Promise<void>;
  disablePlugin(pluginId: string): Promise<void>;

  dispose(): Promise<void>;
}
