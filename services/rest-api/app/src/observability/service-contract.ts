import { hostname } from 'node:os';
import {
  OBSERVABILITY_CONTRACT_VERSION,
  OBSERVABILITY_SCHEMA,
  CANONICAL_OBSERVABILITY_METRICS,
  type ObservabilityCheck,
} from '@kb-labs/core-contracts';
import type {
  ServiceObservabilityDescribe,
  ServiceObservabilityHealth,
  ServiceOperationSample,
} from '@kb-labs/core-contracts';
import {
  createServiceObservabilityDescribe,
  createServiceObservabilityHealth,
} from '@kb-labs/shared-http';
import type { SystemHealthSnapshot } from '@kb-labs/plugin-contracts';
import type { ReadinessState } from '../routes/readiness.js';
import { restDomainOperationMetrics, type MetricsSnapshot } from '../middleware/metrics.js';
import { getLatestSystemMetrics } from '../daemon/metrics/index.js';

declare const __REST_API_VERSION__: string;
const REST_VERSION = typeof __REST_API_VERSION__ !== 'undefined' ? __REST_API_VERSION__ : '0.0.0';

function resolveInstanceId(): string {
  return `${hostname()}:${process.pid}`;
}

function mergeTopOperations(
  httpOperations: ServiceOperationSample[],
  domainOperations: ServiceOperationSample[],
  limit = 5,
): ServiceOperationSample[] {
  const merged = new Map<string, ServiceOperationSample>();

  for (const item of [...httpOperations, ...domainOperations]) {
    const existing = merged.get(item.operation);
    if (!existing) {
      merged.set(item.operation, { ...item });
      continue;
    }

    const count = (existing.count ?? 0) + (item.count ?? 0);
    const totalDurationMs =
      (existing.avgDurationMs ?? 0) * (existing.count ?? 0) +
      (item.avgDurationMs ?? 0) * (item.count ?? 0);

    merged.set(item.operation, {
      operation: item.operation,
      count,
      avgDurationMs: count > 0 ? totalDurationMs / count : 0,
      maxDurationMs: Math.max(existing.maxDurationMs ?? 0, item.maxDurationMs ?? 0),
      errorCount: (existing.errorCount ?? 0) + (item.errorCount ?? 0),
    });
  }

  const ranked = Array.from(merged.values())
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (b.maxDurationMs ?? 0) - (a.maxDurationMs ?? 0))
  const sliced = ranked.slice(0, limit);

  if (domainOperations.length === 0 || sliced.some((item) => !item.operation.startsWith('http.'))) {
    return sliced;
  }

  const firstDomainOperation = ranked.find((item) => !item.operation.startsWith('http.'));
  if (!firstDomainOperation) {
    return sliced;
  }

  return [...sliced.slice(0, Math.max(0, limit - 1)), firstDomainOperation];
}

function finiteNumberOrUndefined(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function buildRestObservabilityDescribe(basePath: string): ServiceObservabilityDescribe {
  return createServiceObservabilityDescribe({
    schema: OBSERVABILITY_SCHEMA,
    contractVersion: OBSERVABILITY_CONTRACT_VERSION,
    serviceId: 'rest',
    instanceId: resolveInstanceId(),
    serviceType: 'http-api',
    version: REST_VERSION,
    environment: process.env.NODE_ENV ?? 'development',
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    dependencies: [
      {
        serviceId: 'workflow',
        required: true,
        description: 'Workflow daemon for workflow and jobs APIs',
      },
      {
        serviceId: 'state-daemon',
        required: false,
        description: 'State broker and cache-backed storage',
      },
    ],
    metricsEndpoint: '/metrics',
    healthEndpoint: `${basePath}/observability/health`,
    logsSource: 'rest',
    capabilities: ['httpMetrics', 'eventLoopMetrics', 'operationMetrics', 'logCorrelation'],
    metricFamilies: [...CANONICAL_OBSERVABILITY_METRICS],
  });
}

export function buildRestObservabilityHealth(
  basePath: string,
  healthSnapshot: SystemHealthSnapshot,
  readiness: ReadinessState,
  metrics: MetricsSnapshot,
): ServiceObservabilityHealth {
  const runtimeMetrics = getLatestSystemMetrics();
  const checks: ObservabilityCheck[] = [
    {
      id: 'registry',
      status: readiness.registryLoaded && !readiness.registryPartial && !readiness.registryStale
        ? 'ok'
        : readiness.registryLoaded ? 'warn' : 'error',
      message: readiness.registryLoaded ? 'Registry snapshot loaded' : 'Registry snapshot incomplete',
    },
    {
      id: 'plugin-routes',
      status: readiness.pluginRouteErrors > 0 ? 'warn' : readiness.pluginRoutesMounted ? 'ok' : 'warn',
      message: readiness.pluginRoutesMounted
        ? `${readiness.pluginRoutesCount} plugin routes mounted`
        : 'Plugin routes are still mounting',
    },
    {
      id: 'redis',
      status: !readiness.redisEnabled ? 'ok' : readiness.redisConnected ? 'ok' : 'warn',
      message: !readiness.redisEnabled
        ? 'Redis integration disabled'
        : readiness.redisConnected
          ? 'Redis healthy'
          : 'Redis unavailable',
    },
  ];

  const httpTopOperations = metrics.latency.histogram
    .slice()
    .sort((a, b) => b.count - a.count || b.max - a.max)
    .slice(0, 5)
    .map((entry) => ({
      operation: `http.${entry.route}`,
      count: entry.count,
      avgDurationMs: entry.count > 0 ? entry.total / entry.count : 0,
      maxDurationMs: entry.max,
      errorCount: Object.entries(entry.byStatus)
        .filter(([status]) => Number(status) >= 400)
        .reduce((sum, [, count]) => sum + count, 0),
    }));
  const topOperations = mergeTopOperations(httpTopOperations, restDomainOperationMetrics.getTopOperations(5));

  const latestOperation = topOperations[0];
  const state = healthSnapshot.status === 'healthy'
    ? 'active'
    : runtimeMetrics || latestOperation
      ? 'partial_observability'
      : 'insufficient_data';

  return createServiceObservabilityHealth({
    schema: OBSERVABILITY_SCHEMA,
    contractVersion: OBSERVABILITY_CONTRACT_VERSION,
    serviceId: 'rest',
    instanceId: resolveInstanceId(),
    observedAt: healthSnapshot.ts,
    status: healthSnapshot.status === 'healthy' ? 'healthy' : healthSnapshot.status === 'degraded' ? 'degraded' : 'unhealthy',
    uptimeSec: healthSnapshot.uptimeSec,
    metricsEndpoint: '/metrics',
    logsSource: 'rest',
    capabilities: ['httpMetrics', 'eventLoopMetrics', 'operationMetrics', 'logCorrelation'],
    checks,
    snapshot: {
      cpuPercent: finiteNumberOrUndefined(runtimeMetrics?.cpu.percentage),
      rssBytes: finiteNumberOrUndefined(runtimeMetrics?.memory.rss),
      heapUsedBytes: finiteNumberOrUndefined(runtimeMetrics?.memory.heapUsed),
      eventLoopLagMs: finiteNumberOrUndefined(runtimeMetrics?.eventLoopLagMs),
      activeOperations: runtimeMetrics?.activeOperations ?? metrics.requests.active,
    },
    topOperations,
    state,
    meta: {
      serviceHealthEndpoint: `${basePath}/health`,
      readyEndpoint: `${basePath}/ready`,
      runtimeMetricsCollectedAt: runtimeMetrics ? new Date(runtimeMetrics.timestamp).toISOString() : null,
      lastRequestAt: metrics.timestamps.lastRequest
        ? new Date(metrics.timestamps.lastRequest).toISOString()
        : null,
    },
  });
}
