/**
 * @module @kb-labs/adapters-analytics-duckdb
 * DuckDB analytics adapter for KB Labs platform.
 *
 * Implements IAnalytics with SQL-native time-series aggregation:
 * - date_trunc() for groupBy (hour/day/week/month)
 * - json_extract_string() for breakdownBy (dot-notation paths)
 * - Dynamic SELECT for metrics filtering
 * - Full EventsQuery support via SQL WHERE clauses
 */

import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBValue } from '@duckdb/node-api';
import { mkdir } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { resolveRuntimeStatePath } from '@kb-labs/core-project-registry';
import type {
  IAnalytics,
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
import {
  CREATE_EVENTS_TABLE,
  CREATE_INDEXES,
  GROUP_BY_TRUNC,
  GROUP_BY_FORMAT,
  dotPathToSQL,
  getDefaultMetrics,
  buildMetricsSelect,
} from './schema.js';

export interface DuckDBAnalyticsOptions {
  /** Path to the DuckDB database file. Default: `<KB_HOME>/state/<projectId>/analytics/analytics.duckdb` */
  dbPath?: string;
  /** Analytics context for event enrichment */
  context?: AnalyticsContext;
  /** Workspace context injected by core-runtime (provides cwd for relative path resolution) */
  workspace?: { cwd: string };
  /** Analytics context injected by core-runtime (for auto-enrichment) */
  analytics?: AnalyticsContext;
}

/**
 * DuckDB-based analytics adapter.
 * Stores events in a local DuckDB file for SQL-native analytics.
 */
export class DuckDBAnalytics implements IAnalytics {
  private readonly dbPath: string;
  private context: AnalyticsContext;
  private instance: DuckDBInstance | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(options: DuckDBAnalyticsOptions = {}) {
    const cwd = options.workspace?.cwd ?? process.cwd();
    const rawPath = options.dbPath;
    // No explicit path: per-project runtime state lives outside the repository (ADR-0044).
    this.dbPath = rawPath === undefined
      ? resolveRuntimeStatePath(cwd, ['analytics', 'analytics.duckdb'])
      : isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
    this.context = options.context ?? options.analytics ?? {
      source: { product: 'unknown', version: '0.0.0' },
      runId: `run-${Date.now()}`,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  private async init(): Promise<DuckDBInstance> {
    if (!this.initPromise) {
      this.initPromise = this._setup();
    }
    await this.initPromise;
    return this.instance!;
  }

  private async _setup(): Promise<void> {
    // The state directory does not exist before the first write.
    await mkdir(dirname(this.dbPath), { recursive: true });
    this.instance = await DuckDBInstance.fromCache(this.dbPath);
    const conn = await this.instance.connect();
    try {
      await conn.run(CREATE_EVENTS_TABLE);
      for (const idx of CREATE_INDEXES) {
        await conn.run(idx);
      }
    } finally {
      conn.closeSync();
    }
  }

  private async withConnection<T>(fn: (conn: Awaited<ReturnType<DuckDBInstance['connect']>>) => Promise<T>): Promise<T> {
    const db = await this.init();
    const conn = await db.connect();
    try {
      return await fn(conn);
    } finally {
      conn.closeSync();
    }
  }

  // ─── Write methods ────────────────────────────────────────────────────────

  async track(event: string, properties?: Record<string, unknown>): Promise<void> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();

    await this.withConnection(async (conn) => {
      await conn.run(
        `INSERT OR IGNORE INTO events
          (id, schema, type, ts, ingest_ts, run_id, product, version, actor_type, actor_id, actor_name, ctx, payload)
         VALUES ($1, 'kb.v1', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
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
        ],
      );
    });
  }

  async identify(userId: string, traits?: Record<string, unknown>): Promise<void> {
    await this.track('identity', { userId, ...traits });
  }

  async flush(): Promise<void> {
    // DuckDB writes synchronously — nothing to flush
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
    return this.withConnection(async (conn) => {
      const { where, params } = buildWhereClause(query);
      const limit = query?.limit ?? 100;
      const offset = query?.offset ?? 0;
      const whereClause = where ? ` WHERE ${where}` : '';

      // Count total
      const countResult = await conn.run(
        `SELECT COUNT(*) as total FROM events${whereClause}`,
        params,
      );
      const countRows = await countResult.getRowObjects();
      const total = Number(countRows[0]?.total ?? 0);

      // Fetch events
      const result = await conn.run(
        `SELECT * FROM events${whereClause} ORDER BY ts DESC LIMIT ${limit} OFFSET ${offset}`,
        params,
      );
      const rows = await result.getRowObjects();
      const events: AnalyticsEvent[] = rows.map(rowToEvent);

      return { events, total, hasMore: offset + events.length < total };
    });
  }

  // ─── Read: Stats ──────────────────────────────────────────────────────────

  async getStats(): Promise<EventsStats> {
    return this.withConnection(async (conn) => {
      const totalResult = await conn.run(
        `SELECT COUNT(*) as total, MIN(ts) as minTs, MAX(ts) as maxTs FROM events`,
      );
      const totalRows = await totalResult.getRowObjects();
      const totalEvents = Number(totalRows[0]?.total ?? 0);
      const from = String(totalRows[0]?.minTs ?? new Date().toISOString());
      const to = String(totalRows[0]?.maxTs ?? new Date().toISOString());

      const byTypeResult = await conn.run(
        `SELECT type, COUNT(*) as cnt FROM events GROUP BY type`,
      );
      const byType: Record<string, number> = {};
      for (const r of await byTypeResult.getRowObjects()) {
        byType[String(r.type)] = Number(r.cnt);
      }

      const bySourceResult = await conn.run(
        `SELECT COALESCE(product, 'unknown') as product, COUNT(*) as cnt FROM events GROUP BY product`,
      );
      const bySource: Record<string, number> = {};
      for (const r of await bySourceResult.getRowObjects()) {
        bySource[String(r.product)] = Number(r.cnt);
      }

      const byActorResult = await conn.run(
        `SELECT COALESCE(actor_id, 'unknown') as actor, COUNT(*) as cnt FROM events GROUP BY actor`,
      );
      const byActor: Record<string, number> = {};
      for (const r of await byActorResult.getRowObjects()) {
        byActor[String(r.actor)] = Number(r.cnt);
      }

      return { totalEvents, byType, bySource, byActor, timeRange: { from, to } };
    });
  }

  // ─── Read: Time-series ────────────────────────────────────────────────────

  async getDailyStats(query?: StatsQuery): Promise<DailyStats[]> {
    return this.withConnection(async (conn) => {
      const groupBy = query?.groupBy ?? 'day';
      const truncUnit = GROUP_BY_TRUNC[groupBy] ?? 'day';
      const fmtStr = GROUP_BY_FORMAT[groupBy] ?? '%Y-%m-%d';

      const breakdownBy = query?.breakdownBy;
      const breakdownSQL = breakdownBy ? dotPathToSQL(breakdownBy) : null;

      const metricsFilter = query?.metrics ?? getDefaultMetrics(query?.type);
      const metricsSelect = buildMetricsSelect(metricsFilter);

      const { where, params } = buildWhereClause(query);
      const whereClause = where ? `WHERE ${where}` : '';

      // Build SELECT
      const selectParts = [
        `strftime(date_trunc('${truncUnit}', ts), '${fmtStr}') as date`,
        `COUNT(*) as count`,
        ...metricsSelect,
        ...(breakdownSQL ? [`${breakdownSQL} as breakdown`] : []),
      ];

      // Build GROUP BY
      const groupByParts = [`date_trunc('${truncUnit}', ts)`];
      if (breakdownSQL) {groupByParts.push(breakdownSQL);}

      const sql = `
        SELECT ${selectParts.join(', ')}
        FROM events
        ${whereClause}
        GROUP BY ${groupByParts.join(', ')}
        ORDER BY date_trunc('${truncUnit}', ts) ASC${breakdownSQL ? ', breakdown ASC NULLS LAST' : ''}
      `;

      const result = await conn.run(sql, params);
      const rows = await result.getRowObjects();

      return rows.map((r): DailyStats => {
        const metrics: Record<string, number> = {};
        for (const m of metricsFilter) {
          const v = r[m];
          if (v !== null && v !== undefined) {
            metrics[m] = Number(v);
          }
        }

        const stat: DailyStats = {
          date: String(r.date),
          count: Number(r.count),
        };
        if (Object.keys(metrics).length > 0) {stat.metrics = metrics;}
        if (breakdownSQL && r.breakdown !== null && r.breakdown !== undefined) {
          stat.breakdown = String(r.breakdown);
        }
        return stat;
      });
    });
  }

  // ─── Read: Buffer / DLQ ──────────────────────────────────────────────────

  async getBufferStatus(): Promise<BufferStatus | null> {
    return this.withConnection(async (conn) => {
      const result = await conn.run(
        `SELECT COUNT(*) as segments, MIN(ts) as oldest, MAX(ts) as newest FROM events`,
      );
      const rows = await result.getRowObjects();
      const row = rows[0];
      return {
        segments: Number(row?.segments ?? 0),
        totalSizeBytes: 0, // DuckDB doesn't expose file size here easily
        oldestEventTs: row?.oldest ? String(row.oldest) : null,
        newestEventTs: row?.newest ? String(row.newest) : null,
      };
    });
  }

  async getDlqStatus(): Promise<DlqStatus | null> {
    return null; // DuckDB adapter has no DLQ
  }
}

// ─── SQL helpers ──────────────────────────────────────────────────────────────

function buildWhereClause(query?: EventsQuery): { where: string; params: DuckDBValue[] } {
  if (!query) {return { where: '', params: [] };}

  const clauses: string[] = [];
  const params: DuckDBValue[] = [];
  let idx = 1;

  if (query.type) {
    const types: string[] = Array.isArray(query.type) ? query.type : [query.type];
    if (types.length === 1) {
      clauses.push(`type = $${idx++}`);
      params.push(types[0] as string);
    } else {
      const placeholders = types.map(() => `$${idx++}`).join(', ');
      clauses.push(`type IN (${placeholders})`);
      params.push(...(types as string[]));
    }
  }

  if (query.source) {
    clauses.push(`product = $${idx++}`);
    params.push(query.source);
  }

  if (query.actor) {
    clauses.push(`actor_id = $${idx++}`);
    params.push(query.actor);
  }

  if (query.from) {
    clauses.push(`ts >= $${idx++}::TIMESTAMPTZ`);
    params.push(query.from);
  }

  if (query.to) {
    clauses.push(`ts <= $${idx++}::TIMESTAMPTZ`);
    params.push(query.to);
  }

  return { where: clauses.join(' AND '), params };
}

function rowToEvent(r: Record<string, unknown>): AnalyticsEvent {
  return {
    id: String(r.id),
    schema: 'kb.v1',
    type: String(r.type),
    ts: String(r.ts),
    ingestTs: String(r.ingest_ts ?? r.ts),
    source: {
      product: String(r.product ?? ''),
      version: String(r.version ?? ''),
    },
    runId: String(r.run_id ?? ''),
    actor: r.actor_type
      ? {
          type: r.actor_type as 'user' | 'agent' | 'ci',
          id: r.actor_id ? String(r.actor_id) : undefined,
          name: r.actor_name ? String(r.actor_name) : undefined,
        }
      : undefined,
    ctx: r.ctx ? (JSON.parse(String(r.ctx)) as Record<string, string | number | boolean | null>) : undefined,
    payload: r.payload ? JSON.parse(String(r.payload)) : undefined,
  };
}

export { manifest } from './manifest.js';

/**
 * Factory function required by core-runtime adapter discovery.
 * Called by platform loader with config options from kb.config.json adapterOptions.analytics
 */
export function createAdapter(options?: DuckDBAnalyticsOptions): IAnalytics {
  return new DuckDBAnalytics(options);
}

export default createAdapter;
