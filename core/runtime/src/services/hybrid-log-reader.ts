/**
 * @module @kb-labs/core-runtime/services/hybrid-log-reader
 * Hybrid log reader adapter implementation.
 *
 * Strategy:
 * 1. If persistence available → use it (complete historical data)
 * 2. If only buffer available → use it (recent logs only)
 * 3. Graceful degradation if neither available
 */

import { LOG_CONTEXT_FIELDS } from '@kb-labs/core-platform';
import type {
  ILogReader,
  ILogPersistence,
  ILogBuffer,
  LogRecord,
  LogQuery,
  LogQueryOptions,
  LogQueryResult,
  LogSearchOptions,
  LogSearchResult,
  LogStats,
  LogCapabilities,
} from '@kb-labs/core-platform';

/**
 * Hybrid log query service.
 *
 * Automatically selects best backend:
 * - Persistence (if available): complete historical data with FTS
 * - Buffer (if available): recent logs only, fast access
 * - Neither: throws descriptive error
 *
 * @example
 * ```typescript
 * const service = new HybridLogReader(persistence, buffer);
 *
 * // Query logs (uses persistence if available)
 * const result = await service.query({ level: 'error' });
 *
 * // Subscribe to real-time stream (uses buffer)
 * const unsubscribe = service.subscribe((log) => console.log(log));
 * ```
 */
export class HybridLogReader implements ILogReader {
  constructor(
    private persistence?: ILogPersistence,
    private buffer?: ILogBuffer
  ) {}

  /**
   * Query logs with filters and pagination.
   *
   * Strategy:
   * 1. Persistence + buffer merged (both available) — handles flush-interval gap
   * 2. Persistence only (no buffer)
   * 3. Buffer only (no persistence)
   * 4. Error if neither available
   *
   * Merging persistence + buffer is critical when logPersistence batches writes
   * (e.g. flushInterval: 5000ms). Records written during that window are in the
   * buffer but not yet in SQLite, so querying only persistence would miss them.
   */
  async query(
    filters: LogQuery,
    options: LogQueryOptions = {}
  ): Promise<LogQueryResult> {
    if (this.persistence && this.buffer) {
      return this.queryMerged(filters, options);
    }

    // Persistence only (no buffer)
    if (this.persistence) {
      const result = await this.persistence.query(filters, {
        limit: options.limit,
        offset: options.offset,
        sortBy: options.sortBy,
        sortOrder: options.sortOrder,
      });

      return {
        logs: result.logs,
        total: result.total,
        hasMore: result.hasMore,
        source: 'persistence',
      };
    }

    // Buffer only
    if (this.buffer) {
      return this.queryFromBuffer(filters, options);
    }

    // No storage available
    throw new Error(
      'No log storage backend available. Configure logPersistence or logRingBuffer in kb.config.json'
    );
  }

  /**
   * Query both persistence and buffer, merge results by ID (dedup).
   * Buffer records not yet flushed to persistence fill the recency gap.
   * @private
   */
  private async queryMerged(
    filters: LogQuery,
    options: LogQueryOptions
  ): Promise<LogQueryResult> {
    // Query persistence with a wide limit to get historical records
    const persistenceResult = await this.persistence!.query(filters, {
      limit: 2000,
      offset: 0,
      sortBy: options.sortBy,
      sortOrder: options.sortOrder,
    });

    // Query buffer for recent records (no pagination — merge first, paginate after)
    const bufferLogs = this.buffer!.query(filters);

    // Build ID set from persistence for dedup
    const persistenceIds = new Set(persistenceResult.logs.map((r) => r.id));

    // Add buffer records not yet in persistence
    const merged: LogRecord[] = [
      ...persistenceResult.logs,
      ...bufferLogs.filter((r) => !persistenceIds.has(r.id)),
    ];

    // Sort chronologically (oldest first by default; honour sortOrder if provided)
    const sortOrder = options.sortOrder ?? 'asc';
    merged.sort((a, b) =>
      sortOrder === 'asc' ? a.timestamp - b.timestamp : b.timestamp - a.timestamp
    );

    // Paginate merged result
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const page = merged.slice(offset, offset + limit);

    return {
      logs: page,
      total: merged.length,
      hasMore: offset + page.length < merged.length,
      source: 'persistence',
    };
  }

  /**
   * Get single log by ID.
   *
   * Searches persistence first (complete data), then buffer.
   */
  async getById(id: string): Promise<LogRecord | null> {
    // Try persistence first (complete data)
    if (this.persistence) {
      return this.persistence.getById(id);
    }

    // Fallback to buffer (recent logs only)
    if (this.buffer) {
      const logs = this.buffer.query({});
      return logs.find((log) => log.id === id) ?? null;
    }

    return null;
  }

  /**
   * Full-text search logs.
   *
   * Uses persistence FTS if available, otherwise simple text matching in buffer.
   */
  async search(
    searchText: string,
    options: LogSearchOptions = {}
  ): Promise<LogSearchResult> {
    // Use persistence FTS if available
    if (this.persistence) {
      return this.persistence.search(searchText, {
        limit: options.limit,
        offset: options.offset,
        filters: options.filters,
      });
    }

    // Fallback: simple text matching in buffer
    if (this.buffer) {
      return this.searchInBuffer(searchText, options);
    }

    throw new Error(
      'No log storage backend available. Configure logPersistence or logRingBuffer in kb.config.json'
    );
  }

  /**
   * Subscribe to real-time log stream.
   *
   * Requires ring buffer. Throws error if not available.
   */
  subscribe(
    callback: (log: LogRecord) => void,
    filters?: LogQuery
  ): () => void {
    if (!this.buffer) {
      throw new Error(
        'Real-time streaming requires ring buffer. Enable streaming in kb.config.json: ' +
        '{ "platform": { "adapters": { "logRingBuffer": "@kb-labs/adapters-log-ringbuffer" } } }'
      );
    }

    // Subscribe to buffer with optional filters
    return this.buffer.subscribe((log) => {
      // Apply filters if provided
      if (filters) {
        if (filters.level && log.level !== filters.level) {return;}
        if (filters.source && log.source !== filters.source) {return;}
        if (filters.from !== undefined && log.timestamp < filters.from) {return;}
        if (filters.to !== undefined && log.timestamp > filters.to) {return;}
        for (const field of LOG_CONTEXT_FIELDS) {
          const value = filters[field];
          if (value !== undefined && log.fields[field] !== value) {return;}
        }
      }
      callback(log);
    });
  }

  /**
   * Get combined statistics from both backends.
   */
  async getStats(): Promise<LogStats> {
    const stats: LogStats = {};

    // Get buffer stats if available
    if (this.buffer) {
      const raw = this.buffer.getStats();
      stats.buffer = {
        size: raw.total,
        maxSize: raw.bufferSize,
        oldestTimestamp: raw.oldestTimestamp,
        newestTimestamp: raw.newestTimestamp,
      };
    }

    // Get persistence stats if available
    if (this.persistence) {
      stats.persistence = await this.persistence.getStats();
    }

    return stats;
  }

  /**
   * Check which backends and features are available.
   */
  getCapabilities(): LogCapabilities {
    return {
      hasBuffer: !!this.buffer,
      hasPersistence: !!this.persistence,
      hasSearch: !!this.persistence,    // FTS only in persistence
      hasStreaming: !!this.buffer,      // Streaming only in buffer
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Query logs from ring buffer (fallback implementation).
   * @private
   */
  private queryFromBuffer(
    filters: LogQuery,
    options: LogQueryOptions
  ): LogQueryResult {
    if (!this.buffer) {
      throw new Error('Buffer not available');
    }

    // Query all matching logs from buffer
    const allLogs = this.buffer.query(filters);

    // Apply sorting
    const sortBy = options.sortBy ?? 'timestamp';
    const sortOrder = options.sortOrder ?? 'desc';

    const sortedLogs = [...allLogs].sort((a, b) => {
      let comparison = 0;

      if (sortBy === 'timestamp') {
        comparison = a.timestamp - b.timestamp;
      } else if (sortBy === 'level') {
        const levelOrder = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
        comparison = levelOrder[a.level] - levelOrder[b.level];
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    // Apply pagination
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const paginatedLogs = sortedLogs.slice(offset, offset + limit);

    return {
      logs: paginatedLogs,
      total: sortedLogs.length,
      hasMore: offset + paginatedLogs.length < sortedLogs.length,
      source: 'buffer',
    };
  }

  /**
   * Search logs in ring buffer (simple text matching).
   * @private
   */
  private searchInBuffer(
    searchText: string,
    options: LogSearchOptions
  ): LogSearchResult {
    if (!this.buffer) {
      throw new Error('Buffer not available');
    }

    // Get all logs from buffer
    const allLogs = this.buffer.query(options.filters ?? {});

    // Simple case-insensitive text matching
    const searchLower = searchText.toLowerCase();
    const filtered = allLogs.filter((log) =>
      log.message.toLowerCase().includes(searchLower)
    );

    // Apply pagination
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;
    const paginated = filtered.slice(offset, offset + limit);

    return {
      logs: paginated,
      total: filtered.length,
      hasMore: offset + paginated.length < filtered.length,
    };
  }
}
