/**
 * @module @kb-labs/studio-data-client/mocks/mock-analytics-source
 * Mock implementation of AnalyticsDataSource
 */

import type { AnalyticsDataSource } from '../sources/analytics-source';
import type {
  EventsQuery,
  EventsResponse,
  EventsStats,
  BufferStatus,
  DlqStatus,
  AnalyticsEvent,
} from '../contracts/analytics';

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * Mock implementation of AnalyticsDataSource
 * Returns deterministic mock data for development and testing
 */
export class MockAnalyticsSource implements AnalyticsDataSource {
  private mockEvents: AnalyticsEvent[];

  constructor() {
    this.mockEvents = this.generateMockEvents();
  }

  private generateMockEvents(): AnalyticsEvent[] {
    const now = Date.now();
    const events: AnalyticsEvent[] = [];

    const eventTypes = [
      'mind.query.started',
      'mind.query.completed',
      'workflow.run.started',
      'workflow.run.completed',
      'commit.generated',
      'plugin.mounted',
    ];

    const sources = ['mind', 'workflow', 'commit', 'core'];
    const actors: Array<'user' | 'agent' | 'ci'> = ['user', 'agent', 'ci'];

    // Generate 100 mock events
    for (let i = 0; i < 100; i++) {
      const ts = new Date(now - i * 60000).toISOString(); // Events every minute
      const type = eventTypes[Math.floor(Math.random() * eventTypes.length)]!;
      const source = sources[Math.floor(Math.random() * sources.length)]!;
      const actorType = actors[Math.floor(Math.random() * actors.length)]!;

      events.push({
        id: `mock-event-${i}`,
        schema: 'kb.v1' as const,
        type,
        ts,
        ingestTs: ts,
        source: {
          product: source,
          version: '1.0.0',
        },
        runId: `run-${Math.floor(i / 5)}`, // Group every 5 events
        actor: {
          type: actorType,
          id: `${actorType}-${Math.floor(Math.random() * 10)}` as string,
          name: `Mock ${actorType}` as string,
        },
        ctx: {
          workspace: '/mock/workspace',
          branch: 'main',
        },
        payload: {
          duration: Math.random() * 1000,
          success: Math.random() > 0.1,
        },
      });
    }

    return events;
  }

  async getEvents(query?: EventsQuery): Promise<EventsResponse> {
    await delay(150);

    let filtered = [...this.mockEvents];

    // Apply filters
    if (query?.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      filtered = filtered.filter(e => types.includes(e.type));
    }

    if (query?.source) {
      filtered = filtered.filter(e => e.source.product === query.source);
    }

    if (query?.actor) {
      filtered = filtered.filter(e => e.actor?.type === query.actor);
    }

    // Apply limit
    const limit = query?.limit || 100;
    const offset = query?.offset || 0;
    const paginated = filtered.slice(offset, offset + limit);

    return {
      events: paginated,
      total: filtered.length,
      hasMore: offset + limit < filtered.length,
    };
  }

  async getStats(): Promise<EventsStats> {
    await delay(180);

    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};
    const byActor: Record<string, number> = {};

    this.mockEvents.forEach(event => {
      byType[event.type] = (byType[event.type] || 0) + 1;
      bySource[event.source.product] = (bySource[event.source.product] || 0) + 1;
      if (event.actor) {
        byActor[event.actor.type] = (byActor[event.actor.type] || 0) + 1;
      }
    });

    const timestamps = this.mockEvents.map(e => new Date(e.ts).getTime());
    const oldestTs = Math.min(...timestamps);
    const newestTs = Math.max(...timestamps);

    return {
      totalEvents: this.mockEvents.length,
      byType,
      bySource,
      byActor,
      timeRange: {
        from: new Date(oldestTs).toISOString(),
        to: new Date(newestTs).toISOString(),
      },
      persistence: { kind: 'durable' },
    };
  }

  async getBufferStatus(): Promise<BufferStatus | null> {
    await delay(100);

    const timestamps = this.mockEvents.map(e => new Date(e.ts).getTime());

    return {
      segments: 3,
      totalSizeBytes: 524288, // 512 KB
      oldestEventTs: new Date(Math.min(...timestamps)).toISOString(),
      newestEventTs: new Date(Math.max(...timestamps)).toISOString(),
    };
  }

  async getDlqStatus(): Promise<DlqStatus | null> {
    await delay(100);

    return {
      failedEvents: 2,
      oldestFailureTs: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    };
  }
}
