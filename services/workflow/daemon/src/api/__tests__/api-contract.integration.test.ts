import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '@kb-labs/shared-testing';
import { registerCronAPI } from '../cron-api.js';
import { registerJobsAPI } from '../jobs-api.js';
import { registerWorkflowsAPI } from '../workflows-api.js';
import { registerApprovalsAPI } from '../approvals-api.js';
import { CronMutationRefusedError } from '../../cron-discovery.js';

function createHostServiceMock() {
  return {
    submitJob: vi.fn(async () => ({ jobId: 'job-1' })),
    getJob: vi.fn(async () => ({ id: 'job-1', type: 'test', status: 'running' })),
    cancelJob: vi.fn(async () => ({ cancelled: true })),
    listJobs: vi.fn(async () => ({ jobs: [{ id: 'job-1', type: 'test', status: 'running' }] })),
    getJobSteps: vi.fn(async () => [{ id: 's1', status: 'success' }]),
    getJobLogs: vi.fn(async () => [{ message: 'log' }]),
    listCron: vi.fn(() => ({ crons: [{ id: 'c1', source: 'user', schedule: '* * * * *', target: { workflow: 'wf' }, enabled: true }], errors: [] })),
    setCronEnabled: vi.fn(async (_id: string, enabled: boolean) => ({ enabled })),
    listWorkflows: vi.fn(async () => ({ workflows: [{ id: 'w1', name: 'wf', source: 'standalone' }] })),
    getWorkflow: vi.fn(async () => ({ id: 'w1', name: 'wf', source: 'standalone' })),
    runWorkflow: vi.fn(async () => ({ runId: 'r1', status: 'queued' })),
    listRuns: vi.fn(async () => ({ runs: [{ id: 'r1', status: 'running' }], total: 1 })),
    getRun: vi.fn(async () => ({
      id: 'r1',
      status: 'running',
      jobs: [{
        id: 'j1',
        steps: [{
          id: 's1',
          name: 'approve me',
          status: 'waiting_approval',
          startedAt: new Date().toISOString(),
          spec: { id: 'step-spec-1', with: {} },
        }],
      }],
    })),
    resolveRunId: vi.fn(async () => null),
    cancelRun: vi.fn(async () => {}),
    listWorkflowRuns: vi.fn(async () => ({ runs: [], total: 0 })),
    getRunLogs: vi.fn(async () => [
      { timestamp: '2026-01-01T00:00:00.000Z', level: 'info', message: 'Executing step', context: { runId: 'r1' } },
    ]),
  };
}

function createEngineMock() {
  return {
    getRun: vi.fn(async () => ({
      id: 'r1',
      status: 'running',
      jobs: [{
        id: 'j1',
        steps: [{
          id: 's1',
          name: 'approve me',
          status: 'waiting_approval',
          startedAt: new Date().toISOString(),
          spec: { id: 'step-spec-1', with: {} },
        }],
      }],
    })),
    subscribeToRunEvents: vi.fn((_runId: string, _handler: (event: { type: string; runId: string; payload?: unknown }) => void) => () => {}),
    resolveApproval: vi.fn(async () => {}),
  };
}

describe('Workflow API Contract Integration', () => {
  let app: FastifyInstance;
  let hostService: ReturnType<typeof createHostServiceMock>;
  let engine: ReturnType<typeof createEngineMock>;
  let observability: { observeOperation: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    app = Fastify({ logger: false });
    hostService = createHostServiceMock();
    engine = createEngineMock();
    const logger = mockLogger();
    observability = {
      observeOperation: vi.fn((_name: string, fn: () => unknown) => fn()),
    };

    registerJobsAPI({ server: app, hostService: hostService as any, logger, observability: observability as any });
    registerCronAPI({ server: app, hostService: hostService as any, logger, observability: observability as any });
    registerWorkflowsAPI({ server: app, hostService: hostService as any, engine: engine as any, logger, observability: observability as any });
    registerApprovalsAPI({ server: app, hostService: hostService as any, engine: engine as any, logger, observability: observability as any });
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Jobs ─────────────────────────────────────────────────────────────

  describe('Jobs', () => {
    it('GET /api/v1/jobs — lists jobs with envelope', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/jobs' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        data: { jobs: [{ id: 'job-1', type: 'test', status: 'running' }] },
      });
    });

    it('GET /api/v1/jobs/:jobId — returns job', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/jobs/job-1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ id: 'job-1', status: 'running' });
    });

    it('GET /api/v1/jobs/:jobId — 404 when not found', async () => {
      hostService.getJob.mockRejectedValueOnce(new Error('Job not found'));
      const res = await app.inject({ method: 'GET', url: '/api/v1/jobs/missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_JOB_NOT_FOUND', message: 'Job not found' } });
    });

    it('POST /api/v1/jobs/:jobId/cancel — cancels job', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/jobs/job-1/cancel' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ cancelled: true });
    });

    it('GET /api/v1/jobs/:jobId/steps — returns steps', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/jobs/job-1/steps' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([{ id: 's1', status: 'success' }]);
    });

    it('GET /api/v1/jobs/:jobId/logs — returns logs', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/jobs/job-1/logs' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ logs: [{ message: 'log' }] });
    });

    it('GET /api/v1/jobs/:jobId/steps — 404 when job not found', async () => {
      hostService.getJobSteps.mockRejectedValueOnce(new Error('Job not found'));
      const res = await app.inject({ method: 'GET', url: '/api/v1/jobs/missing/steps' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_JOB_NOT_FOUND' } });
    });
  });

  // ── Crons ────────────────────────────────────────────────────────────

  describe('Crons', () => {
    it('GET /api/v1/crons — lists crons', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/crons' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        data: { crons: [{ id: 'c1', source: 'user', schedule: '* * * * *', target: { workflow: 'wf' }, enabled: true }], errors: [] },
      });
    });

    it('GET /api/v1/crons — reports an unavailable scheduler with its catalog code', async () => {
      hostService.listCron.mockImplementationOnce(() => { throw new Error('Cron scheduler not available'); });
      const res = await app.inject({ method: 'GET', url: '/api/v1/crons' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_CRON_SCHEDULER_UNAVAILABLE' } });
    });

    it('POST /api/v1/crons/:id/disable — persists disabled state', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/crons/c1/disable' });
      expect(res.statusCode).toBe(200);
      expect(hostService.setCronEnabled).toHaveBeenCalledWith('c1', false);
      expect(res.json()).toMatchObject({ ok: true, data: { enabled: false } });
    });

    it('POST /api/v1/crons/:id/enable — refuses plugin cron with typed error', async () => {
      hostService.setCronEnabled.mockRejectedValueOnce(new CronMutationRefusedError('plugin:qa:cleanup'));
      const res = await app.inject({ method: 'POST', url: '/api/v1/crons/plugin:qa:cleanup/enable' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_CRON_PLUGIN_READ_ONLY' } });
    });

    it('POST /api/v1/crons — rejects non-file registration surfaces', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/crons', payload: {} });
      expect(res.statusCode).toBe(404);
    });

    it('old /api/v1/cron path returns 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/cron' });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Workflows ────────────────────────────────────────────────────────

  describe('Workflows', () => {
    it('GET /api/v1/workflows — lists workflows', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workflows' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ workflows: [{ id: 'w1' }] });
    });

    it('GET /api/v1/workflows/:id — returns definition', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workflows/w1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ id: 'w1', name: 'wf' });
    });

    it('GET /api/v1/workflows/:id — 404 when not found', async () => {
      hostService.getWorkflow.mockResolvedValueOnce(null as any);
      const res = await app.inject({ method: 'GET', url: '/api/v1/workflows/missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_WORKFLOW_NOT_FOUND', message: 'Workflow not found' } });
    });

    it('GET /api/v1/workflows/:id/runs — lists runs for workflow', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/workflows/w1/runs' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ runs: [], total: 0 });
    });

    it('POST /api/v1/workflows/:id/runs — starts a run', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/workflows/w1/runs',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ runId: 'r1', status: 'queued' });
    });

    it('POST /api/v1/workflows/:id/runs — 404 when workflow not found', async () => {
      hostService.runWorkflow.mockRejectedValueOnce(new Error('Workflow not found'));
      const res = await app.inject({
        method: 'POST', url: '/api/v1/workflows/missing/runs',
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_WORKFLOW_NOT_FOUND' } });
    });

    it('old POST /api/v1/workflows/:id/run path returns 404', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/workflows/w1/run', payload: {} });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/v1/workflows/refresh — refreshes definitions', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/workflows/refresh' });
      expect(res.statusCode).toBe(200);
    });
  });

  // ── Runs ─────────────────────────────────────────────────────────────

  describe('Runs', () => {
    // case: S-027.2
    it('GET /api/v1/runs/:runId/events omits transitions already covered by its snapshot watermark', async () => {
      const listeners: Array<(event: { type: string; runId: string; sequence: number; payload?: unknown }) => void> = [];
      engine.subscribeToRunEvents.mockImplementation((_runId, listener) => {
        listeners.push(listener);
        return () => { listeners.splice(listeners.indexOf(listener), 1); };
      });
      engine.getRun.mockImplementation(async () => {
        listeners[0]?.({ type: 'step.started', runId: 'r1', sequence: 1, payload: { stepId: 'step-1' } });
        return {
          id: 'r1', status: 'running', eventSequence: 1,
          jobs: [{ id: 'job-1', steps: [{ id: 'step-1', name: 'compile', status: 'running', startedAt: new Date().toISOString(), spec: { id: 'compile', with: {} } }] }],
        };
      });

      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      try {
        const response = await fetch(`${address}/api/v1/runs/r1/events`);
        if (response.status !== 200) {
          throw new Error(`SSE route returned ${response.status}: ${await response.text()}`);
        }
        listeners[0]?.({ type: 'step.succeeded', runId: 'r1', sequence: 2, payload: { stepId: 'step-1' } });
        listeners[0]?.({ type: 'run.finished', runId: 'r1', sequence: 3, payload: { status: 'success' } });
        const body = await response.text();

        expect(body).toContain('event: run.snapshot');
        expect(body.match(/event: step\.started/g)).toBeNull();
        expect(body).toContain('event: run.finished');
        expect(body).toContain('event: step.succeeded');
        expect(body.indexOf('event: run.snapshot')).toBeLessThan(body.indexOf('event: step.succeeded'));
      } finally {
        await app.close();
      }
    });

    it('GET /api/v1/runs/:runId/events unsubscribes when disconnected during snapshot read', async () => {
      let resolveRun!: (run: unknown) => void;
      const deferredRun = new Promise<unknown>((resolve) => { resolveRun = resolve; });
      const listeners: Array<(event: { type: string; runId: string; sequence: number }) => void> = [];
      const unsubscribe = vi.fn(() => { listeners.length = 0; });
      let subscribed!: () => void;
      const subscriptionReady = new Promise<void>((resolve) => { subscribed = resolve; });
      engine.subscribeToRunEvents.mockImplementation((_runId, listener) => {
        listeners.push(listener);
        subscribed();
        return unsubscribe;
      });
      engine.getRun.mockReturnValue(deferredRun as never);

      const address = await app.listen({ port: 0, host: '127.0.0.1' });
      const controller = new AbortController();
      const responsePromise = fetch(`${address}/api/v1/runs/r1/events`, { signal: controller.signal });
      const responseResult = responsePromise.then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      );
      try {
        await subscriptionReady;
        controller.abort();
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1), { timeout: 1000 });
        listeners[0]?.({ type: 'step.started', runId: 'r1', sequence: 1 });
        resolveRun({ id: 'r1', status: 'running', eventSequence: 0, jobs: [] });
        const result = await responseResult;
        expect('error' in result).toBe(true);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(listeners).toHaveLength(0);
      } finally {
        controller.abort();
        resolveRun(null);
        await app.close();
      }
    });

    it('GET /api/v1/runs — lists all runs', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ runs: [{ id: 'r1' }], total: 1 });
    });

    it('GET /api/v1/runs/:runId — returns run', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ run: { id: 'r1' } });
    });

    it('GET /api/v1/runs/:runId — 404 when not found', async () => {
      hostService.getRun.mockResolvedValueOnce(null as any);
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/missing' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        ok: false,
        error: {
          code: 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND',
          message: 'Workflow run missing was not found.',
          hint: 'Run "kb workflow runs list" to inspect available runs.',
        },
      });
    });

    it('POST /api/v1/runs/:runId/cancel — cancels run', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r1/cancel' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ cancelled: true, runId: 'r1' });
    });

    it('POST /api/v1/runs/:runId/cancel — 404 when not found', async () => {
      hostService.cancelRun.mockRejectedValueOnce(new Error('Run not found'));
      const res = await app.inject({ method: 'POST', url: '/api/v1/runs/missing/cancel' });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/v1/runs/:runId/cancel — 409 when already terminal', async () => {
      hostService.cancelRun.mockRejectedValueOnce(new Error('Cannot cancel run in status: success'));
      const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r1/cancel' });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_WORKFLOW_RUN_CANCEL_CONFLICT' } });
      expect(body.error.message.toLowerCase()).toContain('finished');
    });

    it('old /workflows/runs/:runId/cancel path returns 404', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/workflows/runs/r1/cancel' });
      expect(res.statusCode).toBe(404);
    });

    it('GET /api/v1/runs/:runId/logs — returns run logs with envelope', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r1/logs' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data.runId).toBe('r1');
      expect(body.data.logs).toHaveLength(1);
      expect(body.data.logs[0]).toMatchObject({ level: 'info', message: 'Executing step' });
      expect(hostService.getRunLogs).toHaveBeenCalledWith('r1', {
        stepId: undefined,
        level: undefined,
        limit: undefined,
        offset: undefined,
      });
    });

    it('GET /api/v1/runs/:runId/logs?stepId= — passes stepId to service', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/runs/r1/logs?stepId=r1%3Ajob%3A0&level=info&limit=20&offset=0',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.stepId).toBe('r1:job:0');
      expect(hostService.getRunLogs).toHaveBeenCalledWith('r1', {
        stepId: 'r1:job:0',
        level: 'info',
        limit: 20,
        offset: 0,
      });
    });

    it('GET /api/v1/runs/:runId/logs — 500 on service error', async () => {
      hostService.getRunLogs.mockRejectedValueOnce(new Error('storage unavailable'));
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r1/logs' });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_WORKFLOW_RUN_LOGS_FAILED', message: 'storage unavailable' } });
    });
  });

  // ── Approvals ────────────────────────────────────────────────────────

  describe('Approvals', () => {
    it('GET /api/v1/runs/:runId/approvals — lists pending approvals', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r1/approvals' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data.runId).toBe('r1');
      expect(body.data.pending).toHaveLength(1);
      expect(body.data.pending[0]).toMatchObject({ stepId: 's1', stepName: 'approve me' });
    });

    it('GET /api/v1/runs/:runId/approvals — 404 when run not found', async () => {
      hostService.getRun.mockResolvedValueOnce(null as any);
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/missing/approvals' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND', message: 'Workflow run missing was not found.' } });
    });

    it('GET /api/v1/runs/:runId/approvals — empty list when no pending steps', async () => {
      hostService.getRun.mockResolvedValueOnce({ id: 'r1', status: 'running', jobs: [{ id: 'j1', steps: [{ id: 's1', status: 'running', spec: {} }] }] } as any);
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r1/approvals' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.pending).toHaveLength(0);
    });

    it('POST /api/v1/runs/:runId/approvals/resolve — approves step', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/runs/r1/approvals/resolve',
        payload: { jobId: 'j1', stepId: 's1', action: 'approve' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ action: 'approve', resolved: true });
      expect(engine.resolveApproval).toHaveBeenCalledWith('r1', 'j1', 's1', 'approve', undefined, undefined);
    });

    it('POST /api/v1/runs/:runId/approvals/resolve — rejects step', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/runs/r1/approvals/resolve',
        payload: { jobId: 'j1', stepId: 's1', action: 'reject', comment: 'not good' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ action: 'reject', resolved: true });
      expect(engine.resolveApproval).toHaveBeenCalledWith('r1', 'j1', 's1', 'reject', undefined, 'not good');
    });

    it('POST /api/v1/runs/:runId/approvals/resolve — 400 on missing fields', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/runs/r1/approvals/resolve',
        payload: { jobId: 'j1' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_APPROVAL_INPUT_INVALID' } });
    });

    it('POST /api/v1/runs/:runId/approvals/resolve — 400 on invalid action', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/runs/r1/approvals/resolve',
        payload: { jobId: 'j1', stepId: 's1', action: 'maybe' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_APPROVAL_INPUT_INVALID' } });
    });

    it('POST /api/v1/runs/:runId/approvals/resolve — 404 when run not found', async () => {
      hostService.getRun.mockResolvedValueOnce(null as any);
      const res = await app.inject({
        method: 'POST', url: '/api/v1/runs/missing/approvals/resolve',
        payload: { jobId: 'j1', stepId: 's1', action: 'approve' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND' } });
    });

    it('POST /api/v1/runs/:runId/approvals/resolve — 409 when step not waiting', async () => {
      hostService.getRun.mockResolvedValueOnce({
        id: 'r1', status: 'running',
        jobs: [{ id: 'j1', steps: [{ id: 's1', name: 'x', status: 'success', spec: {} }] }],
      } as any);
      const res = await app.inject({
        method: 'POST', url: '/api/v1/runs/r1/approvals/resolve',
        payload: { jobId: 'j1', stepId: 's1', action: 'approve' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ ok: false, error: { code: 'KB_RUNTIME_APPROVAL_NOT_PENDING' } });
    });

    it('old /runs/:runId/pending-approvals path returns 404', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/runs/r1/pending-approvals' });
      expect(res.statusCode).toBe(404);
    });

    it('old /runs/:runId/approve path returns 404', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/runs/r1/approve', payload: {} });
      expect(res.statusCode).toBe(404);
    });
  });
});
