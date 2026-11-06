/**
 * @module @kb-labs/core-platform/adapters/log-persistence
 * Persistent log storage adapter interface.
 *
 * Purpose:
 * - Long-term log storage (database, files, etc.)
 * - Cross-process log aggregation
 * - Advanced querying (search, filters, pagination)
 *
 * Not for:
 * - Real-time streaming (use ILogRingBuffer)
 * - Low-latency access to recent logs
 */

import type { LogRecord, LogQuery } from "./logger";
import type { IDocumentDatabase } from "./database.js";

/** Maximum time a normalized plugin failure waits for durable error-log persistence. */
export const LOG_PERSISTENCE_ERROR_FLUSH_TIMEOUT_MS = 1_000;

/**
 * Persistent log storage for historical queries.
 *
 * Design:
 * - Writes logs to database (SQLite, PostgreSQL, etc.)
 * - Supports batch writes with auto-flush
 * - Full-text search support
 * - Retention policy support (delete old logs)
 * - Pagination for large result sets
 *
 * @example
 * ```typescript
 * const persistence = await createPersistenceAdapter({
 *   database: platform.db,
 *   batchSize: 100,
 *   flushInterval: 5000,
 * });
 *
 * // Write logs
 * await persistence.write({ timestamp: Date.now(), level: 'info', message: 'Hello' });
 *
 * // Query logs
 * const result = await persistence.query(
 *   { level: 'error', startTime: Date.now() - 3600000 },
 *   { limit: 50, offset: 0 }
 * );
 *
 * // Search logs
 * const searchResults = await persistence.search('authentication failed');
 * ```
 */
export interface ILogPersistence {
  /**
   * Write log record to persistent storage.
   * Logs are buffered and flushed in batches.
   *
   * @param record - Log record to persist
   * @returns Promise that resolves when write is queued (not necessarily flushed)
   */
  write(record: LogRecord): Promise<void>;

  /**
   * Write multiple log records in batch.
   * More efficient than multiple write() calls.
   *
   * @param records - Array of log records
   * @returns Promise that resolves when all writes are queued
   */
  writeBatch(records: LogRecord[]): Promise<void>;

  /**
   * Query logs from persistent storage.
   *
   * @param query - Query parameters (time range, level, source)
   * @param options - Pagination and sorting options
   * @returns Promise with logs and pagination info
   *
   * @example
   * ```typescript
   * // Get last 50 error logs
   * const result = await persistence.query(
   *   { level: 'error' },
   *   { limit: 50, sortBy: 'timestamp', sortOrder: 'desc' }
   * );
   *
   * console.log(result.logs); // Array of 50 logs
   * console.log(result.total); // Total matching logs
   * console.log(result.hasMore); // true if more pages exist
   * ```
   */
  query(
    query: LogQuery,
    options?: {
      /** Maximum number of logs to return (default: 100) */
      limit?: number;
      /** Number of logs to skip (default: 0) */
      offset?: number;
      /** Sort by field (default: 'timestamp') */
      sortBy?: "timestamp" | "level";
      /** Sort order (default: 'desc') */
      sortOrder?: "asc" | "desc";
    },
  ): Promise<{
    /** Logs matching query */
    logs: LogRecord[];
    /** Total number of logs matching query (ignoring limit/offset) */
    total: number;
    /** True if more results are available (offset + logs.length < total) */
    hasMore: boolean;
  }>;

  /**
   * Get single log record by ID.
   *
   * @param id - Log record ID
   * @returns Promise with log record or null if not found
   */
  getById(id: string): Promise<LogRecord | null>;

  /**
   * Search logs by text query (full-text search).
   * Searches message field using database FTS capabilities.
   *
   * @param searchText - Search query (supports database-specific syntax)
   * @param options - Pagination options
   * @returns Promise with matching logs
   *
   * @example
   * ```typescript
   * // Simple search
   * const results = await persistence.search('authentication failed');
   *
   * // Advanced search (SQLite FTS5 syntax)
   * const results = await persistence.search('auth* AND (error OR warn)');
   * ```
   */
  search(
    searchText: string,
    options?: {
      /** Maximum number of logs to return (default: 100) */
      limit?: number;
      /** Number of logs to skip (default: 0) */
      offset?: number;
      /** Structured filters combined with the text match. */
      filters?: LogQuery;
    },
  ): Promise<{
    /** Logs matching search query */
    logs: LogRecord[];
    /** Total number of logs matching search */
    total: number;
    /** True if more results are available */
    hasMore: boolean;
  }>;

  /**
   * Delete logs older than specified timestamp.
   * Used for implementing retention policies.
   *
   * @param beforeTimestamp - Delete logs before this timestamp (milliseconds)
   * @returns Promise with number of deleted logs
   *
   * @example
   * ```typescript
   * // Delete logs older than 30 days
   * const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
   * const deleted = await persistence.deleteOlderThan(thirtyDaysAgo);
   * console.log(`Deleted ${deleted} old logs`);
   * ```
   */
  deleteOlderThan(beforeTimestamp: number): Promise<number>;

  /**
   * Get statistics about stored logs.
   *
   * @returns Promise with log storage statistics
   */
  getStats(): Promise<{
    /** Total number of logs in storage */
    totalLogs: number;
    /** Timestamp of oldest log (0 if empty) */
    oldestTimestamp: number;
    /** Timestamp of newest log (0 if empty) */
    newestTimestamp: number;
    /** Storage size in bytes */
    sizeBytes: number;
  }>;

  /**
   * Delete logs matching specific levels older than specified timestamp.
   * Allows per-level retention policies (e.g., keep errors longer than debug).
   *
   * @param levels - Log levels to delete (e.g., ['debug', 'trace'])
   * @param beforeTimestamp - Delete logs before this timestamp (milliseconds)
   * @returns Promise with number of deleted logs
   */
  deleteByLevelOlderThan?(
    levels: string[],
    beforeTimestamp: number,
  ): Promise<number>;

  /**
   * Close persistence adapter and flush pending writes.
   * Should be called during application shutdown.
   *
   * @returns Promise that resolves when all pending writes are flushed
   */
  close?(): Promise<void>;
}

/**
 * Log retention policy configuration.
 * Controls automatic cleanup of old logs and database size limits.
 *
 * Defaults are applied when retention is omitted — logs are never unbounded.
 */
export interface LogRetentionPolicy {
  /** Max age for fatal records. @default 2592000000 (30 days) */
  maxAgeFatal?: number;

  /** Max age for error records. @default 1209600000 (14 days) */
  maxAgeError?: number;

  /** Max age for warning records. @default 604800000 (7 days) */
  maxAgeWarn?: number;

  /**
   * Max age for debug/trace logs in milliseconds.
   * Set to 0 to disable debug/trace persistence entirely.
   * @default 1800000 (30 minutes)
   */
  maxAgeDebug?: number;

  /**
   * Max age for info logs in milliseconds.
   * @default 1800000 (30 minutes)
   */
  maxAgeInfo?: number;

  /**
   * How often to run retention cleanup in milliseconds.
   * @default 300000 (5 minutes)
   */
  cleanupIntervalMs?: number;
}

/**
 * Configuration for log persistence adapter.
 */
export interface LogPersistenceConfig {
  /**
   * Document database backing log storage. The persistence layer writes log
   * entries as documents into a `logs` collection — same abstraction that
   * the rest of the platform uses for any structured data.
   */
  documentDatabase: IDocumentDatabase;

  /**
   * Collection name for logs.
   * @default 'logs'
   */
  collection?: string;

  /**
   * Batch size for bulk writes.
   * Logs are buffered and written in batches for performance.
   * @default 100
   */
  batchSize?: number;

  /**
   * Flush interval in milliseconds.
   * Pending logs are flushed at this interval even if batch is not full.
   * @default 5000 (5 seconds)
   */
  flushInterval?: number;

  /**
   * Retention policy for automatic log cleanup.
   * Defaults are applied to prevent unbounded database growth.
   */
  retention?: LogRetentionPolicy;
}
