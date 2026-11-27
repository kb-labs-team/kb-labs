import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { ILogger } from '@kb-labs/core-platform';
import { registerPackageRoutes } from '../routes/packages.js';
import { createRegistryAuthMiddleware } from '../auth-middleware.js';

const REGISTRY_INTERNAL_SECRET = 'registry-test-internal-secret';
const gatewayHeaders = (authCtx?: { namespaceId: string; permissions?: string[] }): Record<string, string> => ({
  'x-internal-secret': REGISTRY_INTERNAL_SECRET,
  ...(authCtx ? {
    'x-kb-auth-type': 'user',
    'x-kb-auth-user-id': 'test-user',
    'x-kb-auth-namespace-id': authCtx.namespaceId,
    'x-kb-auth-tier': 'free',
    'x-kb-auth-permissions': JSON.stringify(authCtx.permissions ?? []),
  } : {}),
});

// ── Minimal logger ─────────────────────────────────────────────────────────────

const noopLog: ILogger = {
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
  error: vi.fn(), fatal: vi.fn(), flush: vi.fn().mockResolvedValue(undefined), child: () => noopLog,
};

// ── Registry service mock ──────────────────────────────────────────────────────

function makeMockRegistry() {
  const pkg = {
    name: 'my-plugin',
    authorHandle: 'kirill',
    authorNamespaceId: 'ns-kirill',
    visibility: 'public' as const,
    trust: 'untrusted' as const,
    allowlist: [],
    versions: [{ version: '1.0.0', publishedAt: '2024-01-01T00:00:00.000Z', integrity: 'sha256-abc', yanked: false }],
    deprecated: false,
    featured: false,
    badges: [],
    tags: [],
    meta: { name: 'my-plugin', version: '1.0.0', identity: '@kirill/my-plugin' },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  return {
    resolveIdentity: vi.fn().mockResolvedValue({
      status: 'found',
      package: {
        id: '@kirill/my-plugin', version: '1.0.0', integrity: 'sha256-abc', primaryKind: 'plugin',
        signatureSubject: 'kirill/my-plugin', downloadUrl: 'https://registry.test/api/v1/packages/kirill/my-plugin/1.0.0/tarball',
      },
    }),
    listPublicPackages: vi.fn().mockResolvedValue([{ name: 'my-plugin', fullName: 'kirill/my-plugin', version: '1.0.0', installs: 42 }]),
    getEntry: vi.fn().mockResolvedValue(pkg),
    getVisibleEntry: vi.fn().mockImplementation((entry: unknown) => entry),
    getStats: vi.fn().mockResolvedValue({ installs: 42 }),
    canAccess: vi.fn().mockReturnValue(true),
    resolveShareToken: vi.fn().mockResolvedValue(null),
    listByAuthor: vi.fn().mockResolvedValue([pkg]),
    publish: vi.fn().mockResolvedValue({
      handle: 'kirill',
      name: 'my-plugin',
      version: '1.0.0',
      visibility: 'public',
      trust: 'untrusted',
      installCommand: 'kb marketplace install kb:kirill/my-plugin',
    }),
    updateMeta: vi.fn().mockResolvedValue(undefined),
    yank: vi.fn().mockResolvedValue(undefined),
    deprecate: vi.fn().mockResolvedValue(undefined),
    addToAllowlist: vi.fn().mockResolvedValue(undefined),
    createShareToken: vi.fn().mockResolvedValue({ token: 'kbrt_test', pkg: 'kirill/my-plugin', expiresAt: '' }),
    getTarball: vi.fn().mockResolvedValue({ tarball: Buffer.from('fake'), signature: undefined }),
    incrementInstalls: vi.fn().mockResolvedValue(undefined),
    setFeatured: vi.fn().mockResolvedValue(undefined),
  };
}

// ── App factory ────────────────────────────────────────────────────────────────

async function buildApp(
  authCtx?: { namespaceId: string; permissions?: string[] },
  registry: ReturnType<typeof makeMockRegistry> = makeMockRegistry(),
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 55 * 1024 * 1024 } });

  app.addHook('onRequest', async (req) => {
    const injected = authCtx ? gatewayHeaders(authCtx) : {};
    for (const [name, value] of Object.entries(injected)) { req.headers[name] = value; }
  });
  app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));

  registerPackageRoutes(app, registry as any);

  app.setErrorHandler((err: any, _req, reply) => {
    const code = err.code ?? 'UNKNOWN';
    if (code === 'PACKAGE_NOT_FOUND' || code === 'VERSION_NOT_FOUND') {
      return reply.code(404).send({ error: 'NotFound', code, message: err.message });
    }
    if (code === 'VERSION_ALREADY_EXISTS') {
      return reply.code(409).send({ error: 'Conflict', code, message: err.message });
    }
    if (code === 'FORBIDDEN') {
      return reply.code(403).send({ error: 'Forbidden', code, message: err.message });
    }
    if (err.statusCode) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  });

  return app;
}

function publishMultipartBody(tarball: Buffer, meta: Record<string, unknown>): { boundary: string; payload: Buffer } {
  const boundary = 'kb-registry-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="tarball"; filename="package.tgz"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    tarball,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}--\r\n`),
  ]);
  return { boundary, payload };
}

// ── Test suites ────────────────────────────────────────────────────────────────

describe('GET /api/v1/packages (public)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(() => app.close());

  it('AC-01: 200 with package list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/packages', headers: gatewayHeaders() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ name: 'my-plugin' });
  });
});

describe('GET /api/v1/packages/:handle/:name (public)', () => {
  it('AC-10: 200 for accessible package', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/packages/kirill/my-plugin', headers: gatewayHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'my-plugin' });
    await app.close();
  });

  it('AC-11: 403 when canAccess returns false', async () => {
    const app = await buildApp();
    const registry = makeMockRegistry();
    registry.canAccess.mockReturnValue(false);
    registry.getEntry.mockResolvedValue({
      name: 'private-pkg',
      authorHandle: 'kirill',
      authorNamespaceId: 'ns-kirill',
      visibility: 'private',
      trust: 'untrusted',
      allowlist: [],
      versions: [],
      deprecated: false,
      featured: false,
      badges: [],
      tags: [],
      meta: { name: 'private-pkg', version: '1.0.0', identity: '@kirill/private-pkg' },
      createdAt: '',
      updatedAt: '',
    });
    const freshApp = Fastify({ logger: false });
    await freshApp.register(multipart, {});
    freshApp.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(freshApp, registry as any);
    const res = await freshApp.inject({ method: 'GET', url: '/api/v1/packages/kirill/private-pkg', headers: gatewayHeaders() });
    expect(res.statusCode).toBe(403);
    await freshApp.close();
    await app.close();
  });

  it('passes the optional forwarded namespace to canAccess for a private package', async () => {
    const app = Fastify({ logger: false });
    const registry = makeMockRegistry();
    app.setErrorHandler((err: any, _req, reply) => reply.code(err.code === 'VERSION_NOT_FOUND' ? 404 : 500).send({ code: err.code }));
    const entry = {
      name: 'private-pkg', authorHandle: 'kirill', authorNamespaceId: 'ns-kirill',
      visibility: 'private' as const, trust: 'untrusted' as const, allowlist: [], versions: [],
      deprecated: false, featured: false, badges: [], tags: [], meta: { name: 'private-pkg', version: '1.0.0', identity: '@kirill/private-pkg' },
      createdAt: '', updatedAt: '',
    };
    registry.getEntry.mockResolvedValue(entry);
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/packages/kirill/private-pkg',
      headers: gatewayHeaders({ namespaceId: 'tenant-1' }),
    });
    expect(response.statusCode).toBe(200);
    expect(registry.canAccess).toHaveBeenCalledWith(entry, 'tenant-1', null);
    await app.close();
  });

  it('AC-12: 404 when package does not exist', async () => {
    const app = Fastify({ logger: false });
    await app.register(multipart, {});
    const registry = makeMockRegistry();
    registry.getEntry.mockResolvedValue(null);
    registerPackageRoutes(app, registry as any);
    const res = await app.inject({ method: 'GET', url: '/api/v1/packages/kirill/ghost' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /api/v1/packages/:handle/:name/stats', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(() => app.close());

  it('AC-20: returns stats with installs count', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/packages/kirill/my-plugin/stats', headers: gatewayHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ installs: 42 });
  });
});

describe('public Registry resolution and tarball access', () => {
  // case: S-268.1
  it('resolves and downloads a public package through the Gateway service identity without a Registry user identity', async () => {
    const app = Fastify({ logger: false });
    const registry = makeMockRegistry();
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const resolution = await app.inject({
      method: 'GET', url: '/api/v1/resolve?identity=%40kirill%2Fmy-plugin', headers: gatewayHeaders(),
    });
    expect(resolution.statusCode).toBe(200);
    expect(registry.canAccess).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public' }), null, null, '1.0.0');

    const download = await app.inject({
      method: 'GET', url: '/api/v1/packages/kirill/my-plugin/1.0.0/tarball', headers: gatewayHeaders(),
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(Buffer.from('fake'));
    expect(registry.canAccess).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public' }), null, null, '1.0.0');
    await app.close();
  });

  it('hides an anonymous private tarball as VERSION_NOT_FOUND before reading or counting it', async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler((err: any, _req, reply) => reply.code(err.code === 'VERSION_NOT_FOUND' ? 404 : 500).send({ code: err.code }));
    const registry = makeMockRegistry();
    registry.getEntry.mockResolvedValue({
      name: 'my-plugin', authorHandle: 'kirill', authorNamespaceId: 'ns-kirill',
      visibility: 'private', trust: 'untrusted', allowlist: [], versions: [{ version: '1.0.0', visibility: 'private' }], deprecated: false,
      featured: false, badges: [], tags: [], meta: { name: 'my-plugin', version: '1.0.0', identity: '@kirill/my-plugin' },
      createdAt: '', updatedAt: '',
    });
    registry.canAccess.mockReturnValue(false);
    registry.getTarball.mockRejectedValue(Object.assign(new Error('Version 1.0.0 not found'), { code: 'VERSION_NOT_FOUND' }));
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const response = await app.inject({
      method: 'GET', url: '/api/v1/packages/kirill/my-plugin/1.0.0/tarball', headers: gatewayHeaders(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' });
    expect(registry.getTarball).toHaveBeenCalledWith('kirill', 'my-plugin', '1.0.0', { namespaceId: null, shareToken: null });
    expect(registry.incrementInstalls).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not distinguish an unknown tarball version from an inaccessible private version', async () => {
    const registry = makeMockRegistry();
    registry.getEntry.mockResolvedValue({
      name: 'my-plugin', authorHandle: 'kirill', authorNamespaceId: 'ns-kirill', visibility: 'public',
      trust: 'untrusted', allowlist: [], versions: [
        { version: '1.0.0' }, { version: '9.9.9', visibility: 'private' },
      ],
      deprecated: false, featured: false, badges: [], tags: [],
      meta: { name: 'my-plugin', version: '1.0.0', identity: '@kirill/my-plugin' }, createdAt: '', updatedAt: '',
    });
    registry.canAccess.mockReturnValue(false);
    registry.getTarball.mockImplementation(async (_handle, _name, version) => {
      throw Object.assign(new Error(`Version ${version} not found`), { code: 'VERSION_NOT_FOUND' });
    });
    const app = await buildApp(undefined, registry);
    const knownPrivate = await app.inject({ method: 'GET', url: '/api/v1/packages/kirill/my-plugin/1.0.0/tarball', headers: gatewayHeaders() });
    const hiddenVersion = await app.inject({ method: 'GET', url: '/api/v1/packages/kirill/my-plugin/9.9.9/tarball', headers: gatewayHeaders() });
    const absentVersion = await app.inject({ method: 'GET', url: '/api/v1/packages/kirill/my-plugin/8.8.8/tarball', headers: gatewayHeaders() });
    expect(knownPrivate.statusCode).toBe(404);
    expect(hiddenVersion.statusCode).toBe(knownPrivate.statusCode);
    expect(absentVersion.statusCode).toBe(404);
    expect(hiddenVersion.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' });
    expect(absentVersion.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' });
    expect(knownPrivate.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' });
    expect(registry.getTarball).toHaveBeenCalledWith('kirill', 'my-plugin', '1.0.0', { namespaceId: null, shareToken: null });
    await app.close();

    const publicRegistry = makeMockRegistry();
    publicRegistry.getTarball.mockImplementation(async (_handle, _name, version) => {
      throw Object.assign(new Error(`Version ${version} not found`), { code: 'VERSION_NOT_FOUND' });
    });
    const publicApp = await buildApp(undefined, publicRegistry);
    const publicUnknown = await publicApp.inject({
      method: 'GET', url: '/api/v1/packages/kirill/my-plugin/9.9.9/tarball', headers: gatewayHeaders(),
    });
    const publicAbsent = await publicApp.inject({
      method: 'GET', url: '/api/v1/packages/kirill/my-plugin/8.8.8/tarball', headers: gatewayHeaders(),
    });
    expect(publicUnknown.statusCode).toBe(404);
    expect(publicUnknown.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' });
    expect(publicUnknown.json()).toEqual(hiddenVersion.json());
    expect(publicAbsent.json()).toEqual(absentVersion.json());
    await publicApp.close();

    const ownerRegistry = makeMockRegistry();
    ownerRegistry.getTarball.mockRejectedValue(Object.assign(new Error('Version 9.9.9 not found'), { code: 'VERSION_NOT_FOUND' }));
    const ownerApp = await buildApp({ namespaceId: 'ns-kirill' }, ownerRegistry);
    const ownerUnknown = await ownerApp.inject({ method: 'GET', url: '/api/v1/packages/kirill/my-plugin/9.9.9/tarball' });
    expect(ownerUnknown.statusCode).toBe(404);
    expect(ownerUnknown.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' });
    await ownerApp.close();
  });

  // case: S-268.21
  it('checks visibility of the requested tarball version before reading or counting it', async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler((err: any, _req, reply) => reply.code(err.code === 'VERSION_NOT_FOUND' ? 404 : 500).send({ code: err.code }));
    const registry = makeMockRegistry();
    const baseEntry = await registry.getEntry('kirill', 'my-plugin');
    registry.getEntry.mockResolvedValue({
      ...baseEntry,
      visibility: 'public',
      versions: [
        { version: '1.0.0', visibility: 'private' },
        { version: '2.0.0', visibility: 'public' },
      ],
    });
    registry.canAccess.mockImplementation((_entry, _namespace, _token, version) => version !== '1.0.0');
    registry.getTarball.mockImplementation(async (_handle, _name, version) => {
      if (version !== '2.0.0') { throw Object.assign(new Error(`Version ${version} not found`), { code: 'VERSION_NOT_FOUND' }); }
      return { tarball: Buffer.from('fake'), signature: undefined };
    });
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const privateDownload = await app.inject({
      method: 'GET', url: '/api/v1/packages/kirill/my-plugin/1.0.0/tarball', headers: gatewayHeaders(),
    });
    expect(privateDownload.statusCode).toBe(404);
    expect(privateDownload.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' });
    expect(registry.getTarball).toHaveBeenCalledWith('kirill', 'my-plugin', '1.0.0', { namespaceId: null, shareToken: null });
    expect(registry.incrementInstalls).not.toHaveBeenCalled();
    await app.close();
  });

  // case: S-268.21
  it('returns only accessible version metadata and the matching metadata snapshot', async () => {
    const app = Fastify({ logger: false });
    const registry = makeMockRegistry();
    const baseEntry = await registry.getEntry('kirill', 'my-plugin');
    const entry = {
      ...baseEntry,
      visibility: 'private',
      meta: { name: 'my-plugin', version: '2.0.0', identity: '@kirill/my-plugin', description: 'private release' },
      versions: [
        { version: '1.0.0', visibility: 'public', meta: { name: 'my-plugin', version: '1.0.0', identity: '@kirill/my-plugin', description: 'public release' } },
        { version: '2.0.0', visibility: 'private', meta: { name: 'my-plugin', version: '2.0.0', identity: '@kirill/my-plugin', description: 'private release' } },
      ],
    };
    registry.getEntry.mockResolvedValue(entry);
    registry.getVisibleEntry.mockImplementation((value) => ({
      ...value,
      authorNamespaceId: '',
      allowlist: [],
      visibility: 'public',
      meta: value.versions[0].meta,
      versions: [value.versions[0]],
    }));
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const response = await app.inject({ method: 'GET', url: '/api/v1/packages/kirill/my-plugin', headers: gatewayHeaders() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      visibility: 'public', authorNamespaceId: '', allowlist: [],
      meta: { version: '1.0.0', description: 'public release' },
      versions: [{ version: '1.0.0', visibility: 'public' }],
    });
    expect(response.json().versions).toHaveLength(1);
    expect(registry.getVisibleEntry).toHaveBeenCalledWith(entry, null, null);
    await app.close();
  });

  // case: S-268.21
  it('does not expose stats for a package with no accessible versions', async () => {
    const app = Fastify({ logger: false });
    const registry = makeMockRegistry();
    const baseEntry = await registry.getEntry('kirill', 'my-plugin');
    registry.getEntry.mockResolvedValue({ ...baseEntry, visibility: 'private' });
    registry.canAccess.mockReturnValue(false);
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const response = await app.inject({ method: 'GET', url: '/api/v1/packages/kirill/my-plugin/stats', headers: gatewayHeaders() });
    expect(response.statusCode).toBe(403);
    expect(registry.getStats).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps exact private identity resolution behind the Registry access check', async () => {
    const app = Fastify({ logger: false });
    const registry = makeMockRegistry();
    registry.resolveIdentity.mockResolvedValue({
      status: 'found',
      package: {
        id: 'my-plugin', version: '1.0.0', integrity: 'sha256-abc', primaryKind: 'plugin',
        signatureSubject: 'kirill/my-plugin', downloadUrl: 'https://registry.test/api/v1/packages/kirill/my-plugin/1.0.0/tarball',
      },
    });
    registry.getEntry.mockResolvedValue({
      name: 'my-plugin', authorHandle: 'kirill', authorNamespaceId: 'ns-kirill',
      visibility: 'private', trust: 'untrusted', allowlist: [], versions: [], deprecated: false,
      featured: false, badges: [], tags: [], meta: { name: 'my-plugin', version: '1.0.0', identity: '@kirill/my-plugin' },
      createdAt: '', updatedAt: '',
    });
    registry.canAccess.mockReturnValue(false);
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const response = await app.inject({
      method: 'GET', url: '/api/v1/resolve?identity=%40kirill%2Fmy-plugin', headers: gatewayHeaders(),
    });
    expect(response.statusCode).toBe(403);
    expect(registry.canAccess).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private' }), null, null, '1.0.0');
    await app.close();
  });

  // case: S-268.21
  it('denies an explicitly pinned private release even when the package has a public release', async () => {
    const app = Fastify({ logger: false });
    const registry = makeMockRegistry();
    registry.resolveIdentity.mockResolvedValue({
      status: 'found',
      package: {
        id: 'my-plugin', version: '1.0.0', integrity: 'sha256-abc', primaryKind: 'plugin',
        signatureSubject: 'kirill/my-plugin', downloadUrl: 'https://registry.test/api/v1/packages/kirill/my-plugin/1.0.0/tarball',
      },
    });
    registry.getEntry.mockResolvedValue({
      name: 'my-plugin', authorHandle: 'kirill', authorNamespaceId: 'ns-kirill',
      visibility: 'public', trust: 'untrusted', allowlist: [],
      versions: [
        { version: '1.0.0', visibility: 'private' },
        { version: '2.0.0', visibility: 'public' },
      ],
      deprecated: false, featured: false, badges: [], tags: [],
      meta: { name: 'my-plugin', version: '2.0.0', identity: '@kirill/my-plugin' }, createdAt: '', updatedAt: '',
    });
    registry.canAccess.mockImplementation((_entry, _namespace, _token, version) => version !== '1.0.0');
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const response = await app.inject({
      method: 'GET', url: '/api/v1/resolve?identity=%40kirill%2Fmy-plugin&version=1.0.0', headers: gatewayHeaders(),
    });
    expect(response.statusCode).toBe(403);
    expect(registry.resolveIdentity).toHaveBeenCalledWith('@kirill/my-plugin', null, null, '1.0.0');
    expect(registry.canAccess).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public' }), null, null, '1.0.0');
    await app.close();
  });

  // case: S-268.20
  it('resolves a share-token target before short-name selection', async () => {
    const app = Fastify({ logger: false });
    const registry = makeMockRegistry();
    const share = { pkg: 'kirill/my-plugin' };
    registry.resolveShareToken.mockResolvedValue(share);
    registry.resolveIdentity.mockResolvedValue({
      status: 'found',
      package: {
        id: 'my-plugin', version: '1.0.0', integrity: 'sha256-abc', primaryKind: 'plugin',
        signatureSubject: 'kirill/my-plugin', downloadUrl: 'https://registry.test/api/v1/packages/kirill/my-plugin/1.0.0/tarball',
      },
    });
    registry.getEntry.mockResolvedValue({
      name: 'my-plugin', authorHandle: 'kirill', authorNamespaceId: 'ns-kirill',
      visibility: 'private', trust: 'untrusted', allowlist: [], versions: [], deprecated: false,
      featured: false, badges: [], tags: [], meta: { name: 'my-plugin', version: '1.0.0', identity: '@kirill/my-plugin' },
      createdAt: '', updatedAt: '',
    });
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const response = await app.inject({
      method: 'GET', url: '/api/v1/resolve?identity=widget&token=kbrt_valid', headers: gatewayHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(registry.resolveShareToken).toHaveBeenCalledWith('kbrt_valid');
    expect(registry.resolveIdentity).toHaveBeenCalledWith('widget', null, share, undefined);
    expect(registry.resolveShareToken.mock.invocationCallOrder[0]).toBeLessThan(registry.resolveIdentity.mock.invocationCallOrder[0]!);
    expect(registry.canAccess).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private' }), null, share, '1.0.0');
    await app.close();
  });

  // case: S-268.20
  it('passes duplicate canonical identities through the publish API', async () => {
    const registry = makeMockRegistry();
    const publishAs = async (namespaceId: string, handle: string, name: string, identity: string, visibility: 'public' | 'private') => {
      const app = await buildApp({ namespaceId }, registry);
      const { boundary, payload } = publishMultipartBody(Buffer.from(`${handle}/${name}`), {
        meta: { name, version: '1.0.0', identity }, visibility, primaryKind: 'plugin',
      });
      try {
        return await app.inject({
          method: 'POST', url: '/api/v1/packages/publish', payload,
          headers: {
            ...gatewayHeaders({ namespaceId }),
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'x-author-handle': handle,
          },
        });
      } finally { await app.close(); }
    };

    expect((await publishAs('ns-public', 'public-author', 'widget-public', '@shared/widget', 'public')).statusCode).toBe(201);
    expect((await publishAs('ns-private', 'private-author', 'widget-private', '@shared/widget', 'private')).statusCode).toBe(201);
    expect(registry.publish).toHaveBeenCalledTimes(2);
    expect(registry.publish).toHaveBeenNthCalledWith(1, expect.any(Buffer), {
      meta: { name: 'widget-public', version: '1.0.0', identity: '@shared/widget' }, visibility: 'public', primaryKind: 'plugin',
    }, 'public-author', 'ns-public');
    expect(registry.publish).toHaveBeenNthCalledWith(2, expect.any(Buffer), {
      meta: { name: 'widget-private', version: '1.0.0', identity: '@shared/widget' }, visibility: 'private', primaryKind: 'plugin',
    }, 'private-author', 'ns-private');
  });

  // case: S-268.22
  it('returns forbidden when an authenticated namespace tries to append another namespace package', async () => {
    const registry = makeMockRegistry();
    registry.publish.mockRejectedValueOnce(Object.assign(
      new Error('Authenticated namespace does not own kirill/my-plugin'), { code: 'FORBIDDEN' },
    ));
    const app = await buildApp({ namespaceId: 'ns-other' }, registry);
    const { boundary, payload } = publishMultipartBody(Buffer.from('unauthorized version'), {
      meta: { name: 'my-plugin', version: '1.1.0', identity: '@kirill/my-plugin' },
      visibility: 'public', primaryKind: 'plugin',
    });
    try {
      const response = await app.inject({
        method: 'POST', url: '/api/v1/packages/publish', payload,
        headers: {
          ...gatewayHeaders({ namespaceId: 'ns-other' }),
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'x-author-handle': 'kirill',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(registry.publish).toHaveBeenCalledWith(expect.any(Buffer), {
        meta: { name: 'my-plugin', version: '1.1.0', identity: '@kirill/my-plugin' },
        visibility: 'public', primaryKind: 'plugin',
      }, 'kirill', 'ns-other');
    } finally { await app.close(); }
  });

  it('passes the authenticated owner namespace when resolving an exact private identity', async () => {
    const app = Fastify({ logger: false });
    const registry = makeMockRegistry();
    const privateEntry = {
      name: 'my-plugin', authorHandle: 'kirill', authorNamespaceId: 'ns-kirill',
      visibility: 'private' as const, trust: 'untrusted' as const, allowlist: [], versions: [],
      deprecated: false, featured: false, badges: [], tags: [], meta: { name: 'my-plugin', version: '1.0.0', identity: '@kirill/my-plugin' },
      createdAt: '', updatedAt: '',
    };
    registry.resolveIdentity.mockResolvedValue({
      status: 'found',
      package: {
        id: 'my-plugin', version: '1.0.0', integrity: 'sha256-abc', primaryKind: 'plugin',
        signatureSubject: 'kirill/my-plugin', downloadUrl: 'https://registry.test/api/v1/packages/kirill/my-plugin/1.0.0/tarball',
      },
    });
    registry.getEntry.mockResolvedValue(privateEntry);
    app.addHook('onRequest', async (request) => {
      for (const [name, value] of Object.entries(gatewayHeaders({ namespaceId: 'ns-kirill' }))) {
        request.headers[name] = value;
      }
    });
    app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));
    registerPackageRoutes(app, registry as any);

    const response = await app.inject({
      method: 'GET', url: '/api/v1/resolve?identity=%40kirill%2Fmy-plugin', headers: gatewayHeaders({ namespaceId: 'ns-kirill' }),
    });
    expect(response.statusCode).toBe(200);
    expect(registry.resolveIdentity).toHaveBeenCalledWith('@kirill/my-plugin', 'ns-kirill', null, undefined);
    expect(registry.canAccess).toHaveBeenCalledWith(privateEntry, 'ns-kirill', null, '1.0.0');
    await app.close();
  });
});

describe('Auth-required routes without authContext', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp(); }); // no auth context
  afterAll(() => app.close());

  it('AC-30: POST /api/v1/packages/publish → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/packages/publish' });
    expect(res.statusCode).toBe(401);
  });

  it('AC-31: GET /api/v1/my/packages → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/my/packages' });
    expect(res.statusCode).toBe(401);
  });

  it('AC-32: POST .../yank → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/packages/kirill/my-plugin/1.0.0/yank' });
    expect(res.statusCode).toBe(401);
  });

  it('AC-33: POST .../deprecate → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/packages/kirill/my-plugin/deprecate' });
    expect(res.statusCode).toBe(401);
  });

  it('AC-34: POST .../share/token → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/packages/kirill/my-plugin/share/token' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Auth-required routes as owner', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildApp({ namespaceId: 'ns-kirill' }); });
  afterAll(() => app.close());

  it('AC-40: POST .../deprecate → 204 for owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/packages/kirill/my-plugin/deprecate',
      payload: { message: 'archived' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('AC-41: POST .../yank → 204 for owner', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/packages/kirill/my-plugin/1.0.0/yank',
      payload: {},
    });
    expect(res.statusCode).toBe(204);
  });

  it('AC-42: POST .../share/token → 201 with token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/packages/kirill/my-plugin/share/token',
      payload: { ttlDays: 7 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ token: 'kbrt_test' });
  });

  it('AC-43: POST .../share/allowlist → 204', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/packages/kirill/my-plugin/share/allowlist',
      payload: { namespaceId: 'ns-bob' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('AC-44: GET /api/v1/my/packages → 200 with author packages', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/my/packages' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe('Admin route', () => {
  it('AC-50: POST /admin/.../feature without admin scope → 403', async () => {
    const app = await buildApp({ namespaceId: 'ns-kirill' }); // no admin permission
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/packages/kirill/my-plugin/feature',
      payload: { featured: true },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-51: POST /admin/.../feature with admin scope → 204', async () => {
    const app = await buildApp({ namespaceId: 'ns-kirill', permissions: ['admin'] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/packages/kirill/my-plugin/feature',
      payload: { featured: true },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});
