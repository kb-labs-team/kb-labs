/**
 * Integration tests for InMemoryStateBroker
 *
 * Real tests without mocks - verifying actual behavior:
 * - TTL expiration with real timing
 * - Background cleanup
 * - Namespace/tenant extraction
 * - Statistics tracking
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryStateBroker } from '../backends/in-memory.js';

describe('InMemoryStateBroker', () => {
  let broker: InMemoryStateBroker;

  beforeEach(() => {
    broker = new InMemoryStateBroker(30_000); // 30s cleanup interval
  });

  afterEach(async () => {
    await broker.stop();
  });

  describe('Basic Operations', () => {
    it('should set and get value', async () => {
      await broker.set('test-key', { data: 'hello' }, 60_000);
      const result = await broker.get<{ data: string }>('test-key');

      expect(result).toEqual({ data: 'hello' });
    });

    it('should return null for non-existent key', async () => {
      const result = await broker.get('non-existent');
      expect(result).toBeNull();
    });

    it('applies concurrent sorted-set mutations atomically', async () => {
      await Promise.all([
        broker.zadd('queue', 1, 'first'),
        broker.zadd('queue', 2, 'second'),
        broker.zadd('queue', 3, 'third'),
      ]);
      expect(await broker.zrangebyscore('queue', 0, 10)).toEqual(['first', 'second', 'third']);

      await Promise.all([
        broker.zrem('queue', 'second'),
        broker.zadd('queue', 4, 'fourth'),
      ]);
      expect(await broker.zrangebyscore('queue', 0, 10)).toEqual(['first', 'third', 'fourth']);
    });

    it('keeps delete and clear ordered after a sorted-set mutation starts', async () => {
      const deleteWrite = broker.zadd('delete-queue', 1, 'new');
      await Promise.resolve();
      await broker.delete('delete-queue');
      await deleteWrite;
      expect(await broker.get('delete-queue')).toBeNull();

      const clearWrite = broker.zadd('clear:queue', 1, 'new');
      await Promise.resolve();
      await broker.clear('clear:*');
      await clearWrite;
      expect(await broker.get('clear:queue')).toBeNull();
    });

    it('should delete value', async () => {
      await broker.set('test-key', 'value', 60_000);
      await broker.delete('test-key');

      const result = await broker.get('test-key');
      expect(result).toBeNull();
    });

    it('should clear all entries when no pattern', async () => {
      await broker.set('key1', 'value1', 60_000);
      await broker.set('key2', 'value2', 60_000);
      await broker.set('key3', 'value3', 60_000);

      await broker.clear();

      expect(await broker.get('key1')).toBeNull();
      expect(await broker.get('key2')).toBeNull();
      expect(await broker.get('key3')).toBeNull();
    });

    it('should clear entries by pattern prefix', async () => {
      await broker.set('mind:query-1', 'value1', 60_000);
      await broker.set('mind:query-2', 'value2', 60_000);
      await broker.set('workflow:job-1', 'value3', 60_000);

      await broker.clear('mind:*');

      expect(await broker.get('mind:query-1')).toBeNull();
      expect(await broker.get('mind:query-2')).toBeNull();
      expect(await broker.get('workflow:job-1')).not.toBeNull();
    });
  });

  describe('TTL Expiration - Real Timing', () => {
    it('should expire entry after TTL', async () => {
      // Set with 100ms TTL
      await broker.set('short-lived', 'value', 100);

      // Immediately available
      expect(await broker.get('short-lived')).toBe('value');

      // Wait for expiration
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });

      // Should be expired
      expect(await broker.get('short-lived')).toBeNull();
    }, 5000);

    it('should return null when checking expired entry', async () => {
      await broker.set('key', 'value', 50); // 50ms TTL

      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      const result = await broker.get('key');
      expect(result).toBeNull();
    }, 5000);

    it('should not expire entry before TTL', async () => {
      await broker.set('key', 'value', 500); // 500ms TTL

      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      }); // Wait 200ms

      const result = await broker.get('key');
      expect(result).toBe('value'); // Still valid
    }, 5000);
  });

  describe('Background Cleanup', () => {
    it('should cleanup expired entries in background', async () => {
      // Create broker with 500ms cleanup interval
      const fastBroker = new InMemoryStateBroker(500);

      // Add entries with short TTL
      await fastBroker.set('exp1', 'value1', 100);
      await fastBroker.set('exp2', 'value2', 100);
      await fastBroker.set('long', 'value3', 10_000);

      // Wait for expiration
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });

      // Entries expired but not cleaned yet (lazy deletion on get)
      const stats1 = await fastBroker.getStats();
      expect(stats1.totalEntries).toBe(3); // Still in store

      // Wait for cleanup interval
      await new Promise((resolve) => {
        setTimeout(resolve, 600);
      });

      // After cleanup, expired entries removed
      const stats2 = await fastBroker.getStats();
      expect(stats2.totalEntries).toBe(1); // Only 'long' remains
      expect(stats2.evictions).toBe(2); // 2 evicted

      await fastBroker.stop();
    }, 10000);
  });

  describe('Namespace Extraction', () => {
    it('should extract namespace from simple key', async () => {
      await broker.set('mind:query-123', 'value', 60_000);

      const stats = await broker.getStats();
      expect(stats.namespaces['mind']).toBeDefined();
      expect(stats.namespaces['mind']!.entries).toBe(1);
    });

    it('should extract namespace from tenant key', async () => {
      await broker.set('tenant:acme:mind:query-123', 'value', 60_000);

      const stats = await broker.getStats();
      expect(stats.namespaces['mind']).toBeDefined();
      expect(stats.namespaces['mind']!.entries).toBe(1);
    });

    it('should use key itself as namespace for plain keys', async () => {
      await broker.set('plain-key', 'value', 60_000);

      const stats = await broker.getStats();
      // Plain key without ':' becomes its own namespace
      expect(stats.namespaces['plain-key']).toBeDefined();
      expect(stats.namespaces['plain-key']!.entries).toBe(1);
    });

    it('should track multiple namespaces', async () => {
      await broker.set('mind:query-1', 'v1', 60_000);
      await broker.set('mind:query-2', 'v2', 60_000);
      await broker.set('workflow:job-1', 'v3', 60_000);
      await broker.set('cache:session-1', 'v4', 60_000);

      const stats = await broker.getStats();
      expect(stats.namespaces['mind']!.entries).toBe(2);
      expect(stats.namespaces['workflow']!.entries).toBe(1);
      expect(stats.namespaces['cache']!.entries).toBe(1);
    });
  });

  describe('Multi-Tenancy Stats', () => {
    it('should extract tenant from tenant-prefixed keys', async () => {
      await broker.set('tenant:acme:mind:query-1', 'v1', 60_000);
      await broker.set('tenant:acme:workflow:job-1', 'v2', 60_000);
      await broker.set('tenant:globex:mind:query-2', 'v3', 60_000);

      const stats = await broker.getStats();

      expect(stats.byTenant).toBeDefined();
      expect(stats.byTenant!['acme']!.entries).toBe(2);
      expect(stats.byTenant!['globex']!.entries).toBe(1);
    });

    it('should use default tenant for non-tenant keys', async () => {
      await broker.set('mind:query-1', 'v1', 60_000);
      await broker.set('workflow:job-1', 'v2', 60_000);

      const stats = await broker.getStats();

      expect(stats.byTenant).toBeDefined();
      expect(stats.byTenant!['default']!.entries).toBe(2);
    });

    it('should track size per tenant', async () => {
      const largeData = { data: 'x'.repeat(1000) };
      const smallData = { data: 'y'.repeat(10) };

      await broker.set('tenant:acme:data', largeData, 60_000);
      await broker.set('tenant:globex:data', smallData, 60_000);

      const stats = await broker.getStats();

      // Acme should have larger size
      expect(stats.byTenant!['acme']!.size).toBeGreaterThan(stats.byTenant!['globex']!.size);
    });
  });

  describe('Statistics Tracking', () => {
    it('should track hits and misses', async () => {
      await broker.set('key1', 'value1', 60_000);

      // Hit
      await broker.get('key1');

      // Miss
      await broker.get('non-existent');

      const stats = await broker.getStats();
      expect(stats.hitRate).toBeGreaterThan(0);
      expect(stats.missRate).toBeGreaterThan(0);
      expect(stats.hitRate + stats.missRate).toBeCloseTo(1, 5);
    });

    it('should track total entries', async () => {
      await broker.set('key1', 'value1', 60_000);
      await broker.set('key2', 'value2', 60_000);
      await broker.set('key3', 'value3', 60_000);

      const stats = await broker.getStats();
      expect(stats.totalEntries).toBe(3);
    });

    it('should estimate total size', async () => {
      const smallValue = { data: 'x' };
      const largeValue = { data: 'x'.repeat(10000) };

      await broker.set('small', smallValue, 60_000);
      await broker.set('large', largeValue, 60_000);

      const stats = await broker.getStats();
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.totalSize).toBeGreaterThan(10000); // At least 10KB
    });

    it('should track uptime', async () => {
      const stats1 = await broker.getStats();

      // Sleep 150ms so the uptime check has headroom even on a slow CI runner.
      // setTimeout(100) can fire 1-2ms early, so 100ms threshold was flaky.
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });

      const stats2 = await broker.getStats();
      expect(stats2.uptime).toBeGreaterThan(stats1.uptime);
      expect(stats2.uptime).toBeGreaterThanOrEqual(100);
    }, 5000);

    it('should track evictions from cleanup', async () => {
      const fastBroker = new InMemoryStateBroker(200); // 200ms cleanup

      await fastBroker.set('exp1', 'v1', 50);
      await fastBroker.set('exp2', 'v2', 50);

      // Wait for expiration + cleanup
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      const stats = await fastBroker.getStats();
      expect(stats.evictions).toBe(2);

      await fastBroker.stop();
    }, 5000);
  });

  describe('Health Status', () => {
    it('should return ok health status', async () => {
      const health = await broker.getHealth();

      expect(health.status).toBe('ok');
      expect(health.version).toBe('0.1.0');
      expect(health.stats).toBeDefined();
      expect(health.stats.totalEntries).toBe(0);
    });

    it('should include stats in health', async () => {
      await broker.set('key', 'value', 60_000);

      const health = await broker.getHealth();
      expect(health.stats.totalEntries).toBe(1);
    });
  });

  describe('Cleanup on Stop', () => {
    it('should clear store on stop', async () => {
      await broker.set('key1', 'value1', 60_000);
      await broker.set('key2', 'value2', 60_000);

      const statsBefore = await broker.getStats();
      expect(statsBefore.totalEntries).toBe(2);

      await broker.stop();

      const statsAfter = await broker.getStats();
      expect(statsAfter.totalEntries).toBe(0);
    });

    it('should stop cleanup interval on stop', async () => {
      const cleanupSpy = vi.spyOn(global, 'clearInterval');

      await broker.stop();

      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle large values', async () => {
      const largeValue = { data: 'x'.repeat(1_000_000) }; // 1MB

      await broker.set('large', largeValue, 60_000);
      const result = await broker.get<{ data: string }>('large');

      expect(result?.data.length).toBe(1_000_000);
    });

    it('should handle special characters in keys', async () => {
      const specialKey = 'tenant:acme:mind:query-with-special-chars_123@#$';

      await broker.set(specialKey, 'value', 60_000);
      const result = await broker.get(specialKey);

      expect(result).toBe('value');
    });

    it('should handle null/undefined values', async () => {
      await broker.set('null-key', null, 60_000);
      await broker.set('undefined-key', undefined, 60_000);

      // null is stored as null
      expect(await broker.get('null-key')).toBeNull();

      // undefined is stored as undefined (not converted to null)
      expect(await broker.get('undefined-key')).toBeUndefined();
    });

    it('should handle concurrent operations', async () => {
      const promises = [];

      for (let i = 0; i < 100; i++) {
        promises.push(broker.set(`key-${i}`, `value-${i}`, 60_000));
      }

      await Promise.all(promises);

      const stats = await broker.getStats();
      expect(stats.totalEntries).toBe(100);
    });
  });
});
