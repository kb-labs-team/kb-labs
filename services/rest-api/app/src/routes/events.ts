import type { FastifyInstance } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { IEntityRegistry, SystemHealthSnapshot } from '@kb-labs/plugin-contracts';
import type { ReadinessState } from './readiness';
import { isReady, resolveReadinessReason } from './readiness';
import type { EventHub, BroadcastEvent } from '../events/hub';
import { metricsCollector } from '../middleware/metrics.js';
import { buildRegistrySseAuthHook } from './sse-auth';
import { createSseStream } from '@kb-labs/shared-http';
import { platform } from '@kb-labs/core-runtime';

export async function registerEventRoutes(
  server: FastifyInstance,
  basePath: string,
  registry: IEntityRegistry,
  readiness: ReadinessState,
  eventHub: EventHub,
  config: RestApiConfig
): Promise<void> {
  const endpoint = `${basePath}/events/registry`;
  const authHook = buildRegistrySseAuthHook(config);

  server.route({
    method: 'GET',
    url: endpoint,
    config: { ux: 'raw' },
    onRequest: authHook ? [authHook] : undefined,
    handler: async (request, reply) => {
      // Explicit CORS headers for EventSource (browser requires these before opening connection)
      const origin = request.headers.origin;
      const stream = createSseStream(request, reply, {
        logger: request.kbLogger ?? platform.logger,
        serviceId: 'rest',
        route: endpoint,
        headers: origin === 'http://localhost:3000' || origin === 'http://localhost:5173'
          ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
          : undefined,
      });

      const send = (event: BroadcastEvent) => {
        stream.send(event.type, event);
      };

      const unsubscribe = eventHub.subscribe(send);
      stream.onCleanup(unsubscribe);

      const snapshot = registry.snapshot();
      const checksumAlgorithm = snapshot.checksumAlgorithm === 'sha256' ? 'sha256' : undefined;
      send({
        type: 'registry',
        rev: snapshot.rev,
        generatedAt: snapshot.generatedAt,
        partial: snapshot.partial,
        stale: snapshot.stale,
        expiresAt: snapshot.expiresAt ?? null,
        ttlMs: snapshot.ttlMs ?? null,
        checksum: snapshot.checksum ?? undefined,
        checksumAlgorithm,
        previousChecksum: snapshot.previousChecksum ?? null,
      });

      const healthPromise = registry
        .getSystemHealth()
        .then((health: SystemHealthSnapshot) => {
          const ready = isReady(readiness);
          const reason = resolveReadinessReason(readiness);
          const pluginSnapshot = metricsCollector.getLastPluginMountSnapshot();
          const redisStatus = ('getRedisStatus' in registry && typeof (registry as { getRedisStatus?: () => { enabled: boolean; healthy: boolean; roles: { publisher?: string | null; subscriber?: string | null; cache?: string | null } } }).getRedisStatus === 'function')
            ? (registry as { getRedisStatus: () => { enabled: boolean; healthy: boolean; roles: { publisher?: string | null; subscriber?: string | null; cache?: string | null } } }).getRedisStatus()
            : undefined;
          send({
            type: 'health',
            status: health.status,
            ts: health.ts,
            ready,
            reason,
            registryPartial: readiness.registryPartial,
            registryStale: readiness.registryStale,
            registryLoaded: readiness.registryLoaded,
            pluginMountInProgress: readiness.pluginMountInProgress,
            pluginRoutesMounted: readiness.pluginRoutesMounted,
            pluginsMounted: pluginSnapshot?.succeeded ?? 0,
            pluginsFailed: pluginSnapshot?.failed ?? 0,
            lastPluginMountTs: readiness.lastPluginMountTs ?? null,
            pluginRoutesLastDurationMs: readiness.pluginRoutesLastDurationMs ?? null,
            redisEnabled: redisStatus?.enabled ?? false,
            redisHealthy: redisStatus?.healthy ?? true,
            redisStates: redisStatus ? {
              publisher: redisStatus.roles.publisher ?? null,
              subscriber: redisStatus.roles.subscriber ?? null,
              cache: redisStatus.roles.cache ?? null,
            } : undefined,
          });
        })
        .catch((error: unknown) => {
          if (request.kbLogger) {
            request.kbLogger.warn('Failed to fetch system health for SSE client', { err: error });
          }
        });

      // In inject/test mode there is no TCP close event; finish after the
      // initial snapshot so Fastify can return the captured response.
      if (request.raw.socket && !(request.raw.socket as { writable?: boolean }).writable) {
        await healthPromise;
        stream.close('test_complete');
        return;
      }
      await stream.closed;
    },
  });
}
