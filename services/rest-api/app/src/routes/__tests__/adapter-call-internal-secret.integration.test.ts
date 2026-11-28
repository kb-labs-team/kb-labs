import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kb-labs/core-runtime', () => ({
  platform: {
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
    cache: { get: async () => null },
    getAdapter: () => ({ get: async () => null }),
  },
}));

import { registerAdapterCallRoutes } from '../adapter-call.js';

describe('REST internal adapter-call route authentication', () => {
  const previousSecret = process.env.GATEWAY_INTERNAL_SECRET;
  afterEach(() => {
    if (previousSecret === undefined) { delete process.env.GATEWAY_INTERNAL_SECRET; }
    else { process.env.GATEWAY_INTERNAL_SECRET = previousSecret; }
  });

  it('executes only when the caller supplies the route secret at the actual REST route', async () => {
    process.env.GATEWAY_INTERNAL_SECRET = 'rest-route-internal-secret';
    const app = Fastify({ logger: false });
    await registerAdapterCallRoutes(app);
    await app.ready();

    try {
      const payload = {
        requestId: 'rest-route-auth-test',
        adapter: 'cache',
        method: 'get',
        args: ['rest-route-auth-test'],
        context: { namespaceId: 'test', hostId: 'test' },
      };
      const authorized = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/adapter-call',
        headers: { 'x-internal-secret': 'rest-route-internal-secret' },
        payload,
      });
      expect(authorized.statusCode).toBe(200);

      for (const [url, expectedStatus] of [
        ['/api/v1/internal/adapter-call', 403],
        ['/api/v1/internal/%61dapter-call', 403],
        ['/api/v1/%69nternal/adapter-call', 403],
        ['/api/v1//internal/adapter-call', 404],
        ['/api/v1/internal/../internal/adapter-call', 403],
        ['/api/v1/internal%2Fadapter-call', 404],
      ] as const) {
        const denied = await app.inject({
          method: 'POST',
          url,
          headers: { 'x-internal-secret': 'invalid-route-secret' },
          payload,
        });
        expect(denied.statusCode, url).toBe(expectedStatus);
        if (denied.statusCode === 403) {
          expect(denied.json().error.code, url).toBe('KB_AUTH_FORBIDDEN');
        }
      }
    } finally {
      await app.close();
    }
  });
});
