/**
 * Behavioural tests for DocumentLogPersistence.
 *
 * Uses the sqlite-backed document database as the backing store — same
 * contract any other driver would satisfy. If you swap the factory for
 * mongo or postgres-JSONB the assertions still hold.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSqliteDocumentDatabase } from '@kb-labs/adapters-sqlite';
import { DocumentLogPersistence } from '../index.js';
import type { LogRecord } from '@kb-labs/sdk/adapters';

const record = (over: Partial<LogRecord>): LogRecord => ({
  id: over.id ?? `log-${Math.random().toString(36).slice(2)}`,
  timestamp: over.timestamp ?? Date.now(),
  level: over.level ?? 'info',
  message: over.message ?? 'msg',
  fields: over.fields ?? {},
  source: over.source ?? 'test',
});

describe('DocumentLogPersistence (sqlite-backed)', () => {
  const docs = createSqliteDocumentDatabase({ filename: ':memory:', ttlSweepIntervalMs: 0 });
  let persistence: DocumentLogPersistence;

  beforeAll(async () => {
    persistence = new DocumentLogPersistence({
      documentDatabase: docs,
      collection: 'logs_test',
      batchSize: 5,
      flushInterval: 50,
      retention: { cleanupIntervalMs: 60_000 },
    });
  });

  afterAll(async () => {
    await persistence.close();
    await docs.close();
  });

  beforeEach(async () => {
    await docs.deleteMany('logs_test', {});
  });

  it('writes and reads back a single record by id', async () => {
    const rec = record({ id: 'log-x', message: 'hello world' });
    await persistence.write(rec);
    // Force flush by writing enough to exceed batchSize.
    for (let i = 0; i < 5; i++) {await persistence.write(record({ id: `pad-${i}` }));}
    await new Promise((r) => setTimeout(r, 100));
    const fetched = await persistence.getById('log-x');
    expect(fetched).not.toBeNull();
    expect(fetched!.message).toBe('hello world');
  });

  it('flushes buffered records at shutdown regardless of severity', async () => {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    const records = levels.map((level) => record({ id: `shutdown-${level}`, level }));
    const shutdownPersistence = new DocumentLogPersistence({
      documentDatabase: docs,
      collection: 'shutdown_logs_test',
      batchSize: 100,
      flushInterval: 60_000,
      retention: { cleanupIntervalMs: 60_000 },
    });
    await shutdownPersistence.writeBatch(records);

    await shutdownPersistence.close();

    const result = await shutdownPersistence.query({}, { limit: 100 });
    expect(result.logs.map((log) => log.id).sort()).toEqual(records.map((log) => log.id).sort());
  });

  // case: S-203.26
  it('makes an error record queryable before write resolves', async () => {
    const immediate = new DocumentLogPersistence({
      documentDatabase: docs,
      collection: 'error_visibility_test',
      batchSize: 100,
      flushInterval: 60_000,
      retention: { cleanupIntervalMs: 60_000 },
    });
    const correlationId = 'rest-error-correlation';
    try {
      await immediate.write(record({
        id: 'rest-error-log',
        level: 'error',
        message: 'Plugin handler failed',
        fields: { correlationId },
      }));

      const result = await immediate.query({ correlationId }, { limit: 10 });
      expect(result.logs).toContainEqual(expect.objectContaining({
        id: 'rest-error-log',
        level: 'error',
        fields: expect.objectContaining({ correlationId }),
      }));
    } finally {
      await immediate.close();
      await docs.deleteMany('error_visibility_test', {});
    }
  });

  it('flushes a concurrent error record after an in-flight batch', async () => {
    let releaseFirstInsert!: () => void;
    let signalFirstInsert!: () => void;
    const firstInsertStarted = new Promise<void>((resolve) => { signalFirstInsert = resolve; });
    const firstInsertReleased = new Promise<void>((resolve) => { releaseFirstInsert = resolve; });
    const originalInsertMany = docs.insertMany.bind(docs);
    let firstInsert = true;
    const insertSpy = vi.spyOn(docs, 'insertMany').mockImplementation(async (...args) => {
      if (firstInsert) {
        firstInsert = false;
        signalFirstInsert();
        await firstInsertReleased;
      }
      return originalInsertMany(...args);
    });
    const concurrent = new DocumentLogPersistence({
      documentDatabase: docs,
      collection: 'concurrent_error_visibility_test',
      batchSize: 1,
      flushInterval: 60_000,
      retention: { cleanupIntervalMs: 60_000 },
    });
    try {
      await concurrent.writeBatch([record({ id: 'in-flight-info' })]);
      await firstInsertStarted;
      const correlationId = 'concurrent-rest-error-correlation';
      const errorWrite = concurrent.write(record({
        id: 'concurrent-rest-error',
        level: 'error',
        fields: { correlationId },
      }));
      releaseFirstInsert();
      await errorWrite;

      const result = await concurrent.query({ correlationId }, { limit: 10 });
      expect(insertSpy).toHaveBeenCalledTimes(2);
      expect(result.logs.map((log) => log.id)).toContain('concurrent-rest-error');
    } finally {
      releaseFirstInsert();
      insertSpy.mockRestore();
      await concurrent.close();
      await docs.deleteMany('concurrent_error_visibility_test', {});
    }
  });

  it('writeBatch persists all entries', async () => {
    const batch = [
      record({ id: 'a', level: 'info', message: 'one' }),
      record({ id: 'b', level: 'warn', message: 'two' }),
      record({ id: 'c', level: 'error', message: 'three' }),
    ];
    await persistence.writeBatch(batch);
    await new Promise((r) => setTimeout(r, 120));
    const result = await persistence.query({}, { limit: 100 });
    expect(result.total).toBe(3);
  });

  it('query filters by minimum level', async () => {
    await persistence.writeBatch([
      record({ id: 'd1', level: 'debug', message: 'd' }),
      record({ id: 'i1', level: 'info', message: 'i' }),
      record({ id: 'w1', level: 'warn', message: 'w' }),
      record({ id: 'e1', level: 'error', message: 'e' }),
    ]);
    await new Promise((r) => setTimeout(r, 120));
    const result = await persistence.query({ level: 'warn' }, { limit: 100 });
    expect(result.logs.map((l) => l.id).sort()).toEqual(['e1', 'w1']);
  });

  it('search finds substring matches in message', async () => {
    await persistence.writeBatch([
      record({ id: '1', message: 'database connection lost' }),
      record({ id: '2', message: 'database OK' }),
      record({ id: '3', message: 'unrelated' }),
    ]);
    await new Promise((r) => setTimeout(r, 120));
    const result = await persistence.search('database');
    expect(result.total).toBe(2);
    expect(result.logs.map((l) => l.id).sort()).toEqual(['1', '2']);
  });

  it('search combines text and structured context filters', async () => {
    await persistence.writeBatch([
      record({ id: 'state', message: 'Service ready', fields: { serviceId: 'state-daemon' } }),
      record({ id: 'rest', message: 'Service ready', fields: { serviceId: 'rest' } }),
    ]);
    await new Promise((r) => setTimeout(r, 120));

    const result = await persistence.search('Service ready', {
      filters: { serviceId: 'state-daemon' },
    });

    expect(result.logs.map((log) => log.id)).toEqual(['state']);
  });

  it('deleteOlderThan removes ancient logs', async () => {
    const old = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const fresh = Date.now();
    await persistence.writeBatch([
      record({ id: 'old-1', timestamp: old }),
      record({ id: 'old-2', timestamp: old }),
      record({ id: 'fresh-1', timestamp: fresh }),
    ]);
    await new Promise((r) => setTimeout(r, 120));
    const removed = await persistence.deleteOlderThan(fresh - 60_000);
    expect(removed).toBe(2);
    const remaining = await persistence.query({}, { limit: 100 });
    expect(remaining.logs.map((l) => l.id)).toEqual(['fresh-1']);
  });

  it('deleteByLevelOlderThan respects level filter', async () => {
    const t = Date.now() - 60_000;
    await persistence.writeBatch([
      record({ id: 'd', level: 'debug', timestamp: t }),
      record({ id: 'i', level: 'info', timestamp: t }),
      record({ id: 'e', level: 'error', timestamp: t }),
    ]);
    await new Promise((r) => setTimeout(r, 120));
    const removed = await persistence.deleteByLevelOlderThan(['debug', 'trace'], Date.now());
    expect(removed).toBe(1);
    const survivors = await persistence.query({}, { limit: 100 });
    expect(survivors.logs.map((l) => l.id).sort()).toEqual(['e', 'i']);
  });

  it('getStats reports counts and bounds', async () => {
    const now = Date.now();
    await persistence.writeBatch([
      record({ id: 'a', timestamp: now - 1000 }),
      record({ id: 'b', timestamp: now }),
      record({ id: 'c', timestamp: now + 1000 }),
    ]);
    await new Promise((r) => setTimeout(r, 120));
    const stats = await persistence.getStats();
    expect(stats.totalLogs).toBe(3);
    expect(stats.oldestTimestamp).toBe(now - 1000);
    expect(stats.newestTimestamp).toBe(now + 1000);
  });
});

// ── Regression: createAdapter must wire deps.documentDatabase (bug fix) ──────

describe('createAdapter factory', () => {
  it('accepts documentDatabase via deps second argument (adapter-loader pattern)', async () => {
    // The adapter-loader always calls createAdapter(config, deps) — deps carries
    // adapter dependencies declared in the manifest requires.adapters array.
    // Before the fix, createAdapter ignored deps and config.documentDatabase was
    // undefined, causing `this.docs.ensureCollection` to throw on construction.
    const { createAdapter } = await import('../index.js');
    const db = createSqliteDocumentDatabase({ filename: ':memory:', ttlSweepIntervalMs: 0 });

    // Simulate what adapter-loader does: deps contains the resolved adapter
    const adapter = createAdapter({ collection: 'logs' } as any, {
      documentDatabase: db,
    });

    // If construction succeeded without throwing, the fix works
    expect(adapter).toBeDefined();
    await adapter.close();
  });

  it('falls back to config.documentDatabase when deps is absent', async () => {
    const { createAdapter } = await import('../index.js');
    const db = createSqliteDocumentDatabase({ filename: ':memory:', ttlSweepIntervalMs: 0 });

    // Direct usage (no loader) — documentDatabase in config as before
    const adapter = createAdapter({ collection: 'logs', documentDatabase: db });
    expect(adapter).toBeDefined();
    await adapter.close();
  });
});
