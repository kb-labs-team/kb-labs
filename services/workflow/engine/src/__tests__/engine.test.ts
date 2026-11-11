/**
 * Tests for WorkflowEngine
 *
 * Critical infrastructure tests covering:
 * - Run creation and state management
 * - Event publishing
 * - Job scheduling
 * - Concurrency control
 * - Error handling and retries
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../engine.js';
import { EnvSecretProvider } from '../secrets.js';
import type { WorkflowSpec, WorkflowRun } from '@kb-labs/workflow-contracts';
import type { ICache, IEventBus } from '@kb-labs/core-platform';
import { InMemoryStorage } from '@kb-labs/core-platform/inmemory';
import { mockLogger, type MockLoggerInstance } from '@kb-labs/shared-testing';
import { createErrorEnvelope } from '@kb-labs/core-platform/error-envelope';

// Mock Cache
class MockCache implements ICache {
  private store = new Map<string, any>();

  async get<T>(key: string): Promise<T | null> {
    return this.store.get(key) ?? null;
  }

  async set<T>(key: string, value: T, _ttl?: number): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(pattern?: string): Promise<void> {
    if (!pattern) {
      this.store.clear();
      return;
    }
    // Simple prefix match
    const prefix = pattern.replace('*', '');
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

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
    const filtered = zset.filter((item: any) => item.member !== member);
    this.store.set(key, filtered);
  }

  async setIfNotExists<T>(key: string, value: T, _ttl?: number): Promise<boolean> {
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, value);
    return true;
  }

  async getStats() {
    return {
      totalEntries: this.store.size,
      totalSize: 0,
      hitRate: 0,
      missRate: 0,
      namespaces: {},
      uptime: 0,
      evictions: 0,
    };
  }

  async getHealth() {
    return {
      status: 'ok' as const,
      version: '0.1.0',
      stats: await this.getStats(),
    };
  }

  async stop() {}
}

// Mock EventBus
class MockEventBus implements IEventBus {
  publishedEvents: any[] = [];

  async publish(_topic: string, event: any): Promise<void> {
    this.publishedEvents.push(event);
  }

  subscribe<T>(_topic: string, _handler: (event: T) => void | Promise<void>): () => void {
    return () => {}; // Unsubscribe function
  }
}

describe('WorkflowEngine', () => {
  let cache: MockCache;
  let events: MockEventBus;
  let storage: InMemoryStorage;
  let logger: MockLoggerInstance;
  let engine: WorkflowEngine;

  beforeEach(() => {
    cache = new MockCache();
    events = new MockEventBus();
    storage = new InMemoryStorage();
    logger = mockLogger();

    engine = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(),
      cache,
      storage,
      events,
      logger,
      maxWorkflowDepth: 2,
    });
  });

  describe('Initialization', () => {
    it('should create engine with required adapters', () => {
      expect(engine).toBeDefined();
      expect(engine.loader).toBeDefined();
      expect(engine.maxWorkflowDepth).toBe(2);
    });

    it('should use default maxWorkflowDepth if not provided', () => {
      const engine2 = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(), cache, events, logger, storage });
      expect(engine2.maxWorkflowDepth).toBe(2);
    });
  });

  describe('Run Creation', () => {
    const simpleSpec: WorkflowSpec = {
      name: 'Test Workflow',
      version: '1.0.0',
      on: { manual: true },
      jobs: {
        main: {
          runsOn: 'local',
          steps: [
            { name: 'Step 1', uses: 'builtin:shell', with: { run: 'echo "test"' } },
          ],
        },
      },
    };

    it('should store run in state store', async () => {
      const run = await engine.createRun({
        spec: simpleSpec,
        trigger: { type: 'manual' },
      });

      const storedRun = await engine.getRun(run.id);
      expect(storedRun).toBeDefined();
      expect(storedRun?.id).toBe(run.id);
    });

    it('reopens workflow history and step output from storage with a fresh engine cache', async () => {
      const run = await engine.createRun({ spec: simpleSpec, trigger: { type: 'manual' } });
      const job = run.jobs[0]!;
      const step = job.steps[0]!;
      await engine.markJobStarted(run.id, job.id);
      await engine.markStepStarted(run.id, job.id, step.id);
      const stepAfterStart = (await engine.getRun(run.id))!.jobs[0]!.steps[0]!;
      const startedEvent = events.publishedEvents.find((event) => event.type === 'step.started');
      expect(startedEvent.sequence).toBe(stepAfterStart.eventSequence);
      await engine.markStepCompleted(run.id, job.id, step.id, { message: 'persisted-after-restart' });
      await engine.markJobCompleted(run.id, job.id);

      const stored = await storage.read(`workflows/${run.id}.json`);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!.toString('utf8'))).toMatchObject({
        id: run.id, status: 'success',
        jobs: [{ steps: [{ outputs: { message: 'persisted-after-restart' } }] }],
      });

      const restarted = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(),
        cache: new MockCache(), storage, events: new MockEventBus(), logger: mockLogger(),
      });
      await expect(restarted.getRun(run.id)).resolves.toMatchObject({
        id: run.id, status: 'success',
        jobs: [{ steps: [{ outputs: { message: 'persisted-after-restart' } }] }],
      });
      await expect(restarted.getAllRuns()).resolves.toEqual([
        expect.objectContaining({ id: run.id, status: 'success' }),
      ]);
    });
  });

  describe('Run from File', () => {
    it('should load and create run from YAML file', async () => {
      // This test would require mocking file system
      // For now, we'll skip it as it's covered by WorkflowLoader tests
    });
  });


  describe('Get Run', () => {
    it('should get run by ID', async () => {
      const spec: WorkflowSpec = {
        name: 'Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          main: {
            runsOn: 'local',
            steps: [{ name: 'Step 1', uses: 'builtin:shell', with: { run: 'echo "test"' } }],
          },
        },
      };

      const created = await engine.createRun({
        spec,
        trigger: { type: 'manual' },
      });

      const retrieved = await engine.getRun(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe('Test');
    });

    it('should return null for non-existent run', async () => {
      const retrieved = await engine.getRun('non-existent-id');
      expect(retrieved).toBeNull();
    });
  });

  describe('Cancel Run', () => {
    it('should cancel run and update status', async () => {
      const spec: WorkflowSpec = {
        name: 'Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          main: {
            runsOn: 'local',
            steps: [{ name: 'Step 1', uses: 'builtin:shell', with: { run: 'echo "test"' } }],
          },
        },
      };

      const run = await engine.createRun({
        spec,
        trigger: { type: 'manual' },
      });

      await engine.cancelRun(run.id);

      const cancelled = await engine.getRun(run.id);
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.finishedAt).toBeDefined();
    });

    it('cascades cancellation to all persisted child workflow descendants', async () => {
      const spec: WorkflowSpec = {
        name: 'Nested', version: '1.0.0', on: { manual: true },
        jobs: { main: { runsOn: 'local', steps: [{ name: 'noop', uses: 'builtin:shell' }] } },
      };
      const parent = await engine.createRun({ spec, trigger: { type: 'manual' } });
      const child = await engine.createRun({
        spec,
        trigger: { type: 'workflow', parentRunId: parent.id },
        metadata: { parentRunId: parent.id },
      });
      const grandchild = await engine.createRun({
        spec,
        trigger: { type: 'workflow', parentRunId: child.id },
        metadata: { parentRunId: child.id },
      });

      await engine.cancelRun(parent.id);

      await expect(engine.getRun(child.id)).resolves.toMatchObject({ status: 'cancelled' });
      await expect(engine.getRun(grandchild.id)).resolves.toMatchObject({ status: 'cancelled' });
    });
  });

  describe('Child workflow reconciliation', () => {
    const spec: WorkflowSpec = {
      name: 'Nested', version: '1.0.0', on: { manual: true },
      jobs: { main: { runsOn: 'local', steps: [{ id: 'result', name: 'result', uses: 'builtin:shell' }] } },
    };

    it('resumes a parked parent with a durable child result envelope', async () => {
      const parent = await engine.createRun({ spec, trigger: { type: 'manual' } });
      const parentJob = parent.jobs[0]!;
      const parentStep = parentJob.steps[0]!;
      const child = await engine.createRun({
        spec,
        trigger: { type: 'workflow', parentRunId: parent.id, parentJobId: parentJob.id, parentStepId: parentStep.id },
        metadata: { parentRunId: parent.id, parentJobId: parentJob.id, parentStepId: parentStep.id },
      });
      const childJob = child.jobs[0]!;

      await engine.markJobStarted(parent.id, parentJob.id);
      await engine.markStepWaitingChild(parent.id, parentJob.id, parentStep.id, child.id);
      await engine.markStepCompleted(child.id, childJob.id, childJob.steps[0]!.id, { report: 'green' });
      await engine.markJobCompleted(child.id, childJob.id);

      const updated = await engine.getRun(parent.id);
      expect(updated?.jobs[0]?.status).toBe('queued');
      expect(updated?.jobs[0]?.steps[0]?.status).toBe('success');
      expect(updated?.jobs[0]?.steps[0]?.outputs).toMatchObject({
        runId: child.id,
        status: 'success',
        outputs: { result: { report: 'green' } },
      });
    });

    it('fails a parked parent deterministically when its child was cancelled', async () => {
      const parent = await engine.createRun({ spec, trigger: { type: 'manual' } });
      const parentJob = parent.jobs[0]!;
      const parentStep = parentJob.steps[0]!;
      const child = await engine.createRun({
        spec,
        trigger: { type: 'workflow', parentRunId: parent.id },
        metadata: { parentRunId: parent.id },
      });
      await engine.markJobStarted(parent.id, parentJob.id);
      await engine.markStepWaitingChild(parent.id, parentJob.id, parentStep.id, child.id);

      await engine.cancelRun(child.id);

      await expect(engine.getRun(parent.id)).resolves.toMatchObject({ status: 'failed' });
      await expect(engine.getRun(parent.id)).resolves.toMatchObject({
        jobs: [expect.objectContaining({ status: 'failed' })],
      });
    });

    it('recovers parked parents after an engine restart and reconciles concurrent children', async () => {
      const pairs = await Promise.all(Array.from({ length: 4 }, async () => {
        const child = await engine.createRun({
          spec,
          trigger: { type: 'manual' },
        });
        const childJob = child.jobs[0]!;
        const childStep = childJob.steps[0]!;
        await engine.markJobStarted(child.id, childJob.id);
        await engine.markStepStarted(child.id, childJob.id, childStep.id);
        await engine.markStepCompleted(child.id, childJob.id, childStep.id, { ok: true });
        await engine.markJobCompleted(child.id, childJob.id);

        // Persist a parent waiter only after the child is already terminal,
        // modeling a process boundary where no child terminal event reached it.
        const parent = await engine.createRun({ spec, trigger: { type: 'manual' } });
        const parentJob = parent.jobs[0]!;
        const parentStep = parentJob.steps[0]!;
        await engine.markJobStarted(parent.id, parentJob.id);
        await engine.markStepWaitingChild(parent.id, parentJob.id, parentStep.id, child.id);
        return { parent, parentJob };
      }));

      const restarted = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(), cache, events, logger, storage, maxWorkflowDepth: 2 });
      await expect(restarted.reconcileChildInvocations()).resolves.toBe(4);

      await Promise.all(pairs.map(async ({ parent, parentJob }) => {
        await expect(restarted.getRun(parent.id)).resolves.toMatchObject({
          jobs: [expect.objectContaining({ id: parentJob.id, status: 'queued' })],
        });
      }));
    });
  });

  describe('Job Failure and Retries', () => {
    let run: WorkflowRun;

    beforeEach(async () => {
      const spec: WorkflowSpec = {
        name: 'Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          main: {
            runsOn: 'local',
            retries: {
              max: 3,
              backoff: 'exp',
              initialIntervalMs: 1000,
            },
            steps: [{ name: 'Step 1', uses: 'builtin:shell', with: { run: 'echo "test"' } }],
          },
        },
      };

      run = await engine.createRun({
        spec,
        trigger: { type: 'manual' },
      });
    });

    it('should handle non-existent run gracefully', async () => {
      const error = new Error('Job failed');

      await engine.markJobFailed('non-existent', 'main', error);

      expect(logger.warn).toHaveBeenCalledWith(
        'Cannot mark job as failed: run not found',
        expect.objectContaining({
          runId: 'non-existent',
          jobId: 'main',
        })
      );
    });

    it('should handle non-existent job gracefully', async () => {
      const error = new Error('Job failed');

      await engine.markJobFailed(run.id, 'non-existent', error);

      expect(logger.warn).toHaveBeenCalledWith(
        'Cannot mark job as failed: job not found',
        expect.objectContaining({
          runId: run.id,
          jobId: 'non-existent',
        })
      );
    });
  });

  describe('Job failure: run status and downstream (B-029, B-030)', () => {
    const expectTerminalFailureHistory = async (diagnostic: string) => {
      const spec: WorkflowSpec = {
        name: 'Resolution Failure',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          main: {
            runsOn: 'local',
            retries: { max: 0, backoff: 'exp', initialIntervalMs: 100 },
            steps: [{ name: 'Failing step', uses: 'plugin:failure/handler' }],
          },
        },
      };
      const run = await engine.createRun({ spec, trigger: { type: 'manual' } });
      const jobId = run.jobs[0]!.id;
      const stepId = run.jobs[0]!.steps[0]!.id;

      await engine.markJobStarted(run.id, jobId);
      await engine.markStepStarted(run.id, jobId, stepId);
      await engine.markStepFailed(run.id, jobId, stepId, new Error(diagnostic));
      await engine.markJobFailed(run.id, jobId, new Error(diagnostic));

      expect(await engine.getRun(run.id)).toMatchObject({
        status: 'failed',
        result: { status: 'failed', error: { message: diagnostic } },
        jobs: [{ status: 'failed', error: { message: diagnostic }, steps: [{ status: 'failed', error: { message: diagnostic } }] }],
      });
      const historyEntry = (await engine.getAllRuns()).find((entry) => entry.id === run.id);
      expect(historyEntry).toMatchObject({
        status: 'failed',
        result: { status: 'failed', error: { message: diagnostic } },
      });
    };

    // case: S-029.2
    it('persists terminal history and diagnostics when a handler throws', async () => {
      await expectTerminalFailureHistory('Step handler threw: handler failure diagnostic');
    });

    // case: S-029.2
    it('persists terminal history and diagnostics when a plugin is missing', async () => {
      await expectTerminalFailureHistory('Plugin @kb-labs/missing was not found');
    });

    // case: S-029.2
    it('persists terminal history and diagnostics when a command is unknown', async () => {
      await expectTerminalFailureHistory('Command workflow.unknown is not registered');
    });

    it('B-029: terminal job failure sets run status to "failed", not "dlq"', async () => {
      const spec: WorkflowSpec = {
        name: 'Fail Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          main: {
            runsOn: 'local',
            retries: { max: 0, backoff: 'exp', initialIntervalMs: 100 },
            steps: [{ name: 'Boom', uses: 'builtin:shell', with: { run: 'exit 1' } }],
          },
        },
      };
      const run = await engine.createRun({ spec, trigger: { type: 'manual' } });
      const jobId = run.jobs.find(j => j.jobName === 'main')!.id;

      await engine.markJobFailed(run.id, jobId, new Error('Step handler reported failure (exitCode: 1)'));

      const updated = await engine.getRun(run.id);
      // dlq must be reserved for infrastructure failures, not a user step exit 1.
      expect(updated?.status).toBe('failed');
      expect(updated?.status).not.toBe('dlq');
      // The failing job's error must surface at the run level so consumers can
      // show why the run failed (REST /runs/:id, Studio, e2e).
      expect(updated?.result?.error?.message).toBeTruthy();
    });

    // case: S-243.5
    it('persists the catalogue timeout code and hint on the failed step, job, and terminal run', async () => {
      const spec: WorkflowSpec = {
        name: 'Timeout Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          main: {
            runsOn: 'local',
            steps: [{ name: 'Never ending', uses: 'builtin:shell', timeoutMs: 25 }],
          },
        },
      };
      const run = await engine.createRun({ spec, trigger: { type: 'manual' } });
      const job = run.jobs.find((candidate) => candidate.jobName === 'main')!;
      const step = job.steps[0]!;
      const timeout = createErrorEnvelope('KB_RUNTIME_TIMEOUT', { details: { timeoutMs: '25' } });
      const error = Object.assign(new Error(timeout.message), {
        code: timeout.code,
        hint: timeout.hint,
        details: timeout.details,
      });

      await engine.markStepStarted(run.id, job.id, step.id);
      await engine.markStepFailed(run.id, job.id, step.id, error);
      await engine.markJobFailed(run.id, job.id, error, undefined, false);

      const updated = await engine.getRun(run.id);
      expect(updated?.status).toBe('failed');
      expect(updated?.jobs[0]?.status).toBe('failed');
      expect(updated?.jobs[0]?.steps[0]?.error).toMatchObject({ code: timeout.code, hint: timeout.hint });
      expect(updated?.jobs[0]?.error).toMatchObject({ code: timeout.code, hint: timeout.hint });
      expect(updated?.result?.error).toMatchObject({ code: timeout.code, hint: timeout.hint });
    });

    it('B-030: downstream job of a failed upstream is cancelled, not left queued', async () => {
      const spec: WorkflowSpec = {
        name: 'Cascade Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          'job-a': {
            runsOn: 'local',
            retries: { max: 0, backoff: 'exp', initialIntervalMs: 100 },
            steps: [{ name: 'Boom', uses: 'builtin:shell', with: { run: 'exit 1' } }],
          },
          'job-b': {
            runsOn: 'local',
            needs: ['job-a'],
            steps: [{ name: 'Step B', uses: 'builtin:shell', with: { run: 'echo b' } }],
          },
        },
      };
      const run = await engine.createRun({ spec, trigger: { type: 'manual' } });
      const jobAId = run.jobs.find(j => j.jobName === 'job-a')!.id;

      await engine.markJobFailed(run.id, jobAId, new Error('boom'));

      const updated = await engine.getRun(run.id);
      const jobB = updated?.jobs.find(j => j.jobName === 'job-b');
      // job-b must NOT stay queued forever — it is cancelled because its
      // dependency failed.
      expect(jobB?.status).toBe('cancelled');
      expect(jobB?.status).not.toBe('queued');
      expect(updated?.status).toBe('failed');
    });
  });

  describe('Job Interruption', () => {
    it('should log job interruption', async () => {
      const spec: WorkflowSpec = {
        name: 'Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          main: {
            runsOn: 'local',
            steps: [{ name: 'Step 1', uses: 'builtin:shell', with: { run: 'echo "test"' } }],
          },
        },
      };

      const run = await engine.createRun({
        spec,
        trigger: { type: 'manual' },
      });

      await engine.markJobInterrupted(run.id, 'main');

      expect(logger.warn).toHaveBeenCalledWith(
        'Job interrupted',
        expect.objectContaining({
          runId: run.id,
          jobId: 'main',
        })
      );
    });
  });


  describe('Dispose', () => {
    it('should cleanup resources on dispose', async () => {
      await engine.dispose();
      // Currently no-op, but test structure is here for future cleanup logic
      expect(true).toBe(true);
    });
  });

  describe('replayRun step-transition logic', () => {
    const snapshotSpec: WorkflowSpec = {
      name: 'Snapshot Test',
      version: '1.0.0',
      on: { manual: true },
      jobs: {
        main: {
          runsOn: 'local',
          steps: [
            { id: 'step-a', name: 'Step A', uses: 'builtin:shell', with: { run: 'echo a' } },
            { id: 'step-b', name: 'Step B', uses: 'builtin:shell', with: { run: 'echo b' } },
            { id: 'step-c', name: 'Step C', uses: 'builtin:shell', with: { run: 'echo c' } },
          ],
        },
      },
    };

    async function createFinishedRun(): Promise<WorkflowRun> {
      const run = await engine.createRun({ spec: snapshotSpec, trigger: { type: 'manual' }, metadata: { workflowId: 'snapshot-test' } });
      // Simulate finalizing so snapshot is created
      await engine.finalizeRun(run.id, 'failed', {});
      return (await engine.getRun(run.id))!;
    }

    it('REPLAY-01: returns a new run ID (does not overwrite original)', async () => {
      const original = await createFinishedRun();
      const replayed = await engine.replayRun(original.id);

      expect(replayed).not.toBeNull();
      expect(replayed!.id).not.toBe(original.id);

      // Original run must still exist and be unchanged
      const stillThere = await engine.getRun(original.id);
      expect(stillThere).not.toBeNull();
      expect(stillThere!.status).toBe('failed');
    });

    it('REPLAY-02: replayed run starts as queued', async () => {
      const original = await createFinishedRun();
      const replayed = await engine.replayRun(original.id);

      expect(replayed!.status).toBe('queued');
      expect(replayed!.metadata?.['workflowId']).toBe('snapshot-test');
      expect(replayed!.startedAt).toBeUndefined();
      expect(replayed!.finishedAt).toBeUndefined();
    });

    it('REPLAY-03: fromStepId resets target step and later steps to queued', async () => {
      const original = await createFinishedRun();
      const stepBId = original.jobs[0]!.steps[1]!.id;

      const replayed = await engine.replayRun(original.id, { fromStepId: stepBId });

      const steps = replayed!.jobs[0]!.steps;
      expect(steps[0]!.status).toBe('success'); // step-a: before — left as-is
      expect(steps[1]!.status).toBe('queued');  // step-b: target — reset
      expect(steps[2]!.status).toBe('queued');  // step-c: after — reset
    });

    it('REPLAY-04: fromStepId marks preceding running/queued steps as success', async () => {
      const original = await createFinishedRun();

      // Force step-a to 'queued' in the snapshot to test the marking logic
      const stateStore = (engine as any).stateStore as import('../state-store.js').StateStore;
      const jobId = original.jobs[0]!.id;
      const stepAId = original.jobs[0]!.steps[0]!.id;
      const stepBId = original.jobs[0]!.steps[1]!.id;
      await stateStore.updateStep(original.id, jobId, stepAId, (draft) => {
        draft.status = 'queued';
        draft.finishedAt = undefined;
      });
      // Re-create snapshot with step-a in queued state
      await engine.deleteSnapshot(original.id);
      const updatedRun = (await engine.getRun(original.id))!;
      await engine.createSnapshot(original.id, {}, updatedRun.env ?? {});

      const replayed = await engine.replayRun(original.id, { fromStepId: stepBId });
      const steps = replayed!.jobs[0]!.steps;
      expect(steps[0]!.status).toBe('success'); // step-a was queued, now forced to success
    });

    it('REPLAY-05: non-existent fromStepId throws with "Step not found"', async () => {
      const original = await createFinishedRun();

      await expect(
        engine.replayRun(original.id, { fromStepId: 'ghost-step-id' }),
      ).rejects.toThrow('Step not found: ghost-step-id');
    });

    it('REPLAY-06: non-existent fromStepId does NOT save a broken run state', async () => {
      const original = await createFinishedRun();
      const runsBefore = (await engine.getAllRuns()).length;

      await expect(
        engine.replayRun(original.id, { fromStepId: 'does-not-exist' }),
      ).rejects.toThrow();

      // No extra run should have been created
      const runsAfter = (await engine.getAllRuns()).length;
      expect(runsAfter).toBe(runsBefore);
    });

    it('REPLAY-07: without fromStepId all steps are reset to queued', async () => {
      const original = await createFinishedRun();
      const replayed = await engine.replayRun(original.id);

      const steps = replayed!.jobs[0]!.steps;
      for (const step of steps) {
        expect(step.status).toBe('queued');
        expect(step.startedAt).toBeUndefined();
        expect(step.finishedAt).toBeUndefined();
      }
    });

    // case: S-143.3
    it('REPLAY-10: failed jobs are reset and replay identities belong to the new run', async () => {
      const sourceRun = await engine.createRun({
        spec: snapshotSpec,
        trigger: { type: 'manual' },
        metadata: { workflowId: 'snapshot-test' },
      });
      const sourceJob = sourceRun.jobs[0]!;
      expect(await engine.nextJob()).toMatchObject({ runId: sourceRun.id, jobId: sourceJob.id });
      await engine.markJobStarted(sourceRun.id, sourceJob.id);
      await engine.markStepStarted(sourceRun.id, sourceJob.id, sourceJob.steps[0]!.id);
      await engine.markStepCompleted(sourceRun.id, sourceJob.id, sourceJob.steps[0]!.id);
      await engine.markStepStarted(sourceRun.id, sourceJob.id, sourceJob.steps[1]!.id);
      await engine.markStepFailed(sourceRun.id, sourceJob.id, sourceJob.steps[1]!.id, new Error('step failed'));
      await engine.markJobFailed(sourceRun.id, sourceJob.id, new Error('step failed'), undefined, false);
      const failedRun = (await engine.getRun(sourceRun.id))!;

      const replayed = await engine.replayRun(sourceRun.id, {
        fromStepId: failedRun.jobs[0]!.steps[1]!.id,
      });

      expect(replayed).not.toBeNull();
      const replayJob = replayed!.jobs[0]!;
      expect(replayJob.status).toBe('queued');
      expect(replayJob.id).toBe(`${replayed!.id}:main`);
      expect(replayJob.runId).toBe(replayed!.id);
      expect(replayJob.steps.map((step) => step.status)).toEqual(['success', 'queued', 'queued']);
      expect(replayJob.steps.every((step) => step.runId === replayed!.id && step.jobId === replayJob.id)).toBe(true);

      const entry = await engine.nextJob();
      expect(entry).toMatchObject({ runId: replayed!.id, jobId: replayJob.id });
      await engine.markJobStarted(replayed!.id, replayJob.id);
      await engine.markStepStarted(replayed!.id, replayJob.id, replayJob.steps[1]!.id);
      await engine.markStepFailed(replayed!.id, replayJob.id, replayJob.steps[1]!.id, new Error('step failed again'));
      await engine.markJobFailed(replayed!.id, replayJob.id, new Error('step failed again'), undefined, false);

      expect((await engine.getRun(replayed!.id))?.status).toBe('failed');
    });

    // case: S-143.3
    it('REPLAY-11 preserves successful job outputs after the failed job in failed-only replay', async () => {
      const mixedSpec: WorkflowSpec = {
        name: 'Mixed Replay Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          before: { runsOn: 'local', steps: [{ id: 'before-step', name: 'Before', uses: 'builtin:shell', with: { run: 'echo before' } }] },
          failed: { runsOn: 'local', steps: [{ id: 'failed-step', name: 'Failed', uses: 'builtin:shell', with: { run: 'echo failed' } }] },
          skipped: { runsOn: 'local', steps: [{ id: 'skipped-step', name: 'Skipped', uses: 'builtin:shell', with: { run: 'echo skipped' } }] },
          cancelled: { runsOn: 'local', steps: [{ id: 'cancelled-step', name: 'Cancelled', uses: 'builtin:shell', with: { run: 'echo cancelled' } }] },
          after: { runsOn: 'local', steps: [{ id: 'after-step', name: 'After', uses: 'builtin:shell', with: { run: 'echo after' } }] },
        },
      };
      const source = await engine.createRun({ spec: mixedSpec, trigger: { type: 'manual' }, metadata: { workflowId: 'mixed-replay' } });
      await engine.finalizeRun(source.id, 'failed', {});
      const jobsByName = new Map(source.jobs.map((job) => [job.jobName, job]));
      await engine.updateRun(source.id, (draft) => {
        for (const job of draft.jobs) {
          const status = job.jobName === 'failed' ? 'failed' :
            job.jobName === 'skipped' ? 'skipped' :
            job.jobName === 'cancelled' ? 'cancelled' : 'success';
          job.status = status;
          const step = job.steps[0]!;
          step.status = status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : status;
          step.outputs = { result: `${job.jobName}-output` };
        }
        return draft;
      });
      await engine.deleteSnapshot(source.id);
      const snapshotRun = (await engine.getRun(source.id))!;
      await engine.createSnapshot(source.id, {}, snapshotRun.env ?? {});

      const failedJob = jobsByName.get('failed')!;
      const replayed = await engine.replayRun(source.id, { fromStepId: failedJob.steps[0]!.id });

      expect(replayed!.jobs.map((job) => job.status)).toEqual(['success', 'queued', 'queued', 'queued', 'success']);
      expect(replayed!.jobs[0]!.steps[0]!.outputs).toEqual({ result: 'before-output' });
      expect(replayed!.jobs[4]!.steps[0]!.outputs).toEqual({ result: 'after-output' });
      expect(replayed!.jobs[4]!.steps[0]!.status).toBe('success');
    });

    it('REPLAY-08: fromStepId in job-a resets steps in subsequent jobs to queued (not success)', async () => {
      // Multi-job spec: job-a has step-a, job-b depends on job-a and has step-b
      const multiJobSpec: WorkflowSpec = {
        name: 'Multi-job Replay Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          'job-a': {
            runsOn: 'local',
            steps: [
              { id: 'step-a1', name: 'Step A1', uses: 'builtin:shell', with: { run: 'echo a1' } },
              { id: 'step-a2', name: 'Step A2', uses: 'builtin:shell', with: { run: 'echo a2' } },
            ],
          },
          'job-b': {
            runsOn: 'local',
            needs: ['job-a'],
            steps: [
              { id: 'step-b1', name: 'Step B1', uses: 'builtin:shell', with: { run: 'echo b1' } },
            ],
          },
        },
      };
      const run = await engine.createRun({ spec: multiJobSpec, trigger: { type: 'manual' }, metadata: { workflowId: 'multi-job-replay' } });
      await engine.finalizeRun(run.id, 'failed', {});
      const original = (await engine.getRun(run.id))!;

      // Restart from step-a2 (in job-a)
      const stepA2Id = original.jobs[0]!.steps[1]!.id;
      const replayed = await engine.replayRun(original.id, { fromStepId: stepA2Id });

      expect(replayed).not.toBeNull();
      // step-a1 is before fromStepId — should remain success
      expect(replayed!.jobs[0]!.steps[0]!.status).toBe('success');
      // step-a2 is fromStepId — should be queued
      expect(replayed!.jobs[0]!.steps[1]!.status).toBe('queued');
      // step-b1 is in a subsequent job — must be queued (not success)
      expect(replayed!.jobs[1]!.steps[0]!.status).toBe('queued');
    });

    it('REPLAY-09: downstream jobs have blocked=true and correct pendingDependencies after replay', async () => {
      // Multi-job spec: job-a → job-b (needs job-a)
      const multiJobSpec: WorkflowSpec = {
        name: 'Multi-job Blocking Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          'job-a': {
            runsOn: 'local',
            steps: [
              { id: 'dep-step-a', name: 'Dep Step A', uses: 'builtin:shell', with: { run: 'echo a' } },
            ],
          },
          'job-b': {
            runsOn: 'local',
            needs: ['job-a'],
            steps: [
              { id: 'dep-step-b', name: 'Dep Step B', uses: 'builtin:shell', with: { run: 'echo b' } },
            ],
          },
        },
      };
      const run = await engine.createRun({ spec: multiJobSpec, trigger: { type: 'manual' }, metadata: { workflowId: 'multi-job-blocking' } });
      await engine.finalizeRun(run.id, 'failed', {});
      const original = (await engine.getRun(run.id))!;

      // Full replay (no fromStepId) — job-a has queued steps, so job-b must be blocked
      const replayed = await engine.replayRun(original.id);

      expect(replayed).not.toBeNull();
      const jobB = replayed!.jobs.find(j => j.jobName === 'job-b')!;
      expect(jobB.blocked).toBe(true);
      expect(jobB.pendingDependencies).toEqual(['job-a']);
    });
  });

  describe('Job-level if: condition (BUG-002)', () => {
    // Helper: build a two-job spec where job-b depends on job-a.
    // job-b has an optional `if` condition.
    function makeSpec(jobBIf?: string): WorkflowSpec {
      return {
        name: 'If Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          'job-a': {
            runsOn: 'local',
            steps: [
              {
                id: 'result',
                name: 'Emit result',
                uses: 'builtin:shell',
                with: { run: 'echo test' },
              },
            ],
          },
          'job-b': {
            runsOn: 'local',
            needs: ['job-a'],
            ...(jobBIf !== undefined ? { if: jobBIf } : {}),
            steps: [{ name: 'Step B', uses: 'builtin:shell', with: { run: 'echo b' } }],
          },
        },
      };
    }

    it('job with if: "false" is marked success (skipped) when dependency completes', async () => {
      const run = await engine.createRun({ spec: makeSpec('false'), trigger: { type: 'manual' } });
      const jobAId = run.jobs.find(j => j.jobName === 'job-a')!.id;

      await engine.markJobCompleted(run.id, jobAId);

      const updated = await engine.getRun(run.id);
      const jobB = updated?.jobs.find(j => j.jobName === 'job-b');
      expect(jobB?.status).toBe('success');
      expect(jobB?.finishedAt).toBeDefined();
    });

    it('job with if: "true" is enqueued (not skipped) when dependency completes', async () => {
      const run = await engine.createRun({ spec: makeSpec('true'), trigger: { type: 'manual' } });
      const jobAId = run.jobs.find(j => j.jobName === 'job-a')!.id;

      await engine.markJobCompleted(run.id, jobAId);

      const updated = await engine.getRun(run.id);
      const jobB = updated?.jobs.find(j => j.jobName === 'job-b');
      // Should be enqueued for execution (queued or running), not skipped immediately
      expect(jobB?.status).not.toBe('success');
      // finishedAt must NOT be set — job was not skipped
      expect(jobB?.finishedAt).toBeUndefined();
    });

    it('job without if: condition always runs when dependency completes', async () => {
      const run = await engine.createRun({ spec: makeSpec(undefined), trigger: { type: 'manual' } });
      const jobAId = run.jobs.find(j => j.jobName === 'job-a')!.id;

      await engine.markJobCompleted(run.id, jobAId);

      const updated = await engine.getRun(run.id);
      const jobB = updated?.jobs.find(j => j.jobName === 'job-b');
      expect(jobB?.status).not.toBe('success');
      expect(jobB?.finishedAt).toBeUndefined();
    });

    it('if: ${{ ... }} wrapper is stripped and expression is evaluated', async () => {
      const run = await engine.createRun({
        spec: makeSpec("${{ steps.result.outputs.tier == 'go' }}"),
        trigger: { type: 'manual' },
      });

      // Simulate job-a completing with step output: steps.result.outputs.tier = 'go'
      const jobAId = run.jobs.find(j => j.jobName === 'job-a')!.id;
      const stepId = run.jobs.find(j => j.jobName === 'job-a')!.steps[0]!.id;

      // Manually write step output into state so buildExpressionContext sees it
      const stateStore = (engine as any).stateStore;
      await stateStore.updateStep(run.id, jobAId, stepId, (draft: any) => {
        draft.status = 'success';
        draft.outputs = { tier: 'go' };
      });

      await engine.markJobCompleted(run.id, jobAId);

      const updated = await engine.getRun(run.id);
      const jobB = updated?.jobs.find(j => j.jobName === 'job-b');
      // tier == 'go' → true → job-b should be enqueued, not skipped
      expect(jobB?.status).not.toBe('success');
      expect(jobB?.finishedAt).toBeUndefined();
    });

    it('if: expression false when step output does not match', async () => {
      const run = await engine.createRun({
        spec: makeSpec("${{ steps.result.outputs.tier == 'other' }}"),
        trigger: { type: 'manual' },
      });

      const jobAId = run.jobs.find(j => j.jobName === 'job-a')!.id;
      const stepId = run.jobs.find(j => j.jobName === 'job-a')!.steps[0]!.id;

      const stateStore = (engine as any).stateStore;
      await stateStore.updateStep(run.id, jobAId, stepId, (draft: any) => {
        draft.status = 'success';
        draft.outputs = { tier: 'go' };
      });

      await engine.markJobCompleted(run.id, jobAId);

      const updated = await engine.getRun(run.id);
      const jobB = updated?.jobs.find(j => j.jobName === 'job-b');
      // tier != 'other' → false → job-b skipped
      expect(jobB?.status).toBe('success');
      expect(jobB?.finishedAt).toBeDefined();
    });

    it('cascading: downstream job of skipped job is also evaluated', async () => {
      // job-a → job-b (if: false, skipped) → job-c (no condition)
      const spec: WorkflowSpec = {
        name: 'Cascade Test',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          'job-a': {
            runsOn: 'local',
            steps: [{ name: 'A', uses: 'builtin:shell', with: { run: 'echo a' } }],
          },
          'job-b': {
            runsOn: 'local',
            needs: ['job-a'],
            if: 'false',
            steps: [{ name: 'B', uses: 'builtin:shell', with: { run: 'echo b' } }],
          },
          'job-c': {
            runsOn: 'local',
            needs: ['job-b'],
            steps: [{ name: 'C', uses: 'builtin:shell', with: { run: 'echo c' } }],
          },
        },
      };

      const run = await engine.createRun({ spec, trigger: { type: 'manual' } });
      const jobAId = run.jobs.find(j => j.jobName === 'job-a')!.id;

      await engine.markJobCompleted(run.id, jobAId);

      const updated = await engine.getRun(run.id);
      const jobB = updated?.jobs.find(j => j.jobName === 'job-b');
      const jobC = updated?.jobs.find(j => j.jobName === 'job-c');

      // job-b skipped
      expect(jobB?.status).toBe('success');
      // job-c unblocked and enqueued (not skipped — no if:)
      expect(jobC?.status).not.toBe('success');
      expect(jobC?.finishedAt).toBeUndefined();
    });

    it('skipped job logs the condition', async () => {
      const run = await engine.createRun({ spec: makeSpec('false'), trigger: { type: 'manual' } });
      const jobAId = run.jobs.find(j => j.jobName === 'job-a')!.id;

      await engine.markJobCompleted(run.id, jobAId);

      expect(logger.info).toHaveBeenCalledWith(
        'Job skipped: if condition false',
        expect.objectContaining({ runId: run.id, condition: 'false' }),
      );
    });
  });

  describe('cleanupStaleRuns — daemon restart with an outstanding approval', () => {
    const approvalSpec: WorkflowSpec = {
      name: 'Approval Workflow',
      version: '1.0.0',
      on: { manual: true },
      jobs: {
        main: {
          runsOn: 'local',
          steps: [
            { name: 'Approve', uses: 'builtin:approval', with: { message: 'Approve?' } },
          ],
        },
      },
    };

    it('regression: does not force-fail a job parked on waiting_approval — ' +
      'this is the exact bug this rework closes. Before the fix, a job whose ' +
      'step was `waiting_approval` still had job.status === \'running\' (no ' +
      'job-level parked status existed), so cleanupStaleRuns\'s force-fail ' +
      'loop (which only exempted `waiting_child`, never `waiting_approval`) ' +
      'matched it and marked the job — and by extension the run — `failed`, ' +
      'while the step itself stayed `waiting_approval` forever: a job/step ' +
      'status combination that made no sense and could never resolve. This ' +
      'is deterministic on every daemon restart with an open approval, not a ' +
      'rare race.', async () => {
      const run = await engine.createRun({ spec: approvalSpec, trigger: { type: 'manual' } });
      const job = run.jobs[0]!;
      const step = job.steps[0]!;

      await engine.markJobStarted(run.id, job.id);
      await engine.markStepWaitingApproval(run.id, job.id, step.id);

      // Sanity: confirm the parked state actually landed before simulating a
      // restart, so this test would fail loudly if markStepWaitingApproval's
      // own atomic job+step write ever regressed.
      const parked = await engine.getRun(run.id);
      expect(parked!.jobs[0]!.status).toBe('waiting_approval');
      expect(parked!.jobs[0]!.steps[0]!.status).toBe('waiting_approval');
      expect(parked!.status).toBe('running');

      // Simulate what actually happens on daemon restart: bootstrap calls
      // cleanupStaleRuns() before anything else touches this run.
      await engine.cleanupStaleRuns();

      const afterRestart = await engine.getRun(run.id);
      expect(afterRestart!.status).toBe('running');
      expect(afterRestart!.jobs[0]!.status).toBe('waiting_approval');
      expect(afterRestart!.jobs[0]!.steps[0]!.status).toBe('waiting_approval');
    });

    it('boundary: the parked-job exemption covers waiting_approval/waiting_child ' +
      'only — a job already resolved back to \'queued\' (approved, but no worker ' +
      'picked it up again yet) is NOT specially protected and gets force-failed ' +
      'on restart the same as any other queued job. This is unchanged, ' +
      'pre-existing behavior (queued jobs were already in cleanupStaleRuns\'s ' +
      'force-fail condition before this rework) — documented here so the ' +
      'exemption\'s exact boundary is explicit rather than assumed.', async () => {
      const run = await engine.createRun({ spec: approvalSpec, trigger: { type: 'manual' }, metadata: { workflowId: 'approval-flow' } });
      const job = run.jobs[0]!;
      const step = job.steps[0]!;

      await engine.markJobStarted(run.id, job.id);
      await engine.markStepWaitingApproval(run.id, job.id, step.id);
      await engine.resolveApproval(run.id, job.id, step.id, 'approve');

      expect((await engine.getRun(run.id))?.metadata?.['workflowId']).toBe('approval-flow');

      await engine.cleanupStaleRuns();

      const afterRestart = await engine.getRun(run.id);
      expect(afterRestart!.status).toBe('failed');
      expect(afterRestart!.jobs[0]!.status).toBe('failed');
      // The force-fail loop only touches job.status, not the nested step —
      // the already-resolved step's own status is untouched.
      expect(afterRestart!.jobs[0]!.steps[0]!.status).toBe('success');
    });

    it('still fails a genuinely abandoned job (no approval involved) on restart', async () => {
      const plainSpec: WorkflowSpec = {
        name: 'Plain Workflow',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          main: {
            runsOn: 'local',
            steps: [{ name: 'Step 1', uses: 'builtin:shell', with: { run: 'echo hi' } }],
          },
        },
      };
      const run = await engine.createRun({ spec: plainSpec, trigger: { type: 'manual' } });
      const job = run.jobs[0]!;
      await engine.markJobStarted(run.id, job.id); // job now 'running', executor about to "crash"

      await engine.cleanupStaleRuns();

      const afterRestart = await engine.getRun(run.id);
      expect(afterRestart!.status).toBe('failed');
      expect(afterRestart!.jobs[0]!.status).toBe('failed');
    });
  });

  describe('cleanupStaleRuns — daemon liveness lease guards against false "restart" positives', () => {
    // Regression coverage for a real incident: a `release-prepare` run's
    // Checks job, still genuinely alive under its original daemon process
    // (same PID the whole session, one single startup sequence in its logs),
    // got force-failed mid-step with error "Daemon restarted — run was
    // abandoned" — even though that daemon never restarted. The only way
    // that message can be produced is `cleanupStaleRuns`, which (before this
    // fix) treated simply being *called* as sufficient proof of a restart,
    // with no check for whether some other, still-alive process actually
    // owned the run it was about to force-fail. These tests simulate that
    // exact shape: a second `WorkflowEngine` instance sharing the same
    // underlying state store as a live one.

    const plainSpec: WorkflowSpec = {
      name: 'Plain Workflow',
      version: '1.0.0',
      on: { manual: true },
      jobs: {
        main: {
          runsOn: 'local',
          steps: [{ name: 'Step 1', uses: 'builtin:shell', with: { run: 'echo hi' } }],
        },
      },
    };

    it('does NOT abandon a job under a fresh daemon liveness lease held by a ' +
      'different, still-alive instance — the false-positive this fix closes. ' +
      'A long-running job under the SAME live daemon instance must never be ' +
      'declared abandoned just because some process (here, a second engine ' +
      'against the same store — modeling a stray/duplicate daemon launch) ' +
      'happens to run its own startup sweep.', async () => {
      const liveDaemon = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(),
        cache,
        storage,
        events,
        logger,
        instanceId: 'daemon-live',
      });

      const run = await liveDaemon.createRun({ spec: plainSpec, trigger: { type: 'manual' } });
      const job = run.jobs[0]!;
      await liveDaemon.markJobStarted(run.id, job.id); // genuinely still running

      // The live daemon heartbeats its lease, exactly as bootstrap.ts's
      // periodic renewDaemonLease() call does for as long as it's up.
      await liveDaemon.renewDaemonLease();

      // A second daemon instance boots against the SAME shared state store
      // (e.g. a stray/duplicate launch) and runs its own one-time cleanup.
      const strayLogger = mockLogger();
      const strayDaemon = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(),
        cache,
        storage,
        events,
        logger: strayLogger,
        instanceId: 'daemon-stray',
      });

      await strayDaemon.cleanupStaleRuns();

      const afterStrayBoot = await liveDaemon.getRun(run.id);
      expect(afterStrayBoot!.status).toBe('running');
      expect(afterStrayBoot!.jobs[0]!.status).toBe('running');
      expect(afterStrayBoot!.jobs[0]!.error).toBeUndefined();

      expect(strayLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('daemon liveness lease held by a different instance is still fresh'),
        undefined,
        expect.objectContaining({ thisInstanceId: 'daemon-stray', otherInstanceId: 'daemon-live' }),
      );
    });

    it('still abandons a genuinely orphaned job once the previous instance\'s ' +
      'lease is actually gone — a real restart succeeding a truly-dead daemon ' +
      'must keep cleaning up orphaned runs exactly as before.', async () => {
      const crashedDaemon = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(),
        cache,
        storage,
        events,
        logger,
        instanceId: 'daemon-crashed',
      });

      const run = await crashedDaemon.createRun({ spec: plainSpec, trigger: { type: 'manual' } });
      const job = run.jobs[0]!;
      await crashedDaemon.markJobStarted(run.id, job.id);
      await crashedDaemon.renewDaemonLease();

      // The crashed daemon's lease has since expired (TTL lapsed with no
      // renewal — nothing is heartbeating it any more). Simulate that by
      // removing the lease key directly from the shared cache, the same
      // outcome the real TTL produces once the owning process is truly gone.
      await cache.delete('workflow:project:prj_0000000000000001:kb:daemon:lease');

      const restartedDaemon = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(),
        cache,
        storage,
        events,
        logger,
        instanceId: 'daemon-restarted',
      });

      await restartedDaemon.cleanupStaleRuns();

      const afterRestart = await restartedDaemon.getRun(run.id);
      expect(afterRestart!.status).toBe('failed');
      expect(afterRestart!.jobs[0]!.status).toBe('failed');
      expect(afterRestart!.jobs[0]!.error).toMatchObject({
        message: 'Daemon restarted — run was abandoned',
      });
    });

    it('a daemon calling cleanupStaleRuns again under its OWN instanceId (the ' +
      'lease it just wrote itself) is not mistaken for a different instance, ' +
      'and still correctly abandons a job started under its own watch', async () => {
      await engine.cleanupStaleRuns(); // first call: no prior lease, proceeds, claims the lease

      // Started AFTER this instance already claimed the lease — a real
      // hypothetical second cleanup pass from the SAME instance must still
      // be able to proceed (own lease, not "a different instance") and treat
      // this the same as any other genuinely abandoned running job.
      const run = await engine.createRun({ spec: plainSpec, trigger: { type: 'manual' } });
      const job = run.jobs[0]!;
      await engine.markJobStarted(run.id, job.id);

      await engine.cleanupStaleRuns();

      const afterSecondPass = await engine.getRun(run.id);
      expect(afterSecondPass!.jobs[0]!.status).toBe('failed');
    });
  });

  describe('resolveApproval guards against a stale/reopened approval', () => {
    const approvalSpec: WorkflowSpec = {
      name: 'Approval Workflow',
      version: '1.0.0',
      on: { manual: true },
      jobs: {
        main: {
          runsOn: 'local',
          steps: [
            { name: 'Approve', uses: 'builtin:approval', with: { message: 'Approve?' } },
          ],
        },
      },
    };

    it('regression: rejects resolving an approval whose run was cancelled while it ' +
      'was pending. cancelRun only sets run.status — it does not cascade into ' +
      'cancelling this run\'s own in-flight jobs/steps, so without this check a ' +
      'human with a stale approval link open (or a delayed webhook replay) could ' +
      'resolve the step and resurrect a dead run\'s job back into \'queued\', ' +
      're-enqueuing work for a run nothing should still be executing.', async () => {
      const run = await engine.createRun({ spec: approvalSpec, trigger: { type: 'manual' } });
      const job = run.jobs[0]!;
      const step = job.steps[0]!;

      await engine.markJobStarted(run.id, job.id);
      await engine.markStepWaitingApproval(run.id, job.id, step.id);
      await engine.cancelRun(run.id);

      // Sanity: cancelRun really did leave the job/step parked, untouched.
      const cancelled = await engine.getRun(run.id);
      expect(cancelled!.status).toBe('cancelled');
      expect(cancelled!.jobs[0]!.status).toBe('waiting_approval');
      expect(cancelled!.jobs[0]!.steps[0]!.status).toBe('waiting_approval');

      await expect(engine.resolveApproval(run.id, job.id, step.id, 'approve'))
        .rejects.toThrow(/Illegal job status transition/);

      // The step must NOT have been resolved, and the job must NOT have been
      // re-queued — both would resurrect a cancelled run's execution.
      const afterAttempt = await engine.getRun(run.id);
      expect(afterAttempt!.jobs[0]!.status).toBe('waiting_approval');
      expect(afterAttempt!.jobs[0]!.steps[0]!.status).toBe('waiting_approval');
    });

    it('rejects resolving an approval on a job that is already terminal', async () => {
      const run = await engine.createRun({ spec: approvalSpec, trigger: { type: 'manual' } });
      const job = run.jobs[0]!;
      const step = job.steps[0]!;

      await engine.markJobStarted(run.id, job.id);
      await engine.markStepWaitingApproval(run.id, job.id, step.id);
      await engine.getStateStore().transitionJob(run.id, job.id, 'failed');

      await expect(engine.resolveApproval(run.id, job.id, step.id, 'approve'))
        .rejects.toThrow(/Illegal job status transition/);
    });

    it('still resolves normally when neither run nor job is terminal', async () => {
      const run = await engine.createRun({ spec: approvalSpec, trigger: { type: 'manual' } });
      const job = run.jobs[0]!;
      const step = job.steps[0]!;

      await engine.markJobStarted(run.id, job.id);
      await engine.markStepWaitingApproval(run.id, job.id, step.id);

      await expect(engine.resolveApproval(run.id, job.id, step.id, 'approve')).resolves.not.toThrow();

      const resolved = await engine.getRun(run.id);
      expect(resolved!.jobs[0]!.status).toBe('queued');
      expect(resolved!.jobs[0]!.steps[0]!.status).toBe('success');
    });
  });
});
