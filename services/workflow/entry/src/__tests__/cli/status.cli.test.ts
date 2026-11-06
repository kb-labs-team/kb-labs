import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient } from '../helpers/defaults.js';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(class WorkflowDaemonClientMock {}),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import type { JobStatusDetail } from '../../http-client.js';
import statusCommand from '../../commands/status.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

const runningJob: JobStatusDetail = {
  id: 'job-abc',
  type: 'workflow',
  status: 'running',
  createdAt: new Date().toISOString(),
  jobs: [
    {
      id: 'j-1',
      name: 'build',
      status: 'running',
      durationMs: 500,
      steps: [
        { id: 's-1', name: 'install', status: 'success', durationMs: 200 },
        { id: 's-2', name: 'compile', status: 'running' },
      ],
    },
  ],
};

beforeEach(() => {
  MockedClient.mockReset();
});

describe('workflow job status', () => {
  it('CS-01: positional job ID renders status with jobs and steps', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getJobStatus: async () => runningJob,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await statusCommand.execute(ctx, mockCLIInput({ argv: ['job-abc'] }));

    expect(captured.success.length).toBeGreaterThan(0);
  });

  // case: S-185.2
  it('CS-02: --json returns { ok: true, data: JobStatusDetail }', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getJobStatus: async () => runningJob,
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await statusCommand.execute(ctx, mockCLIInput({ argv: ['job-abc'], flags: { json: true } }));

    const payload = result as JobStatusDetail;
    expect(payload.id).toBe('job-abc');
    expect(payload.status).toBe('running');
  });

  it('CS-03: missing --job-id returns exitCode 1 with error message', async () => {
    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await statusCommand.execute(ctx, mockCLIInput({ argv: [] }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('CS-04: daemon unavailable returns exitCode 1 with readable message', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getJobStatus: async () => { throw new Error('ECONNREFUSED'); },
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await statusCommand.execute(ctx, mockCLIInput({ argv: ['job-abc'] }));

    expect(result).toHaveProperty('ok', false);
    expect(result).toMatchObject({ ok: false, error: { hint: expect.any(String) } });
  });

  it('CS-05: job in running state renders status without throwing', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({
        getJobStatus: async () => ({
          id: 'job-xyz',
          type: 'workflow',
          status: 'running',
          createdAt: new Date().toISOString(),
        }),
      });
    });

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await statusCommand.execute(ctx, mockCLIInput({ argv: ['job-xyz'] }));

    expect(captured.errors.length).toBe(0);
  });

});
