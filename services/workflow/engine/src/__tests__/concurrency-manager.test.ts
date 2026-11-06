import { describe, it, expect, beforeEach } from 'vitest';
import { ConcurrencyManager } from '../concurrency-manager.js';
import type { ICache } from '@kb-labs/core-platform';
import { mockLogger } from '@kb-labs/shared-testing';

class MockCache implements ICache {
  private store = new Map<string, any>();
  async get<T>(key: string): Promise<T | null> { return this.store.get(key) ?? null; }
  async set<T>(key: string, value: T): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async clear(): Promise<void> { this.store.clear(); }
  async has(key: string): Promise<boolean> { return this.store.has(key); }
  async zadd(): Promise<void> {}
  async zrangebyscore(): Promise<string[]> { return []; }
  async zrem(): Promise<void> {}
  async setIfNotExists<T>(key: string, value: T): Promise<boolean> {
    if (this.store.has(key)) { return false; }
    this.store.set(key, value);
    return true;
  }
  async getStats() { return { totalEntries: 0, totalSize: 0, hitRate: 0, missRate: 0, evictions: 0, status: 'ok' as const }; }
  async getHealth() { return { status: 'ok' as const }; }
  async stop() {}
}


describe('ConcurrencyManager', () => {
  let cache: MockCache;
  let mgr: ConcurrencyManager;

  beforeEach(() => {
    cache = new MockCache();
    mgr = new ConcurrencyManager(cache, mockLogger());
  });

  it('acquires lock for empty group', async () => {
    const acquired = await mgr.acquire('deploy', 'run-1');
    expect(acquired).toBe(true);
  });

  it('blocks second acquire on same group', async () => {
    await mgr.acquire('deploy', 'run-1');
    const second = await mgr.acquire('deploy', 'run-2');
    expect(second).toBe(false);
  });

  it('allows acquire after release', async () => {
    await mgr.acquire('deploy', 'run-1');
    await mgr.release('deploy', 'run-1');

    const acquired = await mgr.acquire('deploy', 'run-2');
    expect(acquired).toBe(true);
  });

  it('release only works for the holding runId', async () => {
    await mgr.acquire('deploy', 'run-1');

    // Wrong runId — should NOT release
    await mgr.release('deploy', 'run-wrong');

    const acquired = await mgr.acquire('deploy', 'run-2');
    expect(acquired).toBe(false); // still locked by run-1
  });

  it('getActiveRun returns the holding runId', async () => {
    await mgr.acquire('deploy', 'run-42');
    const active = await mgr.getActiveRun('deploy');
    expect(active).toBe('run-42');
  });

  it('getActiveRun returns null when no lock', async () => {
    const active = await mgr.getActiveRun('deploy');
    expect(active).toBeNull();
  });

  it('different groups are independent', async () => {
    const a = await mgr.acquire('group-a', 'run-1');
    const b = await mgr.acquire('group-b', 'run-2');

    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('release + re-acquire cycle works', async () => {
    await mgr.acquire('release-test', 'run-1');
    await mgr.release('release-test', 'run-1');
    await mgr.acquire('release-test', 'run-2');
    await mgr.release('release-test', 'run-2');
    const final = await mgr.acquire('release-test', 'run-3');
    expect(final).toBe(true);
  });
});
