import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import { createErrorEnvelope, getCatalogEntry } from '@kb-labs/core-platform';
import { InMemoryAnalyticsBuffer } from '@kb-labs/core-platform/inmemory';

const mockPlatform = vi.hoisted(() => ({ analytics: {} as object, cache: { get: vi.fn(), set: vi.fn() } }));

vi.mock('@kb-labs/core-runtime', () => ({ platform: mockPlatform }));

const BASE_CONFIG: RestApiConfig = {
  port: 3000,
  basePath: '/api/v1',
  apiVersion: 'test',
  cors: { origins: [], allowCredentials: true, profile: 'dev' },
  plugins: [],
  mockMode: false,
};

describe('registerAnalyticsRoutes', () => {
  let app: ReturnType<typeof Fastify> | undefined;

  beforeEach(() => {
    mockPlatform.analytics = {};
    mockPlatform.cache.get.mockResolvedValue(undefined);
    mockPlatform.cache.set.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns the catalogued unsupported-stats envelope and status', async () => {
    const { registerAnalyticsRoutes } = await import('../analytics.js');
    app = Fastify({ logger: false });
    await registerAnalyticsRoutes(app, BASE_CONFIG);

    const response = await app.inject({ method: 'GET', url: '/api/v1/analytics/stats' });
    const code = 'KB_ANALYTICS_STATS_UNSUPPORTED';
    const expectedError = createErrorEnvelope(code);

    expect(response.statusCode, response.body).toBe(getCatalogEntry(code).httpStatus);
    expect(response.json()).toEqual({ ok: false, error: expectedError });
  });

  // case: S-275.1
  it('returns the configured adapter stats persistence capability', async () => {
    const analytics = new InMemoryAnalyticsBuffer();
    await analytics.track('workflow.completed');
    mockPlatform.analytics = analytics;
    const { registerAnalyticsRoutes } = await import('../analytics.js');
    app = Fastify({ logger: false });
    await registerAnalyticsRoutes(app, BASE_CONFIG);

    const response = await app.inject({ method: 'GET', url: '/api/v1/analytics/stats' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.totalEvents).toBe(1);
    expect(response.json().data.persistence).toMatchObject({ kind: 'ephemeral' });
    expect(response.json().data.persistence.notice).toEqual({
      message: createErrorEnvelope('KB_ANALYTICS_PERSISTENCE_VOLATILE').message,
      hint: createErrorEnvelope('KB_ANALYTICS_PERSISTENCE_VOLATILE').hint,
    });
  });
});
