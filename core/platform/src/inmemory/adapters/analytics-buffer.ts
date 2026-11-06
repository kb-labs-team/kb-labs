/**
 * @module @kb-labs/core-platform/inmemory/adapters/analytics-buffer
 *
 * Bounded ring buffer for analytics events.
 *
 * Used as the default fallback when no analytics adapter is configured.
 * Honest: events ARE captured and visible through `getEvents()`, unlike a
 * NoOp that silently discards them. Bounded: when the buffer is full,
 * oldest events are dropped to keep memory predictable.
 *
 * Capacity defaults to ~1000 events. Override via constructor.
 */

import type {
  AnalyticsEvent,
  EventsQuery,
  EventsResponse,
  EventsStats,
  IAnalytics,
} from '../../adapters/analytics.js';
import { createErrorEnvelope } from '../../error-envelope/index.js';

const DEFAULT_CAPACITY = 1000;

export interface InMemoryAnalyticsBufferOptions {
  capacity?: number;
  source?: { product: string; version: string };
}

export class InMemoryAnalyticsBuffer implements IAnalytics {
  private readonly capacity: number;
  private readonly events: AnalyticsEvent[] = [];
  private source: { product: string; version: string };
  /** Total events seen (including those dropped on overflow). */
  private totalSeen = 0;

  constructor(opts: InMemoryAnalyticsBufferOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_CAPACITY);
    this.source = opts.source ?? { product: 'kb-labs', version: '0.0.0' };
  }

  async track(event: string, properties?: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    const record: AnalyticsEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      schema: 'kb.v1',
      type: event,
      ts: now,
      ingestTs: now,
      source: this.source,
      runId: 'inmemory',
      payload: properties,
    };
    this.events.push(record);
    this.totalSeen++;
    if (this.events.length > this.capacity) {
      this.events.shift();
    }
  }

  async identify(_userId: string, _traits?: Record<string, unknown>): Promise<void> {
    // No-op in the buffer — identification is a no-op without a real backend.
  }

  async flush(): Promise<void> {
    // No-op — buffer is the destination.
  }

  async getEvents(query: EventsQuery = {}): Promise<EventsResponse> {
    let events = [...this.events];

    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      events = events.filter((e) => types.includes(e.type));
    }
    if (query.source) {
      events = events.filter((e) => e.source.product === query.source);
    }
    if (query.from) {
      events = events.filter((e) => e.ts >= query.from!);
    }
    if (query.to) {
      events = events.filter((e) => e.ts <= query.to!);
    }

    const total = events.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? events.length;
    const slice = events.slice(offset, offset + limit);

    return {
      events: slice,
      total,
      hasMore: offset + slice.length < total,
    };
  }

  async getStats(): Promise<EventsStats> {
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byActor: Record<string, number> = {};
    let from = '';
    let to = '';
    for (const e of this.events) {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      bySource[e.source.product] = (bySource[e.source.product] ?? 0) + 1;
      if (e.actor?.id) {
        byActor[e.actor.id] = (byActor[e.actor.id] ?? 0) + 1;
      }
      if (!from || e.ts < from) { from = e.ts; }
      if (!to || e.ts > to) { to = e.ts; }
    }
    const { message, hint } = createErrorEnvelope('KB_ANALYTICS_PERSISTENCE_VOLATILE');
    return {
      totalEvents: this.events.length,
      byType,
      bySource,
      byActor,
      timeRange: { from, to },
      persistence: {
        kind: 'ephemeral',
        notice: { message, hint },
      },
    };
  }

  getSource(): { product: string; version: string } | undefined {
    return this.source;
  }

  setSource(source: { product: string; version: string }): void {
    this.source = source;
  }

  /** Diagnostic — total events seen since startup, including dropped. */
  getTotalSeen(): number {
    return this.totalSeen;
  }

  /** Diagnostic — how many events were dropped due to capacity. */
  getDropped(): number {
    return Math.max(0, this.totalSeen - this.events.length);
  }
}
