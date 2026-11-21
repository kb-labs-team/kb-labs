import { describe, expect, it, vi } from 'vitest';
import { InMemoryCache, InMemoryEventBus, InMemoryStorage } from '@kb-labs/core-platform/inmemory';
import { mockLogger } from '@kb-labs/shared-testing';
import { classifyFailure } from '@kb-labs/core-retry';
import { WorkflowEngine } from '../engine.js';
import { EnvSecretProvider } from '../secrets.js';

describe('external dependency wait', () => {
  it('persists a retry wait and recovers it in a new engine', async () => {
    const storage = new InMemoryStorage();
    const events = new InMemoryEventBus();
    const published = vi.spyOn(events, 'publish');
    const makeEngine = () => new WorkflowEngine({
      projectId: 'prj_0000000000000001', cache: new InMemoryCache(), storage,
      events, logger: mockLogger(), secretProvider: new EnvSecretProvider(),
    });
    const engine = makeEngine();
    const run = await engine.createRun({
      spec: { name: 'wait', version: '1.0.0', on: { manual: true }, jobs: {
        main: { runsOn: 'local', steps: [{ name: 'step', uses: 'builtin:shell', with: { command: 'true' } }] },
      } }, trigger: { type: 'manual' },
    });
    await engine.nextJob();
    const job = run.jobs[0]!;
    const step = job.steps[0]!;
    await engine.markJobStarted(run.id, job.id);
    await engine.markStepStarted(run.id, job.id, step.id);
    const error = new Error('dependency unavailable');
    await engine.markStepFailed(run.id, job.id, step.id, error);
    const failure = classifyFailure({ kind: 'rate_limit', retryable: true, retryAfterMs: 300, dependency: 'registry', message: error.message });
    await engine.markJobFailed(run.id, job.id, error, failure, { max: 1, on: ['rate_limit'], maxIntervalMs: 1 });
    expect(await engine.getRun(run.id)).toMatchObject({
      jobs: [{ status: 'waiting', steps: [{ status: 'waiting', wait: { dependency: 'registry' } }] }],
    });
    expect(published).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'step.waiting', payload: expect.objectContaining({ status: 'waiting', dependency: 'registry' }) }));
    const waitingEvent = published.mock.calls.map(([, event]) => event).find((event) => event && typeof event === 'object' && 'type' in event && event.type === 'step.waiting');
    expect(waitingEvent).toMatchObject({ sequence: (await engine.getRun(run.id))?.eventSequence });
    const restarted = makeEngine();
    expect(await restarted.nextJob()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(await restarted.nextJob()).toMatchObject({ runId: run.id, jobId: job.id });
  });
});

describe('external wait boundaries', () => {
  async function parked(retryAfterMs: number, maxWaitMs: number) {
    const storage = new InMemoryStorage();
    const engine = new WorkflowEngine({ projectId: 'prj_0000000000000001', cache: new InMemoryCache(), storage,
      events: new InMemoryEventBus(), logger: mockLogger(), secretProvider: new EnvSecretProvider() });
    const run = await engine.createRun({ spec: { name: 'wait', version: '1.0.0', on: { manual: true }, jobs: {
      main: { runsOn: 'local', steps: [{ name: 'step', uses: 'builtin:shell', with: { command: 'true' } }] },
    } }, trigger: { type: 'manual' } });
    await engine.nextJob();
    const job = run.jobs[0]!;
    await engine.markJobStarted(run.id, job.id);
    await engine.markStepStarted(run.id, job.id, job.steps[0]!.id);
    const error = new Error('busy');
    await engine.markStepFailed(run.id, job.id, job.steps[0]!.id, error);
    const failure = classifyFailure({ kind: 'rate_limit', retryable: true, retryAfterMs, message: error.message });
    await engine.markJobFailed(run.id, job.id, error, failure, { max: 1, on: ['rate_limit'], maxWaitMs });
    return { engine, run, job };
  }

  it('does not return a cancelled waiting job after its deadline', async () => {
    const { engine, run } = await parked(30, 1000);
    await engine.cancelRun(run.id);
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(await engine.nextJob()).toBeNull();
    expect((await engine.getRun(run.id))?.status).toBe('cancelled');
  });

  it('recovers a due wait if restart occurs after dequeue but before execution starts', async () => {
    const { engine, run, job } = await parked(0, 1000);
    expect(await engine.nextJob()).toMatchObject({ runId: run.id, jobId: job.id });
    await engine.cleanupStaleRuns();
    expect(await engine.getRun(run.id)).toMatchObject({ status: 'running', jobs: [{ status: 'waiting', steps: [{ status: 'waiting' }] }] });
    expect(await engine.nextJob()).toMatchObject({ runId: run.id, jobId: job.id });
  });

  it('fails rather than truncating a wait beyond the configured ceiling', async () => {
    const { engine, run } = await parked(200, 100);
    expect(await engine.getRun(run.id)).toMatchObject({ status: 'failed', jobs: [{ status: 'failed', error: {
      code: 'WORKFLOW_WAIT_CEILING_EXCEEDED', details: { kind: 'timeout', retryAfterMs: 200, maxWaitMs: 100 },
    }, steps: [{ error: { details: { failure: { kind: 'timeout', retryable: false, code: 'WORKFLOW_WAIT_CEILING_EXCEEDED' } } } }] }] });
  });
});
