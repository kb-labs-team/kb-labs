/**
 * @module @kb-labs/core-platform/adapters/analytics
 * Analytics abstraction for tracking events and user identification.
 */

import type { ErrorEnvelope } from '../error-envelope/types.js';

/**
 * Query parameters for fetching analytics events
 */
export interface EventsQuery {
  type?: string | string[];
  source?: string;
  actor?: string;
  from?: string; // ISO 8601 datetime
  to?: string; // ISO 8601 datetime
  limit?: number;
  offset?: number;
}

/**
 * Analytics event structure (matches kb.v1 schema from @kb-labs/analytics)
 */
export interface AnalyticsEvent {
  id: string;
  schema: "kb.v1";
  type: string;
  ts: string;
  ingestTs: string;
  source: {
    product: string;
    version: string;
  };
  runId: string;
  actor?: {
    type: "user" | "agent" | "ci";
    id?: string;
    name?: string;
  };
  ctx?: Record<string, string | number | boolean | null>;
  payload?: unknown;
  hashMeta?: {
    algo: "hmac-sha256";
    saltId: string;
  };
}

/**
 * Response for events query
 */
export interface EventsResponse {
  events: AnalyticsEvent[];
  total: number;
  hasMore: boolean;
}

/**
 * Aggregated statistics across events
 */
export interface EventsStats {
  totalEvents: number;
  byType: Record<string, number>;
  bySource: Record<string, number>;
  byActor: Record<string, number>;
  timeRange: {
    from: string;
    to: string;
  };
  persistence: AnalyticsPersistence;
}

/** Persistence facts reported by the analytics source that produced its stats. */
export type AnalyticsPersistence =
  | { kind: 'durable' }
  | { kind: 'ephemeral'; notice: Pick<ErrorEnvelope, 'message' | 'hint'> };

/**
 * Daily aggregated statistics for time-series visualization
 */
export interface DailyStats {
  date: string; // Bucket key — format depends on groupBy: 'YYYY-MM-DD' (day), 'YYYY-MM-DDTHH' (hour), 'YYYY-WXX' (week), 'YYYY-MM' (month)
  count: number;
  metrics?: Record<string, number>; // Optional metrics (e.g., totalTokens, totalCost, avgDurationMs)
  breakdown?: string; // Present when StatsQuery.breakdownBy is specified — the value of that field for this bucket
}

/**
 * Extended query for getDailyStats — adds time bucketing and breakdown support on top of EventsQuery.
 * Adapters implement what they can; unsupported fields are silently ignored (graceful degradation).
 */
export interface StatsQuery extends EventsQuery {
  /**
   * Time bucket granularity. Default: 'day'.
   * Controls the format of DailyStats.date in the response.
   */
  groupBy?: "hour" | "day" | "week" | "month";

  /**
   * Dot-notation path to a field to split results by (e.g. 'payload.model', 'payload.tier', 'source.product').
   * When specified, each time bucket returns multiple DailyStats rows — one per unique value of this field.
   * Rows include a `breakdown` field with the field value.
   * Adapters that do not support breakdownBy return data without breakdown (no error).
   */
  breakdownBy?: string;

  /**
   * Specific payload metric field names to aggregate (e.g. ['totalCost', 'totalTokens']).
   * When omitted, adapters aggregate all metrics they know about for the given event type.
   */
  metrics?: string[];
}

/**
 * WAL buffer status (if applicable)
 */
export interface BufferStatus {
  segments: number;
  totalSizeBytes: number;
  oldestEventTs: string | null;
  newestEventTs: string | null;
}

/**
 * Dead-Letter Queue status (if applicable)
 */
export interface DlqStatus {
  failedEvents: number;
  oldestFailureTs: string | null;
}

/**
 * Context for analytics events (automatically populated).
 * Adapters use this to enrich events with source, actor, and runId.
 */
export interface AnalyticsContext {
  /**
   * Source of events (product name and version).
   * Automatically extracted from package.json.
   */
  source: {
    product: string;
    version: string;
  };

  /**
   * Run ID for correlating events in a single execution.
   * Automatically generated per-execution (e.g., CLI invocation, REST request).
   */
  runId: string;

  /**
   * Actor performing the action (user, agent, CI).
   * Auto-detected from environment (git config, CI env vars, etc).
   */
  actor?: {
    type: "user" | "agent" | "ci";
    id?: string;
    name?: string;
  };

  /**
   * Tenant ID for multi-tenancy support.
   */
  tenantId?: string;

  /**
   * Additional context (workspace path, branch, etc).
   */
  ctx?: Record<string, string | number | boolean | null>;
}

/**
 * Analytics adapter interface.
 * Implementations: @kb-labs/analytics-adapter (production), NoOpAnalytics (noop)
 */
export interface IAnalytics {
  /**
   * Track an analytics event.
   * @param event - Event name (e.g., 'user.signup', 'workflow.completed')
   * @param properties - Optional event properties
   */
  track(event: string, properties?: Record<string, unknown>): Promise<void>;

  /**
   * Identify a user for analytics tracking.
   * @param userId - Unique user identifier
   * @param traits - Optional user traits (name, email, etc.)
   */
  identify(userId: string, traits?: Record<string, unknown>): Promise<void>;

  /**
   * Flush all pending analytics events.
   * Call before process exit to ensure all events are sent.
   */
  flush(): Promise<void>;

  /**
   * Get analytics events (optional - for reading/visualization).
   * Not implemented by NoOpAnalytics.
   */
  getEvents?(query?: EventsQuery): Promise<EventsResponse>;

  /**
   * Get aggregated statistics (optional - for dashboards).
   * Not implemented by NoOpAnalytics.
   */
  getStats?(): Promise<EventsStats>;

  /**
   * Get buffer status (optional - for monitoring).
   * Returns null if buffer not applicable (e.g., HTTP-only analytics).
   */
  getBufferStatus?(): Promise<BufferStatus | null>;

  /**
   * Get DLQ status (optional - for monitoring).
   * Returns null if DLQ not applicable.
   */
  getDlqStatus?(): Promise<DlqStatus | null>;

  /**
   * Get current source attribution (optional).
   *
   * Returns the current source (product name and version) used for events.
   * This is useful for saving and restoring source in nested plugin execution.
   *
   * @returns Current source, or undefined if not available
   *
   * Implementation notes:
   * - FileAnalytics: Returns current context.source
   * - NoOpAnalytics: Not needed (no events tracked)
   * - Future HTTP/Cloud adapters: Should implement this
   *
   * @example
   * ```typescript
   * const analytics = platform.analytics;
   * const originalSource = analytics.getSource?.();
   *
   * try {
   *   analytics.setSource?.({ product: '@kb-labs/mind', version: '0.1.0' });
   *   await analytics.track('mind.event', {...});
   * } finally {
   *   if (originalSource) {
   *     analytics.setSource?.(originalSource);
   *   }
   * }
   * ```
   */
  getSource?(): { product: string; version: string } | undefined;

  /**
   * Override source attribution for scoped execution (optional).
   *
   * This method allows wrapping analytics adapters to override the source
   * (product name and version) for events tracked during plugin execution.
   *
   * Use case: When a plugin (@kb-labs/mind) runs in a subprocess, we want
   * analytics events to show source.product = '@kb-labs/mind' instead of
   * the root package (@kb-labs/review).
   *
   * @param source - New source to use for future events
   *
   * Implementation notes:
   * - FileAnalytics: Updates internal context.source
   * - NoOpAnalytics: Not needed (no events tracked)
   * - Future HTTP/Cloud adapters: Should implement this
   *
   * @example
   * ```typescript
   * const analytics = platform.analytics;
   * if (analytics.setSource) {
   *   analytics.setSource({
   *     product: '@kb-labs/mind',
   *     version: '0.1.0'
   *   });
   * }
   * await analytics.track('mind.rag-index.started', {...});
   * // Event will have source.product = '@kb-labs/mind'
   * ```
   */
  setSource?(source: { product: string; version: string }): void;

  /**
   * Get time-bucketed aggregated statistics (optional - for time-series visualization).
   *
   * Groups events by time bucket and returns aggregated counts and metrics.
   * Useful for rendering charts and graphs.
   *
   * @param query - StatsQuery extending EventsQuery with groupBy, breakdownBy, metrics
   * @returns Array of stats sorted by date ascending. When breakdownBy is used,
   *          multiple rows per time bucket are returned (one per unique breakdown value).
   *
   * Implementation notes:
   * - FileAnalytics: Groups events in memory using date-fns; supports all StatsQuery fields
   * - PostgresAnalytics: Uses SQL GROUP BY + date_trunc() for efficiency
   * - NoOpAnalytics: Not implemented (returns empty array)
   * - Adapters that don't support breakdownBy/groupBy silently ignore those fields
   *
   * The metrics object contains event-specific numeric aggregates. LLM and
   * embeddings usage metrics are supported by product analytics adapters.
   *
   * @example
   * ```typescript
   * // Basic daily stats
   * const daily = await analytics.getDailyStats?.({
   *   type: 'llm.completion.completed',
   *   from: '2026-01-01T00:00:00Z',
   *   to: '2026-01-31T23:59:59Z',
   * });
   * // [{ date: '2026-01-01', count: 45, metrics: { totalTokens: 12500, totalCost: 2.34 } }, ...]
   *
   * // Hourly breakdown by model
   * const byModel = await analytics.getDailyStats?.({
   *   type: ['llm.chatWithTools.completed', 'llm.completion.completed'],
   *   groupBy: 'hour',
   *   breakdownBy: 'payload.model',
   *   metrics: ['totalCost', 'totalTokens'],
   * });
   * // [
   * //   { date: '2026-01-01T10', count: 12, breakdown: 'gpt-4o-mini', metrics: { totalCost: 0.05 } },
   * //   { date: '2026-01-01T10', count: 3,  breakdown: 'gpt-5.1-codex-max', metrics: { totalCost: 1.20 } },
   * // ]
   * ```
   */
  getDailyStats?(query?: StatsQuery): Promise<DailyStats[]>;
}
