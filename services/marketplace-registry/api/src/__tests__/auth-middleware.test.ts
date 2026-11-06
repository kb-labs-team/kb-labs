import Fastify, { type FastifyRequest, type RouteOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegistryAuthMiddleware } from '../auth-middleware.js';
import { registerPackageRoutes } from '../routes/packages.js';
import type { RegistryService } from '@kb-labs/marketplace-registry-core';

const headers = { 'x-internal-secret': 'registry-internal-secret' };
const userHeaders = {
  ...headers,
  'x-kb-auth-type': 'user',
  'x-kb-auth-user-id': 'author-1',
  'x-kb-auth-namespace-id': 'tenant-1',
  'x-kb-auth-tier': 'free',
  'x-kb-auth-permissions': '["packages:read"]',
};

describe('registry gateway identity', () => {
  let app: Awaited<ReturnType<typeof Fastify>> | undefined;
  afterEach(async () => { await app?.close(); });

  it('rejects direct or anonymous requests without the gateway secret', async () => {
    app = Fastify();
    app.addHook('onRequest', createRegistryAuthMiddleware('registry-internal-secret'));
    const handler = vi.fn(async (request: { authContext?: unknown }) => ({ auth: request.authContext ?? null }));
    app.get('/api/v1/my/packages', { config: { registryAccess: 'user' } }, handler);
    await app.ready();

    for (const headers of [{}, { 'x-internal-secret': 'wrong' }]) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/my/packages', headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'KB_AUTH_REQUIRED' } });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts only gateway-authenticated identity and does not require a user bearer token', async () => {
    app = Fastify();
    app.addHook('onRequest', createRegistryAuthMiddleware('registry-internal-secret'));
    app.get('/api/v1/my/packages', { config: { registryAccess: 'user' } }, async (request: { authContext?: unknown }) => ({ auth: request.authContext }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/my/packages',
      headers: {
        'x-internal-secret': 'registry-internal-secret',
        'x-kb-auth-type': 'user',
        'x-kb-auth-user-id': 'member-1',
        'x-kb-auth-namespace-id': 'tenant-1',
        'x-kb-auth-tier': 'free',
        'x-kb-auth-permissions': '["packages:read"]',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      auth: { type: 'user', userId: 'member-1', namespaceId: 'tenant-1', permissions: ['packages:read'] },
    });
  });

  it('allows gateway-only access to public catalog reads but not protected routes', async () => {
    app = Fastify();
    app.addHook('onRequest', createRegistryAuthMiddleware('registry-internal-secret'));
    const catalog = vi.fn(async (request: { authContext?: unknown }) => ({ auth: request.authContext ?? null }));
    const protectedHandler = vi.fn(async () => ({ ok: true }));
    app.get('/api/v1/packages', { config: { registryAccess: 'public' } }, catalog);
    app.get('/api/v1/my/packages', { config: { registryAccess: 'user' } }, protectedHandler);
    await app.ready();

    const headers = { 'x-internal-secret': 'registry-internal-secret' };
    const publicRead = await app.inject({ method: 'GET', url: '/api/v1/packages', headers });
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.json()).toEqual({ auth: null });

    const protectedRead = await app.inject({ method: 'GET', url: '/api/v1/my/packages', headers });
    expect(protectedRead.statusCode).toBe(401);
    expect(protectedRead.json()).toMatchObject({ error: { code: 'KB_AUTH_REQUIRED' } });
    expect(protectedHandler).not.toHaveBeenCalled();
  });

  it('declares an access class for every registered marketplace route', async () => {
    app = Fastify();
    const routes: Array<{ method: string | undefined; url: string | undefined; access: unknown }> = [];
    app.addHook('onRoute', (route: RouteOptions) => {
      routes.push({
        method: Array.isArray(route.method) ? route.method.join(',') : route.method,
        url: route.url,
        access: route.config?.registryAccess,
      });
    });
    registerPackageRoutes(app, {} as RegistryService);
    await app.ready();

    expect(routes.length).toBeGreaterThan(0);
    expect(routes.every((route) => ['public', 'service', 'user', 'admin'].includes(String(route.access)))).toBe(true);
  });

  it('requires an authenticated identity for user routes and admin permission for admin routes', async () => {
    app = Fastify();
    app.addHook('onRequest', createRegistryAuthMiddleware('registry-internal-secret'));
    app.get('/user', { config: { registryAccess: 'user' } }, async (request: FastifyRequest) => ({ auth: request.authContext }));
    app.get('/admin', { config: { registryAccess: 'admin' } }, async () => ({ ok: true }));
    await app.ready();

    const serviceUser = await app.inject({ method: 'GET', url: '/user', headers });
    expect(serviceUser.statusCode).toBe(401);
    expect(serviceUser.json()).toMatchObject({ error: { code: 'KB_AUTH_REQUIRED' } });

    const identity = await app.inject({ method: 'GET', url: '/user', headers: userHeaders });
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toMatchObject({ auth: { namespaceId: 'tenant-1' } });

    const nonAdmin = await app.inject({ method: 'GET', url: '/admin', headers: userHeaders });
    expect(nonAdmin.statusCode).toBe(403);
    expect(nonAdmin.json()).toMatchObject({ ok: false, error: { code: 'KB_AUTH_FORBIDDEN', details: { permission: 'admin' } } });
  });

  it('allows only service identity on service routes', async () => {
    app = Fastify();
    app.addHook('onRequest', createRegistryAuthMiddleware('registry-internal-secret'));
    app.get('/service', { config: { registryAccess: 'service' } }, async () => ({ ok: true }));
    await app.ready();

    const service = await app.inject({ method: 'GET', url: '/service', headers });
    expect(service.statusCode).toBe(200);

    const user = await app.inject({ method: 'GET', url: '/service', headers: userHeaders });
    expect(user.statusCode).toBe(401);
  });
});
