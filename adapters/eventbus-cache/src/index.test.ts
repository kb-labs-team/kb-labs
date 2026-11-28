import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheEventBusAdapter, createAdapter } from './index.js';
import type { ICache } from '@kb-labs/sdk/adapters';

/**
 * Mock ICache implementation for testing.
 */
class MockCache implements ICache {
  private store = new Map<string, unknown>();
  private sortedSets = new Map<string, Array<{ score: number; member: string }>>();

  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }

  async set<T>(key: string, value: T, _ttl?: number): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(_pattern?: string): Promise<void> {
    this.store.clear();
    this.sortedSets.clear();
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    let set = this.sortedSets.get(key);
    if (!set) {
      set = [];
      this.sortedSets.set(key, set);
    }

    // Remove existing member if present
    const existingIndex = set.findIndex(m => m.member === member);
    if (existingIndex !== -1) {
      set.splice(existingIndex, 1);
    }

    // Add new member and sort by score
    set.push({ score, member });
    set.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return [];
    }

    return set
      .filter(m => m.score >= min && m.score <= max)
      .map(m => m.member);
  }

  async zrem(key: string, member: string): Promise<void> {
    const set = this.sortedSets.get(key);
    if (!set) {
      return;
    }

    const index = set.findIndex(m => m.member === member);
    if (index !== -1) {
      set.splice(index, 1);
    }
  }

  async setIfNotExists<T>(key: string, value: T, _ttl?: number): Promise<boolean> {
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, value);
    return true;
  }
}

const TEST_TOPIC = 'test.topic';

describe('CacheEventBusAdapter', () => {
  let cache: MockCache;
  let eventBus: CacheEventBusAdapter;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new MockCache();
    eventBus = new CacheEventBusAdapter(cache, {
      pollIntervalMs: 100,
      eventTtlMs: 60000, // 1 minute
      keyPrefix: 'test:eventbus:',
    });
  });

  afterEach(() => {
    eventBus.disconnect();
    vi.useRealTimers();
  });

  describe('publish', () => {
    it('should store event in cache', async () => {
      await eventBus.publish(TEST_TOPIC, { message: 'hello' });

      const events = await cache.zrangebyscore('test:eventbus:test.topic', 0, Date.now() + 1000);
      expect(events).toHaveLength(1);

      const storedEvent = JSON.parse(events[0]!);
      expect(storedEvent.topic).toBe(TEST_TOPIC);
      expect(storedEvent.data).toEqual({ message: 'hello' });
      expect(storedEvent.id).toBeDefined();
      expect(storedEvent.timestamp).toBeDefined();
    });

    it('should store multiple events in order', async () => {
      await eventBus.publish(TEST_TOPIC, { order: 1 });
      vi.advanceTimersByTime(10);
      await eventBus.publish(TEST_TOPIC, { order: 2 });
      vi.advanceTimersByTime(10);
      await eventBus.publish(TEST_TOPIC, { order: 3 });

      const events = await cache.zrangebyscore('test:eventbus:test.topic', 0, Date.now() + 1000);
      expect(events).toHaveLength(3);

      const parsed = events.map(e => JSON.parse(e));
      expect(parsed[0].data.order).toBe(1);
      expect(parsed[1].data.order).toBe(2);
      expect(parsed[2].data.order).toBe(3);
    });

    it('preserves publish order for events written within the same wall-clock millisecond', async () => {
      const received: number[] = [];
      eventBus.subscribe(TEST_TOPIC, async (event: { order: number }) => {
        received.push(event.order);
      });
      await vi.advanceTimersByTimeAsync(1);

      await eventBus.publish(TEST_TOPIC, { order: 1 });
      await eventBus.publish(TEST_TOPIC, { order: 2 });
      await eventBus.publish(TEST_TOPIC, { order: 3 });

      const stored = await cache.zrangebyscore('test:eventbus:test.topic', 0, Date.now() + 1);
      const parsed = stored.map((event) => JSON.parse(event));
      expect(parsed.map((event) => event.timestamp)).toEqual([parsed[0].timestamp, parsed[0].timestamp, parsed[0].timestamp]);
      expect(parsed.map((event) => event.sequence)).toEqual(['0000000000000001', '0000000000000002', '0000000000000003']);

      await vi.advanceTimersByTimeAsync(200);
      expect(received).toEqual([1, 2, 3]);
    });
  });

  describe('subscribe', () => {
    it('should receive published events via polling', async () => {
      const received: unknown[] = [];

      eventBus.subscribe(TEST_TOPIC, async (event) => {
        received.push(event);
      });

      // Advance time so event timestamp > subscription lastTimestamp
      await vi.advanceTimersByTimeAsync(10);

      // Publish an event
      await eventBus.publish(TEST_TOPIC, { message: 'hello' });

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(150);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ message: 'hello' });
    });

    it('should return unsubscribe function', () => {
      const unsubscribe = eventBus.subscribe(TEST_TOPIC, async () => {});

      expect(eventBus.subscriptionCount).toBe(1);

      unsubscribe();

      expect(eventBus.subscriptionCount).toBe(0);
    });

    it('should support multiple subscribers on same topic', async () => {
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      eventBus.subscribe(TEST_TOPIC, async (event) => {
        received1.push(event);
      });

      eventBus.subscribe(TEST_TOPIC, async (event) => {
        received2.push(event);
      });

      // Advance time so event timestamp > subscription lastTimestamp
      await vi.advanceTimersByTimeAsync(10);

      await eventBus.publish(TEST_TOPIC, { message: 'hello' });

      await vi.advanceTimersByTimeAsync(150);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });

    it('should not receive events from other topics', async () => {
      const received: unknown[] = [];

      eventBus.subscribe('topic.a', async (event) => {
        received.push(event);
      });

      await eventBus.publish('topic.b', { message: 'wrong topic' });

      await vi.advanceTimersByTimeAsync(150);

      expect(received).toHaveLength(0);
    });
  });

  describe('disconnect', () => {
    it('should stop all subscriptions', () => {
      eventBus.subscribe('topic.a', async () => {});
      eventBus.subscribe('topic.b', async () => {});

      expect(eventBus.subscriptionCount).toBe(2);

      eventBus.disconnect();

      expect(eventBus.subscriptionCount).toBe(0);
    });
  });

  describe('createAdapter', () => {
    it('should create adapter with default config', () => {
      const adapter = createAdapter({}, { cache });

      expect(adapter).toBeInstanceOf(CacheEventBusAdapter);
      adapter.disconnect();
    });

    it('should create adapter with custom config', () => {
      const adapter = createAdapter(
        {
          pollIntervalMs: 500,
          eventTtlMs: 3600000,
          keyPrefix: 'custom:',
        },
        { cache },
      );

      expect(adapter).toBeInstanceOf(CacheEventBusAdapter);
      adapter.disconnect();
    });
  });
});
