import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { forwardedIdentityHeaders } from '@kb-labs/gateway-contracts';
import { PERMISSIONS } from '@kb-labs/core-contracts';
import type { IEntityRegistry, RegistrySnapshot } from '@kb-labs/plugin-contracts';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import { registerCacheRoutes } from '../cache';
import { registerEnvelopeMiddleware } from '../../middleware/envelope.js';

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

const internalSecret = 'cache-route-test-internal-secret';
const operatorHeaders = forwardedIdentityHeaders({
  type: 'user', userId: 'operator-test', namespaceId: 'tenant-test', tier: 'enterprise',
  permissions: Object.values(PERMISSIONS),
}, internalSecret);

function createMockSnapshot(rev: number): RegistrySnapshot {
  return {
    schema: 'kb.registry/1',
    rev,
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
    inputs: [],
    inputFingerprint: '',
    ts: Date.now(),
  };
}

describe('registerCacheRoutes', () => {
  let app: ReturnType<typeof Fastify>;
  let mockCliApi: IEntityRegistry;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('GATEWAY_INTERNAL_SECRET', internalSecret);
    app = Fastify({ logger: false });
    registerEnvelopeMiddleware(app, BASE_CONFIG);

    mockCliApi = {
      snapshot: vi.fn(),
      refresh: vi.fn(),
      listPlugins: vi.fn(),
    } as unknown as IEntityRegistry;

    await registerCacheRoutes(app, BASE_CONFIG, mockCliApi);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  describe('POST /api/v1/cache/invalidate', () => {
    it('successfully invalidates cache and refreshes registry', async () => {
      const beforeSnapshot = createMockSnapshot(1);
      const afterSnapshot = createMockSnapshot(2);
      const plugins = [
        { id: '@kb-labs/plugin-1', version: '1.0.0', source: { kind: 'local' as const, path: '/plugins/plugin-1' } },
        { id: '@kb-labs/plugin-2', version: '1.0.0', source: { kind: 'local' as const, path: '/plugins/plugin-2' } },
      ];

      vi.mocked(mockCliApi.snapshot)
        .mockReturnValueOnce(beforeSnapshot)
        .mockReturnValueOnce(afterSnapshot);
      vi.mocked(mockCliApi.refresh).mockResolvedValue(undefined);
      vi.mocked(mockCliApi.listPlugins).mockResolvedValue(plugins);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cache/invalidate',
        headers: operatorHeaders,
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.ok).toBe(true);
      expect(payload.data.invalidated).toBe(true);
      expect(payload.data.previousRev).toBe(1);
      expect(payload.data.newRev).toBe(2);
      expect(payload.data.pluginsDiscovered).toBe(2);
      expect(payload.data.timestamp).toBeDefined();
      expect(payload.meta.requestId).toBeDefined();
      expect(payload.meta.durationMs).toBeGreaterThanOrEqual(0);
      expect(payload.meta.apiVersion).toBe('1.0.0');

      expect(mockCliApi.snapshot).toHaveBeenCalledTimes(2);
      expect(mockCliApi.refresh).toHaveBeenCalledTimes(1);
      expect(mockCliApi.listPlugins).toHaveBeenCalledTimes(1);
    });

    it('returns previous and new revision numbers', async () => {
      const beforeSnapshot = createMockSnapshot(42);
      const afterSnapshot = createMockSnapshot(43);

      vi.mocked(mockCliApi.snapshot)
        .mockReturnValueOnce(beforeSnapshot)
        .mockReturnValueOnce(afterSnapshot);
      vi.mocked(mockCliApi.refresh).mockResolvedValue(undefined);
      vi.mocked(mockCliApi.listPlugins).mockResolvedValue([]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cache/invalidate',
        headers: operatorHeaders,
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.data.previousRev).toBe(42);
      expect(payload.data.newRev).toBe(43);
    });

    it('includes plugin registry count', async () => {
      const snapshot = createMockSnapshot(1);
      const plugins = Array.from({ length: 15 }, (_, i) => ({
        id: `@kb-labs/plugin-${i}`,
        version: '1.0.0',
        source: { kind: 'local' as const, path: `/plugins/plugin-${i}` },
      }));

      vi.mocked(mockCliApi.snapshot).mockReturnValue(snapshot);
      vi.mocked(mockCliApi.refresh).mockResolvedValue(undefined);
      vi.mocked(mockCliApi.listPlugins).mockResolvedValue(plugins);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cache/invalidate',
        headers: operatorHeaders,
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.data.pluginsDiscovered).toBe(15);
    });

    it('handles cache refresh errors gracefully', async () => {
      const beforeSnapshot = createMockSnapshot(1);
      const error = new Error('Registry refresh failed');

      vi.mocked(mockCliApi.snapshot).mockReturnValue(beforeSnapshot);
      vi.mocked(mockCliApi.refresh).mockRejectedValue(error);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cache/invalidate',
        headers: operatorHeaders,
      });

      expect(response.statusCode).toBe(500);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({
        code: 'KB_RUNTIME_UNEXPECTED',
        hint: expect.any(String),
        correlationId: expect.any(String),
      });
      expect(JSON.stringify(payload)).not.toContain('Registry refresh failed');

      expect(mockCliApi.refresh).toHaveBeenCalledTimes(1);
      expect(mockCliApi.listPlugins).not.toHaveBeenCalled();
    });

    it('handles non-Error exceptions', async () => {
      const beforeSnapshot = createMockSnapshot(1);

      vi.mocked(mockCliApi.snapshot).mockReturnValue(beforeSnapshot);
      vi.mocked(mockCliApi.refresh).mockRejectedValue('String error');

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cache/invalidate',
        headers: operatorHeaders,
      });

      expect(response.statusCode).toBe(500);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('KB_RUNTIME_UNEXPECTED');
      expect(payload.error.hint).toEqual(expect.any(String));
    });

    it('handles snapshot() errors', async () => {
      vi.mocked(mockCliApi.snapshot).mockImplementation(() => {
        throw new Error('Registry snapshot unavailable');
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cache/invalidate',
        headers: operatorHeaders,
      });

      expect(response.statusCode).toBe(500);
      const payload = response.json();
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('KB_RUNTIME_UNEXPECTED');
      expect(payload.error.correlationId).toEqual(expect.any(String));
    });

    it('tracks request timing in metadata', async () => {
      const snapshot = createMockSnapshot(1);

      // Use fake timers so the test is deterministic regardless of CPU load or CI jitter.
      // Without this, setTimeout(resolve, 10) may resolve after < 10 ms of wall-clock
      // time as measured by Date.now(), causing an intermittent off-by-one failure.
      vi.useFakeTimers();
      const FAKE_DELAY_MS = 10;

      try {
        vi.mocked(mockCliApi.snapshot).mockReturnValue(snapshot);
        vi.mocked(mockCliApi.refresh).mockImplementation(async () => {
          // Advance fake clock so Date.now() inside the route handler reflects the delay.
          vi.advanceTimersByTime(FAKE_DELAY_MS);
        });
        vi.mocked(mockCliApi.listPlugins).mockResolvedValue([]);

        const responsePromise = app.inject({
          method: 'POST',
          url: '/api/v1/cache/invalidate',
          headers: operatorHeaders,
        });

        // Drain any pending microtasks so the mock refresh runs and the clock advance
        // takes effect before we await the final response.
        await Promise.resolve();

        const response = await responsePromise;

        expect(response.statusCode).toBe(200);
        const payload = response.json();
        expect(payload.meta.durationMs).toBeGreaterThanOrEqual(FAKE_DELAY_MS);
      } finally {
        vi.useRealTimers();
      }
    });

    it('includes timestamp in ISO format', async () => {
      const snapshot = createMockSnapshot(1);

      vi.mocked(mockCliApi.snapshot).mockReturnValue(snapshot);
      vi.mocked(mockCliApi.refresh).mockResolvedValue(undefined);
      vi.mocked(mockCliApi.listPlugins).mockResolvedValue([]);

      const before = new Date();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cache/invalidate',
        headers: operatorHeaders,
      });
      const after = new Date();

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      const timestamp = new Date(payload.data.timestamp);

      expect(timestamp).toBeInstanceOf(Date);
      expect(timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('handles empty plugin list after refresh', async () => {
      const beforeSnapshot = createMockSnapshot(1);
      const afterSnapshot = createMockSnapshot(2);

      vi.mocked(mockCliApi.snapshot)
        .mockReturnValueOnce(beforeSnapshot)
        .mockReturnValueOnce(afterSnapshot);
      vi.mocked(mockCliApi.refresh).mockResolvedValue(undefined);
      vi.mocked(mockCliApi.listPlugins).mockResolvedValue([]);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cache/invalidate',
        headers: operatorHeaders,
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.data.pluginsDiscovered).toBe(0);
    });
  });
});
