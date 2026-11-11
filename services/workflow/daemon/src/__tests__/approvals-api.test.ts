import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '@kb-labs/shared-testing';
import { createServer } from '../server.js';

function makeStep(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-1',
    name: 'Approval Step',
    status: 'waiting_approval',
    startedAt: '2026-05-23T10:00:00.000Z',
    spec: {
      id: 'approval-step',
      uses: 'builtin:approval',
      with: {
        message: '${{ steps.prep.outputs.summary }}',
        raw: 'hardcoded',
      },
    },
    ...overrides,
  };
}

function makeRun(stepOverrides: Record<string, unknown> = {}) {
  return {
    id: 'run-123',
    metadata: { workflowId: 'approval-test' },
    jobs: [
      {
        id: 'run-123:job-a',
        steps: [makeStep(stepOverrides)],
      },
    ],
  };
}

function createWorkflowServer(runOverride?: Record<string, unknown>) {
  const run = runOverride ?? makeRun();

  const engine = {
    getRun: vi.fn(async (id: string) => (id === run.id ? run : null)),
    resolveApproval: vi.fn(async () => {}),
    getMetrics: vi.fn(async () => ({
      runs: { total: 0, queued: 0, running: 0, success: 0, failed: 0, cancelled: 0, dlq: 0 },
      jobs: { total: 0, queued: 0, running: 0, success: 0, failed: 0 },
    })),
  };

  const server = createServer({
    engine: engine as any,
    jobBroker: {} as any,
    workflowService: { listAll: vi.fn(), get: vi.fn() } as any,
    cronScheduler: {} as any,
    logger: mockLogger(),
  });

  return { server, engine };
}

describe('approvals API (BUG-003)', () => {
  const servers: Array<Awaited<ReturnType<typeof createWorkflowServer>>['server']> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      const s = servers.pop();
      if (s) { await (await s).close(); }
    }
  });

  it('returns resolvedInputs as context when available (not raw spec.with)', async () => {
    const interpolatedInputs = {
      message: 'Invoice #42 — $750',
      raw: 'hardcoded',
    };
    const run = makeRun({ resolvedInputs: interpolatedInputs });
    const { server } = createWorkflowServer(run);
    const srv = await server;
    servers.push(Promise.resolve(srv));

    const response = await srv.inject({
      method: 'GET',
      url: '/api/v1/runs/run-123/approvals',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.pending).toHaveLength(1);
    // resolvedInputs takes precedence — must not be the raw template string
    expect(body.data.pending[0].context.message).toBe('Invoice #42 — $750');
    expect(body.data.pending[0].context.raw).toBe('hardcoded');
  });

  it('falls back to spec.with when resolvedInputs is absent', async () => {
    const run = makeRun(); // no resolvedInputs
    const { server } = createWorkflowServer(run);
    const srv = await server;
    servers.push(Promise.resolve(srv));

    const response = await srv.inject({
      method: 'GET',
      url: '/api/v1/runs/run-123/approvals',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.pending[0].context.message).toBe('${{ steps.prep.outputs.summary }}');
    expect(body.data.pending[0].context.raw).toBe('hardcoded');
  });

  it('returns 404 for unknown run', async () => {
    const { server } = createWorkflowServer();
    const srv = await server;
    servers.push(Promise.resolve(srv));

    const response = await srv.inject({
      method: 'GET',
      url: '/api/v1/runs/unknown-run/approvals',
    });

    expect(response.statusCode).toBe(404);
  });
});
