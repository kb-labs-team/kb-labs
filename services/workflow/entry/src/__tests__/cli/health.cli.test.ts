import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient } from '../helpers/defaults.js';

// Mock WorkflowDaemonClient before importing the command
vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import healthCommand from '../../commands/health.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failureError(result: unknown): Record<string, unknown> {
  if (!isRecord(result) || !isRecord(result.error)) {
    throw new Error('Expected a workflow command failure envelope.');
  }
  return result.error;
}

function normalizeFailure(error: Record<string, unknown>): Record<string, unknown> {
  const { correlationId, hint, ...fields } = error;
  return {
    ...fields,
    hint: typeof correlationId === 'string' && typeof hint === 'string'
      ? hint.replace(correlationId, '<correlationId>')
      : hint,
  };
}

beforeEach(() => {
  MockedClient.mockReset();
});

describe('workflow:health', () => {
  it('CH-01: prints success message when daemon is healthy', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        health: async () => ({ status: 'ok', service: 'workflow', ts: 1 }),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await healthCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(captured.success.length).toBeGreaterThan(0);
    expect(captured.success[0]?.message).toContain('healthy');
  });

  it('CH-02: --json returns the daemon health status', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        health: async () => ({ status: 'ok', service: 'workflow', ts: 1 }),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await healthCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(result).toEqual({ status: 'ok', service: 'workflow', ts: 1 });
  });

  it('CH-03: daemon unavailable — prints error, returns exitCode 1', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        health: async () => { throw new Error('ECONNREFUSED'); },
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await healthCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  // case: S-203.1
  it('keeps daemon failures identical in human and JSON modes', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ health: async () => { throw new Error('ECONNREFUSED'); } });
    });
    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const humanResult = await healthCommand.execute(ctx, mockCLIInput({ flags: {} }));
    const jsonResult = await healthCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(humanResult).toHaveProperty('ok', false);
    const humanError = failureError(humanResult);
    const jsonError = failureError(jsonResult);
    expect(normalizeFailure(jsonError)).toEqual(normalizeFailure(humanError));
    expect(jsonError.correlationId).toBeTruthy();
    expect(jsonError.hint).toContain(jsonError.correlationId);
  });
});
