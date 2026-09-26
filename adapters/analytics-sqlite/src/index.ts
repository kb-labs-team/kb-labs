/**
 * @module @kb-labs/adapters-analytics-sqlite
 * SQLite analytics adapter for KB Labs platform.
 *
 * Uses better-sqlite3 with WAL mode for concurrent reads/writes from multiple processes.
 * Implements IAnalytics with SQL-native time-series aggregation:
 * - strftime() for groupBy (hour/day/week/month)
 * - json_extract() for breakdownBy (dot-notation paths)
 * - Dynamic SELECT for metrics filtering
 * - Full EventsQuery support via SQL WHERE clauses
 */

import Database from 'better-sqlite3';
import { join, isAbsolute, dirname } from 'node:path';
import { resolveRuntimeStatePath } from '@kb-labs/sdk/adapters';
import { mkdirSync } from 'node:fs';
import type {
  IAnalytics,
  IDisposable,
  AnalyticsContext,
  AnalyticsEvent,
  EventsQuery,
  StatsQuery,
  EventsResponse,
  EventsStats,
  BufferStatus,
  DlqStatus,
  DailyStats,
} from '@kb-labs/sdk/adapters';


// ─── DDL ──────────────────────────────────────────────────────────────────────

const CREATE_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  schema      TEXT NOT NULL DEFAULT 'kb.v1',
  type        TEXT NOT NULL,
  ts          TEXT NOT NULL,
  ingest_ts   TEXT,
  run_id      TEXT,
  product     TEXT,
  version     TEXT,
  actor_type  TEXT,
  actor_id    TEXT,
  actor_name  TEXT,
  ctx         TEXT,
  payload     TEXT
)
`;

const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts)`,
  `CREATE INDEX IF NOT EXISTS events_type_idx ON events (type)`,
  `CREATE INDEX IF NOT EXISTS events_product_idx ON events (product)`,
  `CREATE INDEX IF NOT EXISTS events_type_ts_idx ON events (type, ts)`,
];

// ─── groupBy mappings ─────────────────────────────────────────────────────────

const GROUP_BY_FORMAT: Record<string, string> = {
  hour: '%Y-%m-%dT%H:00',
  day: '%Y-%m-%d',
  week: '%Y-W%W',
  month: '%Y-%m',
};

// ─── dot-path to SQLite json_extract ─────────────────────────────────────────

function dotPathToSQL(path: string): string {
  // "payload.model" → json_extract(payload, '$.model')
  // "payload.nested.key" → json_extract(payload, '$.nested.key')
  const parts = path.split('.');
  const column = parts[0] ?? 'payload';
  const rest = parts.slice(1).join('.');
  if (!rest) {return column;}
  return `json_extract(${column}, '$.${rest}')`;
}

// ─── metrics helpers ──────────────────────────────────────────────────────────

const KNOWN_METRICS: Record<string, string> = {
  totalTokens: `SUM(CAST(json_extract(payload, '$.totalTokens') AS REAL)) as totalTokens`,
  promptTokens: `SUM(CAST(json_extract(payload, '$.promptTokens') AS REAL)) as promptTokens`,
  completionTokens: `SUM(CAST(json_extract(payload, '$.completionTokens') AS REAL)) as completionTokens`,
  estimatedCost: `SUM(CAST(json_extract(payload, '$.estimatedCost') AS REAL)) as estimatedCost`,
  durationMs: `AVG(CAST(json_extract(payload, '$.durationMs') AS REAL)) as durationMs`,
  textLength: `SUM(CAST(json_extract(payload, '$.textLength') AS REAL)) as textLength`,
  vectorCount: `SUM(CAST(json_extract(payload, '$.vectorCount') AS REAL)) as vectorCount`,
  resultsCount: `AVG(CAST(json_extract(payload, '$.resultsCount') AS REAL)) as resultsCount`,
  // VectorStore — event counts by type
  totalSearches: `SUM(CASE WHEN type = 'vectorstore.search.completed' THEN 1 ELSE 0 END) as totalSearches`,
  totalUpserts: `SUM(CASE WHEN type = 'vectorstore.upsert.completed' THEN 1 ELSE 0 END) as totalUpserts`,
  totalDeletes: `SUM(CASE WHEN type = 'vectorstore.delete.completed' THEN 1 ELSE 0 END) as totalDeletes`,
  // Cache — event counts by type + hit rate
  totalHits: `SUM(CASE WHEN type = 'cache.get.hit' THEN 1 ELSE 0 END) as totalHits`,
  totalMisses: `SUM(CASE WHEN type = 'cache.get.miss' THEN 1 ELSE 0 END) as totalMisses`,
  hitRate: `CAST(SUM(CASE WHEN type = 'cache.get.hit' THEN 1 ELSE 0 END) AS REAL) / NULLIF(SUM(CASE WHEN type IN ('cache.get.hit', 'cache.get.miss') THEN 1 ELSE 0 END), 0) * 100 as hitRate`,
  // Storage — sum payload byte fields
  totalBytesRead: `SUM(CAST(json_extract(payload, '$.bytesRead') AS REAL)) as totalBytesRead`,
  totalBytesWritten: `SUM(CAST(json_extract(payload, '$.bytesWritten') AS REAL)) as totalBytesWritten`,
};

function buildMetricsSelect(metrics: string[]): string[] {
  return metrics.map((m) => KNOWN_METRICS[m] ?? `SUM(CAST(json_extract(payload, '$.${m}') AS REAL)) as ${m}`);
}

function getDefaultMetrics(typeFilter?: string | string[]): string[] {
  const types = Array.isArray(typeFilter) ? typeFilter : typeFilter ? [typeFilter] : [];
  if (types.some((t) => t.startsWith('llm.'))) {
    return ['totalTokens', 'promptTokens', 'completionTokens', 'estimatedCost', 'durationMs'];
  }
  if (types.some((t) => t.startsWith('embeddings.'))) {
    return ['textLength', 'estimatedCost', 'durationMs'];
  }
  if (types.some((t) => t.startsWith('vectorstore.'))) {
    return ['totalSearches', 'totalUpserts', 'totalDeletes', 'resultsCount', 'durationMs', 'vectorCount'];
  }
  if (types.some((t) => t.startsWith('cache.'))) {
    return ['totalHits', 'totalMisses', 'hitRate', 'durationMs'];
  }
  if (types.some((t) => t.startsWith('storage.'))) {
    return ['totalBytesRead', 'totalBytesWritten', 'durationMs'];
  }
  return ['durationMs'];
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface SQLiteAnalyticsOptions {
  /** Path to the SQLite database file. Default: `<KB_HOME>/state/<projectId>/analytics/analytics.sqlite` */
  dbPath?: string;
  /** Alias for dbPath — accepted for config compatibility with kb.config.json */
  filename?: string;
  /** Analytics context for event enrichment */
  context?: AnalyticsContext;
  /** Workspace context injected by core-runtime (provides cwd for relative path resolution) */
  workspace?: { cwd: string };
  /** Analytics context injected by core-runtime (for auto-enrichment) */
  analytics?: AnalyticsContext;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/**
 * SQLite-based analytics adapter.
 * Uses WAL mode — supports concurrent reads/writes from multiple processes.
 */
export class SQLiteAnalytics implements IAnalytics, IDisposable {

  private readonly dbPath: string;
  private context: AnalyticsContext;
  private db: Database.Database;

  constructor(options: SQLiteAnalyticsOptions = {}) {
    const cwd = options.workspace?.cwd ?? process.cwd();
    const rawPath = options.dbPath ?? options.filename;
    // No explicit path: per-project runtime state lives outside the repository (ADR-0044).
    this.dbPath = rawPath === undefined
      ? resolveRuntimeStatePath(cwd, ['analytics', 'analytics.sqlite'])
      : isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);

    this.context = options.context ?? options.analytics ?? {
      source: { product: 'unknown', version: '0.0.0' },
      runId: `run-${Date.now()}`,
    };

    // Ensure directory exists
    mkdirSync(dirname(this.dbPath), { recursive: true });

    // Open database — better-sqlite3 is synchronous
    this.db = new Database(this.dbPath);

    // WAL mode: multiple readers + one writer, no exclusive lock
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');

    // Setup schema
    this.db.exec(CREATE_EVENTS_TABLE);
    for (const idx of CREATE_INDEXES) {
      this.db.exec(idx);
    }

    // Ensure clean shutdown — checkpoint WAL and close connection.
    // Without this, process.exit() leaves WAL in inconsistent state
    // causing "database disk image is malformed" for other processes.
    this._onExit = () => this.close();
    process.on('exit', this._onExit);
    process.on('SIGINT', this._onExit);
    process.on('SIGTERM', this._onExit);
  }

  private _onExit: () => void;
  private _closed = false;

  /** Checkpoint WAL and close the database connection cleanly. */
  close(): void {
    if (this._closed) {return;}
    this._closed = true;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.close();
    } catch {
      // Already closed or corrupted — nothing we can do
    }
    process.removeListener('exit', this._onExit);
    process.removeListener('SIGINT', this._onExit);
    process.removeListener('SIGTERM', this._onExit);
  }

  /**
   * Implements IDisposable — delegates to close().
   *
   * close() already provides the complete, correct shutdown sequence:
   *   1. Idempotency guard (this._closed)
   *   2. WAL TRUNCATE checkpoint (flush frames → main DB file, empty WAL)
   *   3. Connection close (this.db.close())
   *   4. Process listener deregistration (exit, SIGINT, SIGTERM)
   *
   * PlatformContainer.shutdown() checks for close() first (container.ts line 830),
   * so the container will call close() on this adapter. dispose() is provided so
   * that isDisposable() returns true and this adapter is typed as IDisposable for
   * observability logging in service-bootstrap's onBeforeShutdown hook.
   */
  dispose(): void {
    this.close();
  }


  // ─── Write ────────────────────────────────────────────────────────────────

  async track(event: string, properties?: Record<string, unknown>): Promise<void> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (id, schema, type, ts, ingest_ts, run_id, product, version, actor_type, actor_id, actor_name, ctx, payload)
      VALUES
        (?, 'kb.v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      event,
      now,
      now,
      this.context.runId ?? null,
      this.context.source.product,
      this.context.source.version,
      this.context.actor?.type ?? null,
      this.context.actor?.id ?? null,
      this.context.actor?.name ?? null,
      this.context.ctx ? JSON.stringify(this.context.ctx) : null,
      properties ? JSON.stringify(properties) : null,
    );
  }

  async identify(userId: string, traits?: Record<string, unknown>): Promise<void> {
    await this.track('identity', { userId, ...traits });
  }

  async flush(): Promise<void> {
    // SQLite writes synchronously — nothing to flush
  }

  // ─── Source attribution ───────────────────────────────────────────────────

  getSource(): { product: string; version: string } | undefined {
    return this.context.source;
  }

  setSource(source: { product: string; version: string }): void {
    this.context = { ...this.context, source };
  }

  // ─── Read: Events ─────────────────────────────────────────────────────────

  async getEvents(query?: EventsQuery): Promise<EventsResponse> {
    const { where, params } = buildWhereClause(query);
    const limit = query?.limit ?? 100;
    const offset = query?.offset ?? 0;
    const whereClause = where ? ` WHERE ${where}` : '';

    const countRow = this.db.prepare(`SELECT COUNT(*) as total FROM events${whereClause}`).get(...params) as { total: number };
    const total = countRow.total;

    const rows = this.db.prepare(
      `SELECT * FROM events${whereClause} ORDER BY ts DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as Record<string, unknown>[];

    const events: AnalyticsEvent[] = rows.map(rowToEvent);
    return { events, total, hasMore: offset + events.length < total };
  }

  // ─── Read: Stats ──────────────────────────────────────────────────────────

  async getStats(): Promise<EventsStats> {
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as total, MIN(ts) as minTs, MAX(ts) as maxTs FROM events`
    ).get() as { total: number; minTs: string; maxTs: string };

    const totalEvents = totalRow.total;
    const from = totalRow.minTs ?? new Date().toISOString();
    const to = totalRow.maxTs ?? new Date().toISOString();

    const byType: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT type, COUNT(*) as cnt FROM events GROUP BY type`).all() as { type: string; cnt: number }[]) {
      byType[r.type] = r.cnt;
    }

    const bySource: Record<string, number> = {};
    for (const r of this.db.prepare(
      `SELECT COALESCE(product, 'unknown') as product, COUNT(*) as cnt FROM events GROUP BY product`
    ).all() as { product: string; cnt: number }[]) {
      bySource[r.product] = r.cnt;
    }

    const byActor: Record<string, number> = {};
    for (const r of this.db.prepare(
      `SELECT COALESCE(actor_id, 'unknown') as actor, COUNT(*) as cnt FROM events GROUP BY actor`
    ).all() as { actor: string; cnt: number }[]) {
      byActor[r.actor] = r.cnt;
    }

    return { totalEvents, byType, bySource, byActor, timeRange: { from, to } };
  }

  // ─── Read: Time-series ────────────────────────────────────────────────────

  async getDailyStats(query?: StatsQuery): Promise<DailyStats[]> {
    const groupBy = query?.groupBy ?? 'day';
    const fmtStr = GROUP_BY_FORMAT[groupBy] ?? '%Y-%m-%d';

    const breakdownBy = query?.breakdownBy;
    const breakdownSQL = breakdownBy ? dotPathToSQL(breakdownBy) : null;

    const metricsFilter = query?.metrics ?? getDefaultMetrics(query?.type);
    const metricsSelect = buildMetricsSelect(metricsFilter);

    const { where, params } = buildWhereClause(query);
    const whereClause = where ? `WHERE ${where}` : '';

    const selectParts = [
      `strftime('${fmtStr}', ts) as date`,
      `COUNT(*) as count`,
      ...metricsSelect,
      ...(breakdownSQL ? [`${breakdownSQL} as breakdown`] : []),
    ];

    const groupByParts = [`strftime('${fmtStr}', ts)`];
    if (breakdownSQL) {groupByParts.push(breakdownSQL);}

    const sql = `
      SELECT ${selectParts.join(', ')}
      FROM events
      ${whereClause}
      GROUP BY ${groupByParts.join(', ')}
      ORDER BY strftime('${fmtStr}', ts) ASC${breakdownSQL ? ', breakdown ASC NULLS LAST' : ''}
    `;

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

    return rows.map((r): DailyStats => {
      const metrics: Record<string, number> = {};
      for (const m of metricsFilter) {
        const v = r[m];
        if (v !== null && v !== undefined) {
          metrics[m] = Number(v);
        }
      }

      const stat: DailyStats = {
        date: String(r['date']),
        count: Number(r['count']),
      };
      if (Object.keys(metrics).length > 0) {stat.metrics = metrics;}
      if (breakdownSQL && r['breakdown'] !== null && r['breakdown'] !== undefined) {
        stat.breakdown = String(r['breakdown']);
      }
      return stat;
    });
  }

  // ─── Read: Buffer / DLQ ───────────────────────────────────────────────────

  async getBufferStatus(): Promise<BufferStatus | null> {
    const row = this.db.prepare(
      `SELECT COUNT(*) as segments, MIN(ts) as oldest, MAX(ts) as newest FROM events`
    ).get() as { segments: number; oldest: string | null; newest: string | null };

    return {
      segments: row.segments,
      totalSizeBytes: 0,
      oldestEventTs: row.oldest,
      newestEventTs: row.newest,
    };
  }

  async getDlqStatus(): Promise<DlqStatus | null> {
    return null;
  }
}

// ─── SQL helpers ──────────────────────────────────────────────────────────────

function buildWhereClause(query?: EventsQuery): { where: string; params: unknown[] } {
  if (!query) {return { where: '', params: [] };}

  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.type) {
    const types = Array.isArray(query.type) ? query.type : [query.type];
    if (types.length === 1) {
      clauses.push(`type = ?`);
      params.push(types[0]);
    } else {
      clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
  }

  if (query.source) {
    clauses.push(`product = ?`);
    params.push(query.source);
  }

  if (query.actor) {
    clauses.push(`actor_id = ?`);
    params.push(query.actor);
  }

  if (query.from) {
    clauses.push(`ts >= ?`);
    params.push(query.from);
  }

  if (query.to) {
    clauses.push(`ts <= ?`);
    params.push(query.to);
  }

  return { where: clauses.join(' AND '), params };
}

function rowToEvent(r: Record<string, unknown>): AnalyticsEvent {
  return {
    id: String(r['id']),
    schema: 'kb.v1',
    type: String(r['type']),
    ts: String(r['ts']),
    ingestTs: String(r['ingest_ts'] ?? r['ts']),
    source: {
      product: String(r['product'] ?? ''),
      version: String(r['version'] ?? ''),
    },
    runId: String(r['run_id'] ?? ''),
    actor: r['actor_type']
      ? {
          type: r['actor_type'] as 'user' | 'agent' | 'ci',
          id: r['actor_id'] ? String(r['actor_id']) : undefined,
          name: r['actor_name'] ? String(r['actor_name']) : undefined,
        }
      : undefined,
    ctx: r['ctx'] ? (JSON.parse(String(r['ctx'])) as Record<string, string | number | boolean | null>) : undefined,
    payload: r['payload'] ? JSON.parse(String(r['payload'])) : undefined,
  };
}

export { manifest } from './manifest.js';

/**
 * Factory function required by core-runtime adapter discovery.
 */
export function createAdapter(options?: SQLiteAnalyticsOptions): IAnalytics {
  return new SQLiteAnalytics(options);
}

export default createAdapter;
