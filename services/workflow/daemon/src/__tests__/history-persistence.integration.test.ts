import { describe, expect, it } from 'vitest';
import { InMemoryCache, InMemoryEventBus, InMemoryStorage } from '@kb-labs/core-platform/inmemory';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import { mockLogger } from '@kb-labs/shared-testing';
import { EnvSecretProvider, WorkflowEngine } from '@kb-labs/workflow-engine';
import { JobBroker } from '../job-broker.js';
import { WorkflowHostService } from '../host/workflow-host-service.js';

describe('workflow history after daemon restart', () => {
  it('serves history, detail, and logs from project storage with a fresh daemon cache', async () => {
    const storage = new InMemoryStorage();
    const firstEngine = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(),
      cache: new InMemoryCache(), storage, events: new InMemoryEventBus(), logger: mockLogger(),
    });
    const run = await firstEngine.createRun({
      spec: {
        name: 'persisted-workflow', version: '1.0.0', on: { manual: true },
        jobs: { main: { runsOn: 'local', steps: [{ id: 'print', name: 'Print line', uses: 'builtin:shell', with: { command: 'echo persisted-after-restart' } }] } },
      },
      trigger: { type: 'manual' },
      metadata: { workflowId: 'persisted-workflow' },
    });
    const job = run.jobs[0]!;
    const step = job.steps[0]!;
    await firstEngine.markJobStarted(run.id, job.id);
    await firstEngine.markStepStarted(run.id, job.id, step.id);
    await firstEngine.markStepCompleted(run.id, job.id, step.id, { stdout: 'persisted-after-restart\n', stderr: '' });
    await firstEngine.markJobCompleted(run.id, job.id);

    const restartedEngine = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      secretProvider: new EnvSecretProvider(),
      cache: new InMemoryCache(), storage, events: new InMemoryEventBus(), logger: mockLogger(),
    });
    const logger = mockLogger();
    const jobBroker = new JobBroker(restartedEngine, logger, {
      logs: { query: async () => ({ logs: [] }) },
    } as unknown as PlatformContainer);
    const hostService = new WorkflowHostService({ engine: restartedEngine, jobBroker, logger });

    await expect(hostService.listRuns({ workflowId: 'persisted-workflow' })).resolves.toMatchObject({
      total: 1, runs: [{ id: run.id, name: 'persisted-workflow', status: 'success' }],
    });
    await expect(hostService.getRun(run.id)).resolves.toMatchObject({
      id: run.id, workflowId: 'persisted-workflow', status: 'success',
    });
    await expect(hostService.getRunLogs(run.id)).resolves.toMatchObject([{
      message: 'persisted-after-restart', stepId: run.jobs[0]?.steps[0]?.id,
      stepName: 'Print line', stream: 'stdout',
    }]);
  });
});
