/**
 * @module @kb-labs/core-discovery/marketplace-lock
 * Read / write / validate .kb/marketplace.lock
 */

import { fs } from './recording-filesystem.js';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
const DISCOVERY_MARKETPLACE_LOCK = path.join('.kb', 'marketplace.lock');
import type {
  EntityKind, EntitySignature, MarketplaceLock, MarketplaceEntry,
  MarketplaceAdapterEntry, UserOwnedLinkPath, InstallOwnedRelativePath,
} from '@kb-labs/plugin-contracts';
import { DiagnosticCollector } from './diagnostics.js';

const SCHEMA_VERSION = 'kb.marketplace/3' as const;

export type MarketplaceLockScope = 'project' | 'platform';

export class MarketplaceLockValidationError extends Error {
  readonly code = 'LOCK_SCHEMA_INVALID' as const;
  readonly remediation = 'Run "kb marketplace sync" to regenerate .kb/marketplace.lock in schema v3.';

  constructor(message: string, readonly pluginId?: string) {
    super(message);
    this.name = 'MarketplaceLockValidationError';
  }
}

export type MarketplaceLockValidationReasonCode = 'invalid-lock' | 'marketplace-provenance-required';

export type MarketplaceLockValidationResult =
  | { valid: true; lock: MarketplaceLock }
  | { valid: false; entry?: string; reasonCode: MarketplaceLockValidationReasonCode; reason: string };

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Load the marketplace lock file from the given workspace root.
 * Returns null if the file does not exist or is invalid.
 */
export async function readMarketplaceLock(
  root: string,
  diag: DiagnosticCollector,
  scope: MarketplaceLockScope = 'platform',
): Promise<MarketplaceLock | null> {
  const lockPath = path.join(root, DISCOVERY_MARKETPLACE_LOCK);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      diag.info('LOCK_NOT_FOUND', `No marketplace lock file found at ${lockPath}`, {
        filePath: lockPath,
        remediation: 'Run "kb marketplace install <package>" to create one',
      });
      return null;
    }
    diag.error('LOCK_PARSE_ERROR', `Failed to read ${lockPath}: ${(err as Error).message}`, {
      filePath: lockPath,
    });
    return null;
  }
  const raw = bytes.toString('utf-8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    diag.error('LOCK_PARSE_ERROR', `Invalid JSON in ${lockPath}: ${(err as Error).message}`, {
      filePath: lockPath,
      remediation: 'Fix or regenerate the lock file',
    });
    return null;
  }

  const validation = validateMarketplaceLock(parsed, scope);
  if (!validation.valid) {
    const isV2 = typeof parsed === 'object' && parsed !== null && 'schema' in parsed && parsed.schema === 'kb.marketplace/2';
    const needsProvenance = validation.reasonCode === 'marketplace-provenance-required';
    const code = needsProvenance ? 'MARKETPLACE_PROVENANCE_REQUIRED' : 'LOCK_SCHEMA_INVALID';
    diag.error(code, isV2
      ? 'Lock file uses kb.marketplace/2 and cannot be read by this version.'
      : needsProvenance
        ? `Marketplace lock entry "${validation.entry ?? 'unknown'}" does not record source provenance.`
      : validation.entry
        ? `Invalid marketplace lock entry "${validation.entry}": ${validation.reason}`
        : validation.reason, {
      ...(validation.entry ? { pluginId: validation.entry } : {}),
      filePath: lockPath,
      ...(needsProvenance && validation.entry
        ? { remediation: `Run "kb marketplace install ${validation.entry} --scope ${scope}" to record Marketplace provenance.` }
        : { remediation: 'Run "kb marketplace sync" to regenerate .kb/marketplace.lock in schema v3.' }),
    });
    return null;
  }

  return validation.lock;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write the marketplace lock file atomically (tmp → rename).
 */
export async function writeMarketplaceLock(
  root: string,
  lock: MarketplaceLock,
  scope: MarketplaceLockScope = 'platform',
): Promise<void> {
  const lockPath = path.join(root, DISCOVERY_MARKETPLACE_LOCK);
  const serialized = {
    schema: SCHEMA_VERSION,
    plugins: Object.fromEntries(Object.entries(lock.plugins).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, entry]) => [id,
      entry.source === 'local'
        ? { link: entry.link, enabled: entry.enabled ?? true, source: entry.source }
        : entry.source === 'platform'
          ? { version: entry.version, integrity: entry.integrity, package: entry.package, resolvedPath: entry.resolvedPath, enabled: entry.enabled ?? true, source: entry.source }
          : {
            version: entry.version,
            integrity: entry.integrity,
            package: entry.package,
            ...(entry.resolvedPath && !entry.resolvedPath.startsWith('store:') ? { resolvedPath: entry.resolvedPath } : {}),
            enabled: entry.enabled ?? true,
            source: entry.source,
            ...(entry.primaryKind ? { primaryKind: entry.primaryKind } : {}),
            ...(entry.provides ? { provides: entry.provides } : {}),
            marketplaceSource: entry.marketplaceSource,
            signatureStatus: entry.signatureStatus,
            ...(entry.signature ? { signature: entry.signature } : {}),
            ...(entry.trust ? { trust: entry.trust } : {}),
          },
    ])),
    ...(lock.adapters && Object.keys(lock.adapters).length > 0 ? {
      adapters: Object.fromEntries(Object.entries(lock.adapters).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, entry]) => [id, {
        version: entry.version,
        integrity: entry.integrity,
        resolvedPath: entry.resolvedPath,
        enabled: entry.enabled ?? true,
        source: entry.source,
        ...(entry.source === 'marketplace' ? { marketplaceSource: entry.marketplaceSource, signatureStatus: entry.signatureStatus } : {}),
      }]))
    } : {})
  };

  const validation = validateMarketplaceLock(serialized, scope);
  if (!validation.valid) {
    const message = validation.entry
      ? `Marketplace lock entry "${validation.entry}" is invalid: ${validation.reason}`
      : `Marketplace lock is invalid: ${validation.reason}`;
    throw new MarketplaceLockValidationError(message, validation.entry);
  }

  const dir = path.dirname(lockPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${lockPath}.tmp.${randomUUID()}`;
  const content = JSON.stringify(serialized, null, 2) + '\n';

  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, lockPath);
}

// ---------------------------------------------------------------------------
// Mutate
// ---------------------------------------------------------------------------

/**
 * Add or update an entry in the marketplace lock.
 * Preserves the existing `enabled` flag when the entry already exists —
 * re-installing a disabled package must not silently re-enable it.
 */
export async function addToMarketplaceLock(
  root: string,
  packageId: string,
  entry: MarketplaceEntry,
  scope: MarketplaceLockScope = 'platform',
): Promise<MarketplaceLock> {
  const diag = new DiagnosticCollector();
  const existing = await readMarketplaceLock(root, diag, scope) ?? createEmptyLock();
  if (entry.primaryKind === 'adapter') {
    if (!entry.resolvedPath) {
      throw new MarketplaceLockValidationError(`Marketplace adapter "${packageId}" requires a resolved installation path.`, packageId);
    }
    const existingEntry = existing.adapters?.[packageId];
    const adapterEntry: MarketplaceAdapterEntry = entry.source === 'marketplace' ? {
      source: 'marketplace',
      version: entry.version,
      integrity: entry.integrity,
      resolvedPath: entry.resolvedPath,
      enabled: existingEntry?.enabled ?? entry.enabled ?? true,
      marketplaceSource: entry.marketplaceSource,
      signatureStatus: entry.signatureStatus,
    } : {
      source: 'platform', version: entry.version, integrity: entry.integrity,
      resolvedPath: entry.resolvedPath, enabled: existingEntry?.enabled ?? entry.enabled ?? true,
    };
    (existing.adapters ??= {})[packageId] = adapterEntry;
  } else {
    const existingEntry = existing.plugins[packageId];
    existing.plugins[packageId] = {
      ...entry,
      // Preserve the existing enabled state; re-install must not override
      // a user's explicit disable.
      enabled: existingEntry?.enabled ?? entry.enabled,
    };
  }
  await writeMarketplaceLock(root, existing, scope);
  return existing;
}

/**
 * Remove an entry from the marketplace lock.
 * Returns true if the entry existed and was removed.
 */
export async function removeFromMarketplaceLock(
  root: string,
  packageId: string,
  scope: MarketplaceLockScope = 'platform',
): Promise<boolean> {
  const diag = new DiagnosticCollector();
  const existing = await readMarketplaceLock(root, diag, scope);
  if (!existing || (!(packageId in existing.plugins) && !(packageId in (existing.adapters ?? {})))) {
    return false;
  }
  delete existing.plugins[packageId];
  if (existing.adapters) {delete existing.adapters[packageId];}
  await writeMarketplaceLock(root, existing, scope);
  return true;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an empty marketplace lock */
export function createEmptyLock(): MarketplaceLock {
  return { schema: SCHEMA_VERSION, plugins: {} };
}

/** Create a marketplace entry */
export function createMarketplaceEntry(opts: {
  version: string;
  integrity: string;
  primaryKind: EntityKind;
  provides: EntityKind[];
  signature?: EntitySignature;
  trust?: 'trusted' | 'untrusted';
} & (
  | { source: 'marketplace'; package: string; resolvedPath?: string; marketplaceSource: 'registry' | 'npm'; signatureStatus: 'verified' | 'unsigned' }
  | { source: 'platform'; package: string; resolvedPath: string }
  | { source: 'local'; package?: never; resolvedPath: string }
)): MarketplaceEntry {
  const metadata = {
    primaryKind: opts.primaryKind,
    provides: opts.provides,
    enabled: true,
    signature: opts.signature,
    trust: opts.trust ?? 'untrusted',
  };
  if (opts.source === 'local') {
    return { ...metadata, source: 'local', version: opts.version, integrity: opts.integrity, link: toUserOwnedLinkPath(opts.resolvedPath) };
  }
  if (opts.source === 'marketplace') {
    return { ...metadata, source: 'marketplace', version: opts.version, integrity: opts.integrity, package: opts.package, resolvedPath: opts.resolvedPath === undefined ? undefined : toInstallOwnedRelativePath(opts.resolvedPath), marketplaceSource: opts.marketplaceSource, signatureStatus: opts.signatureStatus };
  }
  return { ...metadata, source: 'platform', version: opts.version, integrity: opts.integrity, package: opts.package, resolvedPath: toInstallOwnedRelativePath(opts.resolvedPath) };
}

// ---------------------------------------------------------------------------
// Enable / Disable
// ---------------------------------------------------------------------------

/**
 * Set `enabled` on an entry in the marketplace lock.
 * Returns false if the package is not found in the lock.
 */
async function setPluginEnabled(
  root: string,
  packageId: string,
  enabled: boolean,
  scope: MarketplaceLockScope,
): Promise<boolean> {
  const diag = new DiagnosticCollector();
  const existing = await readMarketplaceLock(root, diag, scope);
  if (!existing || (!(packageId in existing.plugins) && !(packageId in (existing.adapters ?? {})))) {
    return false;
  }
  const entry = existing.plugins[packageId] ?? existing.adapters?.[packageId];
  if (entry) {entry.enabled = enabled;}
  await writeMarketplaceLock(root, existing, scope);
  return true;
}

/**
 * Mark a plugin as enabled in the marketplace lock.
 * Returns false if the package is not installed.
 */
export async function enablePlugin(root: string, packageId: string, scope: MarketplaceLockScope = 'platform'): Promise<boolean> {
  return setPluginEnabled(root, packageId, true, scope);
}

/**
 * Mark a plugin as disabled in the marketplace lock.
 * Returns false if the package is not installed.
 */
export async function disablePlugin(root: string, packageId: string, scope: MarketplaceLockScope = 'platform'): Promise<boolean> {
  return setPluginEnabled(root, packageId, false, scope);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate the lock against its resolved owner scope. Call
 * `resolveMarketplaceLockScope` when selecting scope from runtime roots; a
 * development lock shared by platform and project roles is platform-owned.
 */
export function validateMarketplaceLock(value: unknown, scope: MarketplaceLockScope): MarketplaceLockValidationResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {return invalidLock('lock must be an object');}
  const obj = value as Record<string, unknown>;
  const unknownKey = Object.keys(obj).find((key) => !['schema', 'plugins', 'adapters'].includes(key));
  if (unknownKey) {return invalidLock(`unknown lock field "${unknownKey}"`);}
  if (obj.schema !== SCHEMA_VERSION) {return invalidLock(`lock schema must be ${SCHEMA_VERSION}`);}
  if (scope === 'project' && Object.hasOwn(obj, 'adapters')) {return invalidLock('project lock must not contain adapters');}
  if (typeof obj.plugins !== 'object' || obj.plugins === null || Array.isArray(obj.plugins)) {return invalidLock('plugins must be an object');}
  if (obj.adapters !== undefined && (typeof obj.adapters !== 'object' || obj.adapters === null || Array.isArray(obj.adapters))) {return invalidLock('adapters must be an object');}
  for (const [id, raw] of Object.entries(obj.plugins)) {
    const failure = pluginEntryError(id, raw, scope);
    if (failure) {return { ...failure, entry: id };}
  }
  for (const [id, raw] of Object.entries((obj.adapters ?? {}) as Record<string, unknown>)) {
    const failure = adapterEntryError(id, raw);
    if (failure) {return { ...failure, entry: id };}
  }
  return { valid: true, lock: value as MarketplaceLock };
}

type LockValidationFailure = { valid: false; reasonCode: MarketplaceLockValidationReasonCode; reason: string };

function invalidLock(reason: string): LockValidationFailure {
  return { valid: false, reasonCode: 'invalid-lock', reason };
}

function missingProvenance(reason: string): LockValidationFailure {
  return { valid: false, reasonCode: 'marketplace-provenance-required', reason };
}

function pluginEntryError(id: string, raw: unknown, scope: MarketplaceLockScope): LockValidationFailure | undefined {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(id)) {return invalidLock('entry ID must be a package name');}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {return invalidLock('entry must be an object');}
  const entry = raw as Record<string, unknown>;
  if (typeof entry.enabled !== 'boolean') {return invalidLock('enabled must be a boolean');}
  if (!['marketplace', 'local', 'platform'].includes(String(entry.source))) {return invalidLock('source must be marketplace, local, or platform');}
  if (entry.source === 'marketplace' && entry.marketplaceSource === undefined) {return missingProvenance('marketplaceSource is required');}
  if (entry.source === 'marketplace' && !['registry', 'npm'].includes(String(entry.marketplaceSource))) {return invalidLock('marketplaceSource must be registry or npm');}
  if (entry.source === 'marketplace' && entry.signatureStatus === undefined) {return missingProvenance('signatureStatus is required');}
  if (entry.source === 'marketplace' && !['verified', 'unsigned'].includes(String(entry.signatureStatus))) {return invalidLock('signatureStatus must be verified or unsigned');}
  if (scope === 'project' && !['marketplace', 'local'].includes(String(entry.source))) {return invalidLock('source must be marketplace or local in project locks');}
  const allowed = entry.source === 'marketplace' ? ['version', 'integrity', 'package', 'resolvedPath', 'enabled', 'source', 'marketplaceSource', 'signatureStatus', 'signature', 'trust', 'primaryKind', 'provides']
    : entry.source === 'local' ? ['link', 'enabled', 'source']
      : ['version', 'integrity', 'package', 'resolvedPath', 'enabled', 'source'];
  const unknownKey = Object.keys(entry).find((key) => !allowed.includes(key));
  if (unknownKey) {return invalidLock(`field "${unknownKey}" is not allowed for ${entry.source} entries`);}
  if (entry.source === 'local') {
    return isUserOwnedLinkPath(entry.link) ? undefined : invalidLock('link must be a non-empty path');
  }
  if (typeof entry.version !== 'string') {return invalidLock('version must be a string');}
  if (!validIntegrity(entry.integrity)) {return invalidLock('integrity must be a valid sha256 or sha512 SRI value');}
  if (typeof entry.package !== 'string' || !VALID_PACKAGE.test(entry.package)) {return invalidLock('package must be a valid npm package name');}
  if (entry.source === 'platform' && typeof entry.resolvedPath !== 'string') {return invalidLock('resolvedPath must be a string');}
  if (entry.resolvedPath !== undefined && (typeof entry.resolvedPath !== 'string' || !isPortableRelativePath(entry.resolvedPath))) {return invalidLock('resolvedPath must be a relative path');}
  return undefined;
}

function adapterEntryError(id: string, raw: unknown): LockValidationFailure | undefined {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(id)) {return invalidLock('entry ID must be a package name');}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {return invalidLock('entry must be an object');}
  const entry = raw as Record<string, unknown>;
  const allowed = entry.source === 'marketplace'
    ? ['version', 'integrity', 'resolvedPath', 'enabled', 'source', 'marketplaceSource', 'signatureStatus']
    : ['version', 'integrity', 'resolvedPath', 'enabled', 'source'];
  const unknownKey = Object.keys(entry).find((key) => !allowed.includes(key));
  if (unknownKey) {return invalidLock(`field "${unknownKey}" is not allowed for adapter entries`);}
  if (!['platform', 'marketplace'].includes(String(entry.source))) {return invalidLock('source must be platform or marketplace');}
  if (entry.source === 'marketplace' && entry.marketplaceSource === undefined) {return missingProvenance('marketplaceSource is required');}
  if (entry.source === 'marketplace' && !['registry', 'npm'].includes(String(entry.marketplaceSource))) {return invalidLock('marketplaceSource must be registry or npm');}
  if (entry.source === 'marketplace' && entry.signatureStatus === undefined) {return missingProvenance('signatureStatus is required');}
  if (entry.source === 'marketplace' && !['verified', 'unsigned'].includes(String(entry.signatureStatus))) {return invalidLock('signatureStatus must be verified or unsigned');}
  if (typeof entry.version !== 'string') {return invalidLock('version must be a string');}
  if (!validIntegrity(entry.integrity)) {return invalidLock('integrity must be a valid sha256 or sha512 SRI value');}
  if (typeof entry.resolvedPath !== 'string' || !isPortableRelativePath(entry.resolvedPath)) {return invalidLock('resolvedPath must be a relative path');}
  if (typeof entry.enabled !== 'boolean') {return invalidLock('enabled must be a boolean');}
  return undefined;
}

export function isUserOwnedLinkPath(value: unknown): value is UserOwnedLinkPath {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

export function isPortableRelativePath(value: string, scopeRoot?: string): value is InstallOwnedRelativePath {
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value) || path.win32.parse(value).root !== '') {return false;}
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {return false;}
  if (scopeRoot !== undefined) {
    const resolvedRoot = path.resolve(scopeRoot);
    const resolvedPath = path.resolve(resolvedRoot, ...normalized.split('/'));
    const relativePath = path.relative(resolvedRoot, resolvedPath);
    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {return false;}
  }
  return true;
}

/** Parse an install-owned relative path and optionally assert its lock scope. */
export function createInstallOwnedRelativePath(value: string, scopeRoot?: string): InstallOwnedRelativePath {
  if (!isPortableRelativePath(value, scopeRoot)) {throw new MarketplaceLockValidationError('Installed lock paths must be relative and remain within their scope root.');}
  return value;
}

function toInstallOwnedRelativePath(value: string): InstallOwnedRelativePath {
  return createInstallOwnedRelativePath(value);
}

function toUserOwnedLinkPath(value: string): UserOwnedLinkPath {
  if (!isUserOwnedLinkPath(value)) {throw new MarketplaceLockValidationError('Local link entries require a non-empty path.');}
  return value;
}

function validIntegrity(value: unknown): value is string {
  return typeof value === 'string' && /^sha(256|512)-[A-Za-z0-9+/=]+$/.test(value);
}

const VALID_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
