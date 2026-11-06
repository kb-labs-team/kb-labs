import { describe, expect, it } from 'vitest';
import { EVENT_NAMES } from '@kb-labs/workflow-constants';
import type { IEventBus, IStorage } from '@kb-labs/core-platform';
import { InMemoryCache, InMemoryEventBus, InMemoryStorage } from '@kb-labs/core-platform/inmemory';
import { FaultInjectingCache, FaultInjectingEventBus, FaultInjectingStorage, mockLogger } from '@kb-labs/shared-testing';
import { EnvSecretProvider } from '../secrets.js';
import { WorkflowEngine } from '../engine.js';
import { workflowDeadLetterCacheKey } from '../dead-letter-key.js';
import { workflowProjectCacheKey } from '../project-scoped-cache.js';
import type { CacheOperation, EventBusOperation } from '@kb-labs/shared-testing';
import type { WorkflowRun } from '@kb-labs/workflow-contracts';

interface SideEffectObservation {
  readRun?: () => Promise<WorkflowRun | null>;
  status?: WorkflowRun['status'];
}

function failingEventBus(failType: string, error: Error, observation: SideEffectObservation): FaultInjectingEventBus {
  return new FaultInjectingEventBus(new InMemoryEventBus(), async (operation: EventBusOperation) => {
    const event = operation.event;
    if (event && typeof event === 'object' && 'type' in event && event.type === failType) {
      observation.status = (await observation.readRun?.())?.status;
      return error;
    }
    return undefined;
  });
}

async function terminalFailure(
  events: IEventBus = new InMemoryEventBus(),
  deadLetterError?: Error,
  observation: SideEffectObservation = {},
  storage: IStorage = new InMemoryStorage(),
) {
  let deadLetterKey: string | undefined;
  const projectId = 'prj_0000000000000001';
  const cache = deadLetterError
    ? new FaultInjectingCache(new InMemoryCache(), async (operation: CacheOperation) => {
        if (operation.name === 'set' && operation.key === deadLetterKey) {
          observation.status = (await observation.readRun?.())?.status;
          return deadLetterError;
        }
        return undefined;
      })
    : new InMemoryCache();
  const logger = mockLogger();
  const engine = new WorkflowEngine({
    projectId,
    cache,
    storage,
    events,
    logger,
    secretProvider: new EnvSecretProvider(),
  });
  const run = await engine.createRun({
    spec: {
      name: 'side-effect-failure',
      version: '1.0.0',
      on: { manual: true },
      jobs: {
        failed: { runsOn: 'local', steps: [{ name: 'Fail', uses: 'builtin:shell', with: { run: 'false' } }] },
        dependent: { runsOn: 'local', needs: ['failed'], steps: [{ name: 'Blocked', uses: 'builtin:shell', with: { run: 'true' } }] },
      },
    },
    trigger: { type: 'manual' },
  });
  const failedJob = run.jobs.find((job) => job.jobName === 'failed')!;
  await engine.markJobStarted(run.id, failedJob.id);
  deadLetterKey = workflowProjectCacheKey(projectId, workflowDeadLetterCacheKey(run.id, failedJob.id));
  observation.readRun = () => engine.getRun(run.id);
  const result = await engine.markJobFailed(run.id, failedJob.id, new Error('step failed'), undefined, false);
  return { engine, logger, run, failedJob, observation, result };
}

async function successfulRun(events: FaultInjectingEventBus, observation: SideEffectObservation) {
  const logger = mockLogger();
  const engine = new WorkflowEngine({
    projectId: 'prj_0000000000000001',
    cache: new InMemoryCache(),
    storage: new InMemoryStorage(),
    events,
    logger,
    secretProvider: new EnvSecretProvider(),
  });
  const run = await engine.createRun({
    spec: {
      name: 'side-effect-success', version: '1.0.0', on: { manual: true },
      jobs: { success: { runsOn: 'local', steps: [{ name: 'Pass', uses: 'builtin:shell', with: { run: 'true' } }] } },
    },
    trigger: { type: 'manual' },
  });
  const job = run.jobs[0]!;
  await engine.markJobStarted(run.id, job.id);
  observation.readRun = () => engine.getRun(run.id);
  const result = await engine.markJobCompleted(run.id, job.id);
  return { engine, logger, run, job, observation, result };
}

describe('workflow terminal state precedes ancillary effects', () => {
  // case: S-027.4
  it('records correlated publish failure after the failed run is durable', async () => {
    const error = new Error('event bus unavailable');
    const observation: SideEffectObservation = {};
    const { engine, logger, run, failedJob, result } = await terminalFailure(failingEventBus(EVENT_NAMES.job.failed, error, observation), undefined, observation);

    await expect(engine.getRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      jobs: [expect.objectContaining({ id: failedJob.id, status: 'failed' }), expect.objectContaining({ status: 'cancelled' })],
    });
    expect(observation.status).toBe('failed');
    expect(result).toMatchObject({ ancillaryFailures: [{ operation: 'event.publish.job.failed', runId: run.id, jobId: failedJob.id, message: error.message }] });
    await expect(engine.getRun(run.id)).resolves.toMatchObject({ diagnostics: [{ operation: 'event.publish.job.failed', jobId: failedJob.id, message: error.message }] });
    expect(logger.messages).toContainEqual(expect.objectContaining({
      level: 'error',
      msg: 'Workflow ancillary operation failed',
      error,
      meta: { operation: 'event.publish.job.failed', runId: run.id, jobId: failedJob.id },
    }));
  });

  it('records correlated blocked-dependent cancellation failure after the failed run is durable', async () => {
    const error = new Error('dependent cancellation write unavailable');
    const observation: SideEffectObservation = {};
    const storage = new FaultInjectingStorage(new InMemoryStorage(), async (operation) => {
      if (operation.name !== 'write') { return undefined }
      const persisted = JSON.parse(operation.data.toString('utf8')) as WorkflowRun;
      const dependent = persisted.jobs.find((job) => job.jobName === 'dependent');
      if (persisted.status === 'failed' && dependent?.status === 'cancelled') {
        observation.status = (await observation.readRun?.())?.status;
        return error;
      }
      return undefined;
    });
    const { engine, logger, run, failedJob, result } = await terminalFailure(new InMemoryEventBus(), undefined, observation, storage);
    const dependentJob = run.jobs.find((job) => job.jobName === 'dependent')!;

    await expect(engine.getRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      jobs: [expect.objectContaining({ id: failedJob.id, status: 'failed' }), expect.objectContaining({ id: dependentJob.id, status: 'queued', blocked: true })],
    });
    expect(observation.status).toBe('failed');
    expect(result).toMatchObject({ ancillaryFailures: [{ operation: 'workflow.jobs.cancel-downstream', runId: run.id, jobId: failedJob.id, message: error.message }] });
    await expect(engine.getRun(run.id)).resolves.toMatchObject({ diagnostics: [{ operation: 'workflow.jobs.cancel-downstream', jobId: failedJob.id, message: error.message }] });
    expect(logger.messages).toContainEqual(expect.objectContaining({
      level: 'error',
      msg: 'Workflow ancillary operation failed',
      error,
      meta: { operation: 'workflow.jobs.cancel-downstream', runId: run.id, jobId: failedJob.id },
    }));
  });

  it('records correlated dead-letter write failure after the failed run is durable', async () => {
    const error = new Error('cache unavailable');
    const observation: SideEffectObservation = {};
    const { engine, logger, run, failedJob, result } = await terminalFailure(new InMemoryEventBus(), error, observation);

    await expect(engine.getRun(run.id)).resolves.toMatchObject({
      status: 'failed',
      jobs: [expect.objectContaining({ id: failedJob.id, status: 'failed' }), expect.objectContaining({ status: 'cancelled' })],
    });
    expect(observation.status).toBe('failed');
    expect(result).toMatchObject({ ancillaryFailures: [{ operation: 'cache.dead-letter.set', runId: run.id, jobId: failedJob.id, message: error.message }] });
    await expect(engine.getRun(run.id)).resolves.toMatchObject({ diagnostics: [{ operation: 'cache.dead-letter.set', jobId: failedJob.id, message: error.message }] });
    expect(logger.messages).toContainEqual(expect.objectContaining({
      level: 'error',
      msg: 'Workflow ancillary operation failed',
      error,
      meta: { operation: 'cache.dead-letter.set', runId: run.id, jobId: failedJob.id },
    }));
  });

  it('records correlated success-event failure after the successful run is durable', async () => {
    const error = new Error('event bus unavailable');
    const observation: SideEffectObservation = {};
    const { engine, logger, run, job, result } = await successfulRun(failingEventBus(EVENT_NAMES.run.finished, error, observation), observation);

    await expect(engine.getRun(run.id)).resolves.toMatchObject({
      status: 'success', jobs: [expect.objectContaining({ id: job.id, status: 'success' })],
    });
    expect(observation.status).toBe('success');
    expect(result).toMatchObject({ ancillaryFailures: [{
      operation: 'event.publish.run.finished', runId: run.id, jobId: job.id, message: error.message,
    }] });
    await expect(engine.getRun(run.id)).resolves.toMatchObject({ diagnostics: [{
      operation: 'event.publish.run.finished', jobId: job.id, message: error.message,
    }] });
    expect(logger.messages).toContainEqual(expect.objectContaining({
      level: 'error', msg: 'Workflow ancillary operation failed', error,
      meta: { operation: 'event.publish.run.finished', runId: run.id, jobId: job.id },
    }));
  });

  it('attempts later side effects after an earlier failure and returns every failure', async () => {
    const eventError = new Error('event bus unavailable');
    const cacheError = new Error('cache unavailable');
    const observation: SideEffectObservation = {};
    const events = new FaultInjectingEventBus(new InMemoryEventBus(), (operation) => {
      const event = operation.event;
      return event && typeof event === 'object' && 'type' in event
        && event.type === EVENT_NAMES.job.failed ? eventError : undefined;
    });
    const { engine, run, failedJob, result } = await terminalFailure(events, cacheError, observation);

    expect(result).toMatchObject({ ancillaryFailures: [
      { operation: 'event.publish.job.failed', message: eventError.message },
      { operation: 'cache.dead-letter.set', message: cacheError.message },
    ] });
    await expect(engine.getRun(run.id)).resolves.toMatchObject({ diagnostics: [
      { operation: 'event.publish.job.failed', jobId: failedJob.id, message: eventError.message },
      { operation: 'cache.dead-letter.set', jobId: failedJob.id, message: cacheError.message },
    ] });
  });

  // case: S-027.5
  it('cancels a running run through the terminal owner before effects and persists history', async () => {
    const error = new Error('cancellation event unavailable');
    let engine: WorkflowEngine;
    let run: WorkflowRun;
    let observedStatus: WorkflowRun['status'] | undefined;
    const logger = mockLogger();
    const events = new FaultInjectingEventBus(new InMemoryEventBus(), async (operation) => {
      const event = operation.event;
      if (event && typeof event === 'object' && 'type' in event && event.type === EVENT_NAMES.run.cancelled) {
        observedStatus = (await engine.getRun(run.id))?.status;
        return error;
      }
      return undefined;
    });
    engine = new WorkflowEngine({
      projectId: 'prj_0000000000000001', cache: new InMemoryCache(), storage: new InMemoryStorage(),
      events, logger, secretProvider: new EnvSecretProvider(),
    });
    run = await engine.createRun({
      spec: { name: 'cancel-running', version: '1.0.0', on: { manual: true }, jobs: {
        job: { runsOn: 'local', steps: [{ name: 'Hold', uses: 'builtin:shell', with: { run: 'true' } }] },
      } },
      trigger: { type: 'manual' },
    });
    await engine.markJobStarted(run.id, run.jobs[0]!.id);

    const result = await engine.cancelRun(run.id);

    expect(observedStatus).toBe('cancelled');
    expect(result).toMatchObject({ ancillaryFailures: [{
      operation: 'event.publish.run.cancelled', runId: run.id, message: error.message,
    }] });
    await expect(engine.getRun(run.id)).resolves.toMatchObject({ status: 'cancelled', diagnostics: [{
      operation: 'event.publish.run.cancelled', message: error.message,
    }] });
    await expect(engine.getAllRuns()).resolves.toEqual([expect.objectContaining({ id: run.id, status: 'cancelled' })]);
    expect(logger.messages).toContainEqual(expect.objectContaining({
      level: 'error', msg: 'Workflow ancillary operation failed', error,
      meta: { operation: 'event.publish.run.cancelled', runId: run.id, jobId: '' },
    }));
  });
});
