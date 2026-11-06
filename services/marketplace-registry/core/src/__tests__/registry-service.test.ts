import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
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

function makeService(extraOpts?: { signingPrivateKey?: string }): RegistryService {
  return new RegistryService({
    storage: createMemoryStorage(),
    cache: createMemoryCache(),
    logger: noopLogger,
    baseUrl: 'http://localhost:5071',
    siteUrl: 'https://kblabs.ru',
    ...extraOpts,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RegistryService.publish', () => {
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
  it('RS-50: createShareToken + resolveShareToken round trip', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');

    const { token, pkg, expiresAt } = await svc.createShareToken('kirill', 'my-plugin', 60_000);
    expect(token).toMatch(/^kbrt_/);
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

  it('RS-72: featured packages appear first', async () => {
    const svc = makeService();
    await svc.publish(SMALL_TARBALL, makePkg(), 'kirill', 'ns-kirill');
    await svc.publish(SMALL_TARBALL, makePkg({ name: 'featured-plugin' }), 'alice', 'ns-alice');
    await svc.setFeatured('alice', 'featured-plugin', true);

    const list = await svc.listPublicPackages();
    expect(list[0]?.name).toBe('featured-plugin');
  });
});
