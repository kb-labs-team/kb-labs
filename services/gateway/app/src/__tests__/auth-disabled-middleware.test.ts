/**
 * Tests for the machine-auth middleware in "auth disabled" mode (B-023).
 *
 * When auth.enabled is false (solo/local mode) every request must pass without
 * a token and run as the deterministic LOCAL_ADMIN identity. When auth is
 * enabled (default) a tokenless request is still rejected with 401.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ICache } from '@kb-labs/core-platform';
import type { JwtConfig } from '@kb-labs/gateway-auth';
import { createAuthMiddleware, LOCAL_ADMIN_CONTEXT } from '../auth/middleware.js';

function makeCache(): ICache {
  const store = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return (store.get(k) as T) ?? null; },
    async set(k: string, v: unknown) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async clear() { store.clear(); },
  } as unknown as ICache;
}

const jwtConfig: JwtConfig = { secret: 'test-secret' };

async function buildApp(authEnabled: boolean, internalSecret?: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', createAuthMiddleware(makeCache(), jwtConfig, { authEnabled, internalSecret }));
  app.get('/protected', async (request) => ({
    ok: true,
    userId: request.authContext?.userId ?? null,
    forwardedUserId: request.headers['x-kb-auth-user-id'] ?? null,
    forwardedNamespaceId: request.headers['x-kb-auth-namespace-id'] ?? null,
    forwardedInternalSecret: request.headers['x-internal-secret'] ?? null,
  }));
  await app.ready();
  return app;
}

describe('auth middleware — disabled mode (B-023)', () => {
  let app: FastifyInstance;
  beforeEach(() => { app = undefined as unknown as FastifyInstance; });

  it('auth disabled: tokenless request passes as LOCAL_ADMIN', async () => {
    app = await buildApp(false);
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; userId: string };
    expect(body.ok).toBe(true);
    expect(body.userId).toBe(LOCAL_ADMIN_CONTEXT.userId);
    await app.close();
  });

  it('local identity forwarding replaces caller-supplied trust headers', async () => {
    app = await buildApp(false, 'gateway-internal-fixture');
    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        'x-internal-secret': 'caller-forgery',
        'x-kb-auth-user-id': 'caller-forgery',
        'x-kb-auth-namespace-id': 'caller-forgery',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      userId: 'local-admin',
      forwardedUserId: 'local-admin',
      forwardedNamespaceId: 'local',
      forwardedInternalSecret: 'gateway-internal-fixture',
    });
    await app.close();
  });

  it('auth enabled (default): tokenless request is rejected with 401', async () => {
    app = await buildApp(true);
    const res = await app.inject({ method: 'GET', url: '/protected' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('LOCAL_ADMIN has full permissions and a deterministic namespace', () => {
    expect(LOCAL_ADMIN_CONTEXT.namespaceId).toBe('local');
    expect(LOCAL_ADMIN_CONTEXT.tier).toBe('enterprise');
    expect(LOCAL_ADMIN_CONTEXT.permissions.length).toBeGreaterThan(0);
  });
});
