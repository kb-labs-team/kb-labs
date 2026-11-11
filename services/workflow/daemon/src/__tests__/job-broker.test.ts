import { describe, expect, it, vi } from 'vitest';
import { NoOpLogger } from '@kb-labs/core-platform/noop';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import { JobBroker } from '../job-broker.js';

describe('JobBroker', () => {
  // case: S-185.1
  it('persists the generated workflow identity for platform job runs', async () => {
    const runFromInline = vi.fn(async () => ({ id: 'job-run-1', status: 'queued' }));
    const broker = new JobBroker(
      { runFromInline } as unknown as WorkflowEngine,
      new NoOpLogger(),
      {} as unknown as PlatformContainer,
    );

    await broker.submit({ handler: 'fixture:background-task', input: { value: 'hello' } });

    expect(runFromInline).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'job-fixture:background-task' }),
      expect.objectContaining({
        metadata: expect.objectContaining({ workflowId: 'job-fixture:background-task' }),
      }),
    );
  });
});
