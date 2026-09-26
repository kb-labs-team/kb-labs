/**
 * @module @kb-labs/core-discovery/types
 * Core types for marketplace-based entity discovery.
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';

// ---------------------------------------------------------------------------
// Entity Signature (platform-issued proof of quality)
// ---------------------------------------------------------------------------

export interface EntitySignature {
  /** Signing algorithm (e.g., 'ed25519', 'sha256-rsa') */
  algorithm: string;
  /** Base64-encoded signature bytes */
  value: string;
  /** Identity of the signer (e.g., 'kb-labs-platform') */
  signer: string;
  /** ISO timestamp of when the signature was created */
  signedAt: string;
  /** List of checks the entity passed (e.g., ['integrity', 'types', 'lint', 'tests']) */
  verifiedChecks: string[];
}

// ---------------------------------------------------------------------------
// Entity Kind (extensible)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Marketplace Lock (.kb/marketplace.lock)
// ---------------------------------------------------------------------------

export interface MarketplaceLock {
  schema: 'kb.marketplace/2';
  installed: Record<string, MarketplaceEntry>;
}

export interface MarketplaceEntry {
  /** Installed version (semver) */
  version: string;
  /** SRI integrity hash (sha256-...) */
  integrity: string;
  /** Resolved path to the package root (e.g., ./node_modules/@scope/pkg) */
  resolvedPath: string;
  /** ISO timestamp of installation */
  installedAt: string;
  /** How this package was installed */
  source: 'marketplace' | 'local';
  /**
   * Trust level: 'trusted' = signed by KB Labs Registry (sealed, no self-upgrade).
   * 'untrusted' = installed from npm/local/workspace. Default: 'untrusted'.
   */
  trust?: 'trusted' | 'untrusted';
  /** Platform-issued signature (optional, for verified packages) */
  signature?: EntitySignature;
  /** Primary entity kind — discriminator for filtering (e.g., 'plugin', 'adapter') */
  primaryKind: EntityKind;
  /** All entity kinds this package provides (extracted from manifest) */
  provides: EntityKind[];
  /** Whether the entity is active (default: true) */
  enabled?: boolean;
  /**
   * Canonical install spec (e.g. 'kb:handle/name', '@scope/pkg@version').
   * Optional, populated when the source preserves the original spec form.
   */
  spec?: string;
}

// ---------------------------------------------------------------------------
// Discovery Result
// ---------------------------------------------------------------------------

/** Where an entity lives (ADR-0012): the shared platform install or the user's project. */
export type DiscoveryScope = 'platform' | 'project';

/**
 * Where a discovered plugin came from. Also its shadowing priority when the
 * same plugin id is found more than once in one scope:
 * `workspace` > `linked` > `node_modules`.
 *
 * - `workspace`: a pnpm workspace package under the scope root (monorepo development).
 * - `linked`: a marketplace lock entry with `source: 'local'` (`kb marketplace plugins link`).
 * - `node_modules`: a marketplace lock entry with `source: 'marketplace'` (installed package).
 */
export type DiscoveryOrigin = 'workspace' | 'linked' | 'node_modules';

export interface DiscoveredPlugin {
  /** Plugin identifier (@scope/name) */
  id: string;
  /** Plugin version (semver) */
  version: string;
  /** Path to the package root */
  packageRoot: string;
  /** `name` from package.json (falls back to the plugin id) */
  packageName: string;
  /** Scope the plugin was discovered in */
  scope: DiscoveryScope;
  /** Origin of the plugin, drives shadowing priority */
  origin: DiscoveryOrigin;
  /** File the manifest was read from (static JSON or compiled module) */
  manifestPath: string;
  /** `static`: read from JSON, no plugin code executed. `module`: imported. */
  manifestKind: 'static' | 'module';
  /** How this plugin was installed */
  source: { kind: 'marketplace' | 'local'; path: string };
  /** Display metadata */
  display?: { name?: string; description?: string };
  /** SRI integrity from marketplace.lock */
  integrity?: string;
  /** Platform signature from marketplace.lock */
  signature?: EntitySignature;
  /** Entity kinds extracted from manifest */
  provides: EntityKind[];
}

/** A candidate that was found but could not be turned into a plugin. */
export interface DiscoveryFailure {
  /** Lock key or package name of the candidate */
  id: string;
  packageName: string;
  packageRoot: string;
  scope: DiscoveryScope;
  origin: DiscoveryOrigin;
  /** File that failed to load, when known */
  manifestPath?: string;
  /** `manifest`: the manifest exists but could not be loaded. */
  reason: 'manifest' | 'integrity' | 'package-missing';
  message: string;
}

export interface DiscoveryResult {
  /** Successfully discovered plugins */
  plugins: DiscoveredPlugin[];
  /** Loaded manifests keyed by plugin ID */
  manifests: Map<string, ManifestV3>;
  /** Candidates that were found but failed to load */
  failures: DiscoveryFailure[];
  /** Diagnostic events from the discovery process */
  diagnostics: DiagnosticEvent[];
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'debug';

export interface DiagnosticEvent {
  /** Severity level */
  severity: DiagnosticSeverity;
  /** Machine-readable code for programmatic handling */
  code: DiagnosticCode;
  /** Human-readable description of the issue */
  message: string;
  /** Contextual information about the affected entity */
  context?: {
    pluginId?: string;
    entityKind?: EntityKind;
    entityId?: string;
    filePath?: string;
  };
  /** Unix timestamp of when the event occurred */
  ts: number;
  /** Error stack trace (for errors) */
  stack?: string;
  /** Suggested fix for the issue */
  remediation?: string;
}

export type DiagnosticCode =
  | 'LOCK_NOT_FOUND'
  | 'LOCK_PARSE_ERROR'
  | 'LOCK_SCHEMA_INVALID'
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
  | 'PACKAGE_NOT_FOUND'
  | (string & {});
