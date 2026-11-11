import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { RestApiConfig } from '@kb-labs/rest-api-core';
import { registerEnvelopeMiddleware } from '../../middleware/envelope.js';

// Mutable platform object that tests can configure
const mockPlatform = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    flush: vi.fn(async () => {}),
    child: vi.fn(),
  };
  logger.child.mockImplementation(() => logger);
  return { analytics: {} as Record<string, unknown>, logger };
});

vi.mock('@kb-labs/core-runtime', () => ({
  platform: mockPlatform,
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

/**
 * Create mock analytics events with kb.v1 schema
 */
function createMockEvent(
  type: string,
  timestamp: string,
  payload: Record<string, unknown>
): any {
  return {
    id: `evt-${Math.random()}`,
    schema: 'kb.v1',
    type,
    ts: timestamp,
    ingestTs: timestamp,
    runId: 'run-test',
    source: { product: 'test', version: '1.0.0' },
    payload,
    actor: { type: 'user', id: 'test-user' },
  };
}

/**
 * Wrap events array as EventsResponse
 */
function eventsResponse(events: any[]): any {
  return { events, total: events.length, hasMore: false };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});

describe('Adapter Analytics Routes - Date Range Support', () => {
  describe('GET /api/v1/adapters/llm/usage', () => {
    it('should return LLM usage stats without date range', async () => {
      const completedEvents = [
        createMockEvent('llm.completion.completed', '2026-01-15T10:00:00Z', {
          model: 'gpt-4',
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          estimatedCost: 0.01,
          durationMs: 1000,
        }),
        createMockEvent('llm.completion.completed', '2026-01-16T10:00:00Z', {
          model: 'gpt-4',
          promptTokens: 200,
          completionTokens: 100,
          totalTokens: 300,
          estimatedCost: 0.02,
          durationMs: 1500,
        }),
      ];

      const errorEvents = [
        createMockEvent('llm.completion.error', '2026-01-17T10:00:00Z', {
          model: 'gpt-4',
          error: 'Rate limit exceeded',
        }),
      ];

      const mockAnalytics: any = {
        getEvents: vi.fn((query: any) => {
          if ([].concat(query.type).some(t => t === 'llm.completion.completed')) {
            return Promise.resolve(eventsResponse(completedEvents));
          }
          if ([].concat(query.type).some(t => t === 'llm.completion.error')) {
            return Promise.resolve(eventsResponse(errorEvents));
          }
          return Promise.resolve(eventsResponse([]));
        }),
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/llm/usage',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.ok).toBe(true);
      expect(payload.data.totalRequests).toBe(2);
      expect(payload.data.totalTokens).toBe(450);
      expect(payload.data.totalCost).toBe(0.03);
      expect(payload.data.errors).toBe(1);
      expect(mockAnalytics.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          type: expect.arrayContaining(['llm.completion.completed']),
          from: undefined,
          to: undefined,
          limit: 10000,
        })
      );

      await app.close();
    });

    it('should return LLM usage stats with date range', async () => {
      const completedEvents = [
        createMockEvent('llm.completion.completed', '2026-01-15T10:00:00Z', {
          model: 'gpt-4',
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          estimatedCost: 0.01,
          durationMs: 1000,
        }),
      ];

      const errorEvents: any[] = [];

      const mockAnalytics: any = {
        getEvents: vi.fn((query: any) => {
          expect(query.from).toBe('2026-01-01T00:00:00Z');
          expect(query.to).toBe('2026-01-31T23:59:59Z');

          if ([].concat(query.type).some(t => t === 'llm.completion.completed')) {
            return Promise.resolve(eventsResponse(completedEvents));
          }
          if ([].concat(query.type).some(t => t === 'llm.completion.error')) {
            return Promise.resolve(eventsResponse(errorEvents));
          }
          return Promise.resolve(eventsResponse([]));
        }),
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/llm/usage?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.ok).toBe(true);
      expect(payload.data.totalRequests).toBe(1);
      expect(payload.data.totalTokens).toBe(150);
      expect(mockAnalytics.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          type: expect.arrayContaining(['llm.completion.completed']),
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-31T23:59:59Z',
          limit: 10000,
        })
      );

      await app.close();
    });

    it('should return 400 for invalid from date', async () => {
      const mockAnalytics: any = {
        getEvents: vi.fn(),
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/llm/usage?from=invalid-date',
      });

      expect(response.statusCode).toBe(400);
      const payload = response.json();
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_RUNTIME_INPUT_INVALID', hint: expect.any(String) });

      await app.close();
    });

    it('should return 400 for invalid to date', async () => {
      const mockAnalytics: any = {
        getEvents: vi.fn(),
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/llm/usage?to=not-a-date',
      });

      expect(response.statusCode).toBe(400);
      const payload = response.json();
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_RUNTIME_INPUT_INVALID', hint: expect.any(String) });

      await app.close();
    });

    it('should return 501 when analytics does not support getEvents', async () => {
      const mockAnalytics: any = {
        // getEvents not implemented
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/llm/usage',
      });

      expect(response.statusCode).toBe(501);
      const payload = response.json();
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({
        code: 'ANALYTICS_NOT_IMPLEMENTED',
        area: 'product',
        hint: expect.any(String),
      });

      await app.close();
    });
  });

  describe('GET /api/v1/adapters/embeddings/usage', () => {
    it('should return embeddings usage stats with date range', async () => {
      const embeddingEvents = [
        createMockEvent('embeddings.embed.completed', '2026-01-15T10:00:00Z', {
          model: 'text-embedding-ada-002',
          textLength: 500,
          estimatedCost: 0.001,
          durationMs: 200,
        }),
      ];

      const errorEvents: any[] = [];

      const mockAnalytics: any = {
        getEvents: vi.fn((query: any) => {
          if ([].concat(query.type).some(t => t === 'embeddings.embed.completed')) {
            return Promise.resolve(eventsResponse(embeddingEvents));
          }
          if ([].concat(query.type).some(t => t === 'embeddings.embed.error')) {
            return Promise.resolve(eventsResponse(errorEvents));
          }
          return Promise.resolve(eventsResponse([]));
        }),
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/embeddings/usage?from=2026-01-01T00:00:00Z&to=2026-01-31T23:59:59Z',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.ok).toBe(true);
      expect(payload.data.totalRequests).toBe(1);
      expect(payload.data.totalTextLength).toBe(500);

      await app.close();
    });

    it('should return 400 for invalid date range', async () => {
      const mockAnalytics: any = {
        getEvents: vi.fn(),
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/embeddings/usage?from=invalid&to=also-invalid',
      });

      expect(response.statusCode).toBe(400);
      const payload = response.json();
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('KB_RUNTIME_INPUT_INVALID');

      await app.close();
    });
  });

  describe('Date format support', () => {
    it('should accept ISO 8601 with milliseconds', async () => {
      const mockAnalytics: any = {
        getEvents: vi.fn(() => Promise.resolve(eventsResponse([]))),
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/llm/usage?from=2026-01-01T00:00:00.000Z&to=2026-01-31T23:59:59.999Z',
      });

      expect(response.statusCode).toBe(200);

      await app.close();
    });

    it('should accept ISO 8601 with timezone offset', async () => {
      const mockAnalytics: any = {
        getEvents: vi.fn(() => Promise.resolve(eventsResponse([]))),
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/llm/usage?from=2026-01-01T00:00:00%2B03:00&to=2026-01-31T23:59:59-05:00',
      });

      expect(response.statusCode).toBe(200);

      await app.close();
    });

    it('should accept short ISO 8601 date format', async () => {
      const mockAnalytics: any = {
        getEvents: vi.fn(() => Promise.resolve(eventsResponse([]))),
      };

      mockPlatform.analytics = mockAnalytics;

      const { registerAdaptersRoutes } = await import('../adapters');
      const app = Fastify({ logger: false });
      registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
      await registerAdaptersRoutes(app as any, BASE_CONFIG);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/adapters/llm/usage?from=2026-01-01&to=2026-01-31',
      });

      expect(response.statusCode).toBe(200);

      await app.close();
    });
  });

  it('does not register routes that aggregate raw cache, storage, or vector-store events', async () => {
    mockPlatform.analytics = { getEvents: vi.fn() };

    const { registerAdaptersRoutes } = await import('../adapters');
    const app = Fastify({ logger: false });
    registerEnvelopeMiddleware(app as unknown as FastifyInstance, BASE_CONFIG);
    await registerAdaptersRoutes(app as any, BASE_CONFIG);

    for (const path of [
      '/api/v1/adapters/vectorstore/daily-stats',
      '/api/v1/adapters/vectorstore/usage',
      '/api/v1/adapters/cache/daily-stats',
      '/api/v1/adapters/cache/usage',
      '/api/v1/adapters/storage/daily-stats',
      '/api/v1/adapters/storage/usage',
    ]) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode, path).toBe(404);
    }

    await app.close();
  });
});
