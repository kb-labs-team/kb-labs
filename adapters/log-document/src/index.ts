/**
 * @module @kb-labs/adapters-log-document
 *
 * `ILogPersistence` implementation backed by any `IDocumentDatabase`.
 *
 * This is the dogfooded replacement for the old sqlite-only log persistence
 * adapter: log entries are now stored as documents in a `logs` collection
 * using the same abstraction every other plugin uses. The platform stays
 * driver-agnostic — switch from sqlite to postgres-JSONB and logs follow.
 *
 * Buffering: writes are queued in memory and flushed in batches to amortise
 * per-call overhead. `close()` (and the next flush after batchSize entries)
 * drains the queue.
 *
 * Retention: a periodic timer deletes documents older than the configured
 * thresholds per log level. Without retention the collection grows
 * unbounded — defaults are applied if `retention` is absent.
 *
 * Search: implemented via `$contains` on the message field. Full-text
 * indexing (FTS5, MongoDB text) is intentionally OUT of scope here — that's
 * a backend-specific capability and would leak through the contract. If
 * advanced search is needed, route it via an external index (Meilisearch
 * etc.) and keep this layer simple.
 */

import { LOG_CONTEXT_FIELDS } from "@kb-labs/sdk/adapters";
import type {
  ILogPersistence,
  LogPersistenceConfig,
  LogRetentionPolicy,
  LogRecord,
  LogQuery,
  LogLevel,
  IDocumentDatabase,
  DocumentFilter,
  BaseDocument,
} from "@kb-labs/sdk/adapters";

export { manifest } from "./manifest.js";

interface LogDoc extends BaseDocument {
  logId: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  fields: Record<string, unknown>;
  source: string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const LEVELS_AT_OR_ABOVE = (min: LogLevel): LogLevel[] => {
  const threshold = LEVEL_ORDER[min];
  return (Object.keys(LEVEL_ORDER) as LogLevel[]).filter(
    (l) => LEVEL_ORDER[l] >= threshold,
  );
};

const DEFAULT_RETENTION: Required<
  Pick<
    LogRetentionPolicy,
    | "maxAgeFatal"
    | "maxAgeError"
    | "maxAgeWarn"
    | "maxAgeDebug"
    | "maxAgeInfo"
    | "cleanupIntervalMs"
  >
> = {
  maxAgeFatal: 30 * 24 * 60 * 60 * 1000,
  maxAgeError: 14 * 24 * 60 * 60 * 1000,
  maxAgeWarn: 7 * 24 * 60 * 60 * 1000,
  maxAgeDebug: 30 * 60 * 1000,
  maxAgeInfo: 30 * 60 * 1000,
  cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
};

export class DocumentLogPersistence implements ILogPersistence {
  private readonly docs: IDocumentDatabase;
  private readonly collection: string;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly retention: Required<
    Pick<
      LogRetentionPolicy,
      | "maxAgeFatal"
      | "maxAgeError"
      | "maxAgeWarn"
      | "maxAgeDebug"
      | "maxAgeInfo"
      | "cleanupIntervalMs"
    >
  >;

  private buffer: LogRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private flushing: Promise<void> | null = null;
  private initialised: Promise<void>;

  constructor(config: LogPersistenceConfig) {
    this.docs = config.documentDatabase;
    this.collection = config.collection ?? "logs";
    this.batchSize = config.batchSize ?? 100;
    this.flushIntervalMs = config.flushInterval ?? 5_000;
    this.retention = { ...DEFAULT_RETENTION, ...(config.retention ?? {}) };

    this.initialised = this.docs.ensureCollection(this.collection, {
      indexes: [
        { path: "logId", unique: true },
        { path: "timestamp" },
        { path: "level" },
        { path: "source" },
        ...LOG_CONTEXT_FIELDS.map((field) => ({ path: `fields.${field}` })),
      ],
    });

    this.flushTimer = setInterval(() => {
      this.scheduleFlush();
    }, this.flushIntervalMs).unref();
    this.retentionTimer = setInterval(() => {
      void this.runRetention();
    }, this.retention.cleanupIntervalMs).unref();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Write path (buffered)
  // ──────────────────────────────────────────────────────────────────────────

  async write(record: LogRecord): Promise<void> {
    if (this.closed) {
      return;
    }
    this.buffer.push(record);
    if (record.level === "error" || record.level === "fatal") {
      await this.flush();
      return;
    }
    if (this.buffer.length >= this.batchSize) {
      this.scheduleFlush();
    }
  }

  async writeBatch(records: LogRecord[]): Promise<void> {
    if (this.closed) {
      return;
    }
    if (records.length === 0) {
      return;
    }
    this.buffer.push(...records);
    if (this.buffer.length >= this.batchSize) {
      this.scheduleFlush();
    }
  }

  private async flush(): Promise<void> {
    while (this.flushing || this.buffer.length > 0) {
      if (this.flushing) {
        await this.flushing;
        continue;
      }
      const batch = this.buffer.splice(0, this.buffer.length);

      this.flushing = (async () => {
        try {
          await this.initialised;
          await this.docs.insertMany<LogDoc>(
            this.collection,
            batch.map((r) => ({
              logId: r.id,
              timestamp: r.timestamp,
              level: r.level,
              message: r.message,
              fields: r.fields,
              source: r.source,
            })),
          );
        } catch (err) {
          // Re-queue on failure so the next attempt picks up the lost batch.
          this.buffer.unshift(...batch);
          throw err;
        } finally {
          this.flushing = null;
        }
      })();
      await this.flushing;
    }
  }

  private scheduleFlush(): void {
    void this.flush().catch(() => {
      // The batch was re-queued by flush(). A subsequent interval or write
      // retries it; logging itself must not create an unhandled rejection.
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Read path
  // ──────────────────────────────────────────────────────────────────────────

  async query(
    query: LogQuery,
    options?: {
      limit?: number;
      offset?: number;
      sortBy?: "timestamp" | "level";
      sortOrder?: "asc" | "desc";
    },
  ): Promise<{ logs: LogRecord[]; total: number; hasMore: boolean }> {
    await this.initialised;
    const filter = buildFilter(query);
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const sortField = options?.sortBy ?? "timestamp";
    const sortDir = options?.sortOrder === "asc" ? 1 : -1;

    const [total, docs] = await Promise.all([
      this.docs.count<LogDoc>(this.collection, filter),
      this.docs.find<LogDoc>(this.collection, filter, {
        sort: { [sortField]: sortDir },
        limit,
        skip: offset,
      }),
    ]);

    return {
      logs: docs.map(toLogRecord),
      total,
      hasMore: offset + docs.length < total,
    };
  }

  async getById(id: string): Promise<LogRecord | null> {
    await this.initialised;
    const docs = await this.docs.find<LogDoc>(
      this.collection,
      { logId: { $eq: id } },
      { limit: 1 },
    );
    const first = docs[0];
    return first ? toLogRecord(first) : null;
  }

  async search(
    searchText: string,
    options?: { limit?: number; offset?: number; filters?: LogQuery },
  ): Promise<{ logs: LogRecord[]; total: number; hasMore: boolean }> {
    await this.initialised;
    const textFilter: DocumentFilter<LogDoc> = {
      message: { $contains: searchText },
    };
    const structuredFilter = buildFilter(options?.filters ?? {});
    const filter: DocumentFilter<LogDoc> =
      Object.keys(structuredFilter).length === 0
        ? textFilter
        : { $and: [structuredFilter, textFilter] };
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const [total, docs] = await Promise.all([
      this.docs.count<LogDoc>(this.collection, filter),
      this.docs.find<LogDoc>(this.collection, filter, {
        sort: { timestamp: -1 },
        limit,
        skip: offset,
      }),
    ]);

    return {
      logs: docs.map(toLogRecord),
      total,
      hasMore: offset + docs.length < total,
    };
  }

  async deleteOlderThan(beforeTimestamp: number): Promise<number> {
    await this.initialised;
    return this.docs.deleteMany<LogDoc>(this.collection, {
      timestamp: { $lt: beforeTimestamp },
    });
  }

  async deleteByLevelOlderThan(
    levels: string[],
    beforeTimestamp: number,
  ): Promise<number> {
    await this.initialised;
    return this.docs.deleteMany<LogDoc>(this.collection, {
      $and: [
        { level: { $in: levels as LogLevel[] } },
        { timestamp: { $lt: beforeTimestamp } },
      ],
    });
  }

  async getStats(): Promise<{
    totalLogs: number;
    oldestTimestamp: number;
    newestTimestamp: number;
    sizeBytes: number;
  }> {
    await this.initialised;
    const [totalLogs, oldest, newest] = await Promise.all([
      this.docs.count<LogDoc>(this.collection, {}),
      this.docs.find<LogDoc>(
        this.collection,
        {},
        { sort: { timestamp: 1 }, limit: 1 },
      ),
      this.docs.find<LogDoc>(
        this.collection,
        {},
        { sort: { timestamp: -1 }, limit: 1 },
      ),
    ]);
    // Size is not exposed by IDocumentDatabase by design (it varies wildly
    // by backend). Returning 0 here is honest — callers driving retention
    // by size should configure maxAge instead and stop pretending bytes are
    // a universal currency across drivers.
    return {
      totalLogs,
      oldestTimestamp: oldest[0]?.timestamp ?? 0,
      newestTimestamp: newest[0]?.timestamp ?? 0,
      sizeBytes: 0,
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    await this.flush();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Retention
  // ──────────────────────────────────────────────────────────────────────────

  private async runRetention(): Promise<void> {
    if (this.closed) {
      return;
    }
    const now = Date.now();
    try {
      await this.expire(["trace", "debug"], this.retention.maxAgeDebug, now);
      await this.expire(["info"], this.retention.maxAgeInfo, now);
      await this.expire(["warn"], this.retention.maxAgeWarn, now);
      await this.expire(["error"], this.retention.maxAgeError, now);
      await this.expire(["fatal"], this.retention.maxAgeFatal, now);
    } catch {
      /* retention failures should not propagate — they're best-effort cleanup */
    }
  }

  private async expire(
    levels: LogLevel[],
    maxAge: number,
    now: number,
  ): Promise<void> {
    await this.deleteByLevelOlderThan(
      levels,
      maxAge > 0 ? now - maxAge : now + 1,
    );
  }
}

const buildFilter = (query: LogQuery): DocumentFilter<LogDoc> => {
  const clauses: Array<DocumentFilter<LogDoc>> = [];
  if (query.level !== undefined) {
    clauses.push({ level: { $in: LEVELS_AT_OR_ABOVE(query.level) } });
  }
  if (query.source !== undefined) {
    clauses.push({ source: { $eq: query.source } });
  }
  if (query.from !== undefined) {
    clauses.push({ timestamp: { $gte: query.from } });
  }
  if (query.to !== undefined) {
    clauses.push({ timestamp: { $lte: query.to } });
  }
  for (const field of LOG_CONTEXT_FIELDS) {
    const value = query[field];
    if (value !== undefined) {
      clauses.push({ [`fields.${field}`]: { $eq: value } });
    }
  }
  if (clauses.length === 0) {
    return {};
  }
  if (clauses.length === 1) {
    return clauses[0]!;
  }
  return { $and: clauses };
};

const toLogRecord = (doc: LogDoc): LogRecord => ({
  id: doc.logId,
  timestamp: doc.timestamp,
  level: doc.level,
  message: doc.message,
  fields: doc.fields,
  source: doc.source,
});

export function createAdapter(
  config: LogPersistenceConfig,
  deps?: Record<string, unknown>,
): DocumentLogPersistence {
  // deps.documentDatabase is injected by the adapter-loader when the manifest
  // declares requires.adapters = [{ id: "documentDatabase" }]. Merge it in so
  // callers don't need to duplicate the reference in adapterOptions config.
  const resolved: LogPersistenceConfig = deps?.["documentDatabase"]
    ? {
        ...config,
        documentDatabase: deps["documentDatabase"] as IDocumentDatabase,
      }
    : config;
  return new DocumentLogPersistence(resolved);
}

export default createAdapter;
