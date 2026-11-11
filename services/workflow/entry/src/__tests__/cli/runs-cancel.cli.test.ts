import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient, defaultWorkflowClient } from '../helpers/defaults.js';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import runsCancelCommand from '../../commands/runs-cancel.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

beforeEach(() => {
  MockedClient.mockReset();
});

describe('workflow:runs cancel', () => {
  it('RCX-01: cancels a run and prints confirmation', async () => {
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ ...defaultWorkflowClient, cancelRun });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsCancelCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: {} }),
    );

    expect(cancelRun).toHaveBeenCalledWith('run-abc');
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('Cancellation Requested');
  });

  it('RCX-02: --json outputs { ok: true, data: { runId, cancelled: true } }', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        cancelRun: vi.fn().mockResolvedValue(undefined),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsCancelCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: { json: true } }),
    );

    expect(result).toMatchObject({ runId: 'run-abc', cancelled: true });
  });

  it('RCX-03: --run-id flag works as alias for positional argument', async () => {
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ ...defaultWorkflowClient, cancelRun });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsCancelCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: { 'run-id': 'run-flag-001' } }),
    );

    expect(cancelRun).toHaveBeenCalledWith('run-flag-001');
  });

  it('RCX-04: missing runId returns exitCode 1 and validation error', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient(defaultWorkflowClient);
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsCancelCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('RCX-05: daemon unavailable returns exitCode 1', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        cancelRun: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsCancelCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
  });

  it('RCX-06: daemon returns error (run not found / already finished) returns exitCode 1', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        cancelRun: vi.fn().mockRejectedValue(new Error('Failed to cancel run: Not Found')),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsCancelCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-finished'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });
});
