/**
 * Integration tests for builtin:gate routing in the worker:
 * - skipTo: marks intermediate steps as skipped and resumes from target
 * - restartFrom: resets steps to queued and re-runs from target
 *
 * Each test drives the full worker loop with a mocked engine that tracks step
 * state in memory so getRun returns updated statuses on each call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '@kb-labs/shared-testing';
import { createWorkflowExecutionBackendFixture } from '../../test-fixtures/execution-backend-fixture.js';

const mockRunnerExecute = vi.fn();
vi.mock('@kb-labs/workflow-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/workflow-runtime')>();
  return {
    ...actual,
    SandboxRunner: class {
      execute = mockRunnerExecute;
    },
  };
});

import { EnvSecretProvider } from '@kb-labs/workflow-engine';
import { createWorkflowWorker } from '../worker.js';

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function timeout<T>(p: Promise<T>, label: string, ms = 10_000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Timeout: ${label}`)), ms)),
  ]);
}

/** Minimal step shape matching what the worker reads from engine.getRun */
function makeStep(
  id: string,
  specId: string,
  uses: string,
  withOpts: Record<string, unknown> = {},
  status = 'queued',
) {
  return {
    id,
    name: id,
    index: 0,
    status,
    outputs: undefined as Record<string, unknown> | undefined,
    metadata: {} as Record<string, unknown>,
    spec: { id: specId, uses, with: withOpts },
  };
}

/** Build a mutable engine whose getRun returns a live view of in-memory state. */
function buildEngine(runId: string, jobId: string, steps: ReturnType<typeof makeStep>[]) {
  const completion = createDeferred<void>();
  let pendingJobs = 0;
  let served = 0;

  const scheduler = {
    enqueueJob: vi.fn(async () => { pendingJobs++; }),
  };

  const stateStore = {
    updateStep: vi.fn(async (_r: string, _j: string, stepId: string, mutator: (d: any) => void) => {
      const s = steps.find(x => x.id === stepId);
      if (!s) {return;}
      mutator(s);
    }),
    updateJob: vi.fn(async () => {}),
    // Matches worker.ts's applyGateSkip/applyGateRestart, which now go
    // through transitionStep/transitionJob instead of raw updateStep/
    // updateJob. This fake doesn't validate transition legality (that's
    // StateStore's job, covered by its own unit tests) — it just applies
    // the status + mutator, same as the updateStep/updateJob fakes above.
    transitionStep: vi.fn(async (_r: string, _j: string, stepId: string, to: string, mutate?: (d: any) => void) => {
      const s = steps.find(x => x.id === stepId);
      if (!s) {return null;}
      s.status = to;
      mutate?.(s);
      return s;
    }),
    transitionJob: vi.fn(async () => null),
  };

  const run: any = {
    id: runId,
    tenantId: 'default',
    status: 'running',
    env: {},
    metadata: {},
    inputs: {},
    trigger: { type: 'manual' },
    jobs: [{
      id: jobId,
      jobName: 'job',
      status: 'queued',
      attempt: 0,
      get steps() { return steps; },
    }],
  };

  const engine: any = {
    async nextJob() {
      if (served === 0) { served++; return { runId, jobId }; }
      if (pendingJobs > 0) { pendingJobs--; return { runId, jobId }; }
      return null;
    },
    async getRun(id: string) {
      return id === runId ? run : null;
    },
    async markJobStarted() { run.jobs[0].status = 'running'; },
    async markJobCompleted() {
      run.jobs[0].status = 'success';
      completion.resolve();
    },
    async markJobFailed(_r: string, _j: string, err: Error) {
      run.jobs[0].status = 'failed';
      completion.reject(err);
    },
    async markStepStarted(_r: string, _j: string, stepId: string) {
      const s = steps.find(x => x.id === stepId);
      if (s) {s.status = 'running';}
    },
    async markStepCompleted(_r: string, _j: string, stepId: string, outputs?: Record<string, unknown>) {
      const s = steps.find(x => x.id === stepId);
      if (s) { s.status = 'success'; if (outputs) {s.outputs = outputs;} }
    },
    async markStepFailed(_r: string, _j: string, stepId: string) {
      const s = steps.find(x => x.id === stepId);
      if (s) {s.status = 'failed';}
    },
    async markStepWaitingApproval() {},
    async markJobInterrupted() {},
    async updateRun(_id: string, mutator: (d: any) => any) {
      mutator(run);
    },
    getStateStore: vi.fn(() => stateStore),
    getScheduler: vi.fn(() => scheduler),
  };

  return { engine, run, steps, completion, scheduler, stateStore };
}

async function startWorker(engine: any) {
  return createWorkflowWorker({
      projectId: 'prj_0000000000000001',
    engine,
    secretProvider: new EnvSecretProvider(),
    cliApi: {} as any,
    logger: mockLogger(),
    workspaceRoot: '/tmp/gate-test',
    platform: {
      executionBackend: createWorkflowExecutionBackendFixture().backend,
      hasExecutionBackend: true,
      getAdapter: vi.fn().mockReturnValue(undefined),
    },
    concurrency: 1,
  });
}

// ---------------------------------------------------------------------------
// skipTo
// ---------------------------------------------------------------------------

describe('builtin:gate skipTo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunnerExecute.mockResolvedValue({ status: 'success', outputs: {} });
  });

  it('marks intermediate steps as success/skipped and executes the target step', async () => {
    const runId = 'run-skip-1';
    const jobId = `${runId}:job`;

    // step_a outputs alreadyDone=true → gate skips to step_target → step_middle skipped
    const steps = [
      makeStep('step-a',      'step_a',      'plugin:test/handler'),
      makeStep('gate-skip',   'gate_skip',   'builtin:gate', {
        decision:  'steps.step_a.outputs.alreadyDone',
        routes:    { 'true': { skipTo: 'step_target' } },
        default:   'continue',
      }),
      makeStep('step-middle', 'step_middle', 'plugin:test/handler'),
      makeStep('step-target', 'step_target', 'plugin:test/handler'),
    ];

    const { engine, completion, scheduler } = buildEngine(runId, jobId, steps);

    // step-a → alreadyDone=true; step-target → normal success
    mockRunnerExecute
      .mockResolvedValueOnce({ status: 'success', outputs: { alreadyDone: 'true' } })
      .mockResolvedValueOnce({ status: 'success', outputs: {} });

    const worker = await startWorker(engine);
    const startPromise = worker.start();

    await timeout(completion.promise, 'skipTo test');
    await worker.stop();
    await startPromise;

    // gate fired skipTo → re-enqueued the job
    expect(scheduler.enqueueJob).toHaveBeenCalledOnce();

    // step-middle: skipped by gate, not executed
    const middle = steps.find(s => s.id === 'step-middle')!;
    expect(middle.status).toBe('success');
    expect(middle.outputs?.['skipped']).toBe(true);

    // step-target: ran normally (not skipped)
    const target = steps.find(s => s.id === 'step-target')!;
    expect(target.status).toBe('success');
    expect(target.outputs?.['skipped']).toBeUndefined();

    // Runner executed step-a and step-target, but NOT step-middle
    const executedSpecIds = mockRunnerExecute.mock.calls.map((c: any[]) => c[0].spec.id);
    expect(executedSpecIds).toContain('step_a');
    expect(executedSpecIds).toContain('step_target');
    expect(executedSpecIds).not.toContain('step_middle');
  });

  it('does not skip steps before the gate', async () => {
    const runId = 'run-skip-2';
    const jobId = `${runId}:job`;

    const steps = [
      makeStep('before-gate', 'before_gate', 'plugin:test/handler'),
      makeStep('gate-step',   'gate_step',   'builtin:gate', {
        decision: 'steps.before_gate.outputs.skip',
        routes:   { 'true': { skipTo: 'step_target' } },
        default:  'continue',
      }),
      makeStep('step-between', 'step_between', 'plugin:test/handler'),
      makeStep('step-target',  'step_target',  'plugin:test/handler'),
    ];

    const { engine, completion } = buildEngine(runId, jobId, steps);

    mockRunnerExecute
      .mockResolvedValueOnce({ status: 'success', outputs: { skip: 'true' } })
      .mockResolvedValueOnce({ status: 'success', outputs: {} });

    const worker = await startWorker(engine);
    const startPromise = worker.start();

    await timeout(completion.promise, 'before-gate test');
    await worker.stop();
    await startPromise;

    // before-gate: ran normally, not skipped
    const before = steps.find(s => s.id === 'before-gate')!;
    expect(before.status).toBe('success');
    expect(before.outputs?.['skipped']).toBeUndefined();

    // step-between: skipped
    const between = steps.find(s => s.id === 'step-between')!;
    expect(between.outputs?.['skipped']).toBe(true);
  });

  it('continues to next step when decision does not match any skipTo route', async () => {
    const runId = 'run-skip-3';
    const jobId = `${runId}:job`;

    const steps = [
      makeStep('step-a',    'step_a',    'plugin:test/handler'),
      makeStep('gate-step', 'gate_step', 'builtin:gate', {
        decision: 'steps.step_a.outputs.alreadyDone',
        routes:   { 'true': { skipTo: 'step_target' } },
        default:  'continue',
      }),
      makeStep('step-middle', 'step_middle', 'plugin:test/handler'),
      makeStep('step-target', 'step_target', 'plugin:test/handler'),
    ];

    const { engine, completion } = buildEngine(runId, jobId, steps);

    // alreadyDone=false → gate falls to default → all steps run
    mockRunnerExecute.mockResolvedValue({ status: 'success', outputs: { alreadyDone: 'false' } });

    const worker = await startWorker(engine);
    const startPromise = worker.start();

    await timeout(completion.promise, 'no-skip test');
    await worker.stop();
    await startPromise;

    const middle = steps.find(s => s.id === 'step-middle')!;
    expect(middle.status).toBe('success');
    expect(middle.outputs?.['skipped']).toBeUndefined();

    const executedIds = mockRunnerExecute.mock.calls.map((c: any[]) => c[0].spec.id);
    expect(executedIds).toContain('step_middle');
    expect(executedIds).toContain('step_target');
  });

  it('fails the job when skipTo names a step not in the pipeline', async () => {
    const runId = 'run-skip-4';
    const jobId = `${runId}:job`;

    const steps = [
      makeStep('step-a',   'step_a',   'plugin:test/handler'),
      makeStep('gate-bad', 'gate_bad', 'builtin:gate', {
        decision: 'steps.step_a.outputs.done',
        routes:   { 'true': { skipTo: 'nonexistent_step' } },
        default:  'continue',
      }),
    ];

    const { engine, completion } = buildEngine(runId, jobId, steps);

    mockRunnerExecute.mockResolvedValueOnce({ status: 'success', outputs: { done: 'true' } });

    let jobFailedError: Error | undefined;
    engine.markJobFailed = async (_r: string, _j: string, err: Error) => {
      jobFailedError = err;
      completion.reject(err);
    };

    const worker = await startWorker(engine);
    const startPromise = worker.start();

    await timeout(completion.promise.catch(() => {}), 'invalid skipTo test');
    await worker.stop();
    await startPromise.catch(() => {});

    expect(jobFailedError).toBeDefined();
    expect(jobFailedError!.message).toContain('nonexistent_step');
  });
});

// ---------------------------------------------------------------------------
// restartFrom (same-job)
// ---------------------------------------------------------------------------

describe('builtin:gate restartFrom (same-job)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunnerExecute.mockResolvedValue({ status: 'success', outputs: {} });
  });

  it('resets target and subsequent steps and re-runs them', async () => {
    const runId = 'run-restart-1';
    const jobId = `${runId}:job`;

    // First pass: step-impl outputs passed=false → gate restarts from step-impl
    // Second pass: step-impl outputs passed=true → gate continues → step-post runs
    const steps = [
      makeStep('step-impl',   'step_impl',   'plugin:test/handler'),
      makeStep('gate-review', 'gate_review', 'builtin:gate', {
        decision:      'steps.step_impl.outputs.passed',
        routes:        { 'false': { restartFrom: 'step_impl' } },
        default:       'continue',
        maxIterations: 3,
      }),
      makeStep('step-post', 'step_post', 'plugin:test/handler'),
    ];

    const { engine, completion, scheduler } = buildEngine(runId, jobId, steps);

    let implCalls = 0;
    mockRunnerExecute.mockImplementation(async (req: any) => {
      if (req.spec.id === 'step_impl') {
        implCalls++;
        return { status: 'success', outputs: { passed: implCalls > 1 ? 'true' : 'false' } };
      }
      return { status: 'success', outputs: {} };
    });

    const worker = await startWorker(engine);
    const startPromise = worker.start();

    await timeout(completion.promise, 'restart test');
    await worker.stop();
    await startPromise;

    // step-impl ran twice (first fail, then pass)
    expect(implCalls).toBe(2);

    // gate re-enqueued after first pass
    expect(scheduler.enqueueJob).toHaveBeenCalled();

    // step-post ran on the successful second pass
    const executedIds = mockRunnerExecute.mock.calls.map((c: any[]) => c[0].spec.id);
    expect(executedIds).toContain('step_post');

    expect(steps.find(s => s.id === 'step-post')!.status).toBe('success');
  });

  it('fails the job after maxIterations is exhausted', async () => {
    const runId = 'run-restart-2';
    const jobId = `${runId}:job`;

    const steps = [
      makeStep('step-impl',   'step_impl',   'plugin:test/handler'),
      makeStep('gate-review', 'gate_review', 'builtin:gate', {
        decision:      'steps.step_impl.outputs.passed',
        routes:        { 'false': { restartFrom: 'step_impl' } },
        default:       'continue',
        maxIterations: 2,
      }),
    ];

    const { engine, completion } = buildEngine(runId, jobId, steps);

    // step-impl always outputs passed=false → gate will exhaust maxIterations
    mockRunnerExecute.mockResolvedValue({ status: 'success', outputs: { passed: 'false' } });

    let jobFailedError: Error | undefined;
    engine.markJobFailed = async (_r: string, _j: string, err: Error) => {
      jobFailedError = err;
      completion.reject(err);
    };

    const worker = await startWorker(engine);
    const startPromise = worker.start();

    await timeout(completion.promise.catch(() => {}), 'maxIterations test');
    await worker.stop();
    await startPromise.catch(() => {});

    expect(jobFailedError).toBeDefined();
    expect(jobFailedError!.message).toContain('max iterations');
  });

  it('merges restart context into trigger.payload', async () => {
    const runId = 'run-restart-3';
    const jobId = `${runId}:job`;

    const steps = [
      makeStep('step-impl',   'step_impl',   'plugin:test/handler'),
      makeStep('gate-review', 'gate_review', 'builtin:gate', {
        decision: 'steps.step_impl.outputs.passed',
        routes:   { 'false': { restartFrom: 'step_impl', context: { reason: 'quality-fail' } } },
        default:  'continue',
        maxIterations: 3,
      }),
      makeStep('step-post', 'step_post', 'plugin:test/handler'),
    ];

    const { engine, run, completion } = buildEngine(runId, jobId, steps);

    let implCalls = 0;
    mockRunnerExecute.mockImplementation(async (req: any) => {
      if (req.spec.id === 'step_impl') {
        implCalls++;
        return { status: 'success', outputs: { passed: implCalls > 1 ? 'true' : 'false' } };
      }
      return { status: 'success', outputs: {} };
    });

    const worker = await startWorker(engine);
    const startPromise = worker.start();

    await timeout(completion.promise, 'context test');
    await worker.stop();
    await startPromise;

    // context.reason should be merged into trigger.payload after restart
    expect((run.trigger?.payload as any)?.reason).toBe('quality-fail');
  });
});
