/**
 * RegistryService — stores and retrieves packages using platform.storage + platform.cache.
 * No direct filesystem or DB dependencies — swap adapters in kb.config.json.
 */

import { createHash, sign as cryptoSign } from 'node:crypto';
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
    const key = `${authorHandle}/${req.meta.name}`;
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
    if (visibility === 'public' && this.signingPrivateKey) {
      signature = this.signTarball(tarball, integrity, authorHandle, name, version);
      const sigPath = this.sigPath(authorHandle, name, version);
      await this.storage.write(sigPath, Buffer.from(JSON.stringify(signature)));
    }

    const versionEntry: RegistryVersionEntry = {
      version,
      publishedAt: new Date().toISOString(),
      integrity,
      signature,
    };

    const now = new Date().toISOString();
    const entry: RegistryEntry = existing
      ? {
          ...existing,
          visibility,
          primaryKind,
          trust: visibility === 'public' && signature ? 'trusted' : existing.trust,
          versions: [...existing.versions, versionEntry],
          meta,
          updatedAt: now,
        }
      : {
          name,
          authorHandle,
          authorNamespaceId,
          primaryKind,
          visibility,
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
    await this.invalidateCaches(authorHandle, name);

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
    const updated: RegistryEntry = {
      ...entry,
      meta: { ...entry.meta, ...meta },
      updatedAt: new Date().toISOString(),
    };
    await this.saveEntry(authorHandle, name, updated);
    await this.invalidateCaches(authorHandle, name);
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
    await this.invalidateCaches(authorHandle, name);
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
    await this.invalidateCaches(authorHandle, name);
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
    await this.invalidateCaches(authorHandle, name);
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
    await this.cache.set(`registry:sharetoken:${token}`, { pkg, expiresAt }, ttlMs);
    return { token, pkg, expiresAt };
  }

  async resolveShareToken(token: string): Promise<{ pkg: string } | null> {
    return this.cache.get<{ pkg: string; expiresAt: string }>(`registry:sharetoken:${token}`);
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

    const tarball = await this.storage.read(this.tarballPath(authorHandle, name, version));
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
  ): boolean {
    if (entry.visibility === 'public') { return true; }
    if (!callerNamespaceId) {
      return !!shareToken && shareToken.pkg === `${entry.authorHandle}/${entry.name}`;
    }
    if (entry.authorNamespaceId === callerNamespaceId) { return true; }
    if (entry.allowlist.includes(callerNamespaceId)) { return true; }
    return !!shareToken && shareToken.pkg === `${entry.authorHandle}/${entry.name}`;
  }

  // ── Metadata reads ─────────────────────────────────────────────────────────

  async getEntry(authorHandle: string, name: string): Promise<RegistryEntry | null> {
    const cacheKey = `registry:pkg:${authorHandle}/${name}`;
    const cached = await this.cache.get<RegistryEntry>(cacheKey);
    if (cached) { return cached; }
    const entry = await this.loadEntry(authorHandle, name);
    if (entry) { await this.cache.set(cacheKey, entry, CACHE_TTL_META); }
    return entry;
  }

  async resolveIdentity(identity: string): Promise<RegistryIdentityResolution> {
    const paths = (await this.storage.list(`${STORAGE_PREFIX}/packages/`)).filter(path => path.endsWith('/meta.json'));
    const entries: RegistryEntry[] = [];
    for (const path of paths) {
      const raw = await this.storage.read(path);
      if (raw) { entries.push(JSON.parse(raw.toString()) as RegistryEntry); }
    }

    const matches = entries.filter(entry => entry.meta.identity === identity || shortIdentity(entry.meta.identity) === identity);
    if (matches.length > 1) {
      throw Object.assign(new Error(`Marketplace identity ${identity} is ambiguous in the Registry.`), { code: 'IDENTITY_AMBIGUOUS' });
    }
    const entry = matches[0];
    if (entry) {
      const latest = entry.versions.filter(version => !version.yanked).at(-1);
      if (!latest || entry.deprecated) { return { status: 'not-found-owned' }; }
      return {
        status: 'found',
        package: {
          id: entry.meta.name,
          version: latest.version,
          integrity: latest.integrity,
          ...(latest.signature ? { signature: latest.signature } : {}),
          primaryKind: entry.primaryKind,
          downloadUrl: `${this.baseUrl}/api/v1/packages/${entry.authorHandle}/${encodeURIComponent(entry.name)}/${latest.version}/tarball`,
          signatureSubject: `${entry.authorHandle}/${entry.name}`,
        },
      };
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

  async getStats(authorHandle: string, name: string): Promise<PackageStats> {
    const key = `registry:stats:${authorHandle}/${name}`;
    const data = await this.cache.get<PackageStats>(key);
    return data ?? { installs: 0 };
  }

  async incrementInstalls(authorHandle: string, name: string): Promise<void> {
    const key = `registry:stats:${authorHandle}/${name}`;
    const current = await this.cache.get<PackageStats>(key) ?? { installs: 0 };
    await this.cache.set(key, { installs: current.installs + 1 });
  }

  async listPublicPackages(): Promise<RegistryPackageSummary[]> {
    const cached = await this.cache.get<RegistryPackageSummary[]>('registry:search:__index');
    if (cached) { return cached; }
    return this.rebuildIndex();
  }

  async searchPackages(query: string): Promise<RegistryPackageSummary[]> {
    const q = query.toLowerCase().trim();
    const cacheKey = `registry:search:${q}`;
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
    await this.invalidateCaches(authorHandle, name);
    if (entry.visibility === 'public') { await this.rebuildIndex(); }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private metaPath(handle: string, name: string): string {
    return `${STORAGE_PREFIX}/packages/${handle}/${name}/meta.json`;
  }

  private tarballPath(handle: string, name: string, version: string): string {
    return `${STORAGE_PREFIX}/packages/${handle}/${name}/${version}.tgz`;
  }

  private sigPath(handle: string, name: string, version: string): string {
    return `${STORAGE_PREFIX}/packages/${handle}/${name}/${version}.sig`;
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
    await this.cache.delete('registry:search:__index');
  }

  private async rebuildIndex(): Promise<RegistryPackageSummary[]> {
    const paths = await this.storage.list(`${STORAGE_PREFIX}/packages/`);
    const summaries: RegistryPackageSummary[] = [];

    for (const path of paths.filter(p => p.endsWith('/meta.json'))) {
      const raw = await this.storage.read(path);
      if (!raw) { continue; }
      const entry = JSON.parse(raw.toString()) as RegistryEntry;
      if (entry.visibility !== 'public' || entry.deprecated) { continue; }

      const latest = entry.versions.filter(v => !v.yanked).at(-1);
      if (!latest) { continue; }

      const stats = await this.getStats(entry.authorHandle, entry.name);
      summaries.push({
        handle: entry.authorHandle,
        name: entry.name,
        fullName: `${entry.authorHandle}/${entry.name}`,
        version: latest.version,
        description: entry.meta.description,
        author: entry.meta.author,
        keywords: entry.meta.keywords,
        primaryKind: entry.primaryKind ?? 'plugin',
        featured: entry.featured,
        badges: entry.badges,
        trust: entry.trust,
        installs: stats.installs,
        publishedAt: latest.publishedAt,
      });
    }

    summaries.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || b.installs - a.installs);
    await this.cache.set('registry:search:__index', summaries, CACHE_TTL_SEARCH);

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
