import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e/cli';
import { makeClient } from '../helpers/defaults.js';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(function WorkflowDaemonClientMock() {}),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import jobListCommand from '../../commands/job-list.js';
import type { JobStatusInfo } from '@kb-labs/workflow-contracts';

const MockedClient = vi.mocked(WorkflowDaemonClient);
const activeJobs: JobStatusInfo[] = [
  { id: 'job-1', type: 'task', status: 'running', createdAt: '2026-10-01T00:00:00Z' },
  { id: 'job-2', type: 'task', status: 'queued', createdAt: '2026-10-01T00:00:00Z' },
];

beforeEach(() => MockedClient.mockReset());

describe('workflow job list', () => {
  // case: S-185.5
  it('lists active raw jobs in JSON', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ getExecutions: async () => activeJobs });
    });
    const { ui, captured } = createCapturedUI();
    const result = await jobListCommand.execute(createMockContext({ ui }), mockCLIInput({ flags: { json: true } }));

    expect(result).toMatchObject({ jobs: activeJobs });
  });

  it('filters by active job status', async () => {
    MockedClient.mockImplementation(function MockedClientImplementation() {
      return makeClient({ getExecutions: async () => activeJobs });
    });
    const { ui, captured } = createCapturedUI();
    const result = await jobListCommand.execute(createMockContext({ ui }), mockCLIInput({ flags: { json: true, status: 'running' } }));

    expect(result).toMatchObject({ jobs: [activeJobs[0]] });
  });
});
