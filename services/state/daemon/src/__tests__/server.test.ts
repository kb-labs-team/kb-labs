/**
 * Integration tests for StateDaemonServer
 *
 * Real HTTP server tests - no mocks, real requests, real timing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  checkCanonicalObservabilityMetrics,
  validateServiceObservabilityDescribe,
  validateServiceObservabilityHealth,
} from '@kb-labs/core-contracts';
import { StateDaemonServer } from '../server.js';

describe('StateDaemonServer', () => {
  let server: StateDaemonServer;
  const port = 9877;
  const baseURL = `http://localhost:${port}`;

  beforeAll(async () => {
    server = new StateDaemonServer({ port, host: 'localhost' });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe('Health Endpoints', () => {
    it('should return health status', async () => {
      const res = await fetch(`${baseURL}/health`);

      expect(res.status).toBe(200);
      const health = await res.json() as any;

      expect(health.status).toBe('ok');
      expect(health.version).toBe('0.1.0');
      expect(health.stats).toBeDefined();
      expect(health.stats.totalEntries).toBeGreaterThanOrEqual(0);
    });

    it('should return stats', async () => {
      const res = await fetch(`${baseURL}/stats`);

      expect(res.status).toBe(200);
      const stats = await res.json() as any;

      expect(stats.uptime).toBeGreaterThan(0);
      expect(stats.totalEntries).toBeGreaterThanOrEqual(0);
      expect(stats.hitRate).toBeGreaterThanOrEqual(0);
      expect(stats.namespaces).toBeDefined();
    });

    it('should expose versioned observability documents', async () => {
      const describeRes = await fetch(`${baseURL}/observability/describe`);
      expect(describeRes.status).toBe(200);
      const describe = await describeRes.json() as any;
      expect(describe.serviceId).toBe('state-daemon');
      expect(describe.contractVersion).toBe('1.0');
      expect(validateServiceObservabilityDescribe(describe).ok).toBe(true);

      const healthRes = await fetch(`${baseURL}/observability/health`);
      expect(healthRes.status).toBe(200);
      const observability = await healthRes.json() as any;
      expect(observability.serviceId).toBe('state-daemon');
      expect(observability.metricsEndpoint).toBe('/metrics');
      expect(observability.snapshot).toBeDefined();
      expect(validateServiceObservabilityHealth(observability).ok).toBe(true);
      expect(observability.topOperations.map((entry: { operation: string }) => entry.operation)).toEqual(
        expect.arrayContaining(['state.health', 'state.stats']),
      );
    });

    it('should return prometheus metrics', async () => {
      const res = await fetch(`${baseURL}/metrics`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(checkCanonicalObservabilityMetrics(body).missing).toEqual([]);
      expect(body).toContain('state_broker_entries_total');
    });
  });

  describe('State Operations', () => {
    it('should set and get value', async () => {
      const key = 'test-key';
      const value = { data: 'hello' };

      // Set
      const setRes = await fetch(`${baseURL}/state/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, ttl: 60_000 }),
      });

      expect(setRes.status).toBe(204);

      // Get
      const getRes = await fetch(`${baseURL}/state/${key}`);
      expect(getRes.status).toBe(200);

      const retrieved = await getRes.json() as any;
      expect(retrieved).toEqual(value);
    });

    it('should return 404 for non-existent key', async () => {
      const res = await fetch(`${baseURL}/state/non-existent`);
      expect(res.status).toBe(404);
    });

    it('should delete value', async () => {
      const key = 'delete-test';

      // Set
      await fetch(`${baseURL}/state/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'test', ttl: 60_000 }),
      });

      // Delete
      const deleteRes = await fetch(`${baseURL}/state/${key}`, {
        method: 'DELETE',
      });

      expect(deleteRes.status).toBe(204);

      // Verify deleted
      const getRes = await fetch(`${baseURL}/state/${key}`);
      expect(getRes.status).toBe(404);
    });

    it('should clear all entries', async () => {
      // Set multiple entries
      await fetch(`${baseURL}/state/key1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'v1', ttl: 60_000 }),
      });

      await fetch(`${baseURL}/state/key2`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'v2', ttl: 60_000 }),
      });

      // Clear all
      const clearRes = await fetch(`${baseURL}/state/clear`, {
        method: 'POST',
      });

      expect(clearRes.status).toBe(204);

      // Verify cleared
      expect((await fetch(`${baseURL}/state/key1`)).status).toBe(404);
      expect((await fetch(`${baseURL}/state/key2`)).status).toBe(404);
    });

    it('should clear entries by pattern', async () => {
      // Set entries
      await fetch(`${baseURL}/state/mind:query-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'v1', ttl: 60_000 }),
      });

      await fetch(`${baseURL}/state/mind:query-2`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'v2', ttl: 60_000 }),
      });

      await fetch(`${baseURL}/state/workflow:job-1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'v3', ttl: 60_000 }),
      });

      // Clear mind:* pattern
      const clearRes = await fetch(`${baseURL}/state/clear?pattern=${encodeURIComponent('mind:*')}`, {
        method: 'POST',
      });

      expect(clearRes.status).toBe(204);

      // Verify mind:* cleared
      expect((await fetch(`${baseURL}/state/mind:query-1`)).status).toBe(404);
      expect((await fetch(`${baseURL}/state/mind:query-2`)).status).toBe(404);

      // Verify workflow:* NOT cleared
      expect((await fetch(`${baseURL}/state/workflow:job-1`)).status).toBe(200);
    });
  });

  describe('TTL Expiration - Real Timing', () => {
    it('should expire entry after TTL', async () => {
      const key = 'short-lived';

      // Set with 200ms TTL
      await fetch(`${baseURL}/state/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'expires soon', ttl: 200 }),
      });

      // Immediately available
      let res = await fetch(`${baseURL}/state/${key}`);
      expect(res.status).toBe(200);

      // Wait for expiration
      await new Promise((resolve) => {
        setTimeout(resolve, 300);
      });

      // Should be expired
      res = await fetch(`${baseURL}/state/${key}`);
      expect(res.status).toBe(404);
    }, 5000);
  });

  describe('Special Characters in Keys', () => {
    it('should handle URL-encoded keys', async () => {
      const key = 'tenant:acme:mind:query-123@#$%^&*()';
      const encodedKey = encodeURIComponent(key);

      // Set
      await fetch(`${baseURL}/state/${encodedKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'special', ttl: 60_000 }),
      });

      // Get
      const res = await fetch(`${baseURL}/state/${encodedKey}`);
      expect(res.status).toBe(200);

      const value = await res.json() as any;
      expect(value).toBe('special');
    });

    it('should handle colon-separated keys', async () => {
      const key = 'tenant:default:mind:key';

      await fetch(`${baseURL}/state/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'namespaced', ttl: 60_000 }),
      });

      const res = await fetch(`${baseURL}/state/${encodeURIComponent(key)}`);
      expect(res.status).toBe(200);

      const value = await res.json() as any;
      expect(value).toBe('namespaced');
    });
  });

  describe('Large Payloads', () => {
    it('should handle large values', async () => {
      const largeValue = { data: 'x'.repeat(100_000) }; // ~100KB
      const key = 'large-payload';

      await fetch(`${baseURL}/state/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: largeValue, ttl: 60_000 }),
      });

      const res = await fetch(`${baseURL}/state/${key}`);
      expect(res.status).toBe(200);

      const retrieved = await res.json() as any;
      expect(retrieved.data.length).toBe(100_000);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent requests', async () => {
      const promises = [];

      for (let i = 0; i < 50; i++) {
        promises.push(
          fetch(`${baseURL}/state/concurrent-${i}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: `value-${i}`, ttl: 60_000 }),
          })
        );
      }

      const results = await Promise.all(promises);

      // All should succeed
      results.forEach(res => expect(res.status).toBe(204));

      // Verify all stored
      const stats = await fetch(`${baseURL}/stats`).then(r => r.json() as any);
      expect(stats.totalEntries).toBeGreaterThanOrEqual(50);
    });
  });

  describe('CORS Headers', () => {
    it('should include CORS headers', async () => {
      const res = await fetch(`${baseURL}/health`);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    });

    it('should handle OPTIONS preflight', async () => {
      const res = await fetch(`${baseURL}/health`, {
        method: 'OPTIONS',
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown endpoint', async () => {
      const res = await fetch(`${baseURL}/unknown`);
      expect(res.status).toBe(404);

      const body = await res.json() as any;
      expect(body.error).toBe('Not Found');
    });

    it('should handle malformed JSON', async () => {
      const res = await fetch(`${baseURL}/state/test`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json{',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.message ?? body.error).toBeDefined();
    });
  });

  describe('Statistics Tracking', () => {
    it('should track namespace stats', async () => {
      // Clear first
      await fetch(`${baseURL}/state/clear`, { method: 'POST' });

      // Add entries to different namespaces
      await fetch(`${baseURL}/state/ns1:key1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'v1', ttl: 60_000 }),
      });

      await fetch(`${baseURL}/state/ns1:key2`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'v2', ttl: 60_000 }),
      });

      await fetch(`${baseURL}/state/ns2:key1`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'v3', ttl: 60_000 }),
      });

      const stats = await fetch(`${baseURL}/stats`).then(r => r.json() as any);

      expect(stats.namespaces['ns1']).toBeDefined();
      expect(stats.namespaces['ns1'].entries).toBe(2);
      expect(stats.namespaces['ns2']).toBeDefined();
      expect(stats.namespaces['ns2'].entries).toBe(1);
    });

    it('should track hit/miss rates', async () => {
      // Clear first
      await fetch(`${baseURL}/state/clear`, { method: 'POST' });

      // Set a key
      await fetch(`${baseURL}/state/hitrate-test`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'test', ttl: 60_000 }),
      });

      // Hit (exists)
      await fetch(`${baseURL}/state/hitrate-test`);

      // Miss (doesn't exist)
      await fetch(`${baseURL}/state/miss-test`);

      const stats = await fetch(`${baseURL}/stats`).then(r => r.json() as any);

      expect(stats.hitRate).toBeGreaterThan(0);
      expect(stats.missRate).toBeGreaterThan(0);
      expect(stats.hitRate + stats.missRate).toBeCloseTo(1, 5);
    });
  });
});
