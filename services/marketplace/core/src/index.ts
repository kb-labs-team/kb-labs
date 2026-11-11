/**
 * @module @kb-labs/marketplace-core
 * Unified marketplace service for KB Labs platform.
 */

export { MarketplaceService, AdapterScopeError, InvalidEntityError, MarketplaceInstallRollbackError, MarketplaceVersionError, PackageClassificationError, mergeScopedEntries } from './marketplace-service.js';
export type { MarketplaceServiceOptions } from './marketplace-service.js';
export { ScopeResolutionError, resolveScopeRoot, resolveQueryRoots } from './scope.js';
export type { ServiceRoots } from './scope.js';

export {
  readManifestCache,
  writeManifestCache,
  createEmptyManifestCache,
  setCacheEntry,
  removeCacheEntry,
} from './manifest-cache.js';

export { PluginStrategy, AdapterManifestLoadError, AdapterStrategy } from './strategies/index.js';
