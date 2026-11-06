import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient } from '../helpers/defaults.js';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));

vi.mock('@kb-labs/sdk', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    useLoader: () => ({
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      update: vi.fn(),
    }),
  };
});

import { WorkflowDaemonClient } from '../../http-client.js';
import jobRunCommand from '../../commands/run.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

beforeEach(() => {
  MockedClient.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('workflow job run', () => {
  // case: S-185.1
  it('CJR-01: --handler submits job and prints jobId, exitCode 0', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        submitJob: async () => ({ id: 'job-abc', status: 'queued' }),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await jobRunCommand.execute(ctx, mockCLIInput({ flags: { handler: 'foo#default' } }));

    expect(captured.success.length).toBeGreaterThan(0);
  });

  it('CJR-02: --json returns { ok: true, data: { id, status: queued } }', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        submitJob: async () => ({ id: 'job-abc', status: 'queued' }),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await jobRunCommand.execute(ctx, mockCLIInput({ flags: { handler: 'foo#default', json: true } }));

    const payload = result as { id: string; status: string };
    expect(payload.id).toBe('job-abc');
    expect(payload.status).toBe('queued');
  });

  it('CJR-03: --input passes parsed JSON to submitJob', async () => {
    let capturedPayload: unknown;
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        submitJob: async (params) => {
          capturedPayload = params.input;
          return { id: 'job-xyz', status: 'queued' };
        },
      });
    });

    const { ui } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await jobRunCommand.execute(ctx, mockCLIInput({
      flags: { handler: 'foo#default', input: '{"key":"val"}' },
    }));

    expect(capturedPayload).toEqual({ key: 'val' });
  });

  it('CJR-04: --input with invalid JSON returns exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await jobRunCommand.execute(ctx, mockCLIInput({
      flags: { handler: 'foo#default', input: '{not-valid-json', json: true },
    }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_INPUT_INVALID', hint: expect.any(String) },
    });
  });

  // case: S-185.3
  it('CJR-05: --wait returns the final success status in the result envelope', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        submitJob: async () => ({ id: 'job-wait', status: 'queued' }),
        getJobStatus: async () => ({
          id: 'job-wait',
          type: 'workflow',
          status: 'success',
          createdAt: new Date().toISOString(),
        }),
      });
    });

    vi.useFakeTimers();

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const resultPromise = jobRunCommand.execute(ctx, mockCLIInput({
      flags: { handler: 'foo#default', wait: true, json: true },
    }));

    await vi.advanceTimersByTimeAsync(120_000);
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 'success' });
  });

  it('CJR-05 failure: --wait reports a catalogued failure envelope', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        submitJob: async () => ({ id: 'job-failed', status: 'queued' }),
        getJobStatus: async () => ({ id: 'job-failed', type: 'workflow', status: 'failed' }),
      });
    });

    vi.useFakeTimers();
    const { ui, captured } = createCapturedUI();
    const resultPromise = jobRunCommand.execute(
      createMockContext({ ui }),
      mockCLIInput({ flags: { handler: 'foo#default', wait: true, json: true } }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await resultPromise;

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_COMMAND_FAILED', hint: expect.any(String) },
    });
  });

  it('CJR-06: missing --handler returns exitCode 1', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await jobRunCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'KB_RUNTIME_INPUT_INVALID', hint: expect.any(String) },
    });
  });

  it('CJR-07: daemon unavailable returns exitCode 1', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        submitJob: async () => { throw new Error('ECONNREFUSED'); },
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await jobRunCommand.execute(ctx, mockCLIInput({ flags: { handler: 'foo#default' } }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });
});
