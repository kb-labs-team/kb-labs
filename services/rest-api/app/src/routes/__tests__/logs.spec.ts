/**
 * Integration tests for log query endpoints
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import Fastify from 'fastify';

import type { RestApiConfig } from '@kb-labs/rest-api-core';
import { registerLogRoutes } from '../logs.js';
import { registerEnvelopeMiddleware } from '../../middleware/envelope.js';
import { platform } from '@kb-labs/core-runtime';
import type { LogRecord, ILogReader } from '@kb-labs/core-platform';

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

// Helper to create mock log
const createMockLog = (id: string, level: string, message: string, timestamp = Date.now()): LogRecord => ({
  id,
  timestamp,
  level: level as LogRecord['level'],
  message,
  fields: { plugin: 'test', executionId: 'exec-123' },
  source: 'test',
});

describe('Log Routes Integration Tests', () => {
  let app: ReturnType<typeof Fastify>;
  let mockLogService: Partial<ILogReader>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create mock log service
    mockLogService = {
      query: vi.fn(),
      getById: vi.fn(),
      search: vi.fn(),
      subscribe: vi.fn(),
      getStats: vi.fn(),
      getCapabilities: vi.fn(),
    };

    // Mock platform.logs
    vi.spyOn(platform, 'logs', 'get').mockReturnValue(mockLogService as ILogReader);

    app = Fastify({ logger: false });
    registerEnvelopeMiddleware(app, BASE_CONFIG);
    await registerLogRoutes(app);
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  describe('GET /api/v1/logs', () => {
    it('should query logs with filters', async () => {
      const mockLogs = [
        createMockLog('log-1', 'error', 'Error 1', 1000),
        createMockLog('log-2', 'error', 'Error 2', 2000),
      ];

      (mockLogService.query as any).mockResolvedValue({
        logs: mockLogs,
        total: 2,
        hasMore: false,
        source: 'persistence',
      });

      (mockLogService.getStats as any).mockResolvedValue({
        persistence: {
          totalLogs: 100,
          oldestTimestamp: 1000,
          newestTimestamp: 2000,
          sizeBytes: 1024,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs?level=error&limit=10',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.ok).toBe(true);
      expect(payload.data.logs).toHaveLength(2);
      expect(payload.data.total).toBe(2);
      expect(payload.data.hasMore).toBe(false);
      expect(payload.data.source).toBe('persistence');

      expect(mockLogService.query).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error' }),
        expect.objectContaining({ limit: 10 })
      );
    });

    it('should use search when search query provided', async () => {
      const mockLogs = [
        createMockLog('log-1', 'error', 'Authentication failed'),
      ];

      (mockLogService.search as any).mockResolvedValue({
        logs: mockLogs,
        total: 1,
        hasMore: false,
      });

      (mockLogService.getStats as any).mockResolvedValue({});

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs?search=authentication',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.ok).toBe(true);
      expect(payload.data.logs).toHaveLength(1);

      expect(mockLogService.search).toHaveBeenCalledWith(
        'authentication',
        expect.objectContaining({ limit: 100, offset: 0 })
      );
      expect(mockLogService.query).not.toHaveBeenCalled();
    });

    it('should handle pagination', async () => {
      const mockLogs = Array.from({ length: 5 }, (_, i) =>
        createMockLog(`log-${i}`, 'info', `Info ${i}`)
      );

      (mockLogService.query as any).mockResolvedValue({
        logs: mockLogs,
        total: 50,
        hasMore: true,
        source: 'buffer',
      });

      (mockLogService.getStats as any).mockResolvedValue({});

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs?limit=5&offset=10',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.data.hasMore).toBe(true);
      expect(payload.data.total).toBe(50);

      expect(mockLogService.query).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ limit: 5, offset: 10 })
      );
    });

    it('should return stats in response', async () => {
      (mockLogService.query as any).mockResolvedValue({
        logs: [],
        total: 0,
        hasMore: false,
        source: 'persistence',
      });

      (mockLogService.getStats as any).mockResolvedValue({
        buffer: {
          size: 100,
          maxSize: 1000,
          oldestTimestamp: 1000,
          newestTimestamp: 2000,
        },
        persistence: {
          totalLogs: 5000,
          oldestTimestamp: 100,
          newestTimestamp: 3000,
          sizeBytes: 1024000,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.data.stats.buffer).toBeDefined();
      expect(payload.data.stats.buffer.size).toBe(100);
      expect(payload.data.stats.persistence).toBeDefined();
      expect(payload.data.stats.persistence.totalLogs).toBe(5000);
    });

    it('should handle errors gracefully', async () => {
      (mockLogService.query as any).mockRejectedValue(
        new Error('No log storage backend available')
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs',
      });

      expect(response.statusCode).toBe(503);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_RUNTIME_UNEXPECTED', hint: expect.any(String), correlationId: expect.any(String) });
    });
  });

  describe('GET /api/v1/logs/:id', () => {
    it('should return log by ID', async () => {
      const mockLog = createMockLog('log-123', 'error', 'Test error');

      (mockLogService.getById as any).mockResolvedValue(mockLog);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs/log-123',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.ok).toBe(true);
      expect(payload.data.log.msg).toBe('Test error');
      expect(payload.data.log.level).toBe('error');

      expect(mockLogService.getById).toHaveBeenCalledWith('log-123');
    });

    it('should return 404 when log not found', async () => {
      (mockLogService.getById as any).mockResolvedValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs/non-existent',
      });

      expect(response.statusCode).toBe(404);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_RUNTIME_UNEXPECTED', hint: expect.any(String) });
    });

    it('should handle errors', async () => {
      (mockLogService.getById as any).mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs/log-123',
      });

      expect(response.statusCode).toBe(500);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_RUNTIME_UNEXPECTED', hint: expect.any(String) });
    });
  });

  describe('GET /api/v1/logs/stream', () => {
    it('should return 503 when streaming not supported', async () => {
      (mockLogService.getCapabilities as any).mockReturnValue({
        hasBuffer: false,
        hasPersistence: true,
        hasSearch: true,
        hasStreaming: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs/stream',
      });

      expect(response.statusCode).toBe(503);
      const payload = response.json();

      expect(payload.error).toMatchObject({ code: 'KB_RUNTIME_UNEXPECTED', hint: expect.any(String) });
    });

    // Note: SSE streaming is hard to test in unit tests
    // Would need separate E2E tests with real SSE client
  });

  describe('GET /api/v1/logs/stats', () => {
    it('should return combined statistics', async () => {
      (mockLogService.getStats as any).mockResolvedValue({
        buffer: {
          size: 150,
          maxSize: 1000,
          oldestTimestamp: 5000,
          newestTimestamp: 10000,
        },
        persistence: {
          totalLogs: 10000,
          oldestTimestamp: 1000,
          newestTimestamp: 10000,
          sizeBytes: 5120000,
        },
      });

      (mockLogService.getCapabilities as any).mockReturnValue({
        hasBuffer: true,
        hasPersistence: true,
        hasSearch: true,
        hasStreaming: true,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs/stats',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.ok).toBe(true);
      expect(payload.data.capabilities).toEqual({
        hasBuffer: true,
        hasPersistence: true,
        hasSearch: true,
        hasStreaming: true,
      });

      expect(payload.data.buffer).toBeDefined();
      expect(payload.data.buffer.size).toBe(150);

      expect(payload.data.persistence).toBeDefined();
      expect(payload.data.persistence.totalLogs).toBe(10000);
    });

    it('should handle only buffer stats', async () => {
      (mockLogService.getStats as any).mockResolvedValue({
        buffer: {
          size: 50,
          maxSize: 1000,
          oldestTimestamp: null,
          newestTimestamp: null,
        },
      });

      (mockLogService.getCapabilities as any).mockReturnValue({
        hasBuffer: true,
        hasPersistence: false,
        hasSearch: false,
        hasStreaming: true,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs/stats',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.data.buffer).toBeDefined();
      expect(payload.data.persistence).toBeUndefined();
      expect(payload.data.capabilities.hasPersistence).toBe(false);
    });

    it('should handle errors', async () => {
      (mockLogService.getStats as any).mockRejectedValue(
        new Error('Stats unavailable')
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/logs/stats',
      });

      expect(response.statusCode).toBe(500);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_RUNTIME_UNEXPECTED', hint: expect.any(String) });
    });
  });

  describe('POST /api/v1/logs/summarize', () => {
    it('should summarize logs with LLM', async () => {
      const mockLogs = [
        createMockLog('log-1', 'error', 'Database connection failed'),
        createMockLog('log-2', 'error', 'Timeout connecting to DB'),
      ];

      (mockLogService.query as any).mockResolvedValue({
        logs: mockLogs,
        total: 2,
        hasMore: false,
        source: 'persistence',
      });

      // Mock platform.llm
      const mockLLM = {
        complete: vi.fn().mockResolvedValue({
          content: 'Database connection issues detected. Multiple timeouts occurred.',
        }),
      };
      vi.spyOn(platform, 'llm', 'get').mockReturnValue(mockLLM as any);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/logs/summarize',
        payload: {
          timeRange: {
            from: new Date(Date.now() - 3600000).toISOString(),
            to: new Date().toISOString(),
          },
          filters: { level: 'error' },
          question: 'What errors occurred?',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.ok).toBe(true);
      expect(payload.data.aiSummary).toContain('Database connection issues');
      expect(payload.data.summary.total).toBe(2);

      expect(mockLogService.query).toHaveBeenCalled();
      expect(mockLLM.complete).toHaveBeenCalled();
    });

    it('should handle missing LLM gracefully', async () => {
      const mockLogs = [
        createMockLog('log-1', 'error', 'Error 1'),
      ];

      (mockLogService.query as any).mockResolvedValue({
        logs: mockLogs,
        total: 1,
        hasMore: false,
        source: 'buffer',
      });

      // No LLM available
      vi.spyOn(platform, 'llm', 'get').mockReturnValue(undefined as any);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/logs/summarize',
        payload: {
          question: 'What happened?',
        },
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.ok).toBe(true);
      expect(payload.data.aiSummary).toContain('Log Summary'); // Fallback summary
      expect(payload.data.message).toContain('LLM not configured');
    });

    it('should handle errors', async () => {
      (mockLogService.query as any).mockRejectedValue(
        new Error('Query failed')
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/logs/summarize',
        payload: {},
      });

      expect(response.statusCode).toBe(500);
      const payload = response.json();

      expect(payload.ok).toBe(false);
      expect(payload.error).toMatchObject({ code: 'KB_RUNTIME_UNEXPECTED', hint: expect.any(String) });
    });
  });
});
