import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { platform } from '@kb-labs/core-runtime';
import { InMemoryCache } from '@kb-labs/core-platform/inmemory';

import type { RestApiConfig } from '@kb-labs/rest-api-core';
import { registerObservabilityRoutes } from '../observability';
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

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('registerObservabilityRoutes', () => {
  let app: ReturnType<typeof Fastify>;
  let previousStateDaemonUrl: string | undefined;

  beforeEach(async () => {
    previousStateDaemonUrl = process.env.KB_STATE_DAEMON_URL;
    process.env.KB_STATE_DAEMON_URL = 'http://127.0.0.1:43127';
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    registerEnvelopeMiddleware(app, BASE_CONFIG);
    await registerObservabilityRoutes(app, BASE_CONFIG);
  });

  afterEach(async () => {
    await app.close();
    if (previousStateDaemonUrl === undefined) { delete process.env.KB_STATE_DAEMON_URL; }
    else { process.env.KB_STATE_DAEMON_URL = previousStateDaemonUrl; }
  });

  // case: S-203.1
  it('returns a typed 503 when system metrics have no cache', async () => {
    const response = await app.inject('/api/v1/observability/system-metrics');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, error: { code: 'KB_SERVICE_UNAVAILABLE' } });
  });

  it('returns a typed 404 when the metrics cache contains no samples', async () => {
    const metricsApp: ReturnType<typeof Fastify> = Fastify({ logger: false });
    const cache = vi.spyOn(platform, 'cache', 'get').mockReturnValue(new InMemoryCache());
    try {
      registerEnvelopeMiddleware(metricsApp, BASE_CONFIG);
      await registerObservabilityRoutes(metricsApp, BASE_CONFIG, undefined, platform);
      const response = await metricsApp.inject('/api/v1/observability/system-metrics');
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_RESOURCE_NOT_FOUND' } });
    } finally {
      cache.mockRestore();
      await metricsApp.close();
    }
  });

  describe('GET /api/v1/observability/state-broker', () => {
    it('returns the typed missing-address failure without fetching a default URL', async () => {
      delete process.env.KB_STATE_DAEMON_URL;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/observability/state-broker',
      });


      expect(response.statusCode).toBe(503);
      expect(response.json().error).toMatchObject({
        code: 'KB_HOST_SERVICE_ADDRESS_MISSING',
        hint: expect.any(String),
        correlationId: expect.any(String),
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns State Broker statistics', async () => {
      const mockStats = {
        uptime: 3600,
        totalEntries: 42,
        totalSize: 1024,
        hitRate: 0.85,
        missRate: 0.15,
        evictions: 0,
        namespaces: { mind: { entries: 42, size: 1024, oldestEntry: 0 } },
        byTenant: {},
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockStats),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/observability/state-broker',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.ok).toBe(true);
      expect(payload.data).toEqual(mockStats);
      expect(payload.meta.source).toBe('state-broker');
      expect(payload.meta.daemonUrl).toBeDefined();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/stats'),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it('uses KB_STATE_DAEMON_URL environment variable', async () => {
      const customUrl = 'http://custom-daemon:8888';
      process.env.KB_STATE_DAEMON_URL = customUrl;

      mockFetch.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ uptime: 0, totalEntries: 0, totalSize: 0, hitRate: 0, missRate: 0, evictions: 0, namespaces: {} }),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/observability/state-broker',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.meta.daemonUrl).toBe(customUrl);

      expect(mockFetch).toHaveBeenCalledWith(
        `${customUrl}/stats`,
        expect.anything()
      );

      delete process.env.KB_STATE_DAEMON_URL;
    });

    it('does not fall back to a default URL when the host address is missing', async () => {
      delete process.env.KB_STATE_DAEMON_URL;

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/observability/state-broker',
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('KB_HOST_SERVICE_ADDRESS_MISSING');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns 503 when State Broker responds with error status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: vi.fn(),
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/observability/state-broker',
      });

      expect(response.statusCode).toBe(503);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_SERVICE_UNAVAILABLE', hint: expect.any(String) });
    });

    it('returns 503 when State Broker times out', async () => {
      const abortError = new Error('Timeout');
      abortError.name = 'AbortError';

      mockFetch.mockRejectedValue(abortError);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/observability/state-broker',
      });

      expect(response.statusCode).toBe(503);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_SERVICE_UNAVAILABLE', hint: expect.any(String) });
    });

    it('returns 503 when State Broker connection fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/observability/state-broker',
      });

      expect(response.statusCode).toBe(503);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_SERVICE_UNAVAILABLE', hint: expect.any(String) });
    });

    it('handles non-Error exceptions', async () => {
      mockFetch.mockRejectedValue('String error');

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/observability/state-broker',
      });

      expect(response.statusCode).toBe(503);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_SERVICE_UNAVAILABLE', hint: expect.any(String) });
    });
  });
});
