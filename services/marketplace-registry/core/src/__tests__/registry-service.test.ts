import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import type { IStorage, ICache, ILogger } from '@kb-labs/core-platform';
import type { RegistryEntry } from '@kb-labs/marketplace-registry-contracts';
import { RegistryService } from '../registry-service.js';

// ── In-memory adapters ────────────────────────────────────────────────────────

function createMemoryStorage(): IStorage {
  const store = new Map<string, Buffer>();
  return {
    read: async (path) => store.get(path) ?? null,
    write: async (path, data) => { store.set(path, Buffer.isBuffer(data) ? data : Buffer.from(data)); },
    delete: async (path) => { store.delete(path); },
    list: async (prefix) => [...store.keys()].filter(k => k.startsWith(prefix)),
    exists: async (path) => store.has(path),
  };
}

function createMemoryCache(): ICache {
  const store = new Map<string, { value: unknown; expiresAt?: number }>();
  return {
    get: async (key) => {
      const entry = store.get(key);
      if (!entry) { return null; }
      if (entry.expiresAt && Date.now() > entry.expiresAt) { store.delete(key); return null; }
      return entry.value as any;
    },
    set: async (key, value, ttl) => {
      store.set(key, { value, expiresAt: ttl ? Date.now() + ttl : undefined });
    },
    delete: async (key) => { store.delete(key); },
    clear: async () => { store.clear(); },
    setIfNotExists: async (key, value, ttl) => {
      if (store.has(key)) { return false; }
      store.set(key, { value, expiresAt: ttl ? Date.now() + ttl : undefined });
      return true;
    },
    zadd: async () => {},
    zrangebyscore: async () => [],
    zrem: async () => {},
  };
}

const noopLogger: ILogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
  error: vi.fn(), fatal: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
  child: () => noopLogger,
};

// ── Test fixtures ─────────────────────────────────────────────────────────────

const SMALL_TARBALL = Buffer.alloc(1024, 0x42); // 1 KB

function makePkg(overrides?: Partial<Parameters<RegistryService['publish']>[1]['meta']>) {
  return {
    meta: {
      name: 'my-plugin',
      version: '1.0.0',
      identity: '@test/my-plugin',
      description: 'A test plugin',
      keywords: ['test'],
      ...overrides,
    },
    visibility: 'public' as const,
    primaryKind: 'plugin' as const,
  };
}

function makeService(extraOpts?: { signingPrivateKey?: string; cache?: ICache }): RegistryService {
  return new RegistryService({
    storage: createMemoryStorage(),
    cache: extraOpts?.cache ?? createMemoryCache(),
    logger: noopLogger,
    baseUrl: 'http://localhost:5071',
    siteUrl: 'https://kblabs.ru',
    ...extraOpts,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RegistryService.publish', () => {
  // case: S-268.1
  it('returns a Gateway path-reference when the public Registry URL is a path', async () => {
    const svc = new RegistryService({
      storage: createMemoryStorage(), cache: createMemoryCache(), logger: noopLogger,
      baseUrl: '/api/v1/marketplace-registry', siteUrl: 'https://kblabs.ru',
    });
    await svc.publish(SMALL_TARBALL, makePkg({ name: '@kb-labs/commit', identity: '@kb-labs/commit' }),
      'journey', 'journey-namespace');

    await expect(svc.resolveIdentity('@kb-labs/commit')).resolves.toMatchObject({
      status: 'found',
      package: {
        downloadUrl: '/api/v1/marketplace-registry/api/v1/packages/journey/%40kb-labs%2Fcommit/1.0.0/tarball',
      },
    });
  });

  it('resolves canonical identity and returns Registry ownership results', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg({ name: '@kb-labs/commit', identity: '@kb-labs/commit' }), 'kirill', 'ns-kirill');

    await expect(svc.resolveIdentity('@kb-labs/commit')).resolves.toMatchObject({
      status: 'found',
      package: { id: '@kb-labs/commit', signatureSubject: 'kirill/@kb-labs/commit' },
    });
    await expect(svc.resolveIdentity('@kb-labs/unknown')).resolves.toEqual({ status: 'not-found-owned' });
    await expect(svc.resolveIdentity('@other/unknown')).resolves.toEqual({ status: 'not-found-unowned' });
  });

  // case: S-268.21
  it('signs private releases for an owner or share token without granting anonymous access', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const svc = makeService({ signingPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
    await svc.publish(SMALL_TARBALL, { ...makePkg(), visibility: 'private' }, 'author', 'owner');
    const entry = await svc.getEntry('author', 'my-plugin');
    expect(entry && svc.getVisibleEntry(entry, null)).toBeNull();
    const share = await svc.createShareToken('author', 'my-plugin');
    const shared = await svc.resolveShareToken(share.token);
    const ownerResult = await svc.resolveIdentity('@test/my-plugin', 'owner');
    const sharedResult = await svc.resolveIdentity('@test/my-plugin', null, shared);
    if (ownerResult.status !== 'found' || sharedResult.status !== 'found') { throw new Error('private package did not resolve'); }
    expect(sharedResult.package.signature).toEqual(ownerResult.package.signature);
    const signature = ownerResult.package.signature;
    expect(signature?.algorithm).toBe('ed25519');
    const payload = Buffer.from(JSON.stringify({ integrity: ownerResult.package.integrity, pkg: 'author/my-plugin@1.0.0' }));
    expect(cryptoVerify(null, payload, publicKey, Buffer.from(signature!.value, 'base64'))).toBe(true);
  });

  it('resolves an anonymous short identity to its public package when a private package shares the name', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg({ name: 'widget', identity: '@public/widget' }), 'public-author', 'ns-public');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'widget', identity: '@private/widget' }),
      visibility: 'private',
    }, 'private-author', 'ns-private');

    await expect(svc.resolveIdentity('widget')).resolves.toMatchObject({
      status: 'found', package: { id: 'widget', signatureSubject: 'public-author/widget' },
    });
    await expect(svc.resolveIdentity('widget', 'ns-private')).rejects.toMatchObject({ code: 'IDENTITY_AMBIGUOUS' });
    await expect(svc.resolveIdentity('@private/widget', 'ns-private')).resolves.toMatchObject({
      status: 'found', package: { id: 'widget', signatureSubject: 'private-author/widget' },
    });
  });

  // case: S-268.20
  it('applies access before short-name ambiguity and honors a matching share token', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg({ name: 'widget', identity: '@public/widget' }), 'public-author', 'ns-public');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'widget', identity: '@private/widget' }), visibility: 'private',
    }, 'private-author', 'ns-private');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'widget', identity: '@other-private/widget' }), visibility: 'private',
    }, 'other-author', 'ns-other-private');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'gadget', identity: '@private-a/gadget' }), visibility: 'private',
    }, 'private-a', 'ns-private-a');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'gadget', identity: '@private-b/gadget' }), visibility: 'private',
    }, 'private-b', 'ns-private-b');

    await expect(svc.resolveIdentity('widget')).resolves.toMatchObject({
      status: 'found', package: { signatureSubject: 'public-author/widget' },
    });
    await expect(svc.resolveIdentity('widget', 'ns-unrelated')).resolves.toMatchObject({
      status: 'found', package: { signatureSubject: 'public-author/widget' },
    });
    await expect(svc.resolveIdentity('widget', null)).resolves.not.toMatchObject({
      status: 'found', package: { signatureSubject: 'private-author/widget' },
    });
    await expect(svc.resolveIdentity('gadget')).resolves.toEqual({ status: 'not-found-owned' });
    await expect(svc.resolveIdentity('widget', 'ns-private')).rejects.toMatchObject({ code: 'IDENTITY_AMBIGUOUS' });

    const token = await svc.createShareToken('private-author', 'widget');
    const resolvedToken = await svc.resolveShareToken(token.token);
    await expect(svc.resolveIdentity('widget', null, resolvedToken)).resolves.toMatchObject({
      status: 'found', package: { signatureSubject: 'private-author/widget' },
    });
  });

  // case: S-268.20
  it('does not let a bare stored identity take precedence over canonical short-name matches', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg({ name: 'widget', identity: '@legitimate/widget' }), 'legitimate', 'ns-legitimate');
    await svc.publish(SMALL_TARBALL, makePkg({ name: 'widget-bare', identity: 'widget' }), 'bare-owner', 'ns-bare');

    await expect(svc.resolveIdentity('widget')).rejects.toMatchObject({ code: 'IDENTITY_AMBIGUOUS' });
    await expect(svc.resolveIdentity('@legitimate/widget')).resolves.toMatchObject({
      status: 'found', package: { signatureSubject: 'legitimate/widget' },
    });
  });

  // case: S-268.20
  it('filters inaccessible exact duplicates before ambiguity and uses one denied candidate when none are accessible', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg({ name: 'widget-public', identity: '@shared/widget' }), 'public-author', 'ns-public');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'widget-private', identity: '@shared/widget' }), visibility: 'private',
    }, 'private-author', 'ns-private');

    await expect(svc.resolveIdentity('@shared/widget')).resolves.toMatchObject({
      status: 'found', package: { signatureSubject: 'public-author/widget-public' },
    });
    await expect(svc.resolveIdentity('@shared/widget', 'ns-unrelated')).resolves.toMatchObject({
      status: 'found', package: { signatureSubject: 'public-author/widget-public' },
    });
    await expect(svc.resolveIdentity('@shared/widget', 'ns-private')).rejects.toMatchObject({ code: 'IDENTITY_AMBIGUOUS' });

    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'private-one', identity: '@only-private/widget' }), visibility: 'private',
    }, 'private-one', 'ns-private-one');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'private-two', identity: '@only-private/widget' }), visibility: 'private',
    }, 'private-two', 'ns-private-two');
    await expect(svc.resolveIdentity('@only-private/widget')).resolves.toMatchObject({
      status: 'found', package: { signatureSubject: 'private-one/private-one' },
    });
  });

  // case: S-268.21
  it('keeps visibility and metadata private per published version', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'visibility-widget', version: '1.0.0', identity: '@visibility/widget', description: 'private metadata', keywords: ['private-tag'] }),
      visibility: 'private',
    }, 'visibility-author', 'ns-visibility');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'visibility-widget', version: '2.0.0', identity: '@visibility/widget', description: 'public metadata', keywords: ['public-tag'] }),
      visibility: 'public',
    }, 'visibility-author', 'ns-visibility');
    await svc.addToAllowlist('visibility-author', 'visibility-widget', 'ns-shared');

    let entry = (await svc.getEntry('visibility-author', 'visibility-widget'))!;
    expect(entry.versions.map(version => version.visibility)).toEqual(['private', 'public']);
    expect(svc.canAccess(entry, null, null, '1.0.0')).toBe(false);
    expect(svc.canAccess(entry, null, null, '2.0.0')).toBe(true);
    await expect(svc.resolveIdentity('@visibility/widget')).resolves.toMatchObject({
      status: 'found', package: { version: '2.0.0' },
    });
    await expect(svc.resolveIdentity('@visibility/widget', null, null, '1.0.0')).resolves.toMatchObject({
      status: 'found', package: { version: '1.0.0' },
    });
    expect(svc.getVisibleEntry(entry, null, null)).toMatchObject({
      visibility: 'public', authorNamespaceId: '', allowlist: [], tags: ['public-tag'],
      meta: { description: 'public metadata', keywords: ['public-tag'] },
      versions: [{ version: '2.0.0', visibility: 'public' }],
    });
    expect(svc.getVisibleEntry(entry, null, null)?.createdAt).toBe(entry.versions[1]!.publishedAt);
    expect(svc.getVisibleEntry(entry, null, null)?.updatedAt).toBe(entry.versions[1]!.publishedAt);
    expect(svc.getVisibleEntry(entry, 'ns-visibility', null)?.allowlist).toEqual(['ns-shared']);
    await svc.incrementInstalls('visibility-author', 'visibility-widget', '1.0.0');
    await svc.incrementInstalls('visibility-author', 'visibility-widget', '2.0.0');
    await expect(svc.getStats('visibility-author', 'visibility-widget')).resolves.toEqual({ installs: 1 });
    await expect(svc.getStats('visibility-author', 'visibility-widget', 'ns-visibility')).resolves.toEqual({ installs: 2 });

    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'reverse-widget', version: '1.0.0', identity: '@reverse/widget', description: 'public release', keywords: ['public-tag'] }),
      visibility: 'public',
    }, 'reverse-author', 'ns-reverse');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'reverse-widget', version: '2.0.0', identity: '@reverse/widget', description: 'private release', keywords: ['private-tag'] }),
      visibility: 'private',
    }, 'reverse-author', 'ns-reverse');

    entry = (await svc.getEntry('reverse-author', 'reverse-widget'))!;
    expect(svc.canAccess(entry, null, null, '1.0.0')).toBe(true);
    expect(svc.canAccess(entry, null, null, '2.0.0')).toBe(false);
    await expect(svc.resolveIdentity('@reverse/widget')).resolves.toMatchObject({
      status: 'found', package: { version: '1.0.0' },
    });
    await expect(svc.resolveIdentity('@reverse/widget', null, null, '2.0.0')).resolves.toMatchObject({
      status: 'found', package: { version: '2.0.0' },
    });
    await expect(svc.resolveIdentity('@reverse/widget', 'ns-reverse')).resolves.toMatchObject({
      status: 'found', package: { version: '2.0.0' },
    });
    expect(svc.getVisibleEntry(entry, null, null)).toMatchObject({
      visibility: 'public', meta: { description: 'public release', keywords: ['public-tag'] },
      tags: ['public-tag'], versions: [{ version: '1.0.0', visibility: 'public' }],
    });
    await expect(svc.listPublicPackages()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ handle: 'reverse-author', version: '1.0.0', description: 'public release' }),
    ]));
  });

  // case: S-268.21
  it('resolves identity against the visible version metadata, not the package latest metadata', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'identity-history', version: '1.0.0', identity: '@history/old' }),
      visibility: 'public',
    }, 'history-author', 'ns-history');
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'identity-history', version: '2.0.0', identity: '@history/new' }),
      visibility: 'private',
    }, 'history-author', 'ns-history');

    await expect(svc.resolveIdentity('@history/old')).resolves.toMatchObject({
      status: 'found', package: { version: '1.0.0', signatureSubject: 'history-author/identity-history' },
    });
    await expect(svc.resolveIdentity('@history/new')).resolves.toMatchObject({
      status: 'found', package: { version: '2.0.0' },
    });
    await expect(svc.resolveIdentity('@history/new', 'ns-history')).resolves.toMatchObject({
      status: 'found', package: { version: '2.0.0' },
    });
  });

  // case: S-268.21
  it('snapshots legacy release metadata and kind while keeping an unknown legacy release private', async () => {
    const storage = createMemoryStorage();
    const svc = new RegistryService({
      storage, cache: createMemoryCache(), logger: noopLogger,
      baseUrl: 'http://localhost:5071', siteUrl: 'https://kblabs.ru',
    });
    const oldMeta = makePkg({ name: 'legacy-widget', version: '1.0.0', identity: '@legacy/widget', description: 'legacy private release' }).meta;
    const legacyEntry: RegistryEntry = {
      name: 'legacy-widget', authorHandle: 'legacy-author', authorNamespaceId: 'ns-legacy', primaryKind: 'adapter',
      visibility: 'private', trust: 'untrusted', allowlist: [],
      versions: [{ version: '1.0.0', publishedAt: '2024-01-01T00:00:00.000Z', integrity: 'sha256-legacy' }],
      deprecated: false, featured: false, badges: [], tags: [], meta: oldMeta,
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    };
    await storage.write('marketplace-registry/packages/legacy-author/legacy-widget/meta.json', Buffer.from(JSON.stringify(legacyEntry)));
    await storage.write('marketplace-registry/packages/legacy-author/legacy-widget/1.0.0.tgz', SMALL_TARBALL);
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'legacy-widget', version: '2.0.0', identity: '@legacy/widget', description: 'new public release' }),
      visibility: 'public',
    }, 'legacy-author', 'ns-legacy');

    const migrated = (await svc.getEntry('legacy-author', 'legacy-widget'))!;
    expect(migrated.versions.map(version => ({ version: version.version, visibility: version.visibility, description: version.meta?.description }))).toEqual([
      { version: '1.0.0', visibility: 'private', description: 'legacy private release' },
      { version: '2.0.0', visibility: 'public', description: 'new public release' },
    ]);
    expect(migrated.versions[0]?.primaryKind).toBe('adapter');
    expect(svc.canAccess(migrated, null, null, '1.0.0')).toBe(false);
    expect(svc.canAccess(migrated, null, null, '2.0.0')).toBe(true);
  });

  // case: S-268.21
  it('fails closed for legacy visibility and aggregate stats when version history is ambiguous', async () => {
    const storage = createMemoryStorage();
    const cache = createMemoryCache();
    const svc = new RegistryService({
      storage, cache, logger: noopLogger, baseUrl: 'http://localhost:5071', siteUrl: 'https://kblabs.ru',
    });
    const legacyEntry: RegistryEntry = {
      name: 'legacy-stats', authorHandle: 'legacy-author', authorNamespaceId: 'ns-legacy', primaryKind: 'adapter',
      visibility: 'public', trust: 'untrusted', allowlist: [],
      versions: [{ version: '1.0.0', publishedAt: '2024-01-01T00:00:00.000Z', integrity: 'sha256-legacy' }],
      deprecated: false, featured: false, badges: [], tags: [],
      meta: makePkg({ name: 'legacy-stats', version: '1.0.0', identity: '@legacy/stats', description: 'public legacy release' }).meta,
      createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    };
    await storage.write('marketplace-registry/packages/legacy-author/legacy-stats/meta.json', Buffer.from(JSON.stringify(legacyEntry)));
    await storage.write('marketplace-registry/packages/legacy-author/legacy-stats/1.0.0.tgz', SMALL_TARBALL);
    await cache.set('registry:stats:legacy-author/legacy-stats', { installs: 7 });
    await svc.publish(SMALL_TARBALL, {
      ...makePkg({ name: 'legacy-stats', version: '2.0.0', identity: '@legacy/stats', description: 'private latest release' }),
      visibility: 'private', primaryKind: 'plugin',
    }, 'legacy-author', 'ns-legacy');
    await svc.incrementInstalls('legacy-author', 'legacy-stats', '2.0.0');

    const migrated = (await svc.getEntry('legacy-author', 'legacy-stats'))!;
    expect(migrated.versions.map(version => version.primaryKind)).toEqual(['adapter', 'plugin']);
    expect(migrated.versions[0]?.visibility).toBe('private');
    expect(svc.getVisibleEntry(migrated, null)).toBeNull();
    expect(svc.getVisibleEntry(migrated, 'ns-legacy')).toMatchObject({
      primaryKind: 'plugin', versions: [
        { version: '1.0.0', primaryKind: 'adapter' },
        { version: '2.0.0', primaryKind: 'plugin' },
      ],
    });
    await expect(svc.getStats('legacy-author', 'legacy-stats')).resolves.toEqual({ installs: 0 });
    await expect(svc.getStats('legacy-author', 'legacy-stats', 'ns-legacy')).resolves.toEqual({ installs: 8 });
    await expect(svc.listPublicPackages()).resolves.toEqual([]);
  });

  it('RS-01: stores tarball + meta, returns install command', async () => {
    const svc = makeService();
    const result = await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');

    expect(result.name).toBe('my-plugin');
    expect(result.version).toBe('1.0.0');
    expect(result.installCommand).toBe('kb marketplace install @test/my-plugin');
    expect(result.pageUrl).toBe('https://kblabs.ru/ru/marketplace/kirill/my-plugin');

    const entry = await svc.getEntry('kirill', 'my-plugin');
    expect(entry?.versions).toHaveLength(1);
    expect(entry?.versions[0]?.version).toBe('1.0.0');
  });

  // case: S-026.5
  it('RS-02: version already exists → throws VERSION_ALREADY_EXISTS without replacing bytes', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');

    const replacement = Buffer.from('replacement tarball');
    const err = await svc.publish(replacement, makePkg(), 'kirill', 'ns-kirill').catch(e => e);
    expect(err.code).toBe('VERSION_ALREADY_EXISTS');
    expect(err.message).toContain('Versions are immutable');
    const entry = await svc.getEntry('kirill', 'my-plugin');
    expect(entry?.versions).toHaveLength(1);
    expect(entry?.versions[0]?.integrity).toBe(`sha256-${createHash('sha256').update(SMALL_TARBALL).digest('base64')}`);
    const original = await svc.getTarball('kirill', 'my-plugin', '1.0.0');
    expect(original.tarball).toEqual(SMALL_TARBALL);
  });

  it('serializes concurrent publications so an immutable version wins only once', async () => {
    const svc = makeService();
    const replacement = Buffer.from('concurrent replacement tarball');
    const results = await Promise.allSettled([
      svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill'),
      svc.publish(replacement, makePkg(), 'kirill', 'ns-kirill'),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const entry = await svc.getEntry('kirill', 'my-plugin');
    expect(entry?.versions).toHaveLength(1);
    const stored = await svc.getTarball('kirill', 'my-plugin', '1.0.0');
    expect(`sha256-${createHash('sha256').update(stored.tarball).digest('base64')}`)
      .toBe(entry?.versions[0]?.integrity);
  });

  it('RS-03: tarball exceeds 50 MB → throws TARBALL_TOO_LARGE', async () => {
    const svc = makeService();
    const big = Buffer.alloc(51 * 1024 * 1024);

    const err = await svc.publish(big, makePkg(), 'kirill', 'ns-kirill').catch(e => e);
    expect(err.code).toBe('TARBALL_TOO_LARGE');
  });

  it('RS-04: public + signing key → entry has trust=trusted, signature present', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const svc = makeService({ signingPrivateKey: pem });

    const result = await svc.publish(SMALL_TARBALL, makePkg({ ...makePkg().meta }), 'kirill', 'ns-kirill');
    expect(result.trust).toBe('trusted');
    expect(result.signature).toBeDefined();
    expect(result.signature?.signer).toBe('kb-labs-platform');
  });

  it('RS-05: public without signing key → trust=untrusted, no signature', async () => {
    const svc = makeService();
    const result = await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    expect(result.trust).toBe('untrusted');
    expect(result.signature).toBeUndefined();
  });

  it('RS-06: private package → no index rebuild, pageUrl still set', async () => {
    const svc = makeService();
    const result = await svc.publish(
      SMALL_TARBALL,
      { ...makePkg(), visibility: 'private' },
      'kirill',
      'ns-kirill',
    );
    expect(result.visibility).toBe('private');
    expect(result.pageUrl).toBeDefined();
  });

  // case: S-268.22
  it('allows only the owning namespace to append a package version without mutating state on refusal', async () => {
    const storageValues = new Map<string, Buffer>();
    const storage: IStorage = {
      read: async (path) => storageValues.get(path) ?? null,
      write: vi.fn(async (path, data) => {
        storageValues.set(path, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data));
      }),
      delete: vi.fn(async (path) => { storageValues.delete(path); }),
      list: async (prefix) => [...storageValues.keys()].filter(path => path.startsWith(prefix)),
      exists: async (path) => storageValues.has(path),
    };
    const cache = createMemoryCache();
    const cacheDelete = vi.spyOn(cache, 'delete');
    const cacheSet = vi.spyOn(cache, 'set');
    const { privateKey } = generateKeyPairSync('ed25519');
    const svc = new RegistryService({
      storage, cache, logger: noopLogger,
      baseUrl: 'http://localhost:5071', siteUrl: 'https://kblabs.ru',
      signingPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });

    await svc.publish(SMALL_TARBALL, makePkg(), 'shared-handle', 'ns-owner');
    const originalEntry = await svc.getEntry('shared-handle', 'my-plugin');
    const originalStorage = new Map([...storageValues].map(([path, value]) => [path, Buffer.from(value)]));
    const writesBeforeRefusal = vi.mocked(storage.write).mock.calls.length;
    const deletesBeforeRefusal = cacheDelete.mock.calls.length;
    const setsBeforeRefusal = cacheSet.mock.calls.length;

    const refusal = await svc.publish(Buffer.from('attacker tarball'), makePkg({ version: '1.1.0' }),
      'shared-handle', 'ns-other').catch(error => error);

    expect(refusal.code).toBe('FORBIDDEN');
    expect(vi.mocked(storage.write)).toHaveBeenCalledTimes(writesBeforeRefusal);
    expect(cacheDelete).toHaveBeenCalledTimes(deletesBeforeRefusal);
    expect(cacheSet).toHaveBeenCalledTimes(setsBeforeRefusal);
    expect([...storageValues.entries()]).toEqual([...originalStorage.entries()]);
    expect(await svc.getEntry('shared-handle', 'my-plugin')).toEqual(originalEntry);
    await expect(svc.getTarball('shared-handle', 'my-plugin', '1.0.0')).resolves.toMatchObject({
      tarball: SMALL_TARBALL,
      signature: expect.objectContaining({ value: expect.any(String) }),
    });

    const ownerUpdate = await svc.publish(Buffer.from('owner release'), makePkg({ version: '1.1.0' }),
      'shared-handle', 'ns-owner');
    expect(ownerUpdate.version).toBe('1.1.0');
    const updatedEntry = await svc.getEntry('shared-handle', 'my-plugin');
    expect(updatedEntry?.versions.map(version => version.version)).toEqual(['1.0.0', '1.1.0']);
  });

  // case: S-268.22
  it('rejects unsafe publish identifiers before writes while preserving scoped names and exact SemVer', async () => {
    const values = new Map<string, Buffer>();
    const storage: IStorage = {
      read: async (path) => values.get(path) ?? null,
      write: vi.fn(async (path, data) => { values.set(path, Buffer.from(data)); }),
      delete: vi.fn(async (path) => { values.delete(path); }),
      list: async (prefix) => [...values.keys()].filter(path => path.startsWith(prefix)),
      exists: async (path) => values.has(path),
    };
    const cache = createMemoryCache();
    const cacheDelete = vi.spyOn(cache, 'delete');
    const cacheSet = vi.spyOn(cache, 'set');
    const svc = new RegistryService({ storage, cache, logger: noopLogger, baseUrl: 'http://localhost:5071' });

    const invalidAddresses: Array<[string, string, string]> = [
      ['../victim', 'my-plugin', '1.0.0'],
      ['victim', '../my-plugin', '1.0.0'],
      ['victim', '@scope/../my-plugin', '1.0.0'],
      ['victim', 'my-plugin', '1.0.0/../../meta'],
      ['victim', 'my-plugin', ' 1.0.0'],
      ['Victim', 'my-plugin', '1.0.0'],
      ['v', 'my-plugin', '1.0.0'],
    ];
    for (const [handle, name, version] of invalidAddresses) {
      const error = await svc.publish(SMALL_TARBALL, makePkg({ name, version }), handle, 'ns-owner')
        .catch(reason => reason);
      expect(error.code).toBe('INVALID_MANIFEST');
    }
    expect(storage.write).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(cacheDelete).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();

    await svc.publish(SMALL_TARBALL, makePkg({
      name: '@kb-labs/test_widget.v2', version: '1.2.3-rc.1+build.7',
    }), 'valid-handle', 'ns-owner');
    const scoped = await svc.getEntry('valid-handle', '@kb-labs/test_widget.v2');
    expect(scoped?.versions.map(version => version.version)).toEqual(['1.2.3-rc.1+build.7']);
  });

  // case: S-268.22
  it('stores case-distinct SemVer releases separately on case-insensitive storage', async () => {
    const values = new Map<string, Buffer>();
    const storage: IStorage = {
      read: async (path) => values.get(path.toLowerCase()) ?? null,
      write: async (path, data) => { values.set(path.toLowerCase(), Buffer.from(data)); },
      delete: async (path) => { values.delete(path.toLowerCase()); },
      list: async (prefix) => [...values.keys()].filter(path => path.startsWith(prefix.toLowerCase())),
      exists: async (path) => values.has(path.toLowerCase()),
    };
    const { privateKey } = generateKeyPairSync('ed25519');
    const svc = new RegistryService({
      storage, cache: createMemoryCache(), logger: noopLogger, baseUrl: 'http://localhost:5071',
      signingPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    });
    const alphaUpper = Buffer.from('alpha upper release');
    const alphaLower = Buffer.from('alpha lower release');
    const versionUpper = '1.0.0-Alpha+Build.7';
    const versionLower = '1.0.0-alpha+build.7';

    await svc.publish(alphaUpper, makePkg({ version: versionUpper }), 'portable-owner', 'ns-owner');
    await svc.publish(alphaLower, makePkg({ version: versionLower }), 'portable-owner', 'ns-owner');

    const entry = await svc.getEntry('portable-owner', 'my-plugin');
    expect(entry?.versions.map(version => version.version)).toEqual([versionUpper, versionLower]);
    expect((await svc.getTarball('portable-owner', 'my-plugin', versionUpper)).tarball).toEqual(alphaUpper);
    expect((await svc.getTarball('portable-owner', 'my-plugin', versionLower)).tarball).toEqual(alphaLower);
    expect(entry?.versions.every(version => version.signature?.value)).toBe(true);
    const signatureFiles = [...values.entries()].filter(([path]) => path.endsWith('.sig'));
    expect(signatureFiles).toHaveLength(2);
    expect(new Set(signatureFiles.map(([, bytes]) => JSON.parse(bytes.toString()).value)).size).toBe(2);
  });

  // case: S-268.22
  it('stores long valid SemVer versions under a filesystem-safe fixed-length key', async () => {
    const values = new Map<string, Buffer>();
    const storage: IStorage = {
      read: async (path) => values.get(path) ?? null,
      write: async (path, data) => {
        const component = path.slice(path.lastIndexOf('/') + 1);
        if (Buffer.byteLength(component, 'utf8') > 255) { throw new Error('Filesystem component too long'); }
        values.set(path, Buffer.from(data));
      },
      delete: async (path) => { values.delete(path); },
      list: async (prefix) => [...values.keys()].filter(path => path.startsWith(prefix)),
      exists: async (path) => values.has(path),
    };
    const svc = new RegistryService({ storage, cache: createMemoryCache(), logger: noopLogger,
      baseUrl: 'http://localhost:5071' });
    const version = `1.0.0+${'a'.repeat(200)}`;
    const tarball = Buffer.from('long semver release');

    await expect(svc.publish(tarball, makePkg({ version }), 'long-version-owner', 'ns-owner'))
      .resolves.toMatchObject({ version });
    await expect(svc.getTarball('long-version-owner', 'my-plugin', version)).resolves.toMatchObject({ tarball });
    const versionPath = [...values.keys()].find(path => path.endsWith('.tgz'));
    expect(versionPath?.split('/').at(-1)).toMatch(/^v-[a-f0-9]{64}\.tgz$/);
  });

  // case: S-268.22
  it('reads tarballs stored under the previous hexadecimal version key', async () => {
    const values = new Map<string, Buffer>();
    const version = '1.2.3-rc.1+Build.7';
    const base = 'marketplace-registry/packages/legacy/legacy-plugin';
    const meta = makePkg({ name: 'legacy-plugin', version }).meta;
    const registryEntry: RegistryEntry = {
      name: 'legacy-plugin', authorHandle: 'legacy', authorNamespaceId: 'ns-legacy',
      primaryKind: 'plugin', visibility: 'private', legacyStatsVisibility: 'private', trust: 'untrusted',
      allowlist: [], versions: [{ version, publishedAt: '2024-01-01T00:00:00Z', integrity: 'sha256-legacy',
        visibility: 'private', meta, primaryKind: 'plugin' }],
      deprecated: false, featured: false, badges: [], tags: [], meta,
      createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    };
    const tarball = Buffer.from('hex-key legacy release');
    values.set(`${base}/meta.json`, Buffer.from(JSON.stringify(registryEntry)));
    values.set(`${base}/v-${Buffer.from(version, 'utf8').toString('hex')}.tgz`, tarball);
    const storage: IStorage = {
      read: async (path) => values.get(path) ?? null,
      write: async (path, data) => { values.set(path, Buffer.from(data)); },
      delete: async (path) => { values.delete(path); },
      list: async (prefix) => [...values.keys()].filter(path => path.startsWith(prefix)),
      exists: async (path) => values.has(path),
    };
    const svc = new RegistryService({ storage, cache: createMemoryCache(), logger: noopLogger,
      baseUrl: 'http://localhost:5071' });

    await expect(svc.getTarball('legacy', 'legacy-plugin', version)).resolves.toMatchObject({ tarball });
  });

  // case: S-268.22
  it('falls back to a long raw-version tarball when its former hex path exceeds the filesystem limit', async () => {
    const values = new Map<string, Buffer>();
    const version = `1.0.0+${'a'.repeat(140)}`;
    const base = 'marketplace-registry/packages/legacy/legacy-plugin';
    const meta = makePkg({ name: 'legacy-plugin', version }).meta;
    const registryEntry: RegistryEntry = {
      name: 'legacy-plugin', authorHandle: 'legacy', authorNamespaceId: 'ns-legacy',
      primaryKind: 'plugin', visibility: 'private', legacyStatsVisibility: 'private', trust: 'untrusted',
      allowlist: [], versions: [{ version, publishedAt: '2024-01-01T00:00:00Z', integrity: 'sha256-legacy',
        visibility: 'private', meta, primaryKind: 'plugin' }],
      deprecated: false, featured: false, badges: [], tags: [], meta,
      createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    };
    const tarball = Buffer.from('long raw-key legacy release');
    values.set(`${base}/meta.json`, Buffer.from(JSON.stringify(registryEntry)));
    values.set(`${base}/${version}.tgz`, tarball);
    const enforceComponentLimit = (path: string) => {
      const component = path.slice(path.lastIndexOf('/') + 1);
      if (Buffer.byteLength(component, 'utf8') > 255) {
        throw Object.assign(new Error('File name too long'), { code: 'ENAMETOOLONG' });
      }
    };
    const storage: IStorage = {
      read: async (path) => { enforceComponentLimit(path); return values.get(path) ?? null; },
      write: async (path, data) => { enforceComponentLimit(path); values.set(path, Buffer.from(data)); },
      delete: async (path) => { values.delete(path); },
      list: async (prefix) => [...values.keys()].filter(path => path.startsWith(prefix)),
      exists: async (path) => values.has(path),
    };
    const svc = new RegistryService({ storage, cache: createMemoryCache(), logger: noopLogger,
      baseUrl: 'http://localhost:5071' });

    await expect(svc.getTarball('legacy', 'legacy-plugin', version)).resolves.toMatchObject({ tarball });
  });

  // case: S-268.22
  it('allows an owner to append to an existing safe legacy handle and package name', async () => {
    const values = new Map<string, Buffer>();
    const legacyName = 'Legacy.Plugin_Name';
    const legacyHandle = 'Legacy.Author';
    const legacyMeta = { ...makePkg({ name: legacyName }).meta, version: '1.0.0' };
    const legacyEntry: RegistryEntry = {
      name: legacyName, authorHandle: legacyHandle, authorNamespaceId: 'ns-legacy',
      primaryKind: 'plugin', visibility: 'private', legacyStatsVisibility: 'private', trust: 'untrusted',
      allowlist: [], versions: [{ version: '1.0.0', publishedAt: '2024-01-01T00:00:00Z',
        integrity: 'sha256-legacy', visibility: 'private', meta: legacyMeta, primaryKind: 'plugin' }],
      deprecated: false, featured: false, badges: [], tags: [], meta: legacyMeta,
      createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    };
    const base = `marketplace-registry/packages/${legacyHandle}/${legacyName}`;
    values.set(`${base}/meta.json`, Buffer.from(JSON.stringify(legacyEntry)));
    values.set(`${base}/1.0.0.tgz`, SMALL_TARBALL);
    const storage: IStorage = {
      read: async (path) => values.get(path) ?? null,
      write: async (path, data) => { values.set(path, Buffer.from(data)); },
      delete: async (path) => { values.delete(path); },
      list: async (prefix) => [...values.keys()].filter(path => path.startsWith(prefix)),
      exists: async (path) => values.has(path),
    };
    const svc = new RegistryService({ storage, cache: createMemoryCache(), logger: noopLogger,
      baseUrl: 'http://localhost:5071' });
    expect((await svc.getTarball(legacyHandle, legacyName, '1.0.0')).tarball).toEqual(SMALL_TARBALL);

    const result = await svc.publish(SMALL_TARBALL, makePkg({ name: legacyName, version: '1.1.0' }),
      legacyHandle, 'ns-legacy');

    expect(result.version).toBe('1.1.0');
    expect((await svc.getEntry(legacyHandle, legacyName))?.versions.map(version => version.version))
      .toEqual(['1.0.0', '1.1.0']);
  });

  // case: S-268.22
  it('serializes concurrent case aliases of a legacy package on case-insensitive storage', async () => {
    const values = new Map<string, Buffer>();
    const legacyName = 'Legacy.Plugin_Name';
    const legacyHandle = 'Legacy.Author';
    const legacyMeta = { ...makePkg({ name: legacyName }).meta, version: '1.0.0' };
    const legacyEntry: RegistryEntry = {
      name: legacyName, authorHandle: legacyHandle, authorNamespaceId: 'ns-legacy',
      primaryKind: 'plugin', visibility: 'private', legacyStatsVisibility: 'private', trust: 'untrusted',
      allowlist: [], versions: [{ version: '1.0.0', publishedAt: '2024-01-01T00:00:00Z',
        integrity: 'sha256-legacy', visibility: 'private', meta: legacyMeta, primaryKind: 'plugin' }],
      deprecated: false, featured: false, badges: [], tags: [], meta: legacyMeta,
      createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    };
    const base = `marketplace-registry/packages/${legacyHandle}/${legacyName}`;
    values.set(`${base.toLowerCase()}/meta.json`, Buffer.from(JSON.stringify(legacyEntry)));
    values.set(`${base.toLowerCase()}/v-312e302e30.tgz`, SMALL_TARBALL);
    const storage: IStorage = {
      read: async (path) => values.get(path.toLowerCase()) ?? null,
      write: async (path, data) => { values.set(path.toLowerCase(), Buffer.from(data)); },
      delete: async (path) => { values.delete(path.toLowerCase()); },
      list: async (prefix) => [...values.keys()].filter(path => path.startsWith(prefix.toLowerCase())),
      exists: async (path) => values.has(path.toLowerCase()),
    };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const svc = new RegistryService({ storage, cache: createMemoryCache(), logger: noopLogger,
      baseUrl: 'http://localhost:5071',
      signingPrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });

    await svc.getEntry(legacyHandle, legacyName);
    await svc.getEntry(legacyHandle.toLowerCase(), legacyName.toLowerCase());

    await Promise.all([
      svc.publish(Buffer.from('release upper alias'), makePkg({ name: legacyName, version: '1.1.0' }),
        legacyHandle, 'ns-legacy'),
      svc.publish(Buffer.from('release lower alias'), makePkg({ name: legacyName.toLowerCase(), version: '1.2.0' }),
        legacyHandle.toLowerCase(), 'ns-legacy'),
    ]);

    const storedEntry = JSON.parse(values.get(`${base.toLowerCase()}/meta.json`)!.toString()) as RegistryEntry;
    const entry = await svc.getEntry(legacyHandle, legacyName);
    expect(storedEntry.versions.map(version => version.version)).toEqual(['1.0.0', '1.1.0', '1.2.0']);
    expect(entry?.versions.map(version => version.version)).toEqual(['1.0.0', '1.1.0', '1.2.0']);
    expect((await svc.getEntry(legacyHandle.toLowerCase(), legacyName.toLowerCase()))?.versions.map(version => version.version))
      .toEqual(['1.0.0', '1.1.0', '1.2.0']);
    expect((await svc.getTarball(legacyHandle, legacyName, '1.1.0')).tarball).toEqual(Buffer.from('release upper alias'));
    expect((await svc.getTarball(legacyHandle.toLowerCase(), legacyName.toLowerCase(), '1.2.0')).tarball)
      .toEqual(Buffer.from('release lower alias'));

    const resolved = await svc.resolveIdentity(legacyMeta.identity, 'ns-legacy', null, '1.2.0');
    if (resolved.status !== 'found') { throw new Error('Legacy alias release did not resolve'); }
    const { integrity, version, signatureSubject, signature } = resolved.package;
    if (!integrity || !version || !signatureSubject || !signature) {
      throw new Error('Resolved legacy alias release is missing signature data');
    }
    const payload = Buffer.from(JSON.stringify({ integrity, pkg: `${signatureSubject}@${version}` }));
    expect(cryptoVerify(null, payload, publicKey, Buffer.from(signature.value, 'base64'))).toBe(true);
  });

  // case: S-268.22
  it('serializes simultaneous first publication so only one namespace owns the package', async () => {
    const svc = makeService();
    const results = await Promise.allSettled([
      svc.publish(SMALL_TARBALL, makePkg(), 'first-owner', 'ns-first'),
      svc.publish(Buffer.from('second namespace'), makePkg(), 'first-owner', 'ns-second'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.code).toBe('FORBIDDEN');
    const entry = await svc.getEntry('first-owner', 'my-plugin');
    expect(['ns-first', 'ns-second']).toContain(entry?.authorNamespaceId);
    expect(entry?.versions).toHaveLength(1);
  });

  it('RS-07: second version publishes, entry has two versions', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    await svc.publish(SMALL_TARBALL, makePkg({ version: '1.1.0' }), 'kirill', 'ns-kirill');

    const entry = await svc.getEntry('kirill', 'my-plugin');
    expect(entry?.versions).toHaveLength(2);
  });
});

describe('RegistryService.yank', () => {
  it('RS-10: yank marks version, yanked=true on version entry', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    await svc.yank('kirill', 'my-plugin', '1.0.0', 'security issue');

    const entry = await svc.getEntry('kirill', 'my-plugin');
    const v = entry?.versions.find(v => v.version === '1.0.0');
    expect(v?.yanked).toBe(true);
    expect(v?.yankReason).toBe('security issue');
  });

  it('RS-11: yank unknown version → throws VERSION_NOT_FOUND', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');

    const err = await svc.yank('kirill', 'my-plugin', '9.9.9').catch(e => e);
    expect(err.code).toBe('VERSION_NOT_FOUND');
  });

  it('RS-12: getTarball for yanked version → throws VERSION_YANKED', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    await svc.yank('kirill', 'my-plugin', '1.0.0');

    const err = await svc.getTarball('kirill', 'my-plugin', '1.0.0').catch(e => e);
    expect(err.code).toBe('VERSION_YANKED');
  });
});

describe('RegistryService.deprecate', () => {
  it('RS-20: marks package as deprecated with message', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    await svc.deprecate('kirill', 'my-plugin', 'use v2 instead');

    const entry = await svc.getEntry('kirill', 'my-plugin');
    expect(entry?.deprecated).toBe(true);
    expect(entry?.deprecateMessage).toBe('use v2 instead');
  });

  it('RS-21: deprecated package excluded from public index', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    await svc.deprecate('kirill', 'my-plugin');

    const index = await svc.listPublicPackages();
    expect(index.find(p => p.name === 'my-plugin')).toBeUndefined();
  });

  it('RS-22: deprecate non-existent package → throws PACKAGE_NOT_FOUND', async () => {
    const svc = makeService();
    const err = await svc.deprecate('kirill', 'ghost').catch(e => e);
    expect(err.code).toBe('PACKAGE_NOT_FOUND');
  });
});

describe('RegistryService.getTarball', () => {
  it('RS-30: returns correct tarball bytes', async () => {
    const svc = makeService();
    const tarball = Buffer.from('fake-tarball-data');
    await svc.publish(tarball, makePkg(), 'kirill', 'ns-kirill');

    const { tarball: got } = await svc.getTarball('kirill', 'my-plugin', '1.0.0');
    expect(got).toEqual(tarball);
  });

  it('RS-31: unknown package → PACKAGE_NOT_FOUND via requireEntry', async () => {
    const svc = makeService();
    const err = await svc.getTarball('kirill', 'ghost', '1.0.0').catch(e => e);
    expect(err.code).toBe('PACKAGE_NOT_FOUND');
  });
});

describe('RegistryService.canAccess', () => {
  let entry: RegistryEntry;

  beforeEach(() => {
    entry = {
      name: 'my-plugin',
      authorHandle: 'kirill',
      authorNamespaceId: 'ns-kirill',
      primaryKind: 'plugin',
      visibility: 'private',
      trust: 'untrusted',
      allowlist: ['ns-bob'],
      versions: [],
      deprecated: false,
      featured: false,
      badges: [],
      tags: [],
      meta: { name: 'my-plugin', version: '1.0.0', identity: '@kirill/my-plugin' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });

  it('RS-40: public package → always accessible', () => {
    const svc = makeService();
    expect(svc.canAccess({ ...entry, visibility: 'public' }, null)).toBe(true);
    expect(svc.canAccess({ ...entry, visibility: 'public' }, 'ns-stranger')).toBe(true);
  });

  it('RS-41: private + author → accessible', () => {
    const svc = makeService();
    expect(svc.canAccess(entry, 'ns-kirill')).toBe(true);
  });

  it('RS-42: private + allowlisted user → accessible', () => {
    const svc = makeService();
    expect(svc.canAccess(entry, 'ns-bob')).toBe(true);
  });

  it('RS-43: private + unknown user → denied', () => {
    const svc = makeService();
    expect(svc.canAccess(entry, 'ns-stranger')).toBe(false);
  });

  it('RS-44: private + no auth → denied', () => {
    const svc = makeService();
    expect(svc.canAccess(entry, null)).toBe(false);
  });

  it('RS-45: private + valid share token → accessible without account', () => {
    const svc = makeService();
    const token = { pkg: 'kirill/my-plugin' };
    expect(svc.canAccess(entry, null, token)).toBe(true);
  });

  it('RS-46: private + share token for wrong package → denied', () => {
    const svc = makeService();
    const token = { pkg: 'kirill/other-plugin' };
    expect(svc.canAccess(entry, null, token)).toBe(false);
  });
});

describe('RegistryService.shareToken', () => {
  // case: S-252.2
  it('stores share-token credentials by digest and continues to resolve legacy cache entries', async () => {
    const cache = createMemoryCache();
    const setSpy = vi.spyOn(cache, 'set');
    const svc = makeService({ cache });
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    setSpy.mockClear();

    const { token } = await svc.createShareToken('kirill', 'my-plugin', 60_000);
    const digest = createHash('sha256').update(token).digest('hex');
    expect(setSpy).toHaveBeenCalledWith(`registry:sharetoken:sha256:${digest}`, expect.any(Object), 60_000);
    expect(JSON.stringify(setSpy.mock.calls)).not.toContain(token);

    const previouslyIssuedToken = `kbrt_${'b'.repeat(32)}`;
    await cache.set(`registry:sharetoken:${previouslyIssuedToken}`, {
      pkg: 'kirill/my-plugin',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, 60_000);
    await expect(svc.resolveShareToken(previouslyIssuedToken)).resolves.toMatchObject({ pkg: 'kirill/my-plugin' });
    expect(await cache.get(`registry:sharetoken:sha256:${createHash('sha256').update(previouslyIssuedToken).digest('hex')}`))
      .toBeNull();
  });

  it('keeps parallel legacy-token resolutions successful when another lookup is delayed', async () => {
    const cache = createMemoryCache();
    const svc = makeService({ cache });
    const token = `kbrt_${'c'.repeat(32)}`;
    const digestKey = `registry:sharetoken:sha256:${createHash('sha256').update(token).digest('hex')}`;
    const legacyKey = `registry:sharetoken:${token}`;
    await cache.set(legacyKey, {
      pkg: 'kirill/my-plugin', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, 60_000);

    const realGet = cache.get.bind(cache);
    let releaseFirstDigestRead!: () => void;
    let signalFirstDigestRead!: () => void;
    const firstDigestRead = new Promise<void>((resolve) => { signalFirstDigestRead = resolve; });
    const allowFirstDigestRead = new Promise<void>((resolve) => { releaseFirstDigestRead = resolve; });
    let digestReads = 0;
    vi.spyOn(cache, 'get').mockImplementation(async (key) => {
      if (key === digestKey && digestReads++ === 0) {
        signalFirstDigestRead();
        await allowFirstDigestRead;
        return null;
      }
      return realGet(key);
    });

    const delayed = svc.resolveShareToken(token);
    await firstDigestRead;
    const firstResult = await svc.resolveShareToken(token);
    releaseFirstDigestRead();

    expect(firstResult).toMatchObject({ pkg: 'kirill/my-plugin' });
    await expect(delayed).resolves.toMatchObject({ pkg: 'kirill/my-plugin' });
  });

  it('does not resurrect a legacy token after a concurrent revoke', async () => {
    const cache = createMemoryCache();
    const svc = makeService({ cache });
    const token = `kbrt_${'d'.repeat(32)}`;
    const digestKey = `registry:sharetoken:sha256:${createHash('sha256').update(token).digest('hex')}`;
    const legacyKey = `registry:sharetoken:${token}`;
    await cache.set(legacyKey, {
      pkg: 'kirill/my-plugin', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, 60_000);

    const realGet = cache.get.bind(cache);
    let releaseLegacyRead!: () => void;
    let signalLegacyRead!: () => void;
    const legacyReadStarted = new Promise<void>((resolve) => { signalLegacyRead = resolve; });
    const allowLegacyRead = new Promise<void>((resolve) => { releaseLegacyRead = resolve; });
    vi.spyOn(cache, 'get').mockImplementation(async (key) => {
      const value = await realGet(key);
      if (key === legacyKey) {
        signalLegacyRead();
        await allowLegacyRead;
      }
      return value;
    });

    const inFlight = svc.resolveShareToken(token);
    await legacyReadStarted;
    await cache.delete(legacyKey);
    releaseLegacyRead();

    await expect(inFlight).resolves.toMatchObject({ pkg: 'kirill/my-plugin' });
    await expect(svc.resolveShareToken(token)).resolves.toBeNull();
    expect(await realGet(digestKey)).toBeNull();
  });

  it('rejects malformed and digest-namespace inputs before consulting the cache', async () => {
    const cache = createMemoryCache();
    const svc = makeService({ cache });
    const cacheGet = vi.spyOn(cache, 'get');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const digestNamespaceToken = `sha256:${'e'.repeat(64)}`;
    const malformedTokens = [
      'kbrt_unknown',
      'kbrt_ABCDEF0123456789abcdef0123456789',
      'sha256:short-digest',
      digestNamespaceToken,
      `registry:sharetoken:${digestNamespaceToken}`,
    ];

    for (const token of malformedTokens) {
      await cache.set(`registry:sharetoken:${token}`, { pkg: 'kirill/my-plugin', expiresAt }, 60_000);
      await expect(svc.resolveShareToken(token)).resolves.toBeNull();
    }

    expect(cacheGet).not.toHaveBeenCalled();
  });

  it('RS-50: createShareToken + resolveShareToken round trip', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');

    const { token, pkg, expiresAt } = await svc.createShareToken('kirill', 'my-plugin', 60_000);
    expect(token).toMatch(/^kbrt_[a-f0-9]{32}$/);
    expect(pkg).toBe('kirill/my-plugin');
    expect(expiresAt).toBeTruthy();

    const resolved = await svc.resolveShareToken(token);
    expect(resolved?.pkg).toBe('kirill/my-plugin');
  });

  it('RS-51: unknown token → resolves to null', async () => {
    const svc = makeService();
    const result = await svc.resolveShareToken('kbrt_unknown');
    expect(result).toBeNull();
  });
});

describe('RegistryService.stats', () => {
  it('RS-60: initial stats are zero', async () => {
    const svc = makeService();
    const stats = await svc.getStats('kirill', 'my-plugin');
    expect(stats.installs).toBe(0);
  });

  it('RS-61: incrementInstalls increments counter', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    await svc.incrementInstalls('kirill', 'my-plugin');
    await svc.incrementInstalls('kirill', 'my-plugin');

    const stats = await svc.getStats('kirill', 'my-plugin');
    expect(stats.installs).toBe(2);
  });
});

describe('RegistryService.listPublicPackages', () => {
  it('RS-70: empty registry returns empty array', async () => {
    const svc = makeService();
    const list = await svc.listPublicPackages();
    expect(list).toEqual([]);
  });

  it('RS-71: public packages appear in index, private do not', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    await svc.publish(SMALL_TARBALL, { ...makePkg({ name: 'private-plugin' }), visibility: 'private' }, 'kirill', 'ns-kirill');

    const list = await svc.listPublicPackages();
    expect(list.find(p => p.name === 'my-plugin')).toBeDefined();
    expect(list.find(p => p.name === 'private-plugin')).toBeUndefined();
  });

  it('ignores and invalidates the legacy warm catalog index cache key', async () => {
    const cache = createMemoryCache();
    const svc = new RegistryService({
      storage: createMemoryStorage(), cache, logger: noopLogger,
      baseUrl: 'http://localhost:5071', siteUrl: 'https://kblabs.ru',
    });
    await cache.set('registry:search:__index', [{
      handle: 'private-author', name: 'hidden', fullName: 'private-author/hidden', version: '9.9.9',
      description: 'legacy cached private metadata', primaryKind: 'plugin', installs: 123,
    }]);

    await expect(svc.listPublicPackages()).resolves.toEqual([]);
    expect(await cache.get('registry:search:__index')).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'legacy cached private metadata' }),
    ]));

    await svc.publish(SMALL_TARBALL, makePkg({ name: 'public-widget', description: 'safe catalog metadata' }), 'public-author', 'ns-public');

    expect(await cache.get('registry:search:__index')).toBeNull();
    await expect(svc.listPublicPackages()).resolves.toEqual([
      expect.objectContaining({ name: 'public-widget', description: 'safe catalog metadata' }),
    ]);
  });

  it('RS-72: featured packages appear first', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    await svc.publish(SMALL_TARBALL, makePkg({ name: 'featured-plugin' }), 'alice', 'ns-alice');
    await svc.setFeatured('alice', 'featured-plugin', true);

    const list = await svc.listPublicPackages();
    expect(list[0]?.name).toBe('featured-plugin');
  });

  it('does not serve a stale filtered search result after package metadata changes', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg({ description: 'before update' }), 'kirill', 'ns-kirill');
    await expect(svc.searchPackages('my-plugin')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'before update' }),
    ]));

    await svc.updateMeta('kirill', 'my-plugin', { description: 'after update' });

    await expect(svc.searchPackages('my-plugin')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'after update' }),
    ]));
  });
});
