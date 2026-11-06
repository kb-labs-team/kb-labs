import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient } from '../helpers/defaults.js';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import type { WorkflowRunSummary } from '../../http-client.js';
import runsListCommand from '../../commands/runs-list.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

const sampleRuns: WorkflowRunSummary[] = [
  { id: 'r-001', workflowId: 'e2e-hello', name: 'e2e-hello', status: 'success', createdAt: new Date().toISOString(), durationMs: 1200 },
  { id: 'r-002', workflowId: 'e2e-world', name: 'e2e-world', status: 'running', createdAt: new Date().toISOString() },
];

beforeEach(() => {
  MockedClient.mockReset();
});

describe('workflow:runs list', () => {
  it('CL-01: renders table when runs exist', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async () => sampleRuns,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(captured.table.length).toBeGreaterThan(0);
    expect(captured.table[0]!.rows.length).toBe(2);
  });

  // case: S-002.5
  it('CL-02: --json returns array of WorkflowRunSummary', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async () => sampleRuns,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    const payload = result as typeof sampleRuns;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBe(2);
    expect(payload[0]).toMatchObject({ id: 'r-001', workflowId: 'e2e-hello', status: 'success' });
  });

  it('CL-03: --status running filters by status', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async (params: { status?: string; limit?: number; workflowId?: string } = {}) => {
          expect(params.status).toBe('running');
          return [sampleRuns[1]!];
        },
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await runsListCommand.execute(ctx, mockCLIInput({ flags: { status: 'running' } }));

    expect(captured.table[0]?.rows.length).toBe(1);
  });

  it('CL-04: --limit 5 passes limit to client', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async (params: { status?: string; limit?: number; workflowId?: string } = {}) => {
          expect(params.limit).toBe(5);
          return sampleRuns.slice(0, 1);
        },
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: { limit: 5 } }));

  });

  it('CL-05: --workflow filters by workflowId', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async (params: { status?: string; limit?: number; workflowId?: string } = {}) => {
          expect(params.workflowId).toBe('e2e-hello');
          return [sampleRuns[0]!];
        },
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await runsListCommand.execute(ctx, mockCLIInput({ flags: { workflow: 'e2e-hello' } }));
  });

  it('CL-06: empty list renders empty state, does not throw', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async () => [],
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(captured.errors.length).toBe(0);
  });

  it('CL-07: daemon unavailable — error message, exitCode 1', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async () => { throw new Error('ECONNREFUSED'); },
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('CL-09: future startedAt renders as "just now" (not negative)', async () => {
    const futureDate = new Date(Date.now() + 60_000).toISOString();
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async () => [
          { id: 'r-future', workflowId: 'future-run', name: 'future-run', status: 'running', createdAt: futureDate, startedAt: futureDate },
        ],
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    const row = captured.table[0]!.rows[0]!;
    const whenCell = row['When'] as string;
    expect(whenCell).toBe('just now');
    expect(whenCell).not.toMatch(/-\d/);
  });

  it('CL-08: --limit "3" (string) passes limit=3 to client', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async (params: { status?: string; limit?: number; workflowId?: string } = {}) => {
          expect(params.limit).toBe(3);
          return sampleRuns.slice(0, 1);
        },
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: { limit: '3' as unknown as number } }));

  });

  it('CL-11: RUNNING run with currentStepName shows step name in Step column', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async () => [
          { id: 'r-run', workflowId: 'ci', name: 'ci', status: 'running', createdAt: new Date().toISOString(), currentStepName: 'build-image' },
        ],
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    const row = captured.table[0]!.rows[0]!;
    expect(row['Step']).toBe('build-image');
  });

  it('CL-12: non-RUNNING run has empty Step column', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async () => [
          { id: 'r-done', workflowId: 'ci', name: 'ci', status: 'success', createdAt: new Date().toISOString(), currentStepName: undefined },
        ],
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    const row = captured.table[0]!.rows[0]!;
    expect(row['Step']).toBe('');
  });

  it('CL-13: --workflow filters runs by workflow name', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async (params: { status?: string; limit?: number; workflowId?: string } = {}) => {
          expect(params.workflowId).toBe('deploy-prod');
          return [{ id: 'r-dep', workflowId: 'deploy-prod', name: 'deploy-prod', status: 'success' as const, createdAt: new Date().toISOString() }];
        },
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: { workflow: 'deploy-prod' } }));

    expect(captured.table[0]!.rows.length).toBe(1);
    expect(captured.table[0]!.rows[0]!['Workflow']).toBe('deploy-prod');
  });

  it('CL-14: RUNNING run with waiting_approval step shows step name in Step column', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async () => [
          {
            id: 'r-approval',
            workflowId: 'deploy',
            name: 'deploy',
            status: 'running' as const,
            createdAt: new Date().toISOString(),
            hasPendingApproval: true,
            currentStepName: 'await-gate',
          },
        ],
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await runsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    const row = captured.table[0]!.rows[0]!;
    expect(row['Step']).toBe('await-gate');
  });

  it('CL-10: formatDuration returns "0ms" for durationMs=0 (BUG-007)', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        listRuns: async () => [
          { id: 'r-003', workflowId: 'instant', name: 'instant', status: 'success' as const, createdAt: new Date().toISOString(), durationMs: 0 },
        ],
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    await runsListCommand.execute(ctx, mockCLIInput({ flags: {} }));

    const durCell = captured.table[0]?.rows[0]?.['Dur'];
    expect(durCell).toBe('0ms');
  });
});
