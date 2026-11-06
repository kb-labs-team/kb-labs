import { withUxErrorResponses } from './route-schema.js';
/**
 * @module @kb-labs/rest-api-app/routes/health
 * Health check and diagnostics endpoints
 */

import type { FastifyInstance } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { IEntityRegistry, SystemHealthSnapshot } from '@kb-labs/plugin-contracts';
import { CANONICAL_OBSERVABILITY_METRICS } from '@kb-labs/core-contracts';
import { normalizeBasePath, resolvePaths } from './path-helpers';
import type { ReadinessState } from './readiness';
import { isReady, resolveReadinessReason } from './readiness';
import type { PluginsMetricsSnapshot } from '../middleware/metrics.js';
import { metricsCollector } from '../middleware/metrics.js';
import { updateServiceHealthStatus } from '../observability/prometheus-registry.js';
import {
  buildRestObservabilityDescribe,
  buildRestObservabilityHealth,
} from '../observability/service-contract.js';

// Version is injected at build time by tsup define
declare const __REST_API_VERSION__: string;
const REST_VERSION = typeof __REST_API_VERSION__ !== 'undefined' ? __REST_API_VERSION__ : '0.0.0';

const CACHE_WINDOW_MS = 200;
const READY_SCHEMA = 'kb.ready/1';

interface CachedSnapshot {
  base: SystemHealthSnapshot;
  expiresAt: number;
}

let cachedBaseSnapshot: CachedSnapshot | null = null;
let inFlightBaseSnapshot: Promise<SystemHealthSnapshot> | null = null;

/**
 * Register health and readiness routes
 */
export async function registerHealthRoutes(
  fastify: FastifyInstance,
  config: RestApiConfig,
  _repoRoot: string,
  registry: IEntityRegistry,
  readiness: ReadinessState
): Promise<void> {
  const basePath = normalizeBasePath(config.basePath);
  const healthPaths = resolvePaths(basePath, '/health');
  const readyPaths = resolvePaths(basePath, '/ready');
  const observabilityDescribePaths = resolvePaths(basePath, '/observability/describe');
  const observabilityHealthPaths = resolvePaths(basePath, '/observability/health');

  for (const path of healthPaths) {
    fastify.get(path, { config: { ux: 'raw' }, schema: {
      querystring: { type: 'object', additionalProperties: false },
      response: withUxErrorResponses({ 200: {
        type: 'object', additionalProperties: false,
        properties: {
          schema: { const: 'kb.health/1' }, ts: { type: 'string', format: 'date-time' },
          uptimeSec: { type: 'integer', minimum: 0 },
          version: { type: 'object', properties: { kbLabs: { type: 'string' }, rest: { type: 'string' }, studio: { type: 'string' }, git: { type: 'object', properties: { sha: { type: 'string' }, dirty: { type: 'boolean' } }, required: ['sha', 'dirty'], additionalProperties: false } }, required: ['kbLabs', 'rest'], additionalProperties: false },
          registry: { type: 'object', properties: { total: { type: 'integer' }, withRest: { type: 'integer' }, withStudio: { type: 'integer' }, errors: { type: 'integer' }, generatedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' }, partial: { type: 'boolean' }, stale: { type: 'boolean' } }, required: ['total', 'withRest', 'withStudio', 'errors', 'generatedAt', 'partial', 'stale'], additionalProperties: false },
          status: { enum: ['healthy', 'degraded'] },
          components: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'string' }, restRoutes: { type: 'integer' }, studioWidgets: { type: 'integer' }, lastError: { type: 'string' }, status: { enum: ['healthy', 'degraded'] }, details: { type: 'object', additionalProperties: true } }, required: ['id'], additionalProperties: false } },
          meta: { type: 'object', properties: { source: { const: 'rest' }, readiness: { type: 'object', properties: {
            ready: { type: 'boolean' }, reason: { type: 'string' }, registryLoaded: { type: 'boolean' }, registryPartial: { type: 'boolean' }, registryStale: { type: 'boolean' }, pluginRoutesMounted: { type: 'boolean' }, pluginMountInProgress: { type: 'boolean' }, pluginRouteCount: { type: 'integer' }, pluginRouteErrors: { type: 'integer' }, readinessFailures: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, error: { type: 'string' } }, required: ['id', 'error'], additionalProperties: false } },
          }, additionalProperties: true } }, required: ['source', 'readiness'], additionalProperties: true },
        }, required: ['schema', 'ts', 'uptimeSec', 'version', 'registry', 'status', 'components'],
      } }),
    } }, async (_request, reply) => {
      const eventHub = fastify.kbEventHub;
      try {
        const baseSnapshot = await getBaseSnapshot(registry);
        const { registryLoaded, registryPartial, registryStale } = evaluateRegistryState(registry);
        readiness.registryLoaded = registryLoaded;
        readiness.registryPartial = registryPartial;
        readiness.registryStale = registryStale;
        const ready = isReady(readiness);
        const reason = resolveReadinessReason(readiness);
        const pluginsMetrics = metricsCollector.getLastPluginMountSnapshot();
        const response = augmentSnapshot(baseSnapshot, readiness, pluginsMetrics);
        updateServiceHealthStatus(
          response.status === 'healthy' ? 'healthy' : response.status === 'degraded' ? 'degraded' : 'unhealthy',
        );
        eventHub?.publish({
          type: 'health',
          status: response.status,
          ts: response.ts,
          ready,
          reason,
          registryPartial: readiness.registryPartial,
          registryStale: readiness.registryStale,
          registryLoaded: readiness.registryLoaded,
        });
        return reply.send(response);
      } catch (error) {
        const fallback = buildFallbackSnapshot(error, readiness);
        updateServiceHealthStatus('degraded');
        const ready = isReady(readiness);
        const reason = resolveReadinessReason(readiness);
        eventHub?.publish({
          type: 'health',
          status: fallback.status,
          ts: fallback.ts,
          ready,
          reason,
          registryPartial: readiness.registryPartial,
          registryStale: readiness.registryStale,
          registryLoaded: readiness.registryLoaded,
        });
        return reply.send(fallback);
      }
    });
  }

  for (const path of readyPaths) {
    fastify.get(path, { config: { ux: 'raw' }, schema: {
      querystring: { type: 'object', additionalProperties: false },
      response: withUxErrorResponses({ 200: {
        type: 'object', properties: {
          schema: { const: 'kb.ready/1' }, ts: { type: 'string', format: 'date-time' }, ready: { type: 'boolean' }, status: { enum: ['ready', 'degraded', 'initializing'] }, reason: { type: 'string' },
          components: { type: 'object', properties: {
            cliApi: { type: 'object', properties: { initialized: { type: 'boolean' } }, required: ['initialized'], additionalProperties: false },
            registry: { type: 'object', properties: { loaded: { type: 'boolean' }, partial: { type: 'boolean' }, stale: { type: 'boolean' } }, required: ['loaded', 'partial', 'stale'], additionalProperties: false },
            plugins: { type: 'object', properties: { mounted: { type: 'boolean' }, inProgress: { type: 'boolean' }, routeCount: { type: 'integer' }, errors: { type: 'integer' }, failures: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, error: { type: 'string' } }, required: ['id', 'error'], additionalProperties: false } }, lastCompletedAt: { type: ['string', 'null'] }, lastDurationMs: { type: ['number', 'null'] } }, required: ['mounted', 'inProgress', 'routeCount', 'errors', 'failures', 'lastCompletedAt', 'lastDurationMs'], additionalProperties: false },
            redis: { type: 'object', properties: { enabled: { type: 'boolean' }, healthy: { type: 'boolean' }, states: { type: 'object' } }, required: ['enabled', 'healthy', 'states'], additionalProperties: false },
          }, required: ['cliApi', 'registry', 'plugins', 'redis'], additionalProperties: true },
        }, required: ['schema', 'ts', 'ready', 'status', 'reason', 'components'], additionalProperties: false,
      }, 503: { type: 'object', properties: { schema: { const: 'kb.ready/1' }, ts: { type: 'string', format: 'date-time' }, ready: { const: false }, status: { const: 'initializing' }, reason: { type: 'string' }, components: { type: 'object', additionalProperties: true } }, required: ['schema', 'ts', 'ready', 'status', 'reason', 'components'], additionalProperties: false } }),
    } }, async (_request, reply) => {
      const eventHub = fastify.kbEventHub;
      const { registryLoaded, registryPartial, registryStale } = evaluateRegistryState(registry);
      readiness.registryLoaded = registryLoaded;
      readiness.registryPartial = registryPartial;
      readiness.registryStale = registryStale;

      const response = buildReadinessResponse(readiness);
      const statusCode = response.ready ? 200 : 503;
      updateServiceHealthStatus(response.ready ? 'healthy' : 'degraded');

      eventHub?.publish({
        type: 'health',
        status: response.ready ? 'healthy' : 'degraded',
        ts: new Date().toISOString(),
        ready: response.ready,
        reason: response.reason,
        registryPartial: readiness.registryPartial,
        registryStale: readiness.registryStale,
        registryLoaded: readiness.registryLoaded,
        pluginMountInProgress: readiness.pluginMountInProgress,
        pluginRoutesMounted: readiness.pluginRoutesMounted,
        lastPluginMountTs: readiness.lastPluginMountTs,
        pluginRoutesLastDurationMs: readiness.pluginRoutesLastDurationMs,
        pluginsMounted: metricsCollector.getLastPluginMountSnapshot()?.succeeded ?? 0,
        pluginsFailed: metricsCollector.getLastPluginMountSnapshot()?.failed ?? 0,
      });

      return reply.code(statusCode).send(response);
    });
  }

  for (const path of observabilityDescribePaths) {
    fastify.get(path, { config: { ux: 'raw' }, schema: { querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { schema: { const: 'kb.observability/1' }, contractVersion: { type: 'string' }, serviceId: { const: 'rest' }, instanceId: { type: 'string' }, serviceType: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, startedAt: { type: 'string', format: 'date-time' }, dependencies: { type: 'array', items: { type: 'object', properties: { serviceId: { type: 'string' }, required: { type: 'boolean' }, description: { type: 'string' } }, required: ['serviceId', 'required'], additionalProperties: false } }, metricsEndpoint: { type: 'string' }, healthEndpoint: { type: 'string' }, logsSource: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } }, metricFamilies: { type: 'array', items: { enum: CANONICAL_OBSERVABILITY_METRICS } } }, required: ['schema', 'contractVersion', 'serviceId', 'instanceId', 'serviceType', 'version', 'environment', 'startedAt', 'dependencies', 'metricsEndpoint', 'healthEndpoint', 'logsSource', 'capabilities', 'metricFamilies'], additionalProperties: false } }) } }, async () => buildRestObservabilityDescribe(basePath));
  }

  for (const path of observabilityHealthPaths) {
    fastify.get(path, { config: { ux: 'raw' }, schema: { querystring: { type: 'object', additionalProperties: false }, response: withUxErrorResponses({ 200: { type: 'object', properties: { schema: { const: 'kb.observability/1' }, contractVersion: { type: 'string' }, serviceId: { const: 'rest' }, instanceId: { type: 'string' }, observedAt: { type: 'string', format: 'date-time' }, status: { enum: ['healthy', 'degraded', 'unhealthy'] }, uptimeSec: { type: 'number' }, metricsEndpoint: { type: 'string' }, logsSource: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } }, checks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { enum: ['ok', 'warn', 'error'] }, message: { type: 'string' }, latencyMs: { type: 'number' }, details: { type: 'object', additionalProperties: true } }, required: ['id', 'status'], additionalProperties: true } }, snapshot: { type: 'object', additionalProperties: true }, topOperations: { type: 'array', items: { type: 'object', properties: { operation: { type: 'string' }, count: { type: 'number' }, avgDurationMs: { type: 'number' }, maxDurationMs: { type: 'number' }, errorCount: { type: 'number' } }, required: ['operation'], additionalProperties: true } }, state: { type: 'string' }, meta: { type: 'object', additionalProperties: true } }, required: ['schema', 'contractVersion', 'serviceId', 'instanceId', 'observedAt', 'status', 'uptimeSec', 'metricsEndpoint', 'logsSource', 'capabilities', 'checks'], additionalProperties: true } }) } }, async () => {
      try {
        const baseSnapshot = await getBaseSnapshot(registry);
        const pluginsMetrics = metricsCollector.getLastPluginMountSnapshot();
        const augmented = augmentSnapshot(baseSnapshot, readiness, pluginsMetrics);
        updateServiceHealthStatus(
          augmented.status === 'healthy' ? 'healthy' : augmented.status === 'degraded' ? 'degraded' : 'unhealthy',
        );
        return buildRestObservabilityHealth(basePath, augmented, readiness, metricsCollector.getMetrics());
      } catch (error) {
        const fallback = buildFallbackSnapshot(error, readiness);
        updateServiceHealthStatus('degraded');
        return buildRestObservabilityHealth(basePath, fallback, readiness, metricsCollector.getMetrics());
      }
    });
  }
}

async function getBaseSnapshot(registry: IEntityRegistry): Promise<SystemHealthSnapshot> {
  const now = Date.now();
  if (cachedBaseSnapshot && now < cachedBaseSnapshot.expiresAt) {
    return cachedBaseSnapshot.base;
  }

  if (inFlightBaseSnapshot) {
    return inFlightBaseSnapshot;
  }

  inFlightBaseSnapshot = registry
    .getSystemHealth({
      uptimeSec: process.uptime(),
      version: { rest: REST_VERSION },
    })
    .then(snapshot => {
      cachedBaseSnapshot = {
        base: snapshot,
        expiresAt: Date.now() + CACHE_WINDOW_MS,
      };
      inFlightBaseSnapshot = null;
      return snapshot;
    })
    .catch(error => {
      inFlightBaseSnapshot = null;
      throw error;
    });

  return inFlightBaseSnapshot;
}

function augmentSnapshot(
  base: SystemHealthSnapshot,
  readiness: ReadinessState,
  pluginsMetrics?: PluginsMetricsSnapshot | null
): SystemHealthSnapshot {
  const snapshot = cloneSnapshot(base);
  const failures = new Map(readiness.pluginRouteFailures.map(f => [f.id, f.error]));

  const components = snapshot.components.map(component => {
    const failure = failures.get(component.id);
    return failure
      ? {
          ...component,
          lastError: failure,
        }
      : component;
  });

  const readinessMeta = {
    pluginRoutesMounted: readiness.pluginRoutesMounted,
    pluginMountInProgress: readiness.pluginMountInProgress,
    pluginRoutesCount: readiness.pluginRoutesCount,
    pluginRouteErrors: readiness.pluginRouteErrors,
    pluginRouteFailures: readiness.pluginRouteFailures,
    registryPartial: readiness.registryPartial,
    registryStale: readiness.registryStale,
    pluginMounts: pluginsMetrics ?? null,
    lastPluginMountTs: readiness.lastPluginMountTs ?? null,
    pluginRoutesLastDurationMs: readiness.pluginRoutesLastDurationMs ?? null,
    redisEnabled: readiness.redisEnabled,
    redisConnected: readiness.redisConnected,
    redisStates: readiness.redisStates,
  };

  const meta: Record<string, unknown> = {
    source: 'rest',
    ...(snapshot.meta || {}),
    readiness: readinessMeta,
  };

  if (readiness.pluginRouteFailures.length > 0) {
    meta.readinessFailures = readiness.pluginRouteFailures;
  }

  const hasReadinessErrors = readiness.pluginRouteErrors > 0 || readiness.pluginRouteFailures.length > 0;

  return {
    ...snapshot,
    status: hasReadinessErrors ? 'degraded' : snapshot.status,
    components,
    meta,
  };
}

function buildFallbackSnapshot(
  error: unknown,
  readiness: ReadinessState
): SystemHealthSnapshot {
  const message = sanitizeError(error);
  const now = new Date();

  const snapshot: SystemHealthSnapshot = {
    schema: 'kb.health/1',
    ts: now.toISOString(),
    uptimeSec: Math.max(0, Math.floor(process.uptime())),
    version: {
      kbLabs: process.env.KB_LABS_VERSION || process.env.KB_VERSION || 'unknown',
      rest: REST_VERSION,
    },
    registry: {
      total: 0,
      withRest: 0,
      withStudio: 0,
      errors: 1,
      generatedAt: new Date(0).toISOString(),
      expiresAt: undefined,
      partial: true,
      stale: true,
    },
    status: 'degraded',
    components: [],
    meta: {
      source: 'rest',
      error: message,
    },
  };

  return augmentSnapshot(snapshot, readiness, metricsCollector.getLastPluginMountSnapshot());
}

function cloneSnapshot(base: SystemHealthSnapshot): SystemHealthSnapshot {
  return {
    schema: base.schema,
    ts: base.ts,
    uptimeSec: base.uptimeSec,
    version: { ...base.version },
    registry: { ...base.registry },
    status: base.status,
    components: base.components.map(component => ({ ...component })),
    ...(base.meta ? { meta: { ...base.meta } } : {}),
  };
}

function sanitizeError(error: unknown): string {
  if (!error) {
    return 'unknown_error';
  }
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.trim().split('\n')[0] ?? message.trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

function evaluateRegistryState(registry: IEntityRegistry): {
  registryLoaded: boolean;
  registryPartial: boolean;
  registryStale: boolean;
} {
  const snapshot = registry.snapshot();
  return {
    registryLoaded: snapshot.plugins.length > 0 && !snapshot.partial && !snapshot.stale,
    registryPartial: snapshot.partial,
    registryStale: snapshot.stale,
  };
}

function buildReadinessResponse(readiness: ReadinessState) {
  const ready = isReady(readiness);
  const pluginIssues =
    readiness.pluginRouteErrors > 0 || readiness.pluginRouteFailures.length > 0;
  const status = ready ? (pluginIssues ? 'degraded' : 'ready') : 'initializing';
  const reason = ready ? 'ready' : resolveReadinessReason(readiness);

  return {
    schema: READY_SCHEMA,
    ts: new Date().toISOString(),
    ready,
    status,
    reason,
    components: {
      cliApi: {
        initialized: readiness.cliApiInitialized,
      },
      registry: {
        loaded: readiness.registryLoaded,
        partial: readiness.registryPartial,
        stale: readiness.registryStale,
      },
      plugins: {
        mounted: readiness.pluginRoutesMounted,
        inProgress: readiness.pluginMountInProgress,
        routeCount: readiness.pluginRoutesCount,
        errors: readiness.pluginRouteErrors,
        failures: readiness.pluginRouteFailures,
        lastCompletedAt: readiness.lastPluginMountTs ?? null,
        lastDurationMs: readiness.pluginRoutesLastDurationMs ?? null,
      },
      redis: {
        enabled: readiness.redisEnabled,
        healthy: readiness.redisConnected,
        states: readiness.redisStates,
      },
    },
  };
}
