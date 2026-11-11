import { describe, expect, it, vi } from 'vitest';
import type { WorkflowRun } from '@kb-labs/workflow-contracts';
import { mockLogger } from '@kb-labs/shared-testing';
import { WorkflowHostService } from './workflow-host-service.js';

function createService(overrides: Partial<Record<string, any>> = {}) {
  const engine = {
    getMetrics: vi.fn(async () => ({ runs: { total: 1 } })),
    getRun: vi.fn(async () => null),
    getAllRuns: vi.fn(async () => []),
    getActiveExecutions: vi.fn(async () => []),
    cancelRun: vi.fn(async () => undefined),
    runFromSpec: vi.fn(async () => ({ id: 'run-1', status: 'queued' })),
    ...overrides.engine,
  };

  const jobBroker = {
    submit: vi.fn(async () => ({ id: 'job-1' })),
    getJobLogs: vi.fn(async () => []),
    getRunLogs: vi.fn(async () => []),
    ...overrides.jobBroker,
  };

  const workflowService = overrides.workflowService;
  const cronScheduler = overrides.cronScheduler;

  return new WorkflowHostService({
    engine: engine as any,
    jobBroker: jobBroker as any,
    logger: mockLogger(),
    workflowService: workflowService as any,
    cronScheduler: cronScheduler as any,
  });
}

describe('WorkflowHostService', () => {
  it('submits job and returns jobId', async () => {
    const submit = vi.fn(async () => ({ id: 'run-42' }));
    const service = createService({ jobBroker: { submit } });

    const result = await service.submitJob('tenant_1', {
      type: 'mind:rag-query',
      payload: { text: 'hello' },
      priority: 9,
    });

    expect(result).toEqual({ jobId: 'run-42' });
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith({
      handler: 'mind:rag-query',
      input: { text: 'hello' },
      priority: 'high',
    });
  });

  it('rejects invalid tenant id', async () => {
    const service = createService();

    await expect(
      service.submitJob('tenant with spaces', { type: 'mind:rag-query' }),
    ).rejects.toThrow('Invalid tenant ID format');
  });

  it('uses workflow run status in the job status response', async () => {
    const run: WorkflowRun = {
      id: 'run-1',
      name: 'job-mind:rag-query',
      metadata: { workflowId: 'job-mind:rag-query' },
      version: '1.0.0',
      status: 'success',
      eventSequence: 0,
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      jobs: [],
      trigger: { type: 'manual' },
      env: {},
    } as WorkflowRun;

    const service = createService({
      engine: { getRun: vi.fn(async () => run) },
    });

    const result = await service.getJob('tenant_1', 'run-1');
    expect(result.id).toBe('run-1');
    expect(result.status).toBe('success');
    expect(result.type).toBe('job-mind:rag-query');
  });

  // case: S-022.3
  it('getRun preserves workflow run status and submitted inputs for REST detail', async () => {
    const run: WorkflowRun = {
      id: 'run-1',
      name: 'demo',
      metadata: { workflowId: 'demo-id' },
      version: '1.0.0',
      status: 'success',
      eventSequence: 0,
      inputs: { name: 'Ada' },
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      jobs: [],
      trigger: { type: 'manual' },
      env: {},
    } as WorkflowRun;

    const service = createService({
      engine: { getRun: vi.fn(async () => run) },
    });

    const result = await service.getRun('run-1');
    expect(result).toMatchObject({ workflowId: 'demo-id', status: 'success', inputs: { name: 'Ada' } });
  });

  it('raises a typed error when a run lacks workflowId metadata', async () => {
    const service = createService({
      engine: { getRun: vi.fn(async () => ({ id: 'run-without-workflow-id', name: 'demo' })) },
    });

    await expect(service.getRun('run-without-workflow-id')).rejects.toMatchObject({
      code: 'KB_RUNTIME_UNEXPECTED',
    });
  });

  it('rejects a run without workflowId when listing user-visible jobs', async () => {
    const service = createService({
      engine: { getAllRuns: vi.fn(async () => [{ id: 'run-without-workflow-id', name: 'demo' }]) },
    });

    await expect(service.listJobs('tenant_1', {})).rejects.toMatchObject({
      code: 'KB_RUNTIME_UNEXPECTED',
    });
  });

  it('getRunLogs delegates to jobBroker.getRunLogs with stepId filter', async () => {
    const mockLog = { timestamp: '2026-01-01T00:00:00.000Z', level: 'info', message: 'Executing step', context: { runId: 'r1', stepId: 's1' } };
    const getRunLogs = vi.fn(async () => [mockLog]);
    const service = createService({
      engine: { getRun: vi.fn(async () => ({ id: 'run-1', status: 'running', jobs: [] })) },
      jobBroker: { getRunLogs },
    });

    const result = await service.getRunLogs('run-1', { stepId: 'step-1', level: 'info', limit: 50 });

    expect(getRunLogs).toHaveBeenCalledWith('run-1', { stepId: 'step-1', level: 'info', limit: 50 });
    expect(result).toEqual([mockLog]);
  });

  it('getRunLogs works without options (returns all logs for run)', async () => {
    const getRunLogs = vi.fn(async () => []);
    const service = createService({
      engine: { getRun: vi.fn(async () => ({ id: 'run-42', status: 'running', jobs: [] })) },
      jobBroker: { getRunLogs },
    });

    await service.getRunLogs('run-42');

    expect(getRunLogs).toHaveBeenCalledWith('run-42', undefined);
  });

  it('runWorkflow resolves inputs from `inputs` field (plural)', async () => {
    const runFromSpec = vi.fn(async () => ({ id: 'run-1', status: 'queued' }));
    const get = vi.fn(async () => ({
      id: 'wf-1',
      input: {
        name: 'Test Workflow',
        version: '1.0.0',
        on: { manual: true },
        inputs: {
          owner: { type: 'string' },
          repo: { type: 'string' },
          issueNumber: { type: 'number' },
          baseBranch: { type: 'string', default: 'main' },
        },
        jobs: { main: { runsOn: 'local', steps: [] } },
      },
    }));
    const service = createService({ engine: { runFromSpec }, workflowService: { get } });

    await service.runWorkflow('wf-1', {
      inputs: { owner: 'KirillBaranov', repo: 'kb-labs', issueNumber: 29 },
    });

    expect(runFromSpec).toHaveBeenCalledOnce();
    const callArg = (runFromSpec as any).mock.calls[0]?.[1];
    expect(callArg.inputs).toEqual({
      owner: 'KirillBaranov',
      repo: 'kb-labs',
      issueNumber: 29,
      baseBranch: 'main', // default from spec
    });
    expect(callArg.metadata.workflowId).toBe('wf-1');
  });

  it.each(['manual', 'api'] as const)('persists workflowId for %s trigger runs', async (triggerType) => {
    const runFromSpec = vi.fn(async () => ({ id: 'run-1', status: 'queued' }));
    const service = createService({
      engine: { runFromSpec },
      workflowService: {
        get: vi.fn(async () => ({ id: 'wf-triggered', input: {
          name: 'triggered', version: '1.0.0', on: { manual: true }, jobs: { main: { runsOn: 'local', steps: [] } },
        } })),
      },
    });

    await service.runWorkflow('wf-triggered', { trigger: { type: triggerType } });

    expect(runFromSpec).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      metadata: expect.objectContaining({ workflowId: 'wf-triggered' }),
    }));
  });

  it('runWorkflow falls back to legacy `input` field (singular)', async () => {
    const runFromSpec = vi.fn(async () => ({ id: 'run-1', status: 'queued' }));
    const get = vi.fn(async () => ({
      id: 'wf-1',
      input: {
        name: 'Test Workflow',
        version: '1.0.0',
        on: { manual: true },
        inputs: { flag: { type: 'string', default: 'off' } },
        jobs: { main: { runsOn: 'local', steps: [] } },
      },
    }));
    const service = createService({ engine: { runFromSpec }, workflowService: { get } });

    await service.runWorkflow('wf-1', {
      input: { flag: 'on' },
    });

    const callArg = (runFromSpec as any).mock.calls[0]?.[1];
    expect(callArg.inputs).toEqual({ flag: 'on' });
  });

  it('runWorkflow uses spec defaults when no user inputs supplied', async () => {
    const runFromSpec = vi.fn(async () => ({ id: 'run-1', status: 'queued' }));
    const get = vi.fn(async () => ({
      id: 'wf-1',
      input: {
        name: 'Test Workflow',
        version: '1.0.0',
        on: { manual: true },
        inputs: { baseBranch: { type: 'string', default: 'main' } },
        jobs: { main: { runsOn: 'local', steps: [] } },
      },
    }));
    const service = createService({ engine: { runFromSpec }, workflowService: { get } });

    await service.runWorkflow('wf-1', {});

    const callArg = (runFromSpec as any).mock.calls[0]?.[1];
    expect(callArg.inputs).toEqual({ baseBranch: 'main' });
  });

  it('B-017: rejects a run missing a required input with no default', async () => {
    const runFromSpec = vi.fn(async () => ({ id: 'run-1', status: 'queued' }));
    const get = vi.fn(async () => ({
      id: 'wf-1',
      input: {
        name: 'Test Workflow',
        version: '1.0.0',
        on: { manual: true },
        inputs: {
          owner: { type: 'string', required: true },
          baseBranch: { type: 'string', default: 'main' },
        },
        jobs: { main: { runsOn: 'local', steps: [] } },
      },
    }));
    const service = createService({ engine: { runFromSpec }, workflowService: { get } });

    // Missing required `owner` → must reject before creating the run.
    await expect(
      service.runWorkflow('wf-1', { inputs: { baseBranch: 'dev' } }),
    ).rejects.toThrow(/required input.*owner|owner.*required/i);

    expect(runFromSpec).not.toHaveBeenCalled();
  });

  it('B-017: accepts a required input when provided', async () => {
    const runFromSpec = vi.fn(async () => ({ id: 'run-1', status: 'queued' }));
    const get = vi.fn(async () => ({
      id: 'wf-1',
      input: {
        name: 'Test Workflow',
        version: '1.0.0',
        on: { manual: true },
        inputs: { owner: { type: 'string', required: true } },
        jobs: { main: { runsOn: 'local', steps: [] } },
      },
    }));
    const service = createService({ engine: { runFromSpec }, workflowService: { get } });

    await service.runWorkflow('wf-1', { inputs: { owner: 'kb' } });

    expect(runFromSpec).toHaveBeenCalledOnce();
    const callArg = (runFromSpec as any).mock.calls[0]?.[1];
    expect(callArg.inputs).toEqual({ owner: 'kb' });
  });

  it('passes run target/isolation overrides to engine', async () => {
    const runFromSpec = vi.fn(async () => ({ id: 'run-1', status: 'queued' }));
    const get = vi.fn(async () => ({
      id: 'wf-1',
      input: {
        name: 'Test Workflow',
        version: '1.0.0',
        on: { manual: true },
        jobs: {
          build: {
            runsOn: 'sandbox',
            steps: [{ name: 'step', uses: 'builtin:shell', with: { command: 'echo ok' } }],
          },
        },
      },
    }));
    const service = createService({
      engine: { runFromSpec },
      workflowService: { get },
    });

    await service.runWorkflow('wf-1', {
      isolation: 'strict',
      target: {
        namespace: 'team-a/prod',
        environmentId: 'env-1',
      },
      trigger: { type: 'manual' },
    });

    expect(runFromSpec).toHaveBeenCalledOnce();
    const calls = (runFromSpec as any).mock.calls as Array<[Record<string, unknown>, unknown]>;
    const [specArg] = calls[0] ?? [];
    expect(specArg?.isolation).toBe('strict');
    expect(specArg?.target).toEqual({
      namespace: 'team-a/prod',
      environmentId: 'env-1',
    });
  });
});

describe('WorkflowHostService.rerunWorkflow', () => {
  const baseRun = {
    id: 'run-src',
    name: 'my-workflow',
    version: '1.0.0',
    status: 'success',
    createdAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    trigger: { type: 'manual' },
    env: {},
    inputs: { branch: 'main' },
    metadata: { workflowId: 'my-workflow' },
    jobs: [
      {
        id: 'j1',
        jobName: 'build',
        status: 'success',
        runId: 'run-src',
        tenantId: 't1',
        runsOn: 'local',
        queuedAt: new Date().toISOString(),
        attempt: 0,
        artifacts: {},
        steps: [
          { id: 's1', runId: 'run-src', jobId: 'j1', name: 'compile', index: 0, status: 'success', queuedAt: new Date().toISOString(), attempt: 0, spec: { uses: 'noop' }, outputs: { artifactPath: '/dist/app' } },
        ],
      },
      {
        id: 'j2',
        jobName: 'test',
        status: 'failed',
        runId: 'run-src',
        tenantId: 't1',
        runsOn: 'local',
        queuedAt: new Date().toISOString(),
        attempt: 0,
        artifacts: {},
        steps: [
          { id: 's2', runId: 'run-src', jobId: 'j2', name: 'run-tests', index: 0, status: 'failed', queuedAt: new Date().toISOString(), attempt: 0, spec: { uses: 'noop' } },
        ],
      },
    ],
  };

  const baseWorkflow = {
    id: 'my-workflow',
    input: {
      name: 'my-workflow',
      version: '1.0.0',
      on: { manual: true },
      jobs: {
        build: { runsOn: 'local', steps: [] },
        test: { runsOn: 'local', needs: ['build'], steps: [] },
      },
    },
  };

  it('RW-A: failedOnly=false reruns all jobs (full spec passed to engine)', async () => {
    const runFromSpec = vi.fn(async () => ({ id: 'run-new', status: 'queued' }));
    const service = createService({
      engine: { getRun: vi.fn(async () => baseRun), runFromSpec },
      workflowService: { get: vi.fn(async () => baseWorkflow) },
    });

    const result = await service.rerunWorkflow('run-src', { failedOnly: false });

    expect(result.runId).toBe('run-new');
    expect((runFromSpec as any).mock.calls[0]?.[1]?.metadata).toMatchObject({ workflowId: 'my-workflow' });
    expect(runFromSpec).toHaveBeenCalledOnce();
    const [specArg] = (runFromSpec as any).mock.calls[0] as [Record<string, unknown>];
    const jobs = specArg['jobs'] as Record<string, unknown>;
    expect(Object.keys(jobs)).toEqual(['build', 'test']);
  });

  it('RW-B: failedOnly=true resumes from the failed step via replayRun, carrying forward prior step outputs', async () => {
    const replayRun = vi.fn(async () => ({ id: 'run-new', status: 'queued' }));
    const runFromSpec = vi.fn();
    const service = createService({
      engine: { getRun: vi.fn(async () => baseRun), replayRun, runFromSpec },
      workflowService: { get: vi.fn(async () => baseWorkflow) },
    });

    const result = await service.rerunWorkflow('run-src', { failedOnly: true });

    expect(result.runId).toBe('run-new');
    // Must resume via the snapshot, not start a brand-new run from a filtered spec.
    expect(runFromSpec).not.toHaveBeenCalled();
    expect(replayRun).toHaveBeenCalledWith('run-src', { fromStepId: 's2' });
  });

  it('RW-B2: failedOnly=true resumes an interrupted job whose steps never reached failed (still running/queued)', async () => {
    const interruptedRun = {
      ...baseRun,
      jobs: [
        baseRun.jobs[0],
        {
          id: 'j2',
          jobName: 'test',
          status: 'interrupted',
          runId: 'run-src',
          tenantId: 't1',
          runsOn: 'local',
          queuedAt: new Date().toISOString(),
          attempt: 0,
          artifacts: {},
          // Interrupted mid-run: the active step is left 'running', never marked 'failed'.
          steps: [
            { id: 's2', runId: 'run-src', jobId: 'j2', name: 'run-tests', index: 0, status: 'running', queuedAt: new Date().toISOString(), attempt: 0, spec: { uses: 'noop' } },
          ],
        },
      ],
    };
    const replayRun = vi.fn(async () => ({ id: 'run-new', status: 'queued' }));
    const service = createService({
      engine: { getRun: vi.fn(async () => interruptedRun), replayRun },
      workflowService: { get: vi.fn(async () => baseWorkflow) },
    });

    const result = await service.rerunWorkflow('run-src', { failedOnly: true });

    expect(result.runId).toBe('run-new');
    expect(replayRun).toHaveBeenCalledWith('run-src', { fromStepId: 's2' });
  });

  it('RW-C: failedOnly=true throws when no jobs have failed', async () => {
    const allSuccessRun = {
      ...baseRun,
      jobs: [
        { ...baseRun.jobs[0], status: 'success' },
        { ...baseRun.jobs[1], status: 'success' },
      ],
    };
    const service = createService({
      engine: { getRun: vi.fn(async () => allSuccessRun) },
      workflowService: { get: vi.fn(async () => baseWorkflow) },
    });

    await expect(service.rerunWorkflow('run-src', { failedOnly: true })).rejects.toThrow('No failed jobs to rerun');
  });

  it('RW-D: throws when run is not found', async () => {
    const service = createService({
      engine: { getRun: vi.fn(async () => null) },
    });

    await expect(service.rerunWorkflow('missing-run', { failedOnly: false })).rejects.toThrow('Run not found');
  });

  it('RW-E: failedOnly=true throws a clear error when no snapshot exists for the source run', async () => {
    const replayRun = vi.fn(async () => null);
    const service = createService({
      engine: { getRun: vi.fn(async () => baseRun), replayRun },
      workflowService: { get: vi.fn(async () => baseWorkflow) },
    });

    await expect(service.rerunWorkflow('run-src', { failedOnly: true })).rejects.toThrow(
      /No replay snapshot for run run-src/,
    );
  });
});

describe('WorkflowHostService.resolveRunId', () => {
  it('OBS-001: returns full UUID when exact match exists', async () => {
    const fullId = 'abc12345-abcd-4000-8000-000000000001';
    const run = { id: fullId, status: 'running' } as any;
    const service = createService({ engine: { getRun: vi.fn(async () => run) } });

    const resolved = await service.resolveRunId(fullId);
    expect(resolved).toBe(fullId);
  });

  it('OBS-002: resolves 8-char prefix to full UUID via getAllRuns prefix search', async () => {
    const fullId = 'abc12345-abcd-4000-8000-000000000001';
    const getRun = vi.fn(async () => null);
    const getAllRuns = vi.fn(async () => [{ id: fullId, status: 'running' }]);
    const service = createService({ engine: { getRun, getAllRuns } });

    const resolved = await service.resolveRunId('abc12345');
    expect(resolved).toBe(fullId);
  });

  it('OBS-003: returns null when prefix matches nothing', async () => {
    const getRun = vi.fn(async () => null);
    const getAllRuns = vi.fn(async () => []);
    const service = createService({ engine: { getRun, getAllRuns } });

    const resolved = await service.resolveRunId('deadbeef');
    expect(resolved).toBeNull();
  });
});

describe('WorkflowHostService.restartRun', () => {
  const makeFinishedRun = (id: string, status: 'failed' | 'success' | 'cancelled') => ({
    id,
    name: 'my-workflow',
    metadata: { workflowId: 'my-workflow' },
    version: '1.0.0',
    status,
    createdAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    trigger: { type: 'manual' },
    env: {},
    jobs: [],
  });

  it('RST-HS-01: throws "Cannot restart an active run" when run is running (Bug 1 guard)', async () => {
    const activeRun = { id: 'run-live', status: 'running', metadata: { workflowId: 'my-workflow' } };
    const service = createService({
      engine: { getRun: vi.fn(async () => activeRun) },
    });

    await expect(service.restartRun('run-live', {})).rejects.toThrow(
      /Cannot restart an active run \(status: running\)/,
    );
  });

  it('RST-HS-02: throws "Cannot restart an active run" when run is queued (Bug 1 guard)', async () => {
    const queuedRun = { id: 'run-queued', status: 'queued', metadata: { workflowId: 'my-workflow' } };
    const service = createService({
      engine: { getRun: vi.fn(async () => queuedRun) },
    });

    await expect(service.restartRun('run-queued', {})).rejects.toThrow(
      /Cannot restart an active run \(status: queued\)/,
    );
  });

  it('RST-HS-03: propagates "Step not found" when fromStepId is invalid (Bug 2 guard)', async () => {
    const finishedRun = makeFinishedRun('run-done', 'failed');
    const replayRun = vi.fn(async () => { throw new Error('Step not found: ghost-step'); });
    const service = createService({
      engine: {
        getRun: vi.fn(async () => finishedRun),
        replayRun,
      },
    });

    await expect(service.restartRun('run-done', { fromStepId: 'ghost-step' })).rejects.toThrow(
      'Step not found: ghost-step',
    );
    expect(replayRun).toHaveBeenCalledWith('run-done', { fromStepId: 'ghost-step', env: undefined });
  });

  it('RST-HS-04: returns new runId and queued status on successful restart', async () => {
    const finishedRun = makeFinishedRun('run-done', 'failed');
    const newRun = { id: 'run-new-uuid', status: 'queued' };
    const replayRun = vi.fn(async () => newRun);
    const service = createService({
      engine: {
        getRun: vi.fn(async () => finishedRun),
        replayRun,
      },
    });

    const result = await service.restartRun('run-done', { fromStepId: 'step-b' });
    expect(result.runId).toBe('run-new-uuid');
    expect(result.status).toBe('queued');
    expect(result.fromStepId).toBe('step-b');
  });

  it('RST-HS-05: throws "Run not found" (not a snapshot error) when run is not found', async () => {
    const service = createService({
      engine: { getRun: vi.fn(async () => null) },
    });

    await expect(service.restartRun('no-such-run-id-1234', {})).rejects.toThrow(
      'Run not found: no-such-run-id-1234',
    );
  });

  it('RST-HS-06: distinguishes "no snapshot" from "run not found" when the run exists but replayRun() returns null', async () => {
    const finishedRun = makeFinishedRun('run-done', 'failed');
    const service = createService({
      engine: {
        getRun: vi.fn(async () => finishedRun),
        replayRun: vi.fn(async () => null),
      },
    });

    await expect(service.restartRun('run-done', {})).rejects.toThrow(
      /No replay snapshot for run run-done \(status: failed/,
    );
  });
});

describe('WorkflowHostService.listRuns — hasPendingApproval', () => {
  it('OBS-004: hasPendingApproval is true when a step is waiting_approval', async () => {
    const runWithApproval = {
      id: 'run-approval',
      metadata: { workflowId: 'task-to-pr' },
      name: 'task-to-pr',
      version: '1.0.0',
      status: 'running',
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      trigger: { type: 'manual' },
      env: {},
      jobs: [{
        id: 'j1',
        jobName: 'main',
        status: 'running',
        runId: 'run-approval',
        tenantId: 't1',
        runsOn: 'local',
        queuedAt: new Date().toISOString(),
        attempt: 1,
        artifacts: {},
        steps: [
          { id: 's1', name: 'Agent Plans', status: 'success' },
          { id: 's2', name: 'Approve Plan', status: 'waiting_approval' },
        ],
      }],
    };

    const getAllRuns = vi.fn(async () => [runWithApproval]);
    const service = createService({ engine: { getAllRuns } });

    const { runs } = await service.listRuns({});
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: 'run-approval', hasPendingApproval: true });
  });

  it('OBS-005: hasPendingApproval is false when no steps are waiting_approval', async () => {
    const runNoApproval = {
      id: 'run-clean',
      metadata: { workflowId: 'task-to-pr' },
      name: 'task-to-pr',
      version: '1.0.0',
      status: 'running',
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      trigger: { type: 'manual' },
      env: {},
      jobs: [{
        id: 'j1',
        jobName: 'main',
        status: 'running',
        runId: 'run-clean',
        tenantId: 't1',
        runsOn: 'local',
        queuedAt: new Date().toISOString(),
        attempt: 1,
        artifacts: {},
        steps: [
          { id: 's1', name: 'Agent Plans', status: 'success' },
          { id: 's2', name: 'Agent Implements', status: 'running' },
        ],
      }],
    };

    const getAllRuns = vi.fn(async () => [runNoApproval]);
    const service = createService({ engine: { getAllRuns } });

    const { runs } = await service.listRuns({});
    expect(runs[0]).toMatchObject({ id: 'run-clean', hasPendingApproval: false });
  });

  it('OBS-006: currentStepName is the name of the active running step', async () => {
    const run = {
      id: 'run-active',
      metadata: { workflowId: 'ci' },
      name: 'ci',
      version: '1.0.0',
      status: 'running',
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      trigger: { type: 'manual' },
      env: {},
      jobs: [{
        id: 'j1',
        jobName: 'build',
        status: 'running',
        runId: 'run-active',
        tenantId: 't1',
        runsOn: 'local',
        queuedAt: new Date().toISOString(),
        attempt: 1,
        artifacts: {},
        steps: [
          { id: 's1', name: 'unit-tests', status: 'success' },
          { id: 's2', name: 'build-image', status: 'running' },
          { id: 's3', name: 'deploy', status: 'queued' },
        ],
      }],
    };

    const getAllRuns = vi.fn(async () => [run]);
    const service = createService({ engine: { getAllRuns } });

    const { runs } = await service.listRuns({});
    expect(runs[0]?.currentStepName).toBe('build-image');
  });

  it('OBS-007: currentStepName is undefined when all steps are queued (no active step)', async () => {
    const run = {
      id: 'run-queued',
      metadata: { workflowId: 'ci' },
      name: 'ci',
      version: '1.0.0',
      status: 'running',
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      trigger: { type: 'manual' },
      env: {},
      jobs: [{
        id: 'j1',
        jobName: 'build',
        status: 'running',
        runId: 'run-queued',
        tenantId: 't1',
        runsOn: 'local',
        queuedAt: new Date().toISOString(),
        attempt: 1,
        artifacts: {},
        steps: [
          { id: 's1', name: 'unit-tests', status: 'queued' },
        ],
      }],
    };

    const getAllRuns = vi.fn(async () => [run]);
    const service = createService({ engine: { getAllRuns } });

    const { runs } = await service.listRuns({});
    expect(runs[0]?.currentStepName).toBeUndefined();
  });

  it('OBS-008: currentStepName is undefined for non-RUNNING runs', async () => {
    const run = {
      id: 'run-done',
      metadata: { workflowId: 'ci' },
      name: 'ci',
      version: '1.0.0',
      status: 'success',
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      trigger: { type: 'manual' },
      env: {},
      jobs: [{
        id: 'j1',
        jobName: 'build',
        status: 'success',
        runId: 'run-done',
        tenantId: 't1',
        runsOn: 'local',
        queuedAt: new Date().toISOString(),
        attempt: 1,
        artifacts: {},
        steps: [
          { id: 's1', name: 'unit-tests', status: 'success' },
        ],
      }],
    };

    const getAllRuns = vi.fn(async () => [run]);
    const service = createService({ engine: { getAllRuns } });

    const { runs } = await service.listRuns({});
    expect(runs[0]?.currentStepName).toBeUndefined();
  });

  // case: S-002.5
  it('includes workflowId in each run history summary', async () => {
    const run = {
      id: 'run-history',
      name: 'Hello Workflow',
      version: '1.0.0',
      status: 'success',
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      trigger: { type: 'manual' },
      jobs: [],
      metadata: { workflowId: 'hello' },
    };

    const service = createService({ engine: { getAllRuns: vi.fn(async () => [run]) } });
    const { runs } = await service.listRuns({ workflowId: 'hello' });

    expect(runs[0]).toMatchObject({ id: 'run-history', workflowId: 'hello', status: 'success' });
  });

  it('uses run status vocabulary when filtering workflow history', async () => {
    const successRun = {
      id: 'run-success', name: 'hello', metadata: { workflowId: 'hello' }, version: '1.0.0', status: 'success',
      createdAt: new Date().toISOString(), queuedAt: new Date().toISOString(),
      trigger: { type: 'manual' }, jobs: [],
    };
    const service = createService({
      engine: { getAllRuns: vi.fn(async () => [successRun]) },
      workflowService: { get: vi.fn(async () => ({ name: 'hello' })) },
    });

    const result = await service.listWorkflowRuns('hello', { status: 'success' });
    expect(result.runs).toMatchObject([{ id: 'run-success', status: 'success' }]);
  });

  it('OBS-009: parallel jobs — currentStepName shows first active step with overflow count', async () => {
    const run = {
      id: 'run-parallel',
      metadata: { workflowId: 'ci-parallel' },
      name: 'ci-parallel',
      version: '1.0.0',
      status: 'running',
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      trigger: { type: 'manual' },
      env: {},
      jobs: [
        {
          id: 'j1',
          jobName: 'build',
          status: 'running',
          runId: 'run-parallel',
          tenantId: 't1',
          runsOn: 'local',
          queuedAt: new Date().toISOString(),
          attempt: 1,
          artifacts: {},
          steps: [{ id: 's1', name: 'compile', status: 'running' }],
        },
        {
          id: 'j2',
          jobName: 'test',
          status: 'running',
          runId: 'run-parallel',
          tenantId: 't1',
          runsOn: 'local',
          queuedAt: new Date().toISOString(),
          attempt: 1,
          artifacts: {},
          steps: [{ id: 's2', name: 'lint', status: 'running' }],
        },
      ],
    };

    const getAllRuns = vi.fn(async () => [run]);
    const service = createService({ engine: { getAllRuns } });

    const { runs } = await service.listRuns({});
    expect(runs[0]?.currentStepName).toBe('compile (+1)');
  });
});
