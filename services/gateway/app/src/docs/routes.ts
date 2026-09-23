/**
 * @module gateway-app/docs/routes
 * Aggregated OpenAPI documentation endpoints.
 *
 * GET /openapi-merged.json — merged spec from all upstream services
 * GET /docs-all            — Swagger UI pointing at the merged spec
 */

import type { FastifyInstance } from 'fastify';
import { mergeOpenAPISpecs } from '@kb-labs/core-registry';
import type { ICache, IServiceTransport } from '@kb-labs/core-platform';
import type { GatewayConfig } from '@kb-labs/gateway-contracts';

const MERGED_CACHE_KEY = '__gateway_merged_openapi';
const MERGED_CACHE_TTL = 30_000; // 30 second cache

export function registerAggregatedDocsRoutes(
  app: FastifyInstance,
  config: GatewayConfig,
  serviceTransport: IServiceTransport,
  cache?: ICache,
): void {
  const upstreamServiceIds = Object.values(config.upstreams).map((u) => u.serviceId);

  // Merged OpenAPI spec from all upstreams
  app.get('/openapi-merged.json', async (_req, reply) => {
    // Try cache first
    if (cache) {
      try {
        const hit = await cache.get<Record<string, unknown>>(MERGED_CACHE_KEY);
        if (hit) {
          return reply.send(hit);
        }
      } catch { /* cache miss */ }
    }

    // Fetch all upstream specs in parallel via transport. IServiceTransport.call
    // resolves (never rejects) on a non-2xx response — `ok` distinguishes success
    // from failure, the promise itself doesn't. An upstream whose swagger plugin
    // hasn't registered yet (still booting) answers 503 with an error body, not a
    // spec; without the `ok` check that error body is indistinguishable from a
    // real spec below and gets merged in — or, when it's the only upstream to
    // answer within the timeout, returned as-is with no `openapi`/`swagger` key.
    const results = await Promise.allSettled(
      upstreamServiceIds.map((serviceId) =>
        serviceTransport.call(serviceId, {
          path: '/openapi.json',
          signal: AbortSignal.timeout(3000),
        }).then((r) => {
          if (!r.ok) {throw new Error(`${serviceId} /openapi.json returned ${r.statusCode}`);}
          return r.payload;
        }),
      ),
    );

    const specs = results
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      .map((r) => r.value);

    const merged = mergeOpenAPISpecs(specs as Parameters<typeof mergeOpenAPISpecs>[0]);

    // Cache result — but not a degraded merge from zero real specs (every
    // upstream still booting/unreachable): caching that for the full TTL would
    // make a cold-starting platform serve a broken doc for 30s after upstreams
    // actually became ready, instead of self-healing on the next request.
    if (cache && specs.length > 0) {
      try {
        await cache.set(MERGED_CACHE_KEY, merged as unknown as Record<string, unknown>, MERGED_CACHE_TTL);
      } catch { /* cache write failure is non-critical */ }
    }

    return reply.send(merged);
  });

  // Second Swagger UI pointing at merged spec
  // Registered last so /docs (gateway-native) is already bound at this point
  app.register(async function docsAll(scope) {
    const swaggerUi = await import('@fastify/swagger-ui');
    await scope.register(swaggerUi.default ?? swaggerUi, {
      routePrefix: '/docs-all',
      uiConfig: {
        url: '/openapi-merged.json',
        docExpansion: 'list',
        deepLinking: true,
      },
    });
  });
}
