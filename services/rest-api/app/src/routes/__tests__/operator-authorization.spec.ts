import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { forwardedIdentityHeaders } from '@kb-labs/gateway-contracts';
import { PERMISSIONS } from '@kb-labs/core-contracts';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { ICronManager } from '@kb-labs/core-platform';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import { registerEnvelopeMiddleware } from '../../middleware/envelope.js';
import { registerCacheRoutes } from '../cache.js';
import { registerDebugRoutes, registerRouteCollector } from '../debug.js';
import { registerJobsRoutes } from '../jobs.js';

const internalSecret = 'operator-test-internal-secret';
const config: RestApiConfig = {
  port: 3000,
  basePath: '/api/v1',
  apiVersion: 'test',
  cors: { origins: [], allowCredentials: true, profile: 'dev' },
  plugins: [],
  mockMode: false,
};

describe('REST operator authorization', () => {
  afterEach(() => vi.unstubAllEnvs());

  // case: S-257.1
  it('denies tenant members before route inventory, cache refresh, or job diagnostics', async () => {
    vi.stubEnv('GATEWAY_INTERNAL_SECRET', internalSecret);
    const app = Fastify({ logger: false }) as unknown as FastifyInstance;
    const registry = {
      snapshot: vi.fn(() => ({ plugins: [] })),
      refresh: vi.fn(async () => undefined),
      listPlugins: vi.fn(async () => []),
    } as unknown as IEntityRegistry;
    const cronManager = { list: vi.fn(() => []) } as unknown as ICronManager;
    registerEnvelopeMiddleware(app, config);
    registerRouteCollector(app);
    await registerDebugRoutes(app, config);
    await registerCacheRoutes(app, config, registry);
    await registerJobsRoutes(app, config, cronManager);
    await app.ready();

    try {
      const memberHeaders = forwardedIdentityHeaders({
        type: 'user', userId: 'tenant-member', namespaceId: 'tenant-a', tier: 'free',
        permissions: [PERMISSIONS.PROJECTS_READ, PERMISSIONS.WORKFLOWS_READ],
      }, internalSecret);
      const paths = [
        { method: 'GET', url: '/api/v1/routes' },
        { method: 'POST', url: '/api/v1/cache/invalidate' },
        { method: 'GET', url: '/api/v1/jobs' },
        { method: 'GET', url: '/api/v1/jobs/stats' },
      ] as const;

      for (const request of paths) {
        const response = await app.inject({ ...request, headers: memberHeaders });
        expect(response.statusCode, request.url).toBe(403);
        expect(response.json().error.code, request.url).toBe('KB_AUTH_FORBIDDEN');
      }
      expect(registry.refresh).not.toHaveBeenCalled();
      expect(cronManager.list).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
