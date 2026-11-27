/**
 * RegistryService — stores and retrieves packages using platform.storage + platform.cache.
 * No direct filesystem or DB dependencies — swap adapters in kb.config.json.
 */

import { createHash, sign as cryptoSign } from 'node:crypto';
import semver from 'semver';
import type { IStorage, ICache, ILogger } from '@kb-labs/core-platform';
import type {
  RegistryEntry,
  RegistryVersionEntry,
  PackageMeta,
  PublishRequest,
  PublishResponse,
  RegistryPackageSummary,
  PackageStats,
  ShareToken,
  RegistryIdentityResolution,
} from '@kb-labs/marketplace-registry-contracts';
import type { EntitySignature } from '@kb-labs/plugin-contracts';

const STORAGE_PREFIX = 'marketplace-registry';
const CACHE_TTL_META = 5 * 60 * 1000;
const CACHE_TTL_SEARCH = 60 * 1000;
const CACHE_TTL_SHARE_DEFAULT = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_TARBALL_SIZE = 50 * 1024 * 1024; // 50 MB
const SHARE_TOKEN_PATTERN = /^kbrt_[a-f0-9]{32}$/;
const SHARE_TOKEN_DIGEST_PREFIX = 'sha256:';
const MAX_PACKAGE_CACHE_ALIASES = 4096;
const CANONICAL_AUTHOR_HANDLE = /^[a-z0-9-]{2,32}$/;
const CANONICAL_PACKAGE_PART = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_LEGACY_PATH_PART = /^[A-Za-z0-9._-]+$/;
const SEMVER_IDENTIFIER = '(?:0|[1-9]\\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_VERSION = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);

function shortIdentity(identity: string): string {
  return identity.slice(identity.lastIndexOf('/') + 1);
}

function canonicalIdentityNamespace(identity: string): string | undefined {
  const separator = identity.indexOf('/');
  if (!identity.startsWith('@') || separator <= 1 || separator === identity.length - 1) { return undefined; }
  return identity.slice(0, separator);
}

function identityHandle(identity: string): string | undefined {
  const separator = identity.indexOf('/');
  if (identity.startsWith('@') || separator <= 0 || separator === identity.length - 1) { return undefined; }
  return identity.slice(0, separator);
}

function rejectPublishAddress(field: string): never {
  throw Object.assign(new Error(`Registry publish has an invalid ${field}`), { code: 'INVALID_MANIFEST' });
}

function isSafeLegacyHandle(handle: string): boolean {
  return SAFE_LEGACY_PATH_PART.test(handle) && handle !== '.' && handle !== '..';
}

function isSafeLegacyPackageName(name: string): boolean {
  if (name.includes('\\') || name.includes('%') || name.includes('\0')) { return false; }
  const parts = name.startsWith('@') ? name.slice(1).split('/') : name.split('/');
  if (parts.length !== (name.startsWith('@') ? 2 : 1)) { return false; }
  return parts.every(part => SAFE_LEGACY_PATH_PART.test(part) && part !== '.' && part !== '..');
}

function isCanonicalPackageName(name: string): boolean {
  const scoped = name.startsWith('@');
  const parts = scoped ? name.slice(1).split('/') : name.split('/');
  if (parts.length !== (scoped ? 2 : 1)) { return false; }
  return parts.every(part => CANONICAL_PACKAGE_PART.test(part));
}

function validatePublishAddress(handle: string, name: string, version: string): void {
  if (typeof handle !== 'string' || !isSafeLegacyHandle(handle)) { rejectPublishAddress('author handle'); }
  if (typeof name !== 'string' || !isSafeLegacyPackageName(name)) { rejectPublishAddress('package name'); }
  if (typeof version !== 'string' || !SEMVER_VERSION.test(version) || !semver.valid(version, { loose: false })) {
    rejectPublishAddress('SemVer version');
  }
}

export interface RegistryServiceOptions {
  storage: IStorage;
  cache: ICache;
  logger: ILogger;
  /** Base URL of the registry (for share links and pageUrl in responses) */
  baseUrl: string;
  /** Ed25519 private key (PEM) for signing public packages. Absent = no signing. */
  signingPrivateKey?: string;
  /** Site URL for marketplace pages (e.g. https://kblabs.ru) */
  siteUrl?: string;
}

export class RegistryService {
  private readonly storage: IStorage;
  private readonly cache: ICache;
  private readonly log: ILogger;
  private readonly baseUrl: string;
  private readonly signingPrivateKey?: string;
  private readonly siteUrl?: string;
  private readonly publishTails = new Map<string, Promise<void>>();
  private readonly packageCacheKeys = new Map<string, string>();

  constructor(opts: RegistryServiceOptions) {
    this.storage = opts.storage;
    this.cache = opts.cache;
    this.log = opts.logger;
    this.baseUrl = opts.baseUrl;
    this.signingPrivateKey = opts.signingPrivateKey;
    this.siteUrl = opts.siteUrl;
  }

  // ── Publish ────────────────────────────────────────────────────────────────

  async publish(
    tarball: Buffer,
    req: PublishRequest,
    authorHandle: string,
    authorNamespaceId: string,
  ): Promise<PublishResponse> {
    const { name, version } = req?.meta ?? {};
    validatePublishAddress(authorHandle, name, version);
    const existing = await this.loadEntry(authorHandle, name);
    if (!existing && (!CANONICAL_AUTHOR_HANDLE.test(authorHandle) || !isCanonicalPackageName(name))) {
      rejectPublishAddress(!CANONICAL_AUTHOR_HANDLE.test(authorHandle) ? 'author handle' : 'package name');
    }
    // Safe publish path segments are ASCII, so folding case here makes the
    // in-process queue match storage identity on case-insensitive filesystems.
    const key = `${authorHandle}/${name}`.toLowerCase();
    const previous = this.publishTails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    const queuedTail = previous.then(() => tail);
    this.publishTails.set(key, queuedTail);

    await previous;
    try {
      return await this.publishVersion(tarball, req, authorHandle, authorNamespaceId);
    } finally {
      release();
      if (this.publishTails.get(key) === queuedTail) {
        this.publishTails.delete(key);
      }
    }
  }

  private async publishVersion(
    tarball: Buffer,
    req: PublishRequest,
    authorHandle: string,
    authorNamespaceId: string,
  ): Promise<PublishResponse> {
    const { meta, visibility, primaryKind } = req;
    const { name, version } = meta;

    if (tarball.length > MAX_TARBALL_SIZE) {
      throw Object.assign(new Error('Tarball exceeds 50 MB limit'), { code: 'TARBALL_TOO_LARGE' });
    }

    const existing = await this.loadEntry(authorHandle, name);

    if (existing) {
      if (existing.authorNamespaceId !== authorNamespaceId) {
        throw Object.assign(
          new Error(`Namespace ${authorNamespaceId} does not own ${authorHandle}/${name}`),
          { code: 'FORBIDDEN' },
        );
      }
      if (existing.versions.some(v => v.version === version)) {
        throw Object.assign(
          new Error(`Version ${version} already exists. Versions are immutable.`),
          { code: 'VERSION_ALREADY_EXISTS' },
        );
      }
    }

    const integrity = `sha256-${createHash('sha256').update(tarball).digest('base64')}`;
    const tarballPath = this.tarballPath(authorHandle, name, version);
    await this.storage.write(tarballPath, tarball);

    let signature: EntitySignature | undefined;
    if (this.signingPrivateKey) {
      signature = this.signTarball(
        tarball,
        integrity,
        existing?.authorHandle ?? authorHandle,
        existing?.name ?? name,
        version,
      );
      const sigPath = this.sigPath(authorHandle, name, version);
      await this.storage.write(sigPath, Buffer.from(JSON.stringify(signature)));
    }

    const versionEntry: RegistryVersionEntry = {
      version,
      publishedAt: new Date().toISOString(),
      integrity,
      visibility,
      meta,
      primaryKind,
      signature,
    };

    const now = new Date().toISOString();
    const previousVersions = existing?.versions.map(version => ({
      ...version,
      visibility: version.visibility ?? 'private',
      meta: version.meta ?? existing.meta,
      primaryKind: version.primaryKind ?? existing.primaryKind,
    })) ?? [];
    const entry: RegistryEntry = existing
      ? {
          ...existing,
          visibility,
          legacyStatsVisibility: 'private',
          primaryKind,
          trust: visibility === 'public' && signature ? 'trusted' : existing.trust,
          versions: [...previousVersions, versionEntry],
          meta,
          updatedAt: now,
        }
      : {
          name,
          authorHandle,
          authorNamespaceId,
          primaryKind,
          visibility,
          legacyStatsVisibility: visibility,
          trust: visibility === 'public' && signature ? 'trusted' : 'untrusted',
          allowlist: [],
          versions: [versionEntry],
          deprecated: false,
          featured: false,
          badges: [],
          tags: meta.keywords ?? [],
          meta,
          createdAt: now,
          updatedAt: now,
        };

    await this.saveEntry(authorHandle, name, entry);
    await this.invalidateCaches(existing?.authorHandle ?? authorHandle, existing?.name ?? name);

    if (visibility === 'public') {
      await this.rebuildIndex();
    }

    const fullName = `${authorHandle}/${name}`;
    return {
      handle: authorHandle,
      name,
      version,
      visibility,
      trust: entry.trust,
      signature,
      installCommand: `kb marketplace install ${entry.meta.identity}`,
      pageUrl: this.siteUrl ? `${this.siteUrl}/ru/marketplace/${fullName}` : undefined,
    };
  }

  // ── Update metadata only ───────────────────────────────────────────────────

  async updateMeta(authorHandle: string, name: string, meta: Partial<PackageMeta>): Promise<void> {
    const entry = await this.requireEntry(authorHandle, name);
    const updatedMeta = { ...entry.meta, ...meta };
    const versions = entry.versions.map(version => ({
      ...version,
      visibility: version.visibility ?? 'private',
      meta: version.meta ?? entry.meta,
      primaryKind: version.primaryKind ?? entry.primaryKind,
    }));
    const latestIndex = versions.length - 1;
    if (latestIndex >= 0) { versions[latestIndex] = { ...versions[latestIndex]!, meta: updatedMeta }; }
    const updated: RegistryEntry = {
      ...entry,
      meta: updatedMeta,
      versions,
      updatedAt: new Date().toISOString(),
    };
    await this.saveEntry(authorHandle, name, updated);
    await this.invalidateCaches(entry.authorHandle, entry.name);
    if (entry.visibility === 'public') { await this.rebuildIndex(); }
  }

  // ── Yank version ──────────────────────────────────────────────────────────

  async yank(authorHandle: string, name: string, version: string, reason?: string): Promise<void> {
    const entry = await this.requireEntry(authorHandle, name);
    const versions = entry.versions.map(v =>
      v.version === version ? { ...v, yanked: true, yankReason: reason } : v,
    );
    if (versions.every((v, i) => v === entry.versions[i])) {
      throw Object.assign(new Error(`Version ${version} not found`), { code: 'VERSION_NOT_FOUND' });
    }
    await this.saveEntry(authorHandle, name, { ...entry, versions, updatedAt: new Date().toISOString() });
    await this.invalidateCaches(entry.authorHandle, entry.name);
  }

  // ── Deprecate package ─────────────────────────────────────────────────────

  async deprecate(authorHandle: string, name: string, message?: string): Promise<void> {
    const entry = await this.requireEntry(authorHandle, name);
    await this.saveEntry(authorHandle, name, {
      ...entry,
      deprecated: true,
      deprecateMessage: message,
      updatedAt: new Date().toISOString(),
    });
    await this.invalidateCaches(entry.authorHandle, entry.name);
    if (entry.visibility === 'public') { await this.rebuildIndex(); }
  }

  // ── Share ──────────────────────────────────────────────────────────────────

  async addToAllowlist(authorHandle: string, name: string, namespaceId: string): Promise<void> {
    const entry = await this.requireEntry(authorHandle, name);
    if (entry.allowlist.includes(namespaceId)) { return; }
    await this.saveEntry(authorHandle, name, {
      ...entry,
      allowlist: [...entry.allowlist, namespaceId],
      updatedAt: new Date().toISOString(),
    });
    await this.invalidateCaches(entry.authorHandle, entry.name);
  }

  async createShareToken(
    authorHandle: string,
    name: string,
    ttlMs: number = CACHE_TTL_SHARE_DEFAULT,
  ): Promise<ShareToken> {
    await this.requireEntry(authorHandle, name);
    const token = `kbrt_${createHash('sha256').update(`${Date.now()}${Math.random()}`).digest('hex').slice(0, 32)}`;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const pkg = `${authorHandle}/${name}`;
    await this.cache.set(shareTokenCacheKey(token), { pkg, expiresAt }, ttlMs);
    return { token, pkg, expiresAt };
  }

  async resolveShareToken(token: string): Promise<{ pkg: string } | null> {
    // Only tokens issued by this Registry are valid credentials. In particular,
    // never let a digest namespace value reach the legacy-key fallback: the
    // State Broker treats digest keys as safe path keys, while legacy bearer
    // values must stay in request bodies.
    if (typeof token !== 'string' || token.startsWith(SHARE_TOKEN_DIGEST_PREFIX) || !SHARE_TOKEN_PATTERN.test(token)) {
      return null;
    }

    const cacheKey = shareTokenCacheKey(token);
    const current = await this.cache.get<{ pkg: string; expiresAt: string }>(cacheKey);
    if (current) { return current; }

    // Tokens issued before digest-key storage used the credential in the cache
    // key. Read the legacy entry without moving it: separate get/set/delete
    // calls can race concurrent lookups or revocation and restore a deleted
    // token. The old entry expires under its original TTL.
    const legacyKey = `registry:sharetoken:${token}`;
    const legacy = await this.cache.get<{ pkg: string; expiresAt: string }>(legacyKey);
    if (!legacy) { return null; }
    const expiresAt = Date.parse(legacy.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? legacy : null;
  }

  // ── Download ───────────────────────────────────────────────────────────────

  async getTarball(
    authorHandle: string,
    name: string,
    version: string,
  ): Promise<{ tarball: Buffer; signature?: EntitySignature }> {
    const entry = await this.requireEntry(authorHandle, name);
    const vEntry = entry.versions.find(v => v.version === version);
    if (!vEntry) {
      throw Object.assign(new Error(`Version ${version} not found`), { code: 'VERSION_NOT_FOUND' });
    }
    if (vEntry.yanked) {
      throw Object.assign(new Error(`Version ${version} has been yanked`), { code: 'VERSION_YANKED' });
    }

    const tarball = await this.storage.read(this.tarballPath(authorHandle, name, version))
      ?? await this.readPreviousHexTarball(authorHandle, name, version)
      ?? await this.storage.read(this.legacyTarballPath(authorHandle, name, version));
    if (!tarball) {
      throw Object.assign(new Error('Tarball not found in storage'), { code: 'VERSION_NOT_FOUND' });
    }
    return { tarball, signature: vEntry.signature };
  }

  // ── Access check ──────────────────────────────────────────────────────────

  canAccess(
    entry: RegistryEntry,
    callerNamespaceId: string | null,
    shareToken?: { pkg: string } | null,
    version?: string,
  ): boolean {
    if (version !== undefined) {
      const versionEntry = entry.versions.find(candidate => candidate.version === version);
      if (!versionEntry) { return false; }
      if ((versionEntry.visibility ?? 'private') === 'public') { return true; }
      return this.canAccessPrivate(entry, callerNamespaceId, shareToken);
    }
    if (entry.versions.some(candidate => (candidate.visibility ?? 'private') === 'public')) { return true; }
    if (entry.versions.length === 0 && entry.visibility === 'public') { return true; }
    return this.canAccessPrivate(entry, callerNamespaceId, shareToken);
  }

  private canAccessPrivate(entry: RegistryEntry, callerNamespaceId: string | null, shareToken?: { pkg: string } | null): boolean {
    if (!callerNamespaceId) {
      return !!shareToken && shareToken.pkg === `${entry.authorHandle}/${entry.name}`;
    }
    if (entry.authorNamespaceId === callerNamespaceId) { return true; }
    if (entry.allowlist.includes(callerNamespaceId)) { return true; }
    return !!shareToken && shareToken.pkg === `${entry.authorHandle}/${entry.name}`;
  }

  getVisibleEntry(
    entry: RegistryEntry,
    callerNamespaceId: string | null,
    shareToken?: { pkg: string } | null,
  ): RegistryEntry | null {
    const versions = entry.versions.filter(version => this.canAccess(entry, callerNamespaceId, shareToken, version.version));
    const latest = versions.at(-1);
    if (!latest) { return null; }
    const isOwner = callerNamespaceId === entry.authorNamespaceId;
    const meta = latest.meta ?? entry.meta;
    return {
      ...entry,
      authorNamespaceId: isOwner ? entry.authorNamespaceId : '',
      allowlist: isOwner ? entry.allowlist : [],
      legacyStatsVisibility: undefined,
      createdAt: isOwner ? entry.createdAt : versions[0]!.publishedAt,
      updatedAt: isOwner ? entry.updatedAt : latest.publishedAt,
      tags: isOwner ? entry.tags : latest.meta ? latest.meta.keywords ?? [] : entry.tags,
      visibility: latest.visibility ?? 'private',
      primaryKind: latest.primaryKind ?? entry.primaryKind,
      meta,
      versions,
    };
  }

  // ── Metadata reads ─────────────────────────────────────────────────────────

  async getEntry(authorHandle: string, name: string): Promise<RegistryEntry | null> {
    const lookupKey = `${authorHandle}/${name}`;
    const knownCacheKey = this.packageCacheKeys.get(lookupKey);
    if (knownCacheKey) {
      const cached = await this.cache.get<RegistryEntry>(knownCacheKey);
      if (cached) { return cached; }
    }

    const entry = await this.loadEntry(authorHandle, name);
    if (!entry) { return null; }
    const cacheKey = `registry:pkg:${entry.authorHandle}/${entry.name}`;
    if (!this.packageCacheKeys.has(lookupKey) && this.packageCacheKeys.size >= MAX_PACKAGE_CACHE_ALIASES) {
      const oldestLookupKey = this.packageCacheKeys.keys().next().value;
      if (oldestLookupKey) { this.packageCacheKeys.delete(oldestLookupKey); }
    }
    this.packageCacheKeys.set(lookupKey, cacheKey);
    const cached = knownCacheKey ? null : await this.cache.get<RegistryEntry>(cacheKey);
    if (cached) { return cached; }
    await this.cache.set(cacheKey, entry, CACHE_TTL_META);
    return entry;
  }

  async resolveIdentity(
    identity: string,
    callerNamespaceId: string | null = null,
    shareToken: { pkg: string } | null = null,
    requestedVersion?: string,
  ): Promise<RegistryIdentityResolution> {
    const paths = (await this.storage.list(`${STORAGE_PREFIX}/packages/`)).filter(path => path.endsWith('/meta.json'));
    const entries: RegistryEntry[] = [];
    for (const path of paths) {
      const raw = await this.storage.read(path);
      if (raw) { entries.push(JSON.parse(raw.toString()) as RegistryEntry); }
    }

    const qualifiedIdentity = identity.includes('/');
    const matchingVersions = (entry: RegistryEntry, exact: boolean) => entry.versions.filter(version => {
      if (version.yanked || (requestedVersion && version.version !== requestedVersion)) { return false; }
      const versionIdentity = version.meta?.identity ?? entry.meta.identity;
      return exact ? versionIdentity === identity : shortIdentity(versionIdentity) === identity;
    });
    const exactMatches = qualifiedIdentity ? entries.filter(entry => matchingVersions(entry, true).length > 0) : [];
    const shortMatches = entries.filter(entry => matchingVersions(entry, false).length > 0);
    const accessibleFor = (entry: RegistryEntry, exact: boolean) => matchingVersions(entry, exact)
      .filter(version => this.canAccess(entry, callerNamespaceId, shareToken, version.version));
    const accessibleExactMatches = exactMatches.filter(entry => accessibleFor(entry, true).length > 0);
    const deniedExactMatches = exactMatches.filter(entry => matchingVersions(entry, true).length > 0);
    const matches = exactMatches.length > 0
      ? accessibleExactMatches.length > 0 ? accessibleExactMatches : deniedExactMatches.slice(0, 1)
      : shortMatches.filter(entry => accessibleFor(entry, false).length > 0);
    if (!exactMatches.length && !matches.length && shortMatches.length) {
      return { status: 'not-found-owned' };
    }
    if (shareToken) {
      const tokenMatches = matches.filter(entry => `${entry.authorHandle}/${entry.name}` === shareToken.pkg);
      if (tokenMatches.length === 1) {
        return this.resolutionForEntry(tokenMatches[0]!, callerNamespaceId, shareToken, false, requestedVersion, identity, qualifiedIdentity);
      }
    }
    if (matches.length > 1) {
      throw Object.assign(new Error(`Marketplace identity ${identity} is ambiguous in the Registry.`), { code: 'IDENTITY_AMBIGUOUS' });
    }
    const entry = matches[0];
    if (entry) {
      const inaccessibleExact = exactMatches.length > 0 && accessibleExactMatches.length === 0;
      return this.resolutionForEntry(entry, callerNamespaceId, shareToken, inaccessibleExact, requestedVersion, identity, qualifiedIdentity);
    }

    const namespace = canonicalIdentityNamespace(identity);
    if (namespace && entries.some(candidate => canonicalIdentityNamespace(candidate.meta.identity) === namespace)) {
      return { status: 'not-found-owned' };
    }
    const handle = identityHandle(identity);
    if (handle && entries.some(candidate => candidate.authorHandle === handle)) {
      return { status: 'not-found-owned' };
    }
    return { status: 'not-found-unowned' };
  }

  private resolutionForEntry(
    entry: RegistryEntry,
    callerNamespaceId: string | null = null,
    shareToken: { pkg: string } | null = null,
    includeDeniedVersion = false,
    requestedVersion?: string,
    identity?: string,
    exactIdentity = false,
  ): RegistryIdentityResolution {
    const available = entry.versions.filter(version => !version.yanked && (!requestedVersion || version.version === requestedVersion) &&
      (!identity || (exactIdentity ? (version.meta?.identity ?? entry.meta.identity) === identity :
        shortIdentity(version.meta?.identity ?? entry.meta.identity) === identity)) &&
      (includeDeniedVersion || this.canAccess(entry, callerNamespaceId, shareToken, version.version)));
    const latest = available.at(-1) ?? (includeDeniedVersion
      ? entry.versions.find(version => !version.yanked && (!requestedVersion || version.version === requestedVersion) &&
        (!identity || (exactIdentity ? (version.meta?.identity ?? entry.meta.identity) === identity :
          shortIdentity(version.meta?.identity ?? entry.meta.identity) === identity)))
      : undefined);
    if (!latest || entry.deprecated) { return { status: 'not-found-owned' }; }
    const meta = latest.meta ?? entry.meta;
    return {
      status: 'found',
      package: {
        id: meta.name,
        version: latest.version,
        integrity: latest.integrity,
        ...(latest.signature ? { signature: latest.signature } : {}),
        primaryKind: latest.primaryKind ?? entry.primaryKind,
        downloadUrl: `${this.baseUrl}/api/v1/packages/${entry.authorHandle}/${encodeURIComponent(entry.name)}/${latest.version}/tarball`,
        signatureSubject: `${entry.authorHandle}/${entry.name}`,
      },
    };
  }

  async getStats(
    authorHandle: string,
    name: string,
    callerNamespaceId: string | null = null,
    shareToken: { pkg: string } | null = null,
  ): Promise<PackageStats> {
    const entry = await this.getEntry(authorHandle, name);
    if (!entry) {
      return { installs: 0 };
    }
    const legacyStats = await this.cache.get<PackageStats>(`registry:stats:${authorHandle}/${name}`);
    const legacyVisibility = entry.legacyStatsVisibility ?? 'private';
    let installs = legacyStats && (legacyVisibility === 'public' || this.canAccessPrivate(entry, callerNamespaceId, shareToken))
      ? legacyStats.installs
      : 0;
    for (const version of entry.versions) {
      if (!this.canAccess(entry, callerNamespaceId, shareToken, version.version)) { continue; }
      const versionStats = await this.cache.get<PackageStats>(`registry:stats:${authorHandle}/${name}/${version.version}`);
      installs += versionStats?.installs ?? 0;
    }
    return { installs };
  }

  async incrementInstalls(authorHandle: string, name: string, version?: string): Promise<void> {
    const key = version
      ? `registry:stats:${authorHandle}/${name}/${version}`
      : `registry:stats:${authorHandle}/${name}`;
    const current = await this.cache.get<PackageStats>(key) ?? { installs: 0 };
    await this.cache.set(key, { installs: current.installs + 1 });
  }

  async listPublicPackages(): Promise<RegistryPackageSummary[]> {
    const generation = await this.cache.get<string>('registry:search:generation') ?? '0';
    const cached = await this.cache.get<RegistryPackageSummary[]>(`registry:search:${generation}:catalog-index`);
    if (cached) { return cached; }
    return this.rebuildIndex(generation);
  }

  async searchPackages(query: string): Promise<RegistryPackageSummary[]> {
    const q = query.toLowerCase().trim();
    const generation = await this.cache.get<string>('registry:search:generation') ?? '0';
    const cacheKey = `registry:search:${generation}:query:${q}`;
    const cached = await this.cache.get<RegistryPackageSummary[]>(cacheKey);
    if (cached) { return cached; }

    const all = await this.listPublicPackages();
    const results = all.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.fullName.toLowerCase().includes(q) ||
      p.description?.toLowerCase().includes(q) ||
      p.keywords?.some(k => k.toLowerCase().includes(q)),
    );

    await this.cache.set(cacheKey, results, CACHE_TTL_SEARCH);
    return results;
  }

  async listByAuthor(authorNamespaceId: string): Promise<RegistryEntry[]> {
    const paths = await this.storage.list(`${STORAGE_PREFIX}/packages/`);
    const results: RegistryEntry[] = [];
    for (const path of paths.filter(p => p.endsWith('/meta.json'))) {
      const raw = await this.storage.read(path);
      if (!raw) { continue; }
      const entry = JSON.parse(raw.toString()) as RegistryEntry;
      if (entry.authorNamespaceId === authorNamespaceId) { results.push(entry); }
    }
    return results;
  }

  async setFeatured(authorHandle: string, name: string, featured: boolean): Promise<void> {
    const entry = await this.requireEntry(authorHandle, name);
    await this.saveEntry(authorHandle, name, { ...entry, featured, updatedAt: new Date().toISOString() });
    await this.invalidateCaches(entry.authorHandle, entry.name);
    if (entry.visibility === 'public') { await this.rebuildIndex(); }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private metaPath(handle: string, name: string): string {
    return `${STORAGE_PREFIX}/packages/${handle}/${name}/meta.json`;
  }

  private versionStorageSegment(version: string): string {
    return `v-${createHash('sha256').update(version, 'utf8').digest('hex')}`;
  }

  private tarballPath(handle: string, name: string, version: string): string {
    return `${STORAGE_PREFIX}/packages/${handle}/${name}/${this.versionStorageSegment(version)}.tgz`;
  }

  private legacyTarballPath(handle: string, name: string, version: string): string {
    return `${STORAGE_PREFIX}/packages/${handle}/${name}/${version}.tgz`;
  }

  private hexVersionTarballPath(handle: string, name: string, version: string): string {
    const legacySegment = `v-${Buffer.from(version, 'utf8').toString('hex')}`;
    return `${STORAGE_PREFIX}/packages/${handle}/${name}/${legacySegment}.tgz`;
  }

  private async readPreviousHexTarball(handle: string, name: string, version: string): Promise<Buffer | null> {
    try {
      return await this.storage.read(this.hexVersionTarballPath(handle, name, version));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENAMETOOLONG') {
        return null;
      }
      throw error;
    }
  }

  private sigPath(handle: string, name: string, version: string): string {
    return `${STORAGE_PREFIX}/packages/${handle}/${name}/${this.versionStorageSegment(version)}.sig`;
  }

  private async loadEntry(handle: string, name: string): Promise<RegistryEntry | null> {
    const raw = await this.storage.read(this.metaPath(handle, name));
    if (!raw) { return null; }
    return JSON.parse(raw.toString()) as RegistryEntry;
  }

  private async saveEntry(handle: string, name: string, entry: RegistryEntry): Promise<void> {
    await this.storage.write(this.metaPath(handle, name), Buffer.from(JSON.stringify(entry, null, 2)));
  }

  private async requireEntry(handle: string, name: string): Promise<RegistryEntry> {
    const entry = await this.loadEntry(handle, name);
    if (!entry) {
      throw Object.assign(new Error(`Package ${handle}/${name} not found`), { code: 'PACKAGE_NOT_FOUND' });
    }
    return entry;
  }

  private async invalidateCaches(handle: string, name: string): Promise<void> {
    await this.cache.delete(`registry:pkg:${handle}/${name}`);
    const generation = await this.cache.get<string>('registry:search:generation') ?? '0';
    await this.cache.delete(`registry:search:${generation}:catalog-index`);
    await this.cache.delete('registry:search:__index');
    await this.cache.set('registry:search:generation', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  private async rebuildIndex(generation?: string): Promise<RegistryPackageSummary[]> {
    const cacheGeneration = generation ?? (await this.cache.get<string>('registry:search:generation')) ?? '0';
    const paths = await this.storage.list(`${STORAGE_PREFIX}/packages/`);
    const summaries: RegistryPackageSummary[] = [];

    for (const path of paths.filter(p => p.endsWith('/meta.json'))) {
      const raw = await this.storage.read(path);
      if (!raw) { continue; }
      const entry = JSON.parse(raw.toString()) as RegistryEntry;
      if (entry.deprecated) { continue; }

      const latest = entry.versions.filter(v => !v.yanked && (v.visibility ?? 'private') === 'public').at(-1);
      if (!latest) { continue; }

      const stats = await this.getStats(entry.authorHandle, entry.name);
      const meta = latest.meta ?? entry.meta;
      summaries.push({
        handle: entry.authorHandle,
        name: entry.name,
        fullName: `${entry.authorHandle}/${entry.name}`,
        version: latest.version,
        description: meta.description,
        author: meta.author,
        keywords: meta.keywords,
        primaryKind: latest.primaryKind ?? entry.primaryKind ?? 'plugin',
        featured: entry.featured,
        badges: entry.badges,
        trust: entry.trust,
        installs: stats.installs,
        publishedAt: latest.publishedAt,
      });
    }

    summaries.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || b.installs - a.installs);
    await this.cache.set(`registry:search:${cacheGeneration}:catalog-index`, summaries, CACHE_TTL_SEARCH);

    const indexPath = `${STORAGE_PREFIX}/index.json`;
    await this.storage.write(indexPath, Buffer.from(JSON.stringify(summaries, null, 2)));

    return summaries;
  }

  private signTarball(
    tarball: Buffer,
    integrity: string,
    handle: string,
    name: string,
    version: string,
  ): EntitySignature {
    const payload = Buffer.from(JSON.stringify({ integrity, pkg: `${handle}/${name}@${version}` }));
    // Ed25519 uses its own internal hash — algorithm must be null
    const sig = cryptoSign(null, payload, { key: this.signingPrivateKey!, format: 'pem' });
    return {
      algorithm: 'ed25519',
      value: sig.toString('base64'),
      signer: 'kb-labs-platform',
      signedAt: new Date().toISOString(),
      verifiedChecks: ['integrity'],
    };
  }
}

function shareTokenCacheKey(token: string): string {
  return `registry:sharetoken:sha256:${createHash('sha256').update(token).digest('hex')}`;
}
