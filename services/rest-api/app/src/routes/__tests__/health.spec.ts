import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { IEntityRegistry, SystemHealthSnapshot } from '@kb-labs/plugin-contracts';
import {
  checkCanonicalObservabilityMetrics,
  validateServiceObservabilityDescribe,
  validateServiceObservabilityHealth,
} from '@kb-labs/core-contracts';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { ReadinessState } from '../readiness';

const BASE_CONFIG: RestApiConfig = {
  port: 3000,
  basePath: '/api/v1',
  apiVersion: 'test',
  cors: {
    origins: [],
    allowCredentials: true,
    profile: 'dev',
  },
  plugins: [],
  mockMode: false,
};

function buildSnapshot(
  overrides: Partial<SystemHealthSnapshot> = {}
): SystemHealthSnapshot {
  const base: SystemHealthSnapshot = {
    schema: 'kb.health/1',
    ts: new Date().toISOString(),
    uptimeSec: 42,
    version: {
      kbLabs: 'test-suite',
      rest: 'test-rest',
    },
    registry: {
      total: 1,
      withRest: 1,
      withStudio: 0,
      errors: 0,
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      partial: false,
      stale: false,
    },
    status: 'healthy',
    components: [],
  };

  return {
    ...base,
    ...overrides,
    version: {
      ...base.version,
      ...(overrides.version ?? {}),
    },
    registry: {
      ...base.registry,
      ...(overrides.registry ?? {}),
    },
    components: overrides.components ?? base.components,
    ...(overrides.meta !== undefined ? { meta: overrides.meta } : {}),
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe('registerHealthRoutes', () => {
  it('returns kb.health/1 snapshot with readiness metadata and degraded status when plugin failures exist', async () => {
    const { registerHealthRoutes } = await import('../health');
    const app = Fastify({ logger: false }) as unknown as FastifyInstance;

    const readiness: ReadinessState = {
      cliApiInitialized: true,
      registryLoaded: true,
      registryPartial: false,
      registryStale: false,
      pluginRoutesMounted: true,
      pluginMountInProgress: false,
      pluginRoutesCount: 2,
      pluginRouteErrors: 1,
      pluginRouteFailures: [
        { id: '@kb-labs/mind', error: 'rest_mount_failed handler_missing' },
      ],
      lastPluginMountTs: null,
      pluginRoutesLastDurationMs: null,
      redisEnabled: false,
      redisConnected: true,
      redisStates: {
        publisher: null,
        subscriber: null,
        cache: null,
      },
    };

    const baseSnapshot = buildSnapshot({
      components: [
        {
          id: '@kb-labs/mind',
          version: '1.0.0',
          restRoutes: 2,
          studioWidgets: 1,
        },
        {
          id: 'execution',
          status: 'degraded',
          details: { workers: { total: 0, busy: 0, idle: 0, queued: 0, queueLimit: 10 } },
        },
      ],
    });

    const cliApi = {
      getSystemHealth: vi.fn().mockResolvedValue(baseSnapshot),
      snapshot: vi.fn(() => ({
        schema: 'kb.registry/2' as const,
        rev: 1,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ttlMs: 60_000,
        partial: false,
        stale: false,
        source: { cliVersion: 'test', cwd: process.cwd() },
        corrupted: false,
        plugins: [],
      })),
    } as unknown as IEntityRegistry;

    await registerHealthRoutes(app, BASE_CONFIG, cliApi, readiness);

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const payload = response.json() as SystemHealthSnapshot;
    expect(payload.schema).toBe('kb.health/1');
    expect(payload.status).toBe('degraded');
    expect(payload.components.find(component => component.id === 'execution')).toMatchObject({ status: 'degraded', details: { workers: { total: 0, idle: 0 } } });
    const meta = (payload.meta ?? {}) as Record<string, any>;
    expect(meta.readiness).toBeDefined();
    expect(meta.readiness.pluginRouteErrors).toBe(1);
    expect(meta.readinessFailures).toHaveLength(1);

    expect(cliApi.getSystemHealth).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('ready endpoint waits for registry load and mounted routes', async () => {
    const { registerHealthRoutes } = await import('../health');
    const app = Fastify({ logger: false }) as unknown as FastifyInstance;

    const readiness: ReadinessState = {
      cliApiInitialized: true,
      registryLoaded: false,
      registryPartial: true,
      registryStale: true,
      pluginRoutesMounted: false,
      pluginMountInProgress: true,
      pluginRoutesCount: 0,
      pluginRouteErrors: 0,
      pluginRouteFailures: [],
      lastPluginMountTs: null,
      pluginRoutesLastDurationMs: null,
      redisEnabled: false,
      redisConnected: true,
      redisStates: {
        publisher: null,
        subscriber: null,
        cache: null,
      },
    };

    const baseSnapshot = buildSnapshot();
    let snapshotRev = 0;
    let snapshotPartial = true;
    let snapshotStale = true;
    let snapshotPlugins: Array<{ id: string }> = [];

    const cliApi = {
      getSystemHealth: vi.fn().mockResolvedValue(baseSnapshot),
      snapshot: vi.fn(() => ({
        schema: 'kb.registry/2' as const,
        rev: snapshotRev,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ttlMs: 60_000,
        partial: snapshotPartial,
        stale: snapshotStale,
        source: { cliVersion: 'test', cwd: process.cwd() },
        corrupted: false,
        plugins: snapshotPlugins as any,
      })),
    } as unknown as IEntityRegistry;

    await registerHealthRoutes(app, BASE_CONFIG, cliApi, readiness);

    const notReady = await app.inject({ method: 'GET', url: '/ready' });
    expect(notReady.statusCode).toBe(503);
    expect(notReady.json()).toMatchObject({
      schema: 'kb.ready/1',
      ready: false,
      status: 'initializing',
      reason: 'registry_snapshot_stale',
      components: {
        cliApi: {
          initialized: true,
        },
        registry: {
          loaded: false,
          partial: true,
          stale: true,
        },
        plugins: {
          mounted: false,
          inProgress: true,
        },
      },
    });

    snapshotRev = 1;
    snapshotPartial = false;
    snapshotStale = false;
    snapshotPlugins = [{ id: 'test' }];
    readiness.pluginRoutesMounted = true;
    readiness.pluginRouteErrors = 0;
    readiness.pluginRouteFailures = [];
    readiness.registryLoaded = true;
    readiness.registryPartial = false;
    readiness.registryStale = false;
    readiness.pluginMountInProgress = false;

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      schema: 'kb.ready/1',
      ready: true,
      status: 'ready',
      reason: 'ready',
      components: {
        cliApi: {
          initialized: true,
        },
        registry: {
          loaded: true,
          partial: false,
          stale: false,
        },
        plugins: {
          mounted: true,
          inProgress: false,
          routeCount: 0,
          errors: 0,
        },
      },
    });

    await app.close();
  });

  it('reports redis_unavailable when redis is enabled but unhealthy', async () => {
    const { registerHealthRoutes } = await import('../health');
    const app = Fastify({ logger: false }) as unknown as FastifyInstance;

    const readiness: ReadinessState = {
      cliApiInitialized: true,
      registryLoaded: true,
      registryPartial: false,
      registryStale: false,
      pluginRoutesMounted: true,
      pluginMountInProgress: false,
      pluginRoutesCount: 4,
      pluginRouteErrors: 0,
      pluginRouteFailures: [],
      lastPluginMountTs: new Date().toISOString(),
      pluginRoutesLastDurationMs: 128,
      redisEnabled: true,
      redisConnected: false,
      redisStates: {
        publisher: 'reconnecting',
        subscriber: 'end',
        cache: 'error',
      },
    };

    const baseSnapshot = buildSnapshot();
    const cliApi = {
      getSystemHealth: vi.fn().mockResolvedValue(baseSnapshot),
      snapshot: vi.fn(() => ({
        schema: 'kb.registry/2' as const,
        rev: 2,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ttlMs: 60_000,
        partial: false,
        stale: false,
        source: { cliVersion: 'test', cwd: process.cwd() },
        corrupted: false,
        plugins: [{ id: '@kb-labs/demo' }],
      })),
      getRedisStatus: vi.fn(() => ({
        enabled: true,
        healthy: false,
        roles: {
          publisher: 'reconnecting',
          subscriber: 'end',
          cache: 'error',
        },
      })),
    } as unknown as IEntityRegistry;

    await registerHealthRoutes(app, BASE_CONFIG, cliApi, readiness);

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      schema: 'kb.ready/1',
      ready: false,
      status: 'initializing',
      reason: 'redis_unavailable',
      components: {
        redis: {
          enabled: true,
          healthy: false,
        },
      },
    });

    await app.close();
  });

  it('exposes observability describe and health surfaces', async () => {
    const { registerHealthRoutes } = await import('../health');
    const app = Fastify({ logger: false }) as unknown as FastifyInstance;

    const readiness: ReadinessState = {
      cliApiInitialized: true,
      registryLoaded: true,
      registryPartial: false,
      registryStale: false,
      pluginRoutesMounted: true,
      pluginMountInProgress: false,
      pluginRoutesCount: 3,
      pluginRouteErrors: 0,
      pluginRouteFailures: [],
      lastPluginMountTs: new Date().toISOString(),
      pluginRoutesLastDurationMs: 12,
      redisEnabled: false,
      redisConnected: true,
      redisStates: {
        publisher: null,
        subscriber: null,
        cache: null,
      },
    };

    const baseSnapshot = buildSnapshot();
    const cliApi = {
      getSystemHealth: vi.fn().mockResolvedValue(baseSnapshot),
      snapshot: vi.fn(() => ({
        schema: 'kb.registry/2' as const,
        rev: 7,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ttlMs: 60_000,
        partial: false,
        stale: false,
        source: { cwd: process.cwd(), platformVersion: 'test' },
        corrupted: false,
        plugins: [{ id: '@kb-labs/demo' }],
      })),
    } as unknown as IEntityRegistry;

    await registerHealthRoutes(app, BASE_CONFIG, cliApi, readiness);

    const describe = await app.inject({ method: 'GET', url: '/api/v1/observability/describe' });
    expect(describe.statusCode).toBe(200);
    expect(describe.json()).toMatchObject({
      serviceId: 'rest',
      contractVersion: '1.0',
      metricsEndpoint: '/metrics',
      healthEndpoint: '/api/v1/observability/health',
    });

    const health = await app.inject({ method: 'GET', url: '/api/v1/observability/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      serviceId: 'rest',
      contractVersion: '1.0',
      status: 'healthy',
      state: 'active',
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'registry', status: 'ok' }),
      ]),
    });

    expect(validateServiceObservabilityDescribe(describe.json()).ok).toBe(true);
    expect(validateServiceObservabilityHealth(health.json()).ok).toBe(true);

    await app.close();
  });

  it('metrics endpoint exposes canonical observability families', async () => {
    const { registerMetricsRoutes } = await import('../metrics');
    const app = Fastify({ logger: false }) as unknown as FastifyInstance;

    registerMetricsRoutes(app, BASE_CONFIG);

    const metrics = await app.inject({ method: 'GET', url: '/api/v1/metrics' });
    expect(metrics.statusCode).toBe(200);

    const canonicalMetrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(canonicalMetrics.statusCode).toBe(200);
    const compliance = checkCanonicalObservabilityMetrics(metrics.body);
    expect(compliance.missing).toEqual([]);

    const legacy = await app.inject({ method: 'GET', url: '/api/v1/metrics/json' });
    expect(legacy.statusCode).toBe(404);

    await app.close();
  });
});
