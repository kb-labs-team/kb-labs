import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
const mockRunWorkflow = vi.hoisted(() => vi.fn());

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: class WorkflowDaemonClientMock {
    runWorkflow(...args: Parameters<typeof mockRunWorkflow>) { return mockRunWorkflow(...args); }
  },
}));

import workflowRunCommand from '../../commands/workflow-run.js';

beforeEach(() => {
  mockRunWorkflow.mockReset();
});

describe('workflow:run', () => {
  it('CR-01: submits workflow and returns runId', async () => {
    mockRunWorkflow.mockResolvedValue({ runId: 'r-123', status: 'queued' });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await workflowRunCommand.execute(
      ctx,
      mockCLIInput({ flags: { 'workflow-id': 'e2e-hello' } }),
    );

    expect(captured.success[0]?.message).toBeTruthy();
  });

  it('CR-02: --json returns { ok: true, data: { runId, status } }', async () => {
    mockRunWorkflow.mockResolvedValue({ runId: 'r-123', status: 'queued' });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await workflowRunCommand.execute(
      ctx,
      mockCLIInput({ flags: { 'workflow-id': 'e2e-hello', json: true } }),
    );

    expect(result).toMatchObject({ runId: 'r-123', status: 'queued' });
  });

  it('CR-03: --input passes JSON payload to runWorkflow', async () => {
    let capturedRequest: unknown;
    mockRunWorkflow.mockImplementation(async (_id: string, req: unknown) => {
      capturedRequest = req;
      return { runId: 'r-123', status: 'queued' };
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await workflowRunCommand.execute(
      ctx,
      mockCLIInput({ flags: { 'workflow-id': 'e2e-hello', input: '{"key":"val"}' } }),
    );

    expect((capturedRequest as { input?: unknown })?.input).toEqual({ key: 'val' });
  });

  it('CR-04: --input with nested JSON object passes full payload to runWorkflow', async () => {
    let capturedRequest: unknown;
    mockRunWorkflow.mockImplementation(async (_id: string, req: unknown) => {
      capturedRequest = req;
      return { runId: 'r-123', status: 'queued' };
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const payload = {
      invoice_payload: {
        vendor: 'Acme Corp',
        amount: 15000,
        currency: 'USD',
        line_items: [{ desc: 'Consulting', qty: 1, unit_price: 15000 }],
      },
    };
    await workflowRunCommand.execute(
      ctx,
      mockCLIInput({ flags: { 'workflow-id': 'invoice-approval', input: JSON.stringify(payload) } }),
    );

    expect((capturedRequest as { input?: unknown })?.input).toEqual(payload);
  });

  it('CR-05: missing --workflow-id returns exitCode 1 with error', async () => {
    mockRunWorkflow.mockResolvedValue({ runId: 'r-x', status: 'queued' });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await workflowRunCommand.execute(
      ctx,
      mockCLIInput({ flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('CR-06: daemon unavailable — readable error, exitCode 1', async () => {
    mockRunWorkflow.mockRejectedValue(new Error('ECONNREFUSED'));

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await workflowRunCommand.execute(
      ctx,
      mockCLIInput({ flags: { 'workflow-id': 'e2e-hello' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('CR-07: invalid --isolation value returns exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await workflowRunCommand.execute(
      ctx,
      mockCLIInput({ flags: { 'workflow-id': 'e2e-hello', isolation: 'invalid-mode', json: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_INPUT_INVALID', hint: expect.any(String) },
    });
  });

  it('rejects cron as a manual trigger type because schedules are cron entities', async () => {
    const { ui, captured } = createCapturedUI();
    const result = await workflowRunCommand.execute(
      createMockContext({ ui }),
      mockCLIInput({ flags: { 'workflow-id': 'e2e-hello', 'trigger-type': 'cron', json: true } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_INPUT_INVALID', message: expect.stringContaining('Expected manual'), hint: expect.any(String) },
    });
    expect(mockRunWorkflow).not.toHaveBeenCalled();
  });
});
