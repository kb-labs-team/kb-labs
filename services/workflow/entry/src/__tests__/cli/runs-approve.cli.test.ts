import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient, defaultWorkflowClient } from '../helpers/defaults.js';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import runsApproveCommand from '../../commands/runs-approve.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

const PENDING_STEP = {
  jobId: 'job-001',
  stepId: 'step-review',
  stepName: 'Human Review',
  context: {},
};

beforeEach(() => {
  MockedClient.mockReset();
});

describe('workflow:runs approve', () => {
  it('RAP-01: approves the single pending step and prints confirmation', async () => {
    const listPendingApprovals = vi.fn().mockResolvedValue({ runId: 'run-abc', pending: [PENDING_STEP] });
    const resolveApproval = vi.fn().mockResolvedValue({ runId: 'run-abc', jobId: 'job-001', stepId: 'step-review', action: 'approve', resolved: true });
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ ...defaultWorkflowClient, listPendingApprovals, resolveApproval });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: {} }),
    );

    expect(listPendingApprovals).toHaveBeenCalledWith('run-abc');
    expect(resolveApproval).toHaveBeenCalledWith('run-abc', 'job-001', 'step-review', 'approve', undefined);
    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('Approved');
  });

  it('RAP-02: rejects step when --action=reject is passed', async () => {
    const listPendingApprovals = vi.fn().mockResolvedValue({ runId: 'run-abc', pending: [PENDING_STEP] });
    const resolveApproval = vi.fn().mockResolvedValue({ runId: 'run-abc', jobId: 'job-001', stepId: 'step-review', action: 'reject', resolved: true });
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ ...defaultWorkflowClient, listPendingApprovals, resolveApproval });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: { action: 'reject', comment: 'Needs rework' } }),
    );

    expect(resolveApproval).toHaveBeenCalledWith('run-abc', 'job-001', 'step-review', 'reject', 'Needs rework');
    expect(captured.success[0]?.message).toContain('Rejected');
  });

  it('RAP-03: --json outputs { ok: true, data: { ... } }', async () => {
    const resolvedPayload = { runId: 'run-abc', jobId: 'job-001', stepId: 'step-review', action: 'approve', resolved: true };
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        listPendingApprovals: vi.fn().mockResolvedValue({ runId: 'run-abc', pending: [PENDING_STEP] }),
        resolveApproval: vi.fn().mockResolvedValue(resolvedPayload),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: { json: true } }),
    );

    expect(result).toEqual(resolvedPayload);
  });

  it('RAP-04: explicit --job-id + --step-id bypasses list call', async () => {
    const listPendingApprovals = vi.fn();
    const resolveApproval = vi.fn().mockResolvedValue({ runId: 'run-abc', jobId: 'job-001', stepId: 'step-x', action: 'approve', resolved: true });
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ ...defaultWorkflowClient, listPendingApprovals, resolveApproval });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: { 'job-id': 'job-001', 'step-id': 'step-x' } }),
    );

    expect(listPendingApprovals).not.toHaveBeenCalled();
    expect(resolveApproval).toHaveBeenCalledWith('run-abc', 'job-001', 'step-x', 'approve', undefined);
  });

  it('RAP-05: no pending approvals returns exitCode 1 with clear message', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        listPendingApprovals: vi.fn().mockResolvedValue({ runId: 'run-abc', pending: [] }),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('RAP-06: multiple pending approvals returns exitCode 1 with list', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        listPendingApprovals: vi.fn().mockResolvedValue({
          runId: 'run-abc',
          pending: [
            { jobId: 'job-001', stepId: 'step-a', stepName: 'Review A', context: {} },
            { jobId: 'job-002', stepId: 'step-b', stepName: 'Review B', context: {} },
          ],
        }),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('RAP-07: missing runId returns exitCode 1 with validation error', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient(defaultWorkflowClient);
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('RAP-08: invalid action value returns exitCode 1', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient(defaultWorkflowClient);
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: { action: 'skip' } }),
    );

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('RAP-09: daemon error on resolve returns exitCode 1', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        listPendingApprovals: vi.fn().mockResolvedValue({ runId: 'run-abc', pending: [PENDING_STEP] }),
        resolveApproval: vi.fn().mockRejectedValue(new Error('Step is not waiting for approval')),
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: ['run-abc'], flags: {} }),
    );

    expect(result).toHaveProperty('ok', false);
  });

  it('RAP-10: --run-id flag works as alias for positional argument', async () => {
    const resolveApproval = vi.fn().mockResolvedValue({ runId: 'run-flag-001', jobId: 'job-001', stepId: 'step-review', action: 'approve', resolved: true });
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        ...defaultWorkflowClient,
        listPendingApprovals: vi.fn().mockResolvedValue({ runId: 'run-flag-001', pending: [PENDING_STEP] }),
        resolveApproval,
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsApproveCommand.execute(
      ctx,
      mockCLIInput({ argv: [], flags: { 'run-id': 'run-flag-001' } }),
    );

    expect(resolveApproval).toHaveBeenCalledWith('run-flag-001', expect.any(String), expect.any(String), 'approve', undefined);
  });
});
