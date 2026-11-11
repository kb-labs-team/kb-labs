/**
 * @module @kb-labs/marketplace-contracts
 * Shared types and interfaces for the KB Labs marketplace ecosystem.
 */

export type {
  // PackageSource
  PackageSource,
  MarketplaceSource,
  MarketplaceSourceKind,
  MarketplaceSourceResolution,
  MarketplaceEntryWithId,
  ResolvedPackage,
  InstalledPackage,
  PackageListing,
  PublishMetadata,
  PublishResult,

  // Scope
  MarketplaceScope,
  MarketplaceQueryScope,
  ScopeContext,
  QueryScopeContext,
  ScopedMarketplaceEntry,
  MarketplaceDiagnostic,

  // EntityKindStrategy
  EntityKindStrategy,
  MarketplaceServiceAPI,

  // ManifestCache
  ManifestCache,
  ManifestCacheEntry,

  // Results
  SyncResult,
  InstallResult,
  InstallResultEntry,
  DoctorReport,
  DoctorIssue,
  MarketplaceProvenance,
} from './types.js';
