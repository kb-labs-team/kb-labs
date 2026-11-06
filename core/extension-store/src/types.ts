/**
 * @module @kb-labs/core-extension-store/types
 * Types for the shared per-machine store of installed plugin/adapter versions.
 * See ADR-0048 (D2).
 */

import type { ManifestV3 } from '@kb-labs/plugin-contracts';

/** Kind of extension a store entry holds. Adapters use the same layout (D8) even though they stay platform-scope. */
export type StoreEntryKind = 'plugin' | 'adapter';

export interface StoreEntrySignature {
  /** Signing algorithm (e.g. 'ed25519', 'sha256-rsa'). */
  algorithm: string;
  /** Base64-encoded signature bytes. */
  value: string;
  /** Identity of the signer (e.g. 'kb-labs-platform'). */
  signer: string;
  /** ISO timestamp of when the signature was created. */
  signedAt: string;
  /** Checks the entity passed (e.g. ['integrity', 'types', 'lint', 'tests']). */
  verifiedChecks: string[];
}

export const STORE_ENTRY_SCHEMA = 'kb.store-entry/1' as const;

/**
 * `entries/<key>/entry.json` — written last during install, so its presence
 * means the entry is complete (ADR-0048 D2). Never modified after the rename
 * that publishes the entry.
 */
export interface StoreEntry {
  schema: typeof STORE_ENTRY_SCHEMA;
  name: string;
  version: string;
  kind: StoreEntryKind;
  /** Integrity of the installed tarball (from the registry/lockfile when available). */
  integrity: string;
  /** SDK contract range this version declares (ADR-0048 D6). Optional until 7.4 enforces it. */
  sdkApiVersion?: string;
  /** Static `dist/manifest.json` projection, read without executing plugin code. Absent when none was found. */
  manifest?: ManifestV3;
  /** Optional platform signature, verified at install. */
  signature?: StoreEntrySignature;
  /** ISO timestamp of installation. */
  installedAt: string;
}

/** Identifies one store entry: an exact package name and version. */
export interface StoreEntryRef {
  name: string;
  version: string;
}

/** A resolved entry, ready to be loaded by the caller. */
export interface ResolvedStoreEntry {
  entry: StoreEntry;
  /** Absolute, realpath'd root of the installed package (`entries/<key>/node_modules/<name>`). */
  packageRoot: string;
  /** Absolute path of the entry directory (`entries/<key>`). */
  entryDir: string;
}

export interface InstallPackageRequest extends StoreEntryRef {
  kind: StoreEntryKind;
  /**
   * Dependency spec written into the synthetic install project (defaults to the
   * exact `version`, i.e. a registry install). Tests and local-tarball installs
   * may pass `file:`/`link:` specs; the store still keys the entry by `name`+`version`.
   */
  spec?: string;
  /**
   * Expected integrity to verify the resolved entry against (a project's pin).
   * When the entry already exists in the store, its `integrity` must match this
   * value or resolution fails with `KB_PLUGIN_INTEGRITY_MISMATCH`.
   */
  expectedIntegrity?: string;
}

export interface PackageInstallResult {
  /** Integrity string for the installed package (`sha512-...` from the registry, `sha256-...` fallback for non-registry specs). */
  integrity: string;
  /** Absolute, realpath'd root of the installed package inside `projectDir/node_modules/<name>`. */
  packageRoot: string;
}

export interface PackageInstallOptions {
  name: string;
  version: string;
  /** Dependency spec written into the synthetic project's `package.json` (defaults to the exact version). */
  spec?: string;
  /** Registry integrity for a direct tarball URL. The installer verifies these bytes before installation. */
  expectedIntegrity?: string;
  /** Directory of the synthetic pnpm project the package is installed into. */
  projectDir: string;
  /** Dedicated pnpm content-addressed store directory (never the user's default store). */
  casDir: string;
  /** Installed platform root used to resolve release artifacts under `.kb/`. */
  platformRoot?: string;
}

/**
 * Installs one package into a synthetic single-dependency pnpm project.
 * The only implementation shipped here calls `pnpm`; tests may substitute a
 * fake to avoid spawning a real package manager.
 */
export interface PackageInstaller {
  install(options: PackageInstallOptions): Promise<PackageInstallResult>;
}
