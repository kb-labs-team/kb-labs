import { describe, it, expect, beforeEach } from 'vitest';
import { Scheduler, type JobQueueEntry } from '../scheduler.js';
import type { JobRun } from '@kb-labs/workflow-contracts';
import type { ICache } from '@kb-labs/core-platform';
import { mockLogger } from '@kb-labs/shared-testing';

// Reuse MockCache pattern from engine.test.ts
class MockCache implements ICache {
  private store = new Map<string, any>();
  lockAcquisitionAttempts = 0;

  async get<T>(key: string): Promise<T | null> { return this.store.get(key) ?? null; }
  async set<T>(key: string, value: T): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  async clear(): Promise<void> { this.store.clear(); }
  async has(key: string): Promise<boolean> { return this.store.has(key); }
  async zadd(key: string, score: number, member: string): Promise<void> {
    const zset = this.store.get(key) || [];
    zset.push({ score, member });
    this.store.set(key, zset);
  }
  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    const zset = this.store.get(key) || [];
    return zset
      .filter((item: any) => item.score >= min && item.score <= max)
      .sort((a: any, b: any) => a.score - b.score)
      .map((item: any) => item.member);
  }
  async zrem(key: string, member: string): Promise<void> {
    const zset = this.store.get(key) || [];
    this.store.set(key, zset.filter((item: any) => item.member !== member));
  }
  async setIfNotExists<T>(key: string, value: T): Promise<boolean> {
    this.lockAcquisitionAttempts++;
    if (this.store.has(key)) { return false; }
    this.store.set(key, value);
    return true;
  }
  async getStats() { return { totalEntries: 0, totalSize: 0, hitRate: 0, missRate: 0, evictions: 0, status: 'ok' as const }; }
  async getHealth() { return { status: 'ok' as const }; }
  async stop() {}
}


function makeJob(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: 'run-1:build',
    jobName: 'build',
    status: 'queued',
    steps: [],
    blocked: false,
    ...overrides,
  } as JobRun;
}

describe('Scheduler', () => {
  let cache: MockCache;
  let scheduler: Scheduler;

  beforeEach(() => {
    cache = new MockCache();
    scheduler = new Scheduler(cache, mockLogger());
  });

  // ── enqueueJob ───────────────────────────────────────────────────────

  it('enqueues a job to the correct priority queue', async () => {
    const job = makeJob();
    await scheduler.enqueueJob('run-1', job, 'high');

    const entries = await cache.zrangebyscore('kb:jobqueue:high', 0, Infinity);
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(entries[0]!) as JobQueueEntry;
    expect(entry.runId).toBe('run-1');
    expect(entry.jobId).toBe('run-1:build');
    expect(entry.priority).toBe('high');
  });

  it('skips blocked jobs', async () => {
    const job = makeJob({ blocked: true, pendingDependencies: ['setup'] });
    await scheduler.enqueueJob('run-1', job);

    const entries = await cache.zrangebyscore('kb:jobqueue:normal', 0, Infinity);
    expect(entries).toHaveLength(0);
  });

  // ── scheduleRun ──────────────────────────────────────────────────────

  it('schedules only ready (non-blocked) jobs', async () => {
    const run = {
      id: 'run-1',
      jobs: [
        makeJob({ id: 'run-1:setup', jobName: 'setup', blocked: false }),
        makeJob({ id: 'run-1:test', jobName: 'test', blocked: true, needs: ['setup'], pendingDependencies: ['setup'] }),
      ],
    } as any;

    await scheduler.scheduleRun(run);

    const normalQueue = await cache.zrangebyscore('kb:jobqueue:normal', 0, Infinity);
    expect(normalQueue).toHaveLength(1);
    const entry = JSON.parse(normalQueue[0]!) as JobQueueEntry;
    expect(entry.jobName).toBe('setup');
  });

  it('schedules multiple ready jobs in parallel', async () => {
    const run = {
      id: 'run-1',
      jobs: [
        makeJob({ id: 'run-1:lint', jobName: 'lint', blocked: false }),
        makeJob({ id: 'run-1:typecheck', jobName: 'typecheck', blocked: false }),
      ],
    } as any;

    await scheduler.scheduleRun(run);

    const entries = await cache.zrangebyscore('kb:jobqueue:normal', 0, Infinity);
    expect(entries).toHaveLength(2);
  });

  // ── dequeueJob ───────────────────────────────────────────────────────

  it('dequeues high priority jobs first', async () => {
    const lowJob = makeJob({ id: 'run-1:low', jobName: 'low' });
    const highJob = makeJob({ id: 'run-1:high', jobName: 'high' });

    await scheduler.enqueueJob('run-1', lowJob, 'low');
    await scheduler.enqueueJob('run-1', highJob, 'high');

    const first = await scheduler.dequeueJob();
    expect(first).not.toBeNull();
    expect(first!.jobName).toBe('high');

    const second = await scheduler.dequeueJob();
    expect(second).not.toBeNull();
    expect(second!.jobName).toBe('low');
  });

  it('returns null when queue is empty', async () => {
    const result = await scheduler.dequeueJob();
    expect(result).toBeNull();
  });

  // case: S-213.1
  it('does not acquire priority locks while repeatedly polling empty queues', async () => {
    for (let poll = 0; poll < 20; poll++) {
      expect(await scheduler.dequeueJob()).toBeNull();
    }

    expect(cache.lockAcquisitionAttempts).toBe(0);
  });

  it('removes dequeued entry from queue', async () => {
    const job = makeJob();
    await scheduler.enqueueJob('run-1', job, 'normal');

    await scheduler.dequeueJob();

    const remaining = await cache.zrangebyscore('kb:jobqueue:normal', 0, Infinity);
    expect(remaining).toHaveLength(0);
  });

  it('regression: N concurrent dequeueJob() calls against one populated queue ' +
    'return every entry exactly once — no duplicates, no losses. Without the ' +
    'lock around dequeueFromPriority, the read (zrangebyscore) and the remove ' +
    '(zrem) are two separate cache round-trips with an await in between, so ' +
    'two concurrent callers can both read the same top entry before either ' +
    'removes it — both then go on to process the same job. The daemon runs ' +
    'multiple instances/pods in production, so this is a live bug, not a ' +
    'theoretical one.', async () => {
    const jobCount = 8;
    for (let i = 0; i < jobCount; i++) {
      await scheduler.enqueueJob('run-1', makeJob({ id: `run-1:job-${i}`, jobName: `job-${i}` }), 'normal');
    }

    const results = await Promise.all(
      Array.from({ length: jobCount }, () => scheduler.dequeueJob()),
    );

    const jobIds = results.map((entry) => entry?.jobId).filter((id): id is string => id !== undefined);
    expect(jobIds).toHaveLength(jobCount);
    expect(new Set(jobIds).size).toBe(jobCount); // no duplicates

    const remaining = await cache.zrangebyscore('kb:jobqueue:normal', 0, Infinity);
    expect(remaining).toHaveLength(0); // no losses — every entry accounted for
  });

  // ── reschedule ───────────────────────────────────────────────────────

  it('reschedules with delay', async () => {
    const entry: JobQueueEntry = {
      id: 'entry-1',
      runId: 'run-1',
      jobId: 'run-1:build',
      jobName: 'build',
      priority: 'normal',
      enqueuedAt: new Date().toISOString(),
      availableAt: Date.now(),
    };

    await scheduler.reschedule(entry, 5000);

    const entries = await cache.zrangebyscore('kb:jobqueue:normal', 0, Infinity);
    expect(entries).toHaveLength(1);
    const rescheduled = JSON.parse(entries[0]!) as JobQueueEntry;
    expect(rescheduled.availableAt).toBeGreaterThan(Date.now() + 4000);
  });

  // ── getDefaultPriority ───────────────────────────────────────────────

  it('returns configured default priority', () => {
    expect(scheduler.getDefaultPriority()).toBe('normal');

    const highDefault = new Scheduler(cache, mockLogger(), { defaultPriority: 'high' });
    expect(highDefault.getDefaultPriority()).toBe('high');
  });
});
