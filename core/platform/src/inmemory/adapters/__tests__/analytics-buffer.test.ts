import { describe, it, expect } from 'vitest';
import { createErrorEnvelope } from '../../../error-envelope/index.js';
import { InMemoryAnalyticsBuffer } from '../analytics-buffer.js';

describe('InMemoryAnalyticsBuffer', () => {
  it('starts empty', async () => {
    const buf = new InMemoryAnalyticsBuffer();
    const res = await buf.getEvents();
    expect(res.events).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.hasMore).toBe(false);
  });

  it('captures tracked events with payload', async () => {
    const buf = new InMemoryAnalyticsBuffer();
    await buf.track('signup', { plan: 'pro' });
    const res = await buf.getEvents();
    expect(res.total).toBe(1);
    expect(res.events[0]).toMatchObject({
      type: 'signup',
      payload: { plan: 'pro' },
      schema: 'kb.v1',
    });
  });

  it('drops oldest events when capacity is exceeded', async () => {
    const buf = new InMemoryAnalyticsBuffer({ capacity: 2 });
    await buf.track('e1');
    await buf.track('e2');
    await buf.track('e3');
    const res = await buf.getEvents();
    expect(res.total).toBe(2);
    expect(res.events.map((e) => e.type)).toEqual(['e2', 'e3']);
    expect(buf.getTotalSeen()).toBe(3);
    expect(buf.getDropped()).toBe(1);
  });

  it('clamps capacity to at least 1', async () => {
    const buf = new InMemoryAnalyticsBuffer({ capacity: 0 });
    await buf.track('a');
    await buf.track('b');
    const res = await buf.getEvents();
    expect(res.total).toBe(1);
    expect(res.events[0]?.type).toBe('b');
  });

  it('identify and flush are no-ops that resolve', async () => {
    const buf = new InMemoryAnalyticsBuffer();
    await expect(buf.identify('u1', { plan: 'pro' })).resolves.toBeUndefined();
    await expect(buf.flush()).resolves.toBeUndefined();
  });

  it('filters by event type (single)', async () => {
    const buf = new InMemoryAnalyticsBuffer();
    await buf.track('a');
    await buf.track('b');
    const res = await buf.getEvents({ type: 'a' });
    expect(res.events.map((e) => e.type)).toEqual(['a']);
  });

  it('filters by event type (multiple)', async () => {
    const buf = new InMemoryAnalyticsBuffer();
    await buf.track('a');
    await buf.track('b');
    await buf.track('c');
    const res = await buf.getEvents({ type: ['a', 'c'] });
    expect(res.events.map((e) => e.type).sort()).toEqual(['a', 'c']);
  });

  it('filters by source product', async () => {
    const buf = new InMemoryAnalyticsBuffer({ source: { product: 'p1', version: '1' } });
    await buf.track('a');
    buf.setSource({ product: 'p2', version: '1' });
    await buf.track('b');
    const res = await buf.getEvents({ source: 'p2' });
    expect(res.events.map((e) => e.type)).toEqual(['b']);
  });

  it('paginates with offset + limit', async () => {
    const buf = new InMemoryAnalyticsBuffer();
    for (let i = 0; i < 5; i++) { await buf.track(`e${i}`); }
    const res = await buf.getEvents({ offset: 1, limit: 2 });
    expect(res.events.map((e) => e.type)).toEqual(['e1', 'e2']);
    expect(res.total).toBe(5);
    expect(res.hasMore).toBe(true);
  });

  it('hasMore false when slice reaches the end', async () => {
    const buf = new InMemoryAnalyticsBuffer();
    await buf.track('a');
    await buf.track('b');
    const res = await buf.getEvents({ offset: 1, limit: 5 });
    expect(res.hasMore).toBe(false);
  });

  it('getStats aggregates byType/bySource/byActor and timeRange', async () => {
    const buf = new InMemoryAnalyticsBuffer();
    await buf.track('a');
    await buf.track('a');
    await buf.track('b');
    const stats = await buf.getStats();
    expect(stats.totalEvents).toBe(3);
    expect(stats.byType).toEqual({ a: 2, b: 1 });
    expect(stats.bySource['kb-labs']).toBe(3);
    expect(typeof stats.timeRange.from).toBe('string');
    expect(typeof stats.timeRange.to).toBe('string');
  });

  // case: S-275.1
  it('declares process-local persistence with catalog-owned setup guidance', async () => {
    const analytics = new InMemoryAnalyticsBuffer();
    await analytics.track('workflow.completed');
    await analytics.track('workflow.completed');
    await analytics.track('llm.requested');
    const stats = await analytics.getStats();
    const notice = createErrorEnvelope('KB_ANALYTICS_PERSISTENCE_VOLATILE');

    expect(stats.totalEvents).toBe(3);
    expect(stats.persistence).toEqual({
      kind: 'ephemeral',
      notice: { message: notice.message, hint: notice.hint },
    });
  });

  it('getSource / setSource', () => {
    const buf = new InMemoryAnalyticsBuffer();
    expect(buf.getSource()).toEqual({ product: 'kb-labs', version: '0.0.0' });
    buf.setSource({ product: 'x', version: '2' });
    expect(buf.getSource()).toEqual({ product: 'x', version: '2' });
  });
});
