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
    listPublicPackages: vi.fn().mockResolvedValue([{ name: 'my-plugin', fullName: 'kirill/my-plugin', version: '1.0.0', installs: 42 }]),
    getEntry: vi.fn().mockResolvedValue(pkg),
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

async function buildApp(authCtx?: { namespaceId: string; permissions?: string[] }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 55 * 1024 * 1024 } });

  app.addHook('onRequest', async (req) => {
    const injected = authCtx ? gatewayHeaders(authCtx) : {};
    for (const [name, value] of Object.entries(injected)) { req.headers[name] = value; }
  });
  app.addHook('onRequest', createRegistryAuthMiddleware(REGISTRY_INTERNAL_SECRET));

  const registry = makeMockRegistry();
  registerPackageRoutes(app, registry as any);

  app.setErrorHandler((err: any, _req, reply) => {
    const code = err.code ?? 'UNKNOWN';
    if (code === 'PACKAGE_NOT_FOUND' || code === 'VERSION_NOT_FOUND') {
      return reply.code(404).send({ error: 'NotFound', code, message: err.message });
    }
    if (code === 'VERSION_ALREADY_EXISTS') {
      return reply.code(409).send({ error: 'Conflict', code, message: err.message });
    }
    if (err.statusCode) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  });

  return app;
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
