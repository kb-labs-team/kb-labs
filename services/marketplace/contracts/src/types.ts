/**
 * @module @kb-labs/marketplace-contracts/types
 * Shared types for the KB Labs marketplace ecosystem.
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';
import type { MarketplaceLockEntry, MarketplaceResolvedIdentity, MarketplaceIdentityResolution } from '@kb-labs/plugin-contracts';
import type { EntityKind, EntitySignature } from '@kb-labs/plugin-contracts';

// ---------------------------------------------------------------------------
// PackageSource — abstraction over where packages come from
// ---------------------------------------------------------------------------

/**
 * A resolved package ready to be installed.
 */
export interface ResolvedPackage extends MarketplaceResolvedIdentity {
  /** How this package was sourced */
  source: 'marketplace' | 'local';
}

/**
 * Metadata about a successfully installed package.
 */
export interface InstalledPackage {
  /** Package identifier */
  id: string;
  /** Installed version */
  version: string;
  /** Absolute path to the installed package root */
  packageRoot: string;
  /** Computed integrity hash */
  integrity: string;
}

/**
 * Brief listing entry for search results.
 */
export interface PackageListing {
  id: string;
  version: string;
  description?: string;
  primaryKind: EntityKind;
  provides: EntityKind[];
  signature?: EntitySignature;
}

/**
 * Metadata required when publishing a package.
 */
export interface PublishMetadata {
  id: string;
  version: string;
  description?: string;
  primaryKind: EntityKind;
  provides: EntityKind[];
}

/**
 * Result of a publish operation.
 */
export interface PublishResult {
  id: string;
  version: string;
  signature?: EntitySignature;
  publishedAt: string;
}

/**
 * Abstraction over the source of packages.
 *
 * Currently: NpmPackageSource (pnpm add/remove).
 * Future: RegistryPackageSource (KB Labs marketplace registry API).
 *
 * MarketplaceService works through this interface — it never calls
 * pnpm or any other package manager directly.
 */
export interface PackageSource {
  /** Resolve a package spec (e.g., "@scope/pkg@^1.0.0") to installable metadata */
  resolve(spec: string): Promise<ResolvedPackage>;

  /** Install a resolved package into the workspace */
  install(pkg: ResolvedPackage, root: string, opts?: { dev?: boolean }): Promise<InstalledPackage>;

  /** Commit or restore the package-manager mutation after Marketplace validation and lock updates. */
  commitInstall(packageId: string, root: string): Promise<void>;
  rollbackInstall(packageId: string, root: string): Promise<void>;

  /** Remove a package from the workspace */
  remove(packageId: string, root: string): Promise<void>;

  /** Search available packages (optional — not all sources support it) */
  search?(query: string, filter?: { kind?: EntityKind }): Promise<PackageListing[]>;

  /** Publish a package (optional — only registry source supports it) */
  publish?(tarball: Buffer, metadata: PublishMetadata): Promise<PublishResult>;

  /** Return a copy of this source with a per-request share token injected (optional) */
  withShareToken?(token: string): PackageSource;
}

export type MarketplaceSourceKind = 'registry' | 'npm';
export type MarketplaceSourceResolution = MarketplaceIdentityResolution;

export interface MarketplaceSource extends PackageSource {
  kind: MarketplaceSourceKind;
  /** Public verification key resolved from this Registry source's config. */
  verificationKey?: string;
  resolveIdentity(identity: string): Promise<MarketplaceSourceResolution>;
  withShareToken?(token: string): MarketplaceSource;
}

// ---------------------------------------------------------------------------
// Scope model — platform vs project
// ---------------------------------------------------------------------------

/**
 * A marketplace scope. Each scope has its own independent `marketplace.lock`
 * and manifest cache, rooted at a different directory.
 *
 * - `platform` — global installs shared across projects (in the platform root).
 * - `project`  — installs local to a single project (in the project root).
 * - `all`      — only valid as a query scope (`list`). Returns merged entries
 *                from both scopes with `scope` field attached to each entry.
 */
export type MarketplaceScope = 'platform' | 'project';
export type MarketplaceQueryScope = MarketplaceScope | 'all';

/**
 * Per-call scope binding for mutating operations (`install`, `link`,
 * `unlink`, `enable`, `disable`, `update`, `sync`) and for read operations
 * (`list`, `getEntry`).
 *
 * - `scope`       — which lock this call targets.
 * - `projectRoot` — required for `scope: 'project'` (ignored otherwise).
 *                   Absolute path. The service validates that this directory
 *                   exists and contains a `.kb/kb.config.{json,jsonc}` and is
 *                   not equal to the platform root.
 */
export interface ScopeContext {
  scope: MarketplaceScope;
  projectRoot?: string;
}

/**
 * Read-side context. Same as `ScopeContext`, but also admits `'all'` to merge
 * platform and project lists.
 */
export interface QueryScopeContext {
  scope: MarketplaceQueryScope;
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// EntityKindStrategy — extensibility contract for new entity types
// ---------------------------------------------------------------------------

/**
 * Public read-only API of MarketplaceService exposed to strategies.
 * Strategies must not depend on the full implementation.
 */
/** Marketplace entry with its package ID (key from lock record). */
export type MarketplaceEntryWithId = MarketplaceLockEntry & { id: string };

/**
 * Marketplace entry annotated with the scope it came from. Returned by
 * `list()` so callers can always tell where a package was installed, without
 * having to probe locks themselves.
 */
export type ScopedMarketplaceEntry = MarketplaceEntryWithId & {
  scope: MarketplaceScope;
};

/**
 * Non-fatal warning surfaced by a marketplace operation.
 * Examples: a collision between platform and project lock (project wins),
 * a project-scope config ignored because the field is platform-only, etc.
 */
export interface MarketplaceDiagnostic {
  code: string;
  message: string;
  packageId?: string;
  scope?: MarketplaceScope;
}

export interface MarketplaceServiceAPI {
  /** List installed entries, optionally filtered by kind */
  list(ctx: QueryScopeContext, filter?: { kind?: EntityKind }): Promise<ScopedMarketplaceEntry[]>;
  /** Get a single entry by package ID */
  getEntry(ctx: ScopeContext, packageId: string): Promise<MarketplaceLockEntry | null>;
}

/**
 * Strategy for handling a specific entity kind in the marketplace.
 *
 * Each entity type (plugin, adapter, workflow, etc.) can have custom
 * detection, extraction, and lifecycle hooks. Adding a new entity type
 * means implementing this interface — zero changes to core.
 */
export interface EntityKindStrategy {
  /** Which primary kind this strategy handles */
  kind: EntityKind;

  /**
   * Detect whether a package at the given root is of this entity kind.
   * Returns the kind if detected, null otherwise.
   */
  detectKind(packageRoot: string): Promise<EntityKind | null>;

  /**
   * Extract all entity kinds this package provides.
   * Called after detectKind succeeds.
   */
  extractProvides(packageRoot: string): Promise<EntityKind[]>;

  /**
   * Resolve the canonical entity ID to use as the lock key.
   * If provided and returns a non-null value, it overrides the package.json name.
   * Useful when the manifest ID differs from the package name (e.g. after folder renames).
   */
  resolveId?(packageRoot: string): Promise<string | null>;

  /**
   * Post-install hook. Called after the package is installed and written to lock.
   * Example: adapter strategy validates that required adapter dependencies are installed.
   *
   * The `ctx` argument carries the scope of the triggering install/link so the
   * strategy can query/modify the correct lock (e.g. via `service.list(ctx)`).
   */
  afterInstall?(
    packageId: string,
    packageRoot: string,
    service: MarketplaceServiceAPI,
    ctx: ScopeContext,
  ): Promise<void>;

  /**
   * Pre-uninstall hook. Called before the package is removed.
   * Example: adapter strategy checks if other adapters depend on this one.
   */
  beforeUninstall?(
    packageId: string,
    service: MarketplaceServiceAPI,
    ctx: ScopeContext,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Manifest Cache
// ---------------------------------------------------------------------------

/**
 * Cached manifest entry. Stored in .kb/marketplace.manifests.json.
 * Different entity types have different manifest shapes (ManifestV3, AdapterManifest).
 * Caching avoids dynamic import on every discovery cycle.
 */
export interface ManifestCacheEntry {
  /** Which manifest type is stored */
  manifestType: 'plugin' | 'adapter';
  /** The manifest data. Type depends on manifestType. */
  manifest: ManifestV3 | Record<string, unknown>;
  /** ISO timestamp of when this entry was cached */
  cachedAt: string;
  /** Integrity hash of the source package when cached. Stale if different from lock. */
  integrity: string;
}

/**
 * Full manifest cache file schema.
 */
export interface ManifestCache {
  schema: 'kb.marketplace.manifests/1';
  entries: Record<string, ManifestCacheEntry>;
}

// ---------------------------------------------------------------------------
// Install / Doctor results
// ---------------------------------------------------------------------------

export interface InstallResultEntry {
  /** Exact Marketplace install spec supplied for this entry. */
  spec?: string;
  id: string;
  version: string;
  primaryKind: EntityKind;
  provides: EntityKind[];
  packageRoot: string;
  /** Scope this entry was written to. */
  scope: MarketplaceScope;
  source: MarketplaceSourceKind | 'local';
  signatureStatus: 'verified' | 'unsigned' | 'not-applicable';
}

export interface InstallResult {
  installed: InstallResultEntry[];
  warnings: string[];
  /**
   * Scope the install was executed in. Echoed back so callers (API, CLI)
   * can render scope-aware output without tracking the request side.
   */
  scope: MarketplaceScope;
  /**
   * Non-fatal diagnostics produced during the operation (e.g. collisions).
   * Separate from `warnings` (which are free-form strings) so that downstream
   * consumers can render them uniformly.
   */
  diagnostics?: MarketplaceDiagnostic[];
}

export interface SyncResult {
  added: Array<{ id: string; primaryKind: EntityKind; version: string }>;
  skipped: Array<{ id: string; reason: string }>;
  total: number;
}

export interface DoctorIssue {
  severity: 'error' | 'warning' | 'info';
  packageId: string;
  diagnosticCode?: string;
  message: string;
  path?: string;
  remediation?: string;
}

export interface MarketplaceProvenance {
  packageId: string;
  source: 'registry' | 'npm';
  integrity: string;
  signatureStatus: 'verified' | 'unsigned';
}

export interface DoctorReport {
  ok: boolean;
  total: number;
  issues: DoctorIssue[];
  provenance: MarketplaceProvenance[];
}
