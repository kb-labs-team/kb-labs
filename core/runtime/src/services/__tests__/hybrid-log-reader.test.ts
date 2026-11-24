/**
 * Tests for HybridLogReader
 */

import { describe, it, expect, vi } from 'vitest';
import { HybridLogReader } from '../hybrid-log-reader.js';
import type {
  ILogPersistence,
  ILogBuffer,
  LogRecord,
} from '@kb-labs/core-platform';

describe('HybridLogReader', () => {
  // Mock helpers
  const createMockLog = (id: string, level: string, message: string, timestamp = Date.now()): LogRecord => ({
    id,
    timestamp,
    level: level as LogRecord['level'],
    message,
    fields: {},
    source: 'test',
  });

  describe('constructor', () => {
    it('should accept both persistence and buffer', () => {
      const mockPersistence = {} as ILogPersistence;
      const mockBuffer = {} as ILogBuffer;

      const service = new HybridLogReader(mockPersistence, mockBuffer);
      expect(service).toBeDefined();
    });

    it('should accept only persistence', () => {
      const mockPersistence = {} as ILogPersistence;
      const service = new HybridLogReader(mockPersistence, undefined);
      expect(service).toBeDefined();
    });

    it('should accept only buffer', () => {
      const mockBuffer = {} as ILogBuffer;
      const service = new HybridLogReader(undefined, mockBuffer);
      expect(service).toBeDefined();
    });

    it('should accept neither (will error on use)', () => {
      const service = new HybridLogReader(undefined, undefined);
      expect(service).toBeDefined();
    });
  });

  describe('query', () => {
    describe('with persistence', () => {
      it('should query from persistence when available', async () => {
        const mockLogs = [
          createMockLog('log-1', 'error', 'Error 1'),
          createMockLog('log-2', 'error', 'Error 2'),
        ];

        const mockPersistence: Partial<ILogPersistence> = {
          query: vi.fn().mockResolvedValue({
            logs: mockLogs,
            total: 2,
            hasMore: false,
          }),
        };

        const service = new HybridLogReader(
          mockPersistence as ILogPersistence,
          undefined
        );

        const result = await service.query({ level: 'error' });

        expect(mockPersistence.query).toHaveBeenCalledWith(
          { level: 'error' },
          expect.any(Object)
        );
        expect(result.logs).toEqual(mockLogs);
        expect(result.total).toBe(2);
        expect(result.source).toBe('persistence');
      });

      it('should pass query options to persistence', async () => {
        const mockPersistence: Partial<ILogPersistence> = {
          query: vi.fn().mockResolvedValue({
            logs: [],
            total: 0,
            hasMore: false,
          }),
        };

        const service = new HybridLogReader(
          mockPersistence as ILogPersistence,
          undefined
        );

        await service.query(
          { level: 'error' },
          { limit: 50, offset: 10, sortBy: 'timestamp', sortOrder: 'asc' }
        );

        expect(mockPersistence.query).toHaveBeenCalledWith(
          { level: 'error' },
          { limit: 50, offset: 10, sortBy: 'timestamp', sortOrder: 'asc' }
        );
      });
    });

    describe('with buffer only', () => {
      it('should query from buffer when persistence unavailable', async () => {
        const mockLogs = [
          createMockLog('log-1', 'info', 'Info 1', 1000),
          createMockLog('log-2', 'info', 'Info 2', 2000),
        ];

        const mockBuffer: Partial<ILogBuffer> = {
          query: vi.fn().mockReturnValue(mockLogs),
          getStats: vi.fn().mockReturnValue({
            total: 2,
            bufferSize: 1000,
            oldestTimestamp: 1000,
            newestTimestamp: 2000,
          }),
          subscribe: vi.fn(),
          append: vi.fn(),
        };

        const service = new HybridLogReader(
          undefined,
          mockBuffer as ILogBuffer
        );

        const result = await service.query({});

        expect(mockBuffer.query).toHaveBeenCalled();
        expect(result.logs).toHaveLength(2);
        expect(result.source).toBe('buffer');
      });

      it('should apply pagination from buffer', async () => {
        const mockLogs = Array.from({ length: 10 }, (_, i) =>
          createMockLog(`log-${i}`, 'info', `Info ${i}`, 1000 + i)
        );

        const mockBuffer: Partial<ILogBuffer> = {
          query: vi.fn().mockReturnValue(mockLogs),
          getStats: vi.fn(),
          subscribe: vi.fn(),
          append: vi.fn(),
        };

        const service = new HybridLogReader(
          undefined,
          mockBuffer as ILogBuffer
        );

        const result = await service.query({}, { limit: 3, offset: 2 });

        expect(result.logs).toHaveLength(3);
        // Default sort is desc (newest first): [9,8,7,6,5,4,3,2,1,0]
        // With offset=2, limit=3: [7,6,5]
        expect(result.logs[0]!.id).toBe('log-7');
        expect(result.logs[1]!.id).toBe('log-6');
        expect(result.logs[2]!.id).toBe('log-5');
        expect(result.total).toBe(10);
        expect(result.hasMore).toBe(true);
      });

      it('should sort buffer results', async () => {
        const mockLogs = [
          createMockLog('log-3', 'info', 'Info 3', 3000),
          createMockLog('log-1', 'info', 'Info 1', 1000),
          createMockLog('log-2', 'info', 'Info 2', 2000),
        ];

        const mockBuffer: Partial<ILogBuffer> = {
          query: vi.fn().mockReturnValue(mockLogs),
          getStats: vi.fn(),
          subscribe: vi.fn(),
          append: vi.fn(),
        };

        const service = new HybridLogReader(
          undefined,
          mockBuffer as ILogBuffer
        );

        // Sort ascending
        const resultAsc = await service.query({}, { sortOrder: 'asc' });
        expect(resultAsc.logs[0]!.timestamp).toBe(1000);
        expect(resultAsc.logs[2]!.timestamp).toBe(3000);

        // Sort descending (default)
        const resultDesc = await service.query({}, { sortOrder: 'desc' });
        expect(resultDesc.logs[0]!.timestamp).toBe(3000);
        expect(resultDesc.logs[2]!.timestamp).toBe(1000);
      });
    });

    describe('with neither backend', () => {
      it('should throw error when no backend available', async () => {
        const service = new HybridLogReader(undefined, undefined);

        await expect(service.query({})).rejects.toThrow(
          'No log storage backend available'
        );
      });
    });
  });

  describe('getById', () => {
    it('should get log from persistence when available', async () => {
      const mockLog = createMockLog('log-123', 'error', 'Test error');

      const mockPersistence: Partial<ILogPersistence> = {
        getById: vi.fn().mockResolvedValue(mockLog),
      };

      const service = new HybridLogReader(
        mockPersistence as ILogPersistence,
        undefined
      );

      const result = await service.getById('log-123');

      expect(mockPersistence.getById).toHaveBeenCalledWith('log-123');
      expect(result).toEqual(mockLog);
    });

    it('should fallback to buffer when persistence unavailable', async () => {
      const mockLogs = [
        createMockLog('log-1', 'info', 'Info 1'),
        createMockLog('log-123', 'error', 'Test error'),
        createMockLog('log-3', 'info', 'Info 3'),
      ];

      const mockBuffer: Partial<ILogBuffer> = {
        query: vi.fn().mockReturnValue(mockLogs),
        getStats: vi.fn(),
        subscribe: vi.fn(),
        append: vi.fn(),
      };

      const service = new HybridLogReader(
        undefined,
        mockBuffer as ILogBuffer
      );

      const result = await service.getById('log-123');

      expect(mockBuffer.query).toHaveBeenCalled();
      expect(result?.id).toBe('log-123');
      expect(result?.message).toBe('Test error');
    });

    it('should return null when log not found', async () => {
      const mockPersistence: Partial<ILogPersistence> = {
        getById: vi.fn().mockResolvedValue(null),
      };

      const service = new HybridLogReader(
        mockPersistence as ILogPersistence,
        undefined
      );

      const result = await service.getById('non-existent');

      expect(result).toBeNull();
    });

    it('should return null when no backend available', async () => {
      const service = new HybridLogReader(undefined, undefined);
      const result = await service.getById('log-123');
      expect(result).toBeNull();
    });
  });

  describe('search', () => {
    it('should use persistence FTS when available', async () => {
      const mockLogs = [
        createMockLog('log-1', 'error', 'Authentication failed'),
        createMockLog('log-2', 'error', 'Login failed'),
      ];

      const mockPersistence: Partial<ILogPersistence> = {
        search: vi.fn().mockResolvedValue({
          logs: mockLogs,
          total: 2,
          hasMore: false,
        }),
      };

      const service = new HybridLogReader(
        mockPersistence as ILogPersistence,
        undefined
      );

      const result = await service.search('failed');

      expect(mockPersistence.search).toHaveBeenCalledWith('failed', expect.any(Object));
      expect(result.logs).toEqual(mockLogs);
      expect(result.total).toBe(2);
    });

    it('should fallback to simple text matching in buffer', async () => {
      const mockLogs = [
        createMockLog('log-1', 'info', 'Test authentication success'),
        createMockLog('log-2', 'error', 'Authentication failed'),
        createMockLog('log-3', 'info', 'Test complete'),
      ];

      const mockBuffer: Partial<ILogBuffer> = {
        query: vi.fn().mockReturnValue(mockLogs),
        getStats: vi.fn(),
        subscribe: vi.fn(),
        append: vi.fn(),
      };

      const service = new HybridLogReader(
        undefined,
        mockBuffer as ILogBuffer
      );

      const result = await service.search('authentication');

      expect(result.logs).toHaveLength(2);
      expect(result.logs[0]!.message).toContain('authentication');
      expect(result.logs[1]!.message).toContain('Authentication');
    });

    it('should throw error when no backend available', async () => {
      const service = new HybridLogReader(undefined, undefined);

      await expect(service.search('test')).rejects.toThrow(
        'No log storage backend available'
      );
    });
  });

  describe('subscribe', () => {
    it('should subscribe to buffer with no filters', () => {
      const mockCallback = vi.fn();
      const mockUnsubscribe = vi.fn();

      const mockBuffer: Partial<ILogBuffer> = {
        subscribe: vi.fn().mockReturnValue(mockUnsubscribe),
        query: vi.fn(),
        getStats: vi.fn(),
        append: vi.fn(),
      };

      const service = new HybridLogReader(
        undefined,
        mockBuffer as ILogBuffer
      );

      const unsubscribe = service.subscribe(mockCallback);

      expect(mockBuffer.subscribe).toHaveBeenCalledWith(expect.any(Function));
      expect(unsubscribe).toBe(mockUnsubscribe);
    });

    it('should apply filters to subscription', () => {
      let capturedCallback: ((log: LogRecord) => void) | undefined;

      const mockBuffer: Partial<ILogBuffer> = {
        subscribe: vi.fn().mockImplementation((cb) => {
          capturedCallback = cb;
          return vi.fn();
        }),
        query: vi.fn(),
        getStats: vi.fn(),
        append: vi.fn(),
      };

      const service = new HybridLogReader(
        undefined,
        mockBuffer as ILogBuffer
      );

      const userCallback = vi.fn();
      service.subscribe(userCallback, { level: 'error' });

      expect(capturedCallback).toBeDefined();

      // Trigger subscription with error log (should pass filter)
      capturedCallback!(createMockLog('log-1', 'error', 'Error log'));
      expect(userCallback).toHaveBeenCalledTimes(1);

      // Trigger subscription with info log (should be filtered out)
      capturedCallback!(createMockLog('log-2', 'info', 'Info log'));
      expect(userCallback).toHaveBeenCalledTimes(1); // Still 1
    });

    // case: S-122.3
    it('should require both workflow run and step execution IDs to match', () => {
      let publish: ((log: LogRecord) => void) | undefined;
      const mockBuffer: Partial<ILogBuffer> = {
        subscribe: vi.fn().mockImplementation((callback) => {
          publish = callback;
          return vi.fn();
        }),
        query: vi.fn(),
        getStats: vi.fn(),
        append: vi.fn(),
      };
      const service = new HybridLogReader(undefined, mockBuffer as ILogBuffer);
      const userCallback = vi.fn();
      service.subscribe(userCallback, { runId: 'run-1', executionId: 'exec-1' });

      const matchingLog = createMockLog('matching', 'info', 'matching');
      matchingLog.fields = { runId: 'run-1', executionId: 'exec-1' };
      const otherExecution = createMockLog('other-execution', 'info', 'other execution');
      otherExecution.fields = { runId: 'run-1', executionId: 'exec-2' };
      const otherRun = createMockLog('other-run', 'info', 'other run');
      otherRun.fields = { runId: 'run-2', executionId: 'exec-1' };

      publish!(matchingLog);
      publish!(otherExecution);
      publish!(otherRun);

      expect(userCallback).toHaveBeenCalledTimes(1);
      expect(userCallback).toHaveBeenCalledWith(matchingLog);
    });

    it('should throw error when buffer unavailable', () => {
      const service = new HybridLogReader(undefined, undefined);

      expect(() => service.subscribe(vi.fn())).toThrow(
        'Real-time streaming requires ring buffer'
      );
    });
  });

  describe('getStats', () => {
    it('should return combined stats from both backends', async () => {
      const mockPersistence: Partial<ILogPersistence> = {
        getStats: vi.fn().mockResolvedValue({
          totalLogs: 10000,
          oldestTimestamp: 1000,
          newestTimestamp: 5000,
          sizeBytes: 1024000,
        }),
      };

      const mockBuffer: Partial<ILogBuffer> = {
        getStats: vi.fn().mockReturnValue({
          total: 100,
          bufferSize: 1000,
          oldestTimestamp: 4000,
          newestTimestamp: 5000,
        }),
        query: vi.fn(),
        subscribe: vi.fn(),
        append: vi.fn(),
      };

      const service = new HybridLogReader(
        mockPersistence as ILogPersistence,
        mockBuffer as ILogBuffer
      );

      const stats = await service.getStats();

      expect(stats.persistence).toEqual({
        totalLogs: 10000,
        oldestTimestamp: 1000,
        newestTimestamp: 5000,
        sizeBytes: 1024000,
      });

      expect(stats.buffer).toEqual({
        size: 100,
        maxSize: 1000,
        oldestTimestamp: 4000,
        newestTimestamp: 5000,
      });
    });

    it('should return only buffer stats when persistence unavailable', async () => {
      const mockBuffer: Partial<ILogBuffer> = {
        getStats: vi.fn().mockReturnValue({
          total: 50,
          bufferSize: 1000,
          oldestTimestamp: null,
          newestTimestamp: null,
        }),
        query: vi.fn(),
        subscribe: vi.fn(),
        append: vi.fn(),
      };

      const service = new HybridLogReader(
        undefined,
        mockBuffer as ILogBuffer
      );

      const stats = await service.getStats();

      expect(stats.buffer).toBeDefined();
      expect(stats.persistence).toBeUndefined();
    });

    it('should return empty stats when no backend available', async () => {
      const service = new HybridLogReader(undefined, undefined);
      const stats = await service.getStats();

      expect(stats.buffer).toBeUndefined();
      expect(stats.persistence).toBeUndefined();
    });
  });

  describe('getCapabilities', () => {
    it('should report all capabilities with both backends', () => {
      const mockPersistence = {} as ILogPersistence;
      const mockBuffer = {} as ILogBuffer;

      const service = new HybridLogReader(mockPersistence, mockBuffer);
      const caps = service.getCapabilities();

      expect(caps.hasBuffer).toBe(true);
      expect(caps.hasPersistence).toBe(true);
      expect(caps.hasSearch).toBe(true);
      expect(caps.hasStreaming).toBe(true);
    });

    it('should report limited capabilities with buffer only', () => {
      const mockBuffer = {} as ILogBuffer;
      const service = new HybridLogReader(undefined, mockBuffer);
      const caps = service.getCapabilities();

      expect(caps.hasBuffer).toBe(true);
      expect(caps.hasPersistence).toBe(false);
      expect(caps.hasSearch).toBe(false);  // FTS only in persistence
      expect(caps.hasStreaming).toBe(true);
    });

    it('should report limited capabilities with persistence only', () => {
      const mockPersistence = {} as ILogPersistence;
      const service = new HybridLogReader(mockPersistence, undefined);
      const caps = service.getCapabilities();

      expect(caps.hasBuffer).toBe(false);
      expect(caps.hasPersistence).toBe(true);
      expect(caps.hasSearch).toBe(true);
      expect(caps.hasStreaming).toBe(false);  // Streaming only in buffer
    });

    it('should report no capabilities when no backend available', () => {
      const service = new HybridLogReader(undefined, undefined);
      const caps = service.getCapabilities();

      expect(caps.hasBuffer).toBe(false);
      expect(caps.hasPersistence).toBe(false);
      expect(caps.hasSearch).toBe(false);
      expect(caps.hasStreaming).toBe(false);
    });
  });
});
