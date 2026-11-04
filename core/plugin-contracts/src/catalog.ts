import type { ManifestV3 } from './manifest.js';
import type { AdapterManifestLoadResult } from '@kb-labs/core-platform';

export type EntityKind =
  | 'plugin'
  | 'adapter'
  | 'cli-command'
  | 'rest-route'
  | 'ws-channel'
  | 'workflow'
  | 'webhook'
  | 'job'
  | 'cron'
  | 'studio-widget'
  | 'studio-menu'
  | 'studio-layout'
  | 'skill'
  | 'hook'
  | (string & {});

export interface EntitySignature {
  algorithm: string;
  value: string;
  signer: string;
  signedAt: string;
  verifiedChecks: string[];
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'debug';
export type DiagnosticCode =
  | 'LOCK_NOT_FOUND'
  | 'LOCK_PARSE_ERROR'
  | 'LOCK_SCHEMA_INVALID'
  | 'MARKETPLACE_PROVENANCE_REQUIRED'
  | 'MANIFEST_NOT_FOUND'
  | 'MANIFEST_PARSE_ERROR'
  | 'MANIFEST_VALIDATION_ERROR'
  | 'MANIFEST_LOAD_TIMEOUT'
  | 'MANIFEST_NOT_PLUGIN'
  | 'INTEGRITY_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_MISSING'
  | 'DEPENDENCY_MISSING'
  | 'ENTITY_CONFLICT'
  | 'PLUGIN_DISABLED'
  | 'PLUGIN_BLOCKED'
  | 'PLUGIN_NOT_ALLOWED'
  | 'PACKAGE_NOT_FOUND'
  | 'COMMAND_SCHEMA_INVALID'
  | 'COMMAND_HANDLER_MISSING'
  | 'COMMAND_HANDLER_UNREADABLE'
  | 'PLUGIN_ID_MISMATCH'
  | (string & {});

export interface DiagnosticEvent {
  severity: DiagnosticSeverity;
  code: DiagnosticCode;
  message: string;
  context?: { pluginId?: string; entityKind?: EntityKind; entityId?: string; filePath?: string };
  ts: number;
  stack?: string;
  remediation?: string;
}

export type DiscoveryScope = 'platform' | 'project';
export type DiscoveryOrigin = 'workspace' | 'linked' | 'node_modules';

export interface DiscoveredPlugin {
  id: string;
  version: string;
  packageRoot: string;
  packageName: string;
  scope: DiscoveryScope;
  origin: DiscoveryOrigin;
  manifestPath: string;
  manifestKind: 'static';
  source: { kind: 'marketplace' | 'local'; path: string };
  display?: { name?: string; description?: string };
  integrity?: string;
  signature?: EntitySignature;
  provides: EntityKind[];
}

export interface DiscoveryFailure {
  id: string;
  packageName: string;
  packageRoot: string;
  scope: DiscoveryScope;
  origin: DiscoveryOrigin;
  manifestPath?: string;
  reason: 'manifest' | 'integrity' | 'package-missing' | 'package-unavailable';
  message: string;
  diagnosticCode?: DiagnosticCode;
  remediation?: string;
}

export interface DiscoveryResult {
  plugins: DiscoveredPlugin[];
  manifests: Map<string, ManifestV3>;
  failures: DiscoveryFailure[];
  diagnostics: DiagnosticEvent[];
  observations: DiscoveryObservation[];
  requestIdentity: string;
  fingerprint: string;
}

export interface DiscoveryObservation {
  path: string;
  kind: 'content' | 'absent' | 'present' | 'listing';
  digest: string;
}

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

export interface PluginBrief {
  id: string;
  version: string;
  source: { kind: 'marketplace' | 'local'; path: string };
  display?: { name?: string; description?: string };
}

export interface RegistryDiff {
  added: PluginBrief[];
  removed: PluginBrief[];
  changed: PluginBrief[];
}

export interface RegistrySnapshotManifestEntry {
  pluginId: string;
  manifest: ManifestV3;
  pluginRoot: string;
  source: { kind: 'marketplace' | 'local'; path: string };
  packageName: DiscoveredPlugin['packageName'];
  scope: DiscoveredPlugin['scope'];
  origin: DiscoveredPlugin['origin'];
  manifestPath: DiscoveredPlugin['manifestPath'];
  manifestKind: DiscoveredPlugin['manifestKind'];
}

export interface RegistrySnapshot {
  schema: 'kb.registry/2';
  rev: number;
  version: string;
  generatedAt: string;
  expiresAt?: string;
  ttlMs?: number;
  partial: boolean;
  stale: boolean;
  source: { cwd: string; platformVersion?: string };
  corrupted?: boolean;
  checksum?: string;
  checksumAlgorithm?: 'sha256';
  previousChecksum?: string | null;
  plugins: Array<{ id: string; version: string; source: { kind: 'marketplace' | 'local'; path: string } }>;
  manifests: RegistrySnapshotManifestEntry[];
  observations: DiscoveryObservation[];
  requestIdentity: string;
  diagnostics?: DiagnosticEvent[];
  inputFingerprint: string;
  ts: number;
}

export type SnapshotWithoutIntegrity = Omit<RegistrySnapshot, 'checksum' | 'checksumAlgorithm' | 'previousChecksum'>;

export interface MarketplaceLock {
  schema: 'kb.marketplace/3';
  plugins: Record<string, MarketplaceEntry>;
  adapters?: Record<string, MarketplaceAdapterEntry>;
}

declare const userOwnedLinkPathBrand: unique symbol;
declare const installOwnedRelativePathBrand: unique symbol;
export type UserOwnedLinkPath = string & { readonly [userOwnedLinkPathBrand]: true };
export type InstallOwnedRelativePath = string & { readonly [installOwnedRelativePathBrand]: true };

interface MarketplaceEntryMetadata {
  trust?: 'trusted' | 'untrusted';
  signature?: EntitySignature;
  primaryKind?: EntityKind;
  provides?: EntityKind[];
  enabled?: boolean;
}

export type MarketplaceEntry = MarketplaceEntryMetadata & (
  | {
      source: 'marketplace'; version: string; integrity: string; package: string;
      resolvedPath?: InstallOwnedRelativePath; marketplaceSource: 'registry' | 'npm';
      signatureStatus: 'verified' | 'unsigned'; link?: never;
    }
  | { source: 'platform'; version: string; integrity: string; package: string; resolvedPath: InstallOwnedRelativePath; link?: never }
  | { source: 'local'; link: UserOwnedLinkPath; package?: never; version?: string; integrity?: string; resolvedPath?: never }
);

export type MarketplaceAdapterEntry =
  | { source: 'platform'; version: string; integrity: string; resolvedPath: InstallOwnedRelativePath; enabled: boolean }
  | { source: 'marketplace'; version: string; integrity: string; resolvedPath: InstallOwnedRelativePath; enabled: boolean; marketplaceSource: 'registry' | 'npm'; signatureStatus: 'verified' | 'unsigned' };
export type MarketplaceLockEntry = MarketplaceEntry | MarketplaceAdapterEntry;

export interface MarketplaceResolvedIdentity {
  id: string;
  version: string;
  integrity: string;
  signature?: EntitySignature;
  primaryKind?: EntityKind;
  downloadUrl?: string;
  signatureSubject?: string;
}

export type MarketplaceIdentityResolution =
  | { status: 'found'; package: MarketplaceResolvedIdentity }
  | { status: 'not-found-unowned' }
  | { status: 'not-found-owned' };

export interface GitInfo { sha: string; dirty: boolean }
export interface HealthContributorResult { status: 'healthy' | 'degraded'; details?: Record<string, unknown>; lastError?: string }
export interface HealthContributor { id: string; getHealth(): Promise<HealthContributorResult> }

export interface SystemHealthSnapshot {
  schema: 'kb.health/1'; ts: string; uptimeSec: number;
  version: { kbLabs: string; rest: string; studio?: string; git?: GitInfo };
  registry: { total: number; withRest: number; withStudio: number; errors: number; generatedAt: string; expiresAt?: string; partial: boolean; stale: boolean };
  status: 'healthy' | 'degraded';
  components: Array<{ id: string; version?: string; restRoutes?: number; studioWidgets?: number; lastError?: string; status?: 'healthy' | 'degraded'; details?: Record<string, unknown> }>;
  meta?: Record<string, unknown>;
}
export interface SystemHealthOptions { uptimeSec?: number; version?: Partial<SystemHealthSnapshot['version']>; meta?: Record<string, unknown> }

export interface OpenAPISpec { openapi: string; info: { title: string; version: string; description?: string }; paths: Record<string, unknown>; components?: { schemas?: Record<string, unknown> }; 'x-kb-plugin-id'?: string }
export interface StudioRegistryEntry {
  id: string; version: string; display: { name: string; description?: string; icon?: string; category?: string };
  capabilities: { hasCommands?: boolean; hasRestAPI?: boolean; hasUI?: boolean; hasJobs?: boolean };
  metadata?: Record<string, unknown>;
}
export interface StudioRegistry { version: string; generated: string; plugins: StudioRegistryEntry[] }
export interface DiagnosticReport {
  events: DiagnosticEvent[];
  summary: { errors: number; warnings: number; totalPlugins: number; loadedPlugins: number; failedPlugins: number };
  byPlugin: Record<string, DiagnosticEvent[]>;
}

export interface CatalogAdapter {
  id: string;
  packageRoot: string;
  source: 'marketplace' | 'workspace';
  manifest: AdapterManifestLoadResult;
}

export interface CatalogOpenOptions {
  healthContributors?: HealthContributor[];
  workspaceAdapters?:
    | { development: true; workspaceRoot: string; configuredPackages: readonly { packageName: string; slot: string }[]; discoverAll?: boolean }
    | { development: false; configuredPackages: readonly { packageName: string; slot: string }[] };
}

export interface CatalogScope {
  platformRoot?: string;
  projectRoot?: string;
}

/** Read-only view of the resolved catalog. Generation identity is snapshot `rev` plus `checksum`. */
export interface IEntityRegistry {
  listPlugins(): PluginBrief[];
  getManifest(pluginId: string): ManifestV3 | null;
  getOpenAPISpec(pluginId: string): OpenAPISpec | null;
  getStudioRegistry(): StudioRegistry;
  queryEntities(filter: EntityFilter): EntityEntry[];
  getEntity(ref: EntityRef): EntityEntry | null;
  getEntityKinds(): EntityKind[];
  snapshot(): RegistrySnapshot;
  discovery(): DiscoveryResult;
  adapters(): ReadonlyMap<string, CatalogAdapter>;
  marketplaceLocks(): Promise<ReadonlyMap<string, MarketplaceLock>>;
  computePackageIntegrity(packageRoot: string): Promise<string>;
  discoveryObservationFingerprinter(): (roots: readonly string[]) => Promise<string>;
  findStoredPluginPackageForRestPrefix(requestedPrefix: string, basePath: string): Promise<string | undefined>;
  refresh(): Promise<void>;
  onChange(cb: (diff: RegistryDiff) => void): () => void;
  getSystemHealth(opts?: SystemHealthOptions): Promise<SystemHealthSnapshot>;
  getDiagnostics(): DiagnosticReport;
  dispose(): Promise<void>;
}

export interface IEntityRegistryWriter {
  enablePlugin(pluginId: string): Promise<void>;
  disablePlugin(pluginId: string): Promise<void>;
}
