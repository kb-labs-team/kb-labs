import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { IEntityRegistry, RegistrySnapshot, SystemHealthSnapshot } from '@kb-labs/plugin-contracts';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import type { EventHub, BroadcastEvent } from '../../events/hub';
import type { ReadinessState } from '../readiness';
import { registerEventRoutes } from '../events';

// Mock dependencies
vi.mock('../../middleware/metrics', () => ({
  metricsCollector: {
    getLastPluginMountSnapshot: vi.fn(() => ({
      succeeded: 5,
      failed: 1,
    })),
  },
}));

vi.mock('../../utils/sse-auth', () => ({
  buildRegistrySseAuthHook: vi.fn(() => null),
}));

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

function createMockSnapshot(): RegistrySnapshot {
  return {
    schema: 'kb.registry/1',
    rev: 42,
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ttlMs: 60_000,
    partial: false,
    stale: false,
    source: { platformVersion: 'test', cwd: process.cwd() },
    corrupted: false,
    plugins: [],
    manifests: [],
    inputFingerprint: '',
    ts: Date.now(),
    checksum: 'abc123',
    checksumAlgorithm: 'sha256',
    previousChecksum: 'def456',
  };
}

function createMockHealthSnapshot(): SystemHealthSnapshot {
  return {
    schema: 'kb.health/1',
    ts: new Date().toISOString(),
    uptimeSec: 42,
    version: {
      kbLabs: '1.0.0',
      rest: '1.0.0',
    },
    registry: {
      total: 5,
      withRest: 3,
      withStudio: 2,
      errors: 0,
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      partial: false,
      stale: false,
    },
    status: 'healthy',
    components: [],
  };
}

function createMockReadinessState(): ReadinessState {
  return {
    cliApiInitialized: true,
    registryLoaded: true,
    registryPartial: false,
    registryStale: false,
    pluginRoutesMounted: true,
    pluginMountInProgress: false,
    pluginRoutesCount: 5,
    pluginRouteErrors: 0,
    pluginRouteFailures: [],
    lastPluginMountTs: new Date().toISOString(),
    pluginRoutesLastDurationMs: 128,
    redisEnabled: false,
    redisConnected: false,
    redisStates: {
      publisher: null,
      subscriber: null,
      cache: null,
    },
  };
}

describe('registerEventRoutes', () => {
  let app: ReturnType<typeof Fastify>;
  let mockCliApi: IEntityRegistry;
  let mockEventHub: EventHub;
  let readiness: ReadinessState;
  let subscribers: Array<(event: BroadcastEvent) => void> = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    subscribers = [];
    app = Fastify({ logger: false });

    mockCliApi = {
      snapshot: vi.fn(() => createMockSnapshot()),
      getSystemHealth: vi.fn(() => Promise.resolve(createMockHealthSnapshot())),
      getRedisStatus: vi.fn(() => ({
        enabled: false,
        healthy: true,
        roles: {
          publisher: null,
          subscriber: null,
          cache: null,
        },
      })),
    } as unknown as IEntityRegistry;

    mockEventHub = {
      subscribe: vi.fn((callback: (event: BroadcastEvent) => void) => {
        subscribers.push(callback);
        return () => {
          const index = subscribers.indexOf(callback);
          if (index > -1) {subscribers.splice(index, 1);}
        };
      }),
      publish: vi.fn((event: BroadcastEvent) => {
        subscribers.forEach((sub) => sub(event));
      }),
    } as any;

    readiness = createMockReadinessState();

    await registerEventRoutes(
      app,
      '/api/v1',
      mockCliApi,
      readiness,
      mockEventHub,
      BASE_CONFIG
    );
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/events/registry', () => {
    it('returns SSE stream with correct headers', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      // SSE uses response hijacking, so status code is 0
      // Check headers instead
      expect(response.headers['content-type']).toBe('text/event-stream');
      expect(response.headers['cache-control']).toBe('no-cache, no-transform');
      expect(response.headers['connection']).toBe('keep-alive');
    });

    it('sends initial registry event', async () => {
      const snapshot = createMockSnapshot();
      vi.mocked(mockCliApi.snapshot).mockReturnValue(snapshot);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      const body = response.body;
      expect(body).toContain('event: registry');
      expect(body).toContain('"rev":42');
      expect(body).toContain('"partial":false');
      expect(body).toContain('"stale":false');
      expect(body).toContain('"checksum":"abc123"');
      expect(body).toContain('"checksumAlgorithm":"sha256"');
    });

    it('sends health event after registry event', async () => {
      const health = createMockHealthSnapshot();
      vi.mocked(mockCliApi.getSystemHealth).mockResolvedValue(health);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      // Wait for async health fetch
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const body = response.body;
      expect(body).toContain('event: health');
      expect(body).toContain('"status":"healthy"');
      expect(body).toContain('"ready":true');
      expect(body).toContain('"pluginRoutesMounted":true');
    });

    it('subscribes to event hub', async () => {
      await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      expect(mockEventHub.subscribe).toHaveBeenCalledTimes(1);
      expect(mockEventHub.subscribe).toHaveBeenCalledWith(expect.any(Function));
    });

    it('includes Redis status in health event when Redis is enabled', async () => {
      vi.mocked((mockCliApi as any).getRedisStatus).mockReturnValue({
        enabled: true,
        healthy: true,
        roles: {
          publisher: 'ready',
          subscriber: 'ready',
          cache: 'ready',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const body = response.body;
      expect(body).toContain('"redisEnabled":true');
      expect(body).toContain('"redisHealthy":true');
      expect(body).toContain('"publisher":"ready"');
    });

    it('includes plugin mount statistics in health event', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const body = response.body;
      expect(body).toContain('"pluginsMounted":5');
      expect(body).toContain('"pluginsFailed":1');
      expect(body).toContain('"pluginRoutesLastDurationMs":128');
    });

    it('includes readiness state in health event', async () => {
      readiness.registryPartial = true;
      readiness.pluginMountInProgress = true;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const body = response.body;
      expect(body).toContain('"registryPartial":true');
      expect(body).toContain('"pluginMountInProgress":true');
      expect(body).toContain('"reason":"plugin_mount_in_progress"');
    });

    it('handles system health fetch errors gracefully', async () => {
      vi.mocked(mockCliApi.getSystemHealth).mockRejectedValue(
        new Error('Health fetch failed')
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      // Should still send registry event, just not health event
      const body = response.body;
      expect(body).toContain('event: registry');
      // Should not crash
    });

    it('sets CORS headers for localhost:3000 origin', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
        headers: {
          origin: 'http://localhost:3000',
        },
      });

      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:3000'
      );
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('sets CORS headers for localhost:5173 origin (Vite dev)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
        headers: {
          origin: 'http://localhost:5173',
        },
      });

      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173'
      );
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not set CORS headers for other origins', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
        headers: {
          origin: 'http://evil.com',
        },
      });

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('handles snapshot with missing checksum fields', async () => {
      const snapshot = createMockSnapshot();
      delete (snapshot as any).checksum;
      delete (snapshot as any).checksumAlgorithm;
      delete (snapshot as any).previousChecksum;

      vi.mocked(mockCliApi.snapshot).mockReturnValue(snapshot);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      const body = response.body;
      expect(body).toContain('event: registry');
      expect(body).not.toContain('"checksum"');
      expect(body).not.toContain('"checksumAlgorithm"');
    });

    it('handles snapshot with null expiration fields', async () => {
      const snapshot = createMockSnapshot();
      (snapshot as any).expiresAt = null;
      (snapshot as any).ttlMs = null;

      vi.mocked(mockCliApi.snapshot).mockReturnValue(snapshot);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      const body = response.body;
      expect(body).toContain('"expiresAt":null');
      expect(body).toContain('"ttlMs":null');
    });

    it('handles missing getRedisStatus method gracefully', async () => {
      delete (mockCliApi as any).getRedisStatus;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const body = response.body;
      expect(body).toContain('"redisEnabled":false');
      expect(body).toContain('"redisHealthy":true');
    });

    it('handles missing plugin mount snapshot', async () => {
      const { metricsCollector } = await import('../../middleware/metrics');
      vi.mocked(metricsCollector.getLastPluginMountSnapshot).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const body = response.body;
      expect(body).toContain('"pluginsMounted":0');
      expect(body).toContain('"pluginsFailed":0');
    });

    it('handles null lastPluginMountTs', async () => {
      readiness.lastPluginMountTs = null;
      readiness.pluginRoutesLastDurationMs = null;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/events/registry',
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });

      const body = response.body;
      expect(body).toContain('"lastPluginMountTs":null');
      expect(body).toContain('"pluginRoutesLastDurationMs":null');
    });
  });
});
