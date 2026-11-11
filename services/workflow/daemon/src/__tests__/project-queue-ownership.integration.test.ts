import { describe, expect, it, vi } from 'vitest';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import { InMemoryCache, InMemoryEventBus, InMemoryStorage } from '@kb-labs/core-platform/inmemory';
import { mockLogger } from '@kb-labs/shared-testing';
import { EnvSecretProvider, WorkflowEngine, type JobQueueEntry } from '@kb-labs/workflow-engine';
import type { JobRun } from '@kb-labs/workflow-contracts';
import { createWorkflowWorker } from '../worker.js';
import { createWorkflowExecutionBackendFixture } from '../../test-fixtures/execution-backend-fixture.js';

describe('workflow project queue ownership', () => {
  // case: S-007.2
  it('keeps a queued input run for its owning project worker when project workers share a cache', async () => {
    const cache = new InMemoryCache();
    const events = new InMemoryEventBus();
    const logger = mockLogger();
    const projectA = new WorkflowEngine({
      projectId: 'prj_0000000000000001',
      cache,
      storage: new InMemoryStorage(),
      events,
      logger,
      secretProvider: new EnvSecretProvider(),
      workspaceRoot: '/tmp/project-a',
    });
    const projectB = new WorkflowEngine({
      projectId: 'prj_0000000000000002',
      cache,
      storage: new InMemoryStorage(),
      events,
      logger,
      secretProvider: new EnvSecretProvider(),
      workspaceRoot: '/tmp/project-b',
    });
    const run = await projectA.createRun({
      spec: {
        name: 'input-run',
        version: '1.0.0',
        on: { manual: true },
        inputs: { message: { type: 'string', required: true } },
        jobs: {
          main: {
            runsOn: 'local',
            steps: [{ name: 'print', uses: 'builtin:shell', with: { run: 'echo hello' } }],
          },
        },
      },
      trigger: { type: 'manual' },
      inputs: { message: 'hello' },
    });

    let firstPoll = true;
    let reportFirstPoll!: (entry: JobQueueEntry | null) => void;
    const firstPollResult = new Promise<JobQueueEntry | null>((resolve) => {
      reportFirstPoll = resolve;
    });
    const nextJob = projectB.nextJob.bind(projectB);
    projectB.nextJob = async () => {
      const entry = await nextJob();
      if (firstPoll) {
        firstPoll = false;
        reportFirstPoll(entry);
      }
      return entry;
    };

    const worker = await createWorkflowWorker({
      engine: projectB,
      secretProvider: new EnvSecretProvider(),
      cliApi: {} as unknown as IEntityRegistry,
      logger,
      platform: {
        executionBackend: createWorkflowExecutionBackendFixture().backend,
        hasExecutionBackend: true,
        getAdapter: () => undefined,
      },
      workspaceRoot: '/tmp/project-b',
      projectRoot: '/tmp/project-b',
      projectId: 'prj_0000000000000002',
      concurrency: 1,
    });

    const workerRun = worker.start();
    try {
      await expect(firstPollResult).resolves.toBeNull();
      await expect(projectA.getRun(run.id)).resolves.toMatchObject({
        status: 'queued',
        inputs: { message: 'hello' },
        jobs: [{ status: 'queued' }],
      });
      await expect(projectA.nextJob()).resolves.toMatchObject({ runId: run.id });
    } finally {
      await worker.stop();
      await workerRun;
    }
  });

  it('warns with project context and drops an orphan queue entry without retrying it', async () => {
    const logger = mockLogger();
    const engine = new WorkflowEngine({
      projectId: 'prj_0000000000000002',
      cache: new InMemoryCache(),
      storage: new InMemoryStorage(),
      events: new InMemoryEventBus(),
      logger,
      secretProvider: new EnvSecretProvider(),
      workspaceRoot: '/tmp/project-b',
    });
    const job: JobRun = {
      id: 'orphan-job',
      runId: 'orphan-run',
      jobName: 'orphan',
      status: 'queued',
      eventSequence: 0,
      runsOn: 'local',
      queuedAt: new Date().toISOString(),
      attempt: 0,
      steps: [],
    };
    await engine.getScheduler().enqueueJob('orphan-run', job);

    const worker = await createWorkflowWorker({
      engine,
      secretProvider: new EnvSecretProvider(),
      cliApi: {} as unknown as IEntityRegistry,
      logger,
      platform: {
        executionBackend: createWorkflowExecutionBackendFixture().backend,
        hasExecutionBackend: true,
        getAdapter: () => undefined,
      },
      workspaceRoot: '/tmp/project-b',
      projectRoot: '/tmp/project-b',
      projectId: 'prj_0000000000000002',
      concurrency: 1,
    });

    const workerRun = worker.start();
    try {
      await vi.waitFor(() => {
        expect(logger.messages).toContainEqual(expect.objectContaining({
          level: 'warn',
          msg: 'Dequeued workflow job is missing from this project state',
          meta: expect.objectContaining({
            runId: 'orphan-run',
            projectId: 'prj_0000000000000002',
            outcome: 'dropped',
          }),
        }));
      });
      await expect(engine.nextJob()).resolves.toBeNull();
    } finally {
      await worker.stop();
      await workerRun;
    }
  });
});
