/**
 * @module @kb-labs/rest-api-app/routes
 * Route registration
 */

import type { FastifyInstance } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { ICronManager } from '@kb-labs/core-platform';

type RedisStatus = {
  enabled: boolean;
  healthy: boolean;
  roles: { publisher?: string | null; subscriber?: string | null; cache?: string | null };
};
import { platform } from '@kb-labs/core-runtime';
import { EventHub } from '../events/hub';
import { registerEventRoutes } from './events';
import { registerHealthRoutes } from './health';
import { registerOpenAPIRoutes } from './openapi';
import { registerMetricsRoutes } from './metrics';
import { registerPluginRoutes, registerPluginSnapshotRoutes } from './plugins';
import { registerWorkflowRoutes } from './workflows';
import { registerJobsRoutes } from './jobs';
import { registerCacheRoutes } from './cache';
import { registerObservabilityRoutes } from './observability';
import { registerAnalyticsRoutes } from './analytics';
import { registerAdaptersRoutes } from './adapters';
import { registerLogRoutes } from './logs';
import { registerPlatformRoutes } from './platform';
import { registerAdapterCallRoutes } from './adapter-call';
import { registerDebugRoutes, registerRouteCollector } from './debug';
import type { ReadinessState } from './readiness';
import { isReady, resolveReadinessReason } from './readiness';
import { metricsCollector } from '../middleware/metrics.js';
import { HistoricalMetricsCollector } from '../daemon/metrics';

function normalizeBasePath(basePath?: string): string {
  if (!basePath || basePath === '/') {
    return '';
  }
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

/**
 * Register all routes
 */
export async function registerRoutes(
  server: FastifyInstance,
  config: RestApiConfig,
  repoRoot: string,
  registry: IEntityRegistry
): Promise<void> {
  // Register route collector hook FIRST, before any routes are registered
  // This allows us to collect all routes for the /routes endpoint
  registerRouteCollector(server);

  const initialSnapshot = registry.snapshot();
  const initialRedisStatus = ('getRedisStatus' in registry && typeof (registry as { getRedisStatus?: () => RedisStatus }).getRedisStatus === 'function')
    ? (registry as { getRedisStatus: () => RedisStatus }).getRedisStatus()
    : undefined;
  const initialRedisStates = {
    publisher: initialRedisStatus?.roles.publisher ?? null,
    subscriber: initialRedisStatus?.roles.subscriber ?? null,
    cache: initialRedisStatus?.roles.cache ?? null,
  };

  const registryLoaded =
    initialSnapshot.plugins.length > 0 && !initialSnapshot.partial && !initialSnapshot.stale;

  const readiness: ReadinessState = {
    cliApiInitialized: true,
    registryLoaded,
    registryPartial: initialSnapshot.partial,
    registryStale: initialSnapshot.stale,
    pluginRoutesMounted: false,
    pluginMountInProgress: true,
    pluginRoutesCount: 0,
    pluginRouteErrors: 0,
    pluginRouteFailures: [],
    lastPluginMountTs: null,
    pluginRoutesLastDurationMs: null,
    redisEnabled: initialRedisStatus?.enabled ?? false,
    redisConnected: initialRedisStatus?.healthy ?? true,
    redisStates: initialRedisStates,
  };

  const handleRedisUpdate = (status: RedisStatus) => {
    metricsCollector.recordRedisStatus(status);
    if (!readiness.redisEnabled && status.enabled) {
      platform.logger.info('Redis support enabled', { redis: status });
    }
    if (readiness.redisConnected !== status.healthy) {
      const message = 'Redis health status changed';
      if (status.healthy) {
        platform.logger.info(message, { redis: status });
      } else {
        platform.logger.warn(message, { redis: status });
      }
    }
    const prevStates = readiness.redisStates;
    if (
      prevStates.publisher !== (status.roles.publisher ?? null) ||
      prevStates.subscriber !== (status.roles.subscriber ?? null) ||
      prevStates.cache !== (status.roles.cache ?? null)
    ) {
      platform.logger.info('Redis role state changed', { redis: status.roles });
    }
  };

  if (initialRedisStatus) {
    handleRedisUpdate(initialRedisStatus);
  }
  server.kbReadiness = readiness;

  const eventHub = server.kbEventHub ?? new EventHub();
  server.kbEventHub = eventHub;

  const broadcastState = async (): Promise<void> => {
    const pluginsSnapshot = metricsCollector.getLastPluginMountSnapshot();
    const redisStatus = ('getRedisStatus' in registry && typeof (registry as { getRedisStatus?: () => RedisStatus }).getRedisStatus === 'function')
      ? (registry as { getRedisStatus: () => RedisStatus }).getRedisStatus()
      : undefined;
    if (redisStatus) {
      handleRedisUpdate(redisStatus);
      readiness.redisEnabled = redisStatus.enabled;
      readiness.redisConnected = redisStatus.healthy;
      readiness.redisStates = {
        publisher: redisStatus.roles.publisher ?? null,
        subscriber: redisStatus.roles.subscriber ?? null,
        cache: redisStatus.roles.cache ?? null,
      };
    }
    try {
      const snapshot = registry.snapshot();
      eventHub.publish({
        type: 'registry',
        rev: snapshot.rev,
        generatedAt: snapshot.generatedAt,
        partial: snapshot.partial,
        stale: snapshot.stale,
        expiresAt: snapshot.expiresAt ?? null,
        ttlMs: snapshot.ttlMs ?? null,
        checksum: snapshot.checksum ?? undefined,
        checksumAlgorithm: snapshot.checksumAlgorithm,
        previousChecksum: snapshot.previousChecksum ?? null,
      });
    } catch (error) {
      platform.logger.warn('Failed to publish registry snapshot event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const health = await registry.getSystemHealth();
      const ready = isReady(readiness);
      const reason = resolveReadinessReason(readiness);
      eventHub.publish({
        type: 'health',
        status: health.status,
        ts: health.ts,
        ready,
        reason,
        registryPartial: readiness.registryPartial,
        registryStale: readiness.registryStale,
        registryLoaded: readiness.registryLoaded,
        pluginsMounted: pluginsSnapshot?.succeeded ?? 0,
        pluginsFailed: pluginsSnapshot?.failed ?? 0,
        pluginMountInProgress: readiness.pluginMountInProgress,
        pluginRoutesMounted: readiness.pluginRoutesMounted,
        lastPluginMountTs: readiness.lastPluginMountTs ?? null,
        pluginRoutesLastDurationMs: readiness.pluginRoutesLastDurationMs ?? null,
        redisEnabled: readiness.redisEnabled,
        redisHealthy: readiness.redisConnected,
        redisStates: readiness.redisStates,
      });
    } catch (error) {
      platform.logger.warn('Failed to publish health event', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await broadcastState();

  const runMount = async (): Promise<void> => {
    try {
      await registerPluginRoutes(server, config, repoRoot, registry, readiness);
    } finally {
      await broadcastState();
    }
  };

  // Initial mount - wait for completion before server starts listening
  platform.logger.info('Starting initial plugin route mounting');
  try {
    await runMount();
    platform.logger.info('Plugin route mounting completed');
  } catch (error) {
    platform.logger.error(
      'Plugin route mounting failed',
      error instanceof Error ? error : new Error(String(error))
    );
  }

  const basePath = normalizeBasePath(config.basePath);

  await registerHealthRoutes(server, config, repoRoot, registry, readiness);

  await registerOpenAPIRoutes(server, config, repoRoot, registry);

  registerMetricsRoutes(server, config);

  await registerPluginSnapshotRoutes(server, config, registry);

  // Workflow SSE streaming (long-lived connections that can't go through plugin execution)
  // All CRUD operations are handled by the project-scoped workflow service route.
  await registerWorkflowRoutes(server, config);

  // Register jobs management endpoints (scheduled jobs)
  const cronManager = (platform as { cron?: ICronManager }).cron ?? null;
  await registerJobsRoutes(server, config, cronManager);

  const platformServices = platform;

  await registerCacheRoutes(server, config, registry);

  // Initialize historical metrics collector
  const historicalCollector = new HistoricalMetricsCollector(
    platformServices.cache,
    {
      intervalMs: 5000, // Collect every 5 seconds
      debug: process.env.NODE_ENV !== 'production',
    },
    platformServices.logger
  );

  // Start background collection
  historicalCollector.start();
  platform.logger.info('Historical metrics collector started');

  // Stop collector on server close
  server.addHook('onClose', async () => {
    historicalCollector.stop();
    platform.logger.info('Historical metrics collector stopped');
  });

  await registerObservabilityRoutes(server, config, repoRoot, historicalCollector, platformServices);

  await registerAnalyticsRoutes(server, config);

  await registerAdaptersRoutes(server, config);

  await registerLogRoutes(server, config, eventHub);

  await registerPlatformRoutes(server, config, repoRoot);

  await registerAdapterCallRoutes(server);

  await registerDebugRoutes(server, config);

  await registerEventRoutes(server, basePath, registry, readiness, eventHub, config);
}
