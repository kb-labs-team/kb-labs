import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient, defaultWorkflowClient } from '../helpers/defaults.js';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import runsWatchCommand from '../../commands/runs-watch.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

/** Builds a minimal ReadableStream that emits SSE-formatted lines then closes. */
function makeSseStream(events: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = events
    .map((e) => {
      const obj: Record<string, unknown> = { type: e.type, payload: e.payload ?? {} };
      if (e.stepId !== undefined) obj['stepId'] = e.stepId;
      return `data: ${JSON.stringify(obj)}\n\n`;
    })
    .join('');

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

/** Mocks globalThis.fetch to return a streaming SSE response. */
function mockFetchWithSse(events: Array<{ type: string; stepId?: string; payload?: Record<string, unknown> }>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: makeSseStream(events),
  }));
}

beforeEach(() => {
  MockedClient.mockReset();
  MockedClient.mockImplementation(function MockedClientImplementation() {
    return makeClient({
      ...defaultWorkflowClient,
      getRunEventsUrl: (runId: string) => `http://127.0.0.1:4000/api/v1/projects/prj_0123456789abcdef/workflow/runs/${runId}/events`,
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workflow:runs watch', () => {
  // case: S-027.2
  it('renders active snapshot steps and later step transitions with their workflow IDs', async () => {
    mockFetchWithSse([
      {
        type: 'run.snapshot',
        payload: {
          status: 'running',
          jobs: [{
            id: 'job-uuid',
            steps: [{
              id: 'step-uuid',
              name: 'First visible step',
              status: 'running',
              spec: { id: 'first-id' },
            }],
          }],
        },
      },
      { type: 'step.succeeded', stepId: 'step-uuid', payload: { status: 'success' } },
      { type: 'run.finished', payload: { status: 'success' } },
    ]);

    const { ui, captured } = createCapturedUI();
    await runsWatchCommand.execute(createMockContext({ ui }), mockCLIInput({ argv: ['run-abc'] }));

    expect(captured.writes.some((line) => line.includes('step.started') && line.includes('step:first-id'))).toBe(true);
    expect(captured.writes.some((line) => line.includes('step.succeeded') && line.includes('step:first-id'))).toBe(true);
  });

  it('CW-01: no runId and no runs → exitCode 0, info message', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        listRuns: async () => [],
        getRunEventsUrl: (runId: string) => `http://127.0.0.1:4000/api/v1/projects/prj_0123456789abcdef/workflow/runs/${runId}/events`,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsWatchCommand.execute(ctx, mockCLIInput({ argv: [] }));

    expect(captured.infos.some(i => i.message.includes('No runs found'))).toBe(true);
  });

  it('CW-01b: no runId → auto-fetches latest and watches it', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        listRuns: async () => [{ id: 'run-latest', workflowId: 'deploy', name: 'deploy', status: 'running' as const, createdAt: new Date().toISOString() }],
        getRunEventsUrl: (runId: string) => `http://127.0.0.1:4000/api/v1/projects/prj_0123456789abcdef/workflow/runs/${runId}/events`,
      });
    });
    mockFetchWithSse([
      { type: 'run.finished', payload: { status: 'success' } },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsWatchCommand.execute(ctx, mockCLIInput({ argv: [] }));

    expect(captured.infos.some(i => i.message.includes('run-latest'))).toBe(true);
  });

  it('CW-02: streams events until run.finished, exits with 0', async () => {
    mockFetchWithSse([
      { type: 'run.snapshot', payload: { status: 'running' } },
      { type: 'run.finished', payload: { status: 'success' } },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsWatchCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'] }),
    );

    expect(captured.writes.some((w) => w.includes('run.finished') || w.includes('SUCCESS'))).toBe(true);
  });

  it('CW-03: run.failed terminal event exits with 1', async () => {
    mockFetchWithSse([
      { type: 'run.failed', payload: { status: 'failed', error: 'timeout' } },
    ]);

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsWatchCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'] }),
    );

    expect(result).toHaveProperty('ok', false);
  });

  it('CW-04: --json flag emits JSON objects per event', async () => {
    mockFetchWithSse([
      { type: 'run.snapshot', payload: { status: 'running' } },
      { type: 'run.finished', payload: { status: 'success' } },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsWatchCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: { json: true } }),
    );

        const payload = result as { events: Array<{ type: string }> };
    expect(payload.events).toHaveLength(2);
    expect(payload.events[0]?.type).toBe('run.snapshot');
  });

  it('CW-05: daemon connection refused — error message, exitCode 1', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsWatchCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'] }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('CW-06: log.appended events are forwarded to ctx.ui.log()', async () => {
    mockFetchWithSse([
      { type: 'log.appended', payload: { level: 'info', message: 'Step started' } },
      { type: 'run.finished', payload: { status: 'success' } },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await runsWatchCommand.execute(ctx, mockCLIInput({ argv: ['run-abc'] }));

    expect(captured.logs.some((l) => l.message.includes('Step started'))).toBe(true);
  });

  it('CW-07: log.appended with stepName in payload uses step name as prefix, not UUID', async () => {
    mockFetchWithSse([
      {
        type: 'log.appended',
        stepId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        payload: { level: 'info', message: 'Running checks', stepName: 'Check CI' },
      },
      { type: 'run.finished', payload: { status: 'success' } },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await runsWatchCommand.execute(ctx, mockCLIInput({ argv: ['run-abc'] }));

    const logLine = captured.logs.find((l) => l.message.includes('Running checks'));
    expect(logLine).toBeTruthy();
    // Must use human-readable step name, not UUID
    expect(logLine?.message).toContain('[Check CI]');
    expect(logLine?.message).not.toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('CW-08: --logs flag shows only log.appended events, not status events', async () => {
    mockFetchWithSse([
      { type: 'run.snapshot', payload: { status: 'running' } },
      { type: 'step.started', payload: { stepName: 'Build' } },
      { type: 'log.appended', payload: { level: 'info', message: 'Building...', stepName: 'Build' } },
      { type: 'log.appended', payload: { level: 'info', message: 'Done', stepName: 'Build' } },
      { type: 'run.finished', payload: { status: 'success' } },
    ]);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await runsWatchCommand.execute(ctx, mockCLIInput({ argv: ['run-abc'], flags: { logs: true } }));

    // Log lines must appear
    expect(captured.logs.some((l) => l.message.includes('Building...'))).toBe(true);
    expect(captured.logs.some((l) => l.message.includes('Done'))).toBe(true);
    // Status events must NOT appear in writes
    expect(captured.writes.every((w) => !w.includes('run.snapshot') && !w.includes('step.started'))).toBe(true);
  });
});
