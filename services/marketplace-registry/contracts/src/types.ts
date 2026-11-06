/**
 * @module @kb-labs/marketplace-registry-contracts
 * Shared types for the KB Labs Marketplace Registry.
 */

import type { MarketplaceIdentityResolution } from '@kb-labs/plugin-contracts';
import type { EntitySignature, EntityKind } from '@kb-labs/plugin-contracts';

// ---------------------------------------------------------------------------
// Package metadata (read from package.json at publish time)
// ---------------------------------------------------------------------------

export interface PackageAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface PackageRepository {
  type: string;
  url: string;
}

/** Fields read from package.json and stored in the registry. */
export interface PackageMeta {
  name: string;
  version: string;
  /** Canonical KB Labs plugin/adapter identity declared by its manifest. */
  identity: string;
  description?: string;
  author?: PackageAuthor | string;
  repository?: PackageRepository | string;
  keywords?: string[];
  license?: string;
  homepage?: string;
  /** README.md content captured at publish time (markdown). */
  readme?: string;
  /** Permissions declared in kb.manifest.permissions. */
  permissions?: string[];
  /** Environment variables declared in kb.manifest.envVars. */
  envVars?: string[];
  /** Allowed network hosts declared in kb.manifest.allowedHosts. */
  allowedHosts?: string[];
  /** CLI command IDs registered by the plugin. */
  commands?: string[];
}

/** Registry-owned identity and namespace ownership result consumed by Marketplace. */
export type RegistryIdentityResolution = MarketplaceIdentityResolution;

// ---------------------------------------------------------------------------
// Registry entry (meta.json stored in platform.storage)
// ---------------------------------------------------------------------------

export type RegistryVisibility = 'public' | 'private';
export type RegistryTrust = 'trusted' | 'untrusted';

export interface RegistryVersionEntry {
  version: string;
  publishedAt: string;
  /** SRI integrity hash of the tarball */
  integrity: string;
  /** Platform signature (present for trusted/public packages) */
  signature?: EntitySignature;
  yanked?: boolean;
  yankReason?: string;
}

export interface RegistryEntry {
  /** Package name (from package.json) */
  name: string;
  /** Author handle (e.g. "kirill") */
  authorHandle: string;
  /** Primary entity kind declared at publish time */
  primaryKind: EntityKind;
  /** Author namespaceId (from gateway auth) */
  authorNamespaceId: string;
  /** Visibility: public (listed in catalog) or private (allowlist only) */
  visibility: RegistryVisibility;
  /** Trust level: trusted = signed by KB Labs Platform */
  trust: RegistryTrust;
  /** namespaceIds allowed to install (private packages) */
  allowlist: string[];
  /** All published versions */
  versions: RegistryVersionEntry[];
  /** Whether the package is archived (deprecated) */
  deprecated: boolean;
  deprecateMessage?: string;
  /** Discoverable in catalog and search */
  featured: boolean;
  /** Badges (e.g. 'beta-contributor') */
  badges: string[];
  /** Tags for filtering */
  tags: string[];
  /** Metadata from latest version's package.json */
  meta: PackageMeta;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Publish request / response
// ---------------------------------------------------------------------------

export interface PublishRequest {
  /** package.json metadata */
  meta: PackageMeta;
  visibility: RegistryVisibility;
  /** Primary entity kind (plugin, adapter, studio-widget, …) */
  primaryKind: EntityKind;
}

export interface PublishResponse {
  handle: string;
  name: string;
  version: string;
  visibility: RegistryVisibility;
  trust: RegistryTrust;
  signature?: EntitySignature;
  installCommand: string;
  pageUrl?: string;
}

// ---------------------------------------------------------------------------
// Share token
// ---------------------------------------------------------------------------

export interface ShareToken {
  token: string;
  pkg: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Package listing (public catalog)
// ---------------------------------------------------------------------------

export interface RegistryPackageSummary {
  handle: string;
  name: string;
  fullName: string;
  version: string;
  description?: string;
  author?: PackageAuthor | string;
  keywords?: string[];
  primaryKind: EntityKind;
  featured: boolean;
  badges: string[];
  trust: RegistryTrust;
  installs: number;
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// Registry config (from kb.config.json)
// ---------------------------------------------------------------------------

export interface RegistryConfig {
  url: string;
  publishKey?: string;
  /** Embedded Ed25519 public key for signature verification (bundled at build time) */
  signingPublicKey?: string;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface PackageStats {
  installs: number;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type RegistryErrorCode =
  | 'PACKAGE_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_ALREADY_EXISTS'
  | 'VERSION_YANKED'
  | 'PACKAGE_DEPRECATED'
  | 'ACCESS_DENIED'
  | 'HANDLE_NOT_FOUND'
  | 'SIGNATURE_INVALID'
  | 'TARBALL_TOO_LARGE'
  | (string & {});
