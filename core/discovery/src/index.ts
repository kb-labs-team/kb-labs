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

// Marketplace lock CRUD
export {
  readMarketplaceLock,
  writeMarketplaceLock,
  addToMarketplaceLock,
  removeFromMarketplaceLock,
  createEmptyLock,
  createMarketplaceEntry,
  enablePlugin,
  disablePlugin,
} from './marketplace-lock.js';

// Manifest loader
export { loadManifest, loadManifestFile } from './manifest-loader.js';
export type { LoadedManifest } from './manifest-loader.js';

// Integrity (SRI computation for marketplace entries and manifest files)
export { computeFileIntegrity, computePackageIntegrity, computeManifestIntegrity, parseIntegrity } from './integrity.js';

// Diagnostics
export { DiagnosticCollector } from './diagnostics.js';

// Types
export type {
  // Entity model
  EntityKind,
  EntitySignature,
  // Marketplace lock
  MarketplaceLock,
  MarketplaceEntry,
  // Discovery result
  DiscoveredPlugin,
  DiscoveryResult,
  DiscoveryFailure,
  DiscoveryOrigin,
  DiscoveryScope,
  // Diagnostics
  DiagnosticSeverity,
  DiagnosticEvent,
  DiagnosticCode,
} from './types.js';
