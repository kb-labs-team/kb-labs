/**
 * In-memory state broker with TTL cleanup
 */

import type { StateBroker, BrokerStats, HealthStatus } from '../index';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
  size: number; // estimated size in bytes
  namespace: string;
}

export class InMemoryStateBroker implements StateBroker {
  private store = new Map<string, CacheEntry>();
  private cleanupInterval: NodeJS.Timeout;
  private startTime: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    private cleanupIntervalMs = 30_000 // cleanup every 30s
  ) {
    this.startTime = Date.now();
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttl = 300_000): Promise<void> {
    const namespace = this.extractNamespace(key);
    const size = this.estimateSize(value);

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl,
      size,
      namespace,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(pattern?: string): Promise<void> {
    if (!pattern) {
      this.store.clear();
      return;
    }

    // Simple pattern matching (namespace prefix)
    const prefix = pattern.replace('*', '');
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  async setIfNotExists<T>(key: string, value: T, ttl = 300_000): Promise<boolean> {
    const existing = this.store.get(key);
    if (existing && Date.now() <= existing.expiresAt) {
      return false;
    }
    await this.set(key, value, ttl);
    return true;
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    const entries = (await this.get<Array<{ score: number; member: string }>>(key)) ?? [];
    const next = entries.filter((entry) => entry.member !== member);
    next.push({ score, member });
    next.sort((left, right) => left.score - right.score || left.member.localeCompare(right.member));
    await this.set(key, next);
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    const entries = (await this.get<Array<{ score: number; member: string }>>(key)) ?? [];
    return entries.filter((entry) => entry.score >= min && entry.score <= max).map((entry) => entry.member);
  }

  async zrem(key: string, member: string): Promise<void> {
    const entries = (await this.get<Array<{ score: number; member: string }>>(key)) ?? [];
    await this.set(key, entries.filter((entry) => entry.member !== member));
  }

  async getStats(): Promise<BrokerStats> {
    const namespaces: Record<string, { entries: number; size: number; oldestEntry: number }> = {};
    const byTenant: Record<string, { entries: number; size: number; lastAccess: number }> = {};
    let totalSize = 0;
    const now = Date.now();

    for (const [key, entry] of this.store.entries()) {
      // Namespace stats (existing)
      if (!namespaces[entry.namespace]) {
        namespaces[entry.namespace] = { entries: 0, size: 0, oldestEntry: now };
      }

      const ns = namespaces[entry.namespace]!;
      ns.entries++;
      ns.size += entry.size;
      totalSize += entry.size;

      const entryAge = entry.expiresAt - now;
      if (entryAge < ns.oldestEntry) {
        ns.oldestEntry = entryAge;
      }

      // Tenant stats (new - multi-tenancy support)
      const tenant = this.extractTenant(key);
      if (!byTenant[tenant]) {
        byTenant[tenant] = { entries: 0, size: 0, lastAccess: now };
      }
      byTenant[tenant].entries++;
      byTenant[tenant].size += entry.size;
      if (entry.expiresAt > byTenant[tenant].lastAccess) {
        byTenant[tenant].lastAccess = entry.expiresAt;
      }
    }

    const totalRequests = this.hits + this.misses;
    const hitRate = totalRequests > 0 ? this.hits / totalRequests : 0;
    const missRate = totalRequests > 0 ? this.misses / totalRequests : 0;

    return {
      uptime: Date.now() - this.startTime,
      totalEntries: this.store.size,
      totalSize,
      hitRate,
      missRate,
      evictions: this.evictions,
      namespaces,
      byTenant, // ← New: stats by tenant
    };
  }

  async getHealth(): Promise<HealthStatus> {
    const stats = await this.getStats();
    return {
      status: 'ok',
      version: '0.1.0',
      stats,
    };
  }

  async stop(): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }

  protected hasLiveEntry(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  protected snapshotEntries(): Array<{ key: string; value: unknown; expiresAt: number }> {
    const now = Date.now();
    return [...this.store].flatMap(([key, entry]) => entry.expiresAt < now
      ? []
      : [{ key, value: entry.value, expiresAt: entry.expiresAt }]);
  }

  /**
   * Cleanup expired entries
   */
  private cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        this.evictions++;
      }
    }
  }

  /**
   * Extract namespace from key (format: namespace:key or tenant:tenantId:namespace:key)
   */
  private extractNamespace(key: string): string {
    const parts = key.split(':');
    // New format: tenant:default:mind:key → namespace: mind
    // Old format: mind:key → namespace: mind
    if (parts[0] === 'tenant' && parts.length >= 3) {
      return parts[2] || 'default';
    }
    return parts[0] || 'default';
  }

  /**
   * Extract tenant ID from key (format: tenant:tenantId:namespace:key)
   * For backward compatibility, returns 'default' if no tenant prefix
   */
  private extractTenant(key: string): string {
    const parts = key.split(':');
    // New format: tenant:default:mind:key → tenant: default
    // Old format: mind:key → tenant: default (backward compatible)
    if (parts[0] === 'tenant' && parts.length >= 2) {
      return parts[1] || 'default';
    }
    return 'default';
  }

  /**
   * Estimate size of value in bytes
   */
  private estimateSize(value: unknown): number {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }
}
