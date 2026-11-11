/**
 * @module @kb-labs/shared-testing/mock-cache
 *
 * In-memory cache mock that actually stores data (unlike noop mocks).
 * All methods are vi.fn() spies for assertion.
 *
 * @example
 * ```typescript
 * const cache = mockCache();
 * await cache.set('key', { data: 42 }, 5000);
 * expect(await cache.get('key')).toEqual({ data: 42 });
 * expect(cache.set).toHaveBeenCalledWith('key', { data: 42 }, 5000);
 * ```
 */

import { vi } from 'vitest';
import type { ICache } from '@kb-labs/core-platform';

interface CacheEntry {
  value: unknown;
  expiresAt: number | null; // null = no TTL
}

interface SortedSetMember {
  score: number;
  member: string;
}

/**
 * Mock cache instance with working in-memory storage.
 * All methods are vi.fn() spies.
 */
export interface MockCacheInstance extends ICache {
  /** Direct access to the internal store (for assertions) */
  readonly store: Map<string, CacheEntry>;
  /** Direct access to sorted sets (for assertions) */
  readonly sortedSets: Map<string, SortedSetMember[]>;
  /** Reset all data and spy call history */
  reset: () => void;
}

/**
 * Create a mock cache with working in-memory storage.
 *
 * Unlike noop mocks, this cache actually stores and retrieves data,
 * respects TTL, and supports sorted set operations.
 *
 * @param initial - Optional initial data to populate the cache
 *
 * @example
 * ```typescript
 * // Empty cache
 * const cache = mockCache();
 *
 * // Pre-populated cache
 * const cache = mockCache({ 'user:1': { name: 'Alice' } });
 *
 * // TTL works
 * await cache.set('temp', 'value', 100); // expires in 100ms
 * await new Promise(r => setTimeout(r, 150));
 * expect(await cache.get('temp')).toBeNull(); // expired
 * ```
 */
export function mockCache(initial?: Record<string, unknown>): MockCacheInstance {
  const store = new Map<string, CacheEntry>();
  const sortedSets = new Map<string, SortedSetMember[]>();

  // Populate initial data
  if (initial) {
    for (const [key, value] of Object.entries(initial)) {
      store.set(key, { value, expiresAt: null });
    }
  }

  function isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt !== null && Date.now() > entry.expiresAt;
  }

  // Keep raw vi.fn() references for mockClear() in reset.
  // The ICache-typed versions are cast below for the public interface.
  const spies: ReturnType<typeof vi.fn>[] = [];


  function spy<T extends (...args: any[]) => unknown>(fn: T): T {
    const s = vi.fn(fn) as unknown as T;
    spies.push(s as unknown as ReturnType<typeof vi.fn>);
    return s;
  }

  const getFn = spy(async (key: string): Promise<unknown> => {
    const entry = store.get(key);
    if (!entry || isExpired(entry)) {
      if (entry) {store.delete(key);} // cleanup expired
      return null;
    }
    return entry.value;
  });

  const setFn = spy(async (key: string, value: unknown, ttl?: number): Promise<void> => {
    store.set(key, {
      value,
      expiresAt: ttl ? Date.now() + ttl : null,
    });
  });

  const deleteFn = spy(async (key: string): Promise<void> => {
    store.delete(key);
  });

  const clearFn = spy(async (pattern?: string): Promise<void> => {
    if (!pattern) {
      store.clear();
      return;
    }
    // Simple glob matching: only support trailing *
    const prefix = pattern.replace(/\*$/, '');
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) {
        store.delete(key);
      }
    }
  });

  const zaddFn = spy(async (key: string, score: number, member: string): Promise<void> => {
    if (!sortedSets.has(key)) {sortedSets.set(key, []);}
    const set = sortedSets.get(key)!;
    // Remove existing member
    const idx = set.findIndex(m => m.member === member);
    if (idx >= 0) {set.splice(idx, 1);}
    // Add with new score
    set.push({ score, member });
    // Keep sorted by score
    set.sort((a, b) => a.score - b.score);
  });

  const zrangebyscoreFn = spy(async (key: string, min: number, max: number): Promise<string[]> => {
    const set = sortedSets.get(key);
    if (!set) {return [];}
    return set
      .filter(m => m.score >= min && m.score <= max)
      .map(m => m.member);
  });

  const zremFn = spy(async (key: string, member: string): Promise<void> => {
    const set = sortedSets.get(key);
    if (!set) {return;}
    const idx = set.findIndex(m => m.member === member);
    if (idx >= 0) {set.splice(idx, 1);}
  });

  const setIfNotExistsFn = spy(async (key: string, value: unknown, ttl?: number): Promise<boolean> => {
    const existing = store.get(key);
    if (existing && !isExpired(existing)) {return false;}
    store.set(key, {
      value,
      expiresAt: ttl ? Date.now() + ttl : null,
    });
    return true;
  });

  const instance: MockCacheInstance = {
    get: getFn as unknown as ICache['get'],
    set: setFn as unknown as ICache['set'],
    delete: deleteFn,
    clear: clearFn,
    zadd: zaddFn,
    zrangebyscore: zrangebyscoreFn,
    zrem: zremFn,
    setIfNotExists: setIfNotExistsFn as unknown as ICache['setIfNotExists'],
    get store() { return store; },
    get sortedSets() { return sortedSets; },
    reset: () => {
      store.clear();
      sortedSets.clear();
      for (const s of spies) {s.mockClear();}
    },
  };

  return instance;
}
