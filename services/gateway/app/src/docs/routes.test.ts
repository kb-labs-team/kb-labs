import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { ICache, IServiceTransport } from '@kb-labs/core-platform';
import type { GatewayConfig } from '@kb-labs/gateway-contracts';
import { registerAggregatedDocsRoutes } from './routes.js';

function makeCache(): { cache: ICache; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const cache: ICache = {
    async get<T>(k: string) { return (store.get(k) as T) ?? null; },
    async set(k: string, v: unknown) { store.set(k, v); },
    async delete(k: string) { store.delete(k); },
    async clear() { store.clear(); },
  } as unknown as ICache;
  return { cache, store };
}

const config = {
  upstreams: {
    a: { serviceId: 'a', prefix: '/a' },
    b: { serviceId: 'b', prefix: '/b' },
  },
} as unknown as GatewayConfig;

async function buildApp(transport: IServiceTransport, cache?: ICache) {
  const app = Fastify();
  // registerAggregatedDocsRoutes also registers @fastify/swagger-ui at
  // /docs-all, which requires @fastify/swagger already on the instance — in
  // production that's done by registerOpenAPI (shared/http) before this runs.
  const swagger = await import('@fastify/swagger');
  await app.register(swagger.default ?? swagger, { openapi: { info: { title: 't', version: '1' } } });
  registerAggregatedDocsRoutes(app, config, transport, cache);
  await app.ready();
  return app;
}

describe('GET /openapi-merged.json', () => {
  it('excludes a 503 "not ready" upstream from the merge instead of treating its error body as a spec', async () => {
    // Regression: IServiceTransport.call resolves (doesn't reject) on non-2xx —
    // a booting upstream's 503 error body was indistinguishable from a real
    // spec and got merged in / returned as-is.
    const transport: IServiceTransport = {
      connectionInfo: () => undefined,
      call: async (serviceId: string) => {
        if (serviceId === 'a') {
          return { ok: false, statusCode: 503, payload: { error: 'OpenAPI spec not ready' } };
        }
        return {
          ok: true,
          statusCode: 200,
          payload: { openapi: '3.1.0', info: { title: 'b' }, paths: { '/b/x': {} } },
        };
      },
      stream: async () => { throw new Error('not used'); },
    } as unknown as IServiceTransport;

    const app = await buildApp(transport);
    const res = await app.inject({ method: 'GET', url: '/openapi-merged.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toBeTruthy();
    expect(body.paths).toHaveProperty('/b/x');
    await app.close();
  });

  it('returns a valid merged doc, not a bare error body, when only one upstream answers and it is not ready', async () => {
    const transport: IServiceTransport = {
      connectionInfo: () => undefined,
      call: async () => ({ ok: false, statusCode: 503, payload: { error: 'OpenAPI spec not ready' } }),
      stream: async () => { throw new Error('not used'); },
    } as unknown as IServiceTransport;

    const app = await buildApp(transport);
    const res = await app.inject({ method: 'GET', url: '/openapi-merged.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi ?? body.swagger).toBeTruthy();
    await app.close();
  });

  it('does not cache a degraded merge computed from zero real specs', async () => {
    const transport: IServiceTransport = {
      connectionInfo: () => undefined,
      call: async () => ({ ok: false, statusCode: 503, payload: { error: 'not ready' } }),
      stream: async () => { throw new Error('not used'); },
    } as unknown as IServiceTransport;
    const { cache, store } = makeCache();

    const app = await buildApp(transport, cache);
    await app.inject({ method: 'GET', url: '/openapi-merged.json' });
    expect(store.has('__gateway_merged_openapi')).toBe(false);
    await app.close();
  });

  it('caches a merge that includes at least one real spec', async () => {
    const transport: IServiceTransport = {
      connectionInfo: () => undefined,
      call: async () => ({
        ok: true,
        statusCode: 200,
        payload: { openapi: '3.1.0', info: { title: 'a' }, paths: {} },
      }),
      stream: async () => { throw new Error('not used'); },
    } as unknown as IServiceTransport;
    const { cache, store } = makeCache();

    const app = await buildApp(transport, cache);
    await app.inject({ method: 'GET', url: '/openapi-merged.json' });
    expect(store.has('__gateway_merged_openapi')).toBe(true);
    await app.close();
  });
});
