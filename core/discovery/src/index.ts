/**
 * @module @kb-labs/core-discovery
 * Marketplace-based entity discovery for the KB Labs platform.
 *
 * Installed or linked entities (plugins, adapters, widgets, skills, hooks, etc.)
 * are registered through the marketplace lock file (.kb/marketplace.lock), in both
 * platform and project scope. The only other source is the pnpm workspace under a
 * scope root (monorepo development). Nothing else is scanned.
 */

// Discovery manager
export { DiscoveryManager, extractEntityKinds } from './discovery-manager.js';
export type { DiscoveryOptions } from './discovery-manager.js';
export {
  isDiscoverySnapshotStale,
  createDiscoveryObservationFingerprinter,
} from './discovery-inputs.js';
export type { DiscoveryObservationFingerprinter } from './discovery-inputs.js';
export { captureFilesystemObservations, hashFilesystemObservations, readFile, exists, access, stat, listDirectory, glob, replayFilesystemObservations } from './recording-filesystem.js';
export type { FilesystemObservation } from './recording-filesystem.js';

// Marketplace lock CRUD
export {
  readMarketplaceLock,
  writeMarketplaceLock,
  addToMarketplaceLock,
  removeFromMarketplaceLock,
  createEmptyLock,
  createMarketplaceEntry,
  createInstallOwnedRelativePath,
  MarketplaceLockValidationError,
  validateMarketplaceLock,
  enablePlugin,
  disablePlugin,
} from './marketplace-lock.js';
export type { MarketplaceLockScope, MarketplaceLockValidationResult } from './marketplace-lock.js';
export { resolveMarketplaceLockScope, validateMarketplaceLockAtRoot } from './marketplace-lock-scope.js';
export type { MarketplaceLockRoots } from './marketplace-lock-scope.js';

// Manifest loader
export { loadManifestFile } from './manifest-loader.js';
export type { LoadedManifest, ManifestLoadResult } from './manifest-loader.js';

// Integrity (SRI computation for marketplace entries and manifest files)
export { computeFileIntegrity, computePackageIntegrity, computeManifestIntegrity, parseIntegrity } from './integrity.js';

// Governance gate
export { readPluginPolicy, checkPluginPolicy } from './plugin-policy.js';
export type { PluginPolicy, PluginPolicyResult, PolicyVerdict } from './plugin-policy.js';

// Workspace packages are also the development source for configured adapters.
export { findWorkspacePackages } from './workspace-source.js';
export type { WorkspaceCandidate } from './workspace-source.js';

// Diagnostics
export { DiagnosticCollector } from './diagnostics.js';
