import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient } from '../helpers/defaults.js';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import runsLogsCommand from '../../commands/runs-logs.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

const sampleLogs = [
  { level: 'info' as const, message: 'Step started', timestamp: new Date().toISOString() },
  { level: 'warn' as const, message: 'Retrying step', timestamp: new Date().toISOString(), stepName: 'build' },
  { level: 'error' as const, message: 'Step failed', timestamp: new Date().toISOString(), stepId: 'step-3' },
];

beforeEach(() => {
  MockedClient.mockReset();
});

describe('workflow:runs-logs', () => {
  it('RLG-01: positional runId renders log lines', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getRunLogs: async () => sampleLogs,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsLogsCommand.execute(ctx, mockCLIInput({ flags: {}, argv: ['r-123'] }));

    expect(captured.logs.length).toBe(3);
    expect(captured.logs[0]?.message).toContain('Step started');
  });

  // case: S-029.3
  it('renders persisted command output tails with the failed workflow log message', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ getRunLogs: async () => [{
        level: 'warn',
        message: 'Shell command failed',
        timestamp: new Date().toISOString(),
        context: { stdoutTail: 'journey-failure-diagnostic', stderrTail: 'command detail' },
      }] });
    });

    const { ui, captured } = createCapturedUI();
    await runsLogsCommand.execute(createMockContext({ ui }), mockCLIInput({ flags: {}, argv: ['failed-run'] }));

    expect(captured.logs.map((entry) => entry.message).join('\n')).toContain('journey-failure-diagnostic');
    expect(captured.logs.map((entry) => entry.message).join('\n')).toContain('command detail');
  });

  it('RLG-02: --run-id flag form renders log lines', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getRunLogs: async () => sampleLogs,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsLogsCommand.execute(ctx, mockCLIInput({ flags: { 'run-id': 'r-456' } }));

    expect(captured.logs.length).toBe(3);
  });

  it('RLG-03: --json returns { ok: true, data: { logs } }', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getRunLogs: async () => sampleLogs,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsLogsCommand.execute(ctx, mockCLIInput({ flags: { json: true }, argv: ['r-123'] }));

    const payload = result as { logs: typeof sampleLogs };
    expect(Array.isArray(payload.logs)).toBe(true);
    expect(payload.logs.length).toBe(3);
  });

  it('RLG-04: missing runId returns exitCode 1 with validation error message', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsLogsCommand.execute(ctx, mockCLIInput({ flags: {}, argv: [] }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('Missing run ID') } });
  });

  it('RLG-07: --step passes stepId to getRunLogs', async () => {
    let capturedParams: { stepId?: string } = {};
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getRunLogs: async (_runId: string, params: { stepId?: string }) => {
          capturedParams = params;
          return [];
        },
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await runsLogsCommand.execute(ctx, mockCLIInput({ flags: { step: 'build' }, argv: ['r-123'] }));

    expect(capturedParams.stepId).toBe('build');
  });

  it('RLG-05: --log-failed passes failedOnly to getRunLogs', async () => {
    let capturedParams: { failedOnly?: boolean } = {};
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getRunLogs: async (_runId: string, params: { failedOnly?: boolean }) => {
          capturedParams = params;
          return [];
        },
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await runsLogsCommand.execute(ctx, mockCLIInput({ flags: { 'log-failed': true }, argv: ['r-123'] }));

    expect(capturedParams.failedOnly).toBe(true);
  });

  it('RLG-06: daemon unavailable returns exitCode 1', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getRunLogs: async () => { throw new Error('ECONNREFUSED'); },
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsLogsCommand.execute(ctx, mockCLIInput({ flags: {}, argv: ['r-123'] }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });
});
