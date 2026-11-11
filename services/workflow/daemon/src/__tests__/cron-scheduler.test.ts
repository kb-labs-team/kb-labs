import { describe, expect, it, vi } from 'vitest';
import { NoOpLogger } from '@kb-labs/core-platform/noop';
import type { IAnalytics } from '@kb-labs/core-platform';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { UserCron, WorkflowSpec } from '@kb-labs/workflow-contracts';
import type { JobBroker } from '../job-broker.js';
import { JobBroker as JobBrokerImpl } from '../job-broker.js';
import { CronScheduler } from '../cron-scheduler.js';

describe('CronScheduler project handler targets', () => {
  // case: S-254.4
  it('records a cron submission with run identity without claiming terminal completion', async () => {
    const track = vi.fn(async () => undefined);
    const runFromInline = vi.fn(async () => ({ id: 'workflow-run-active', status: 'running' }));
    const scheduler = new CronScheduler({
      jobBroker: {} as JobBroker,
      workflowEngine: { runFromInline } as unknown as WorkflowEngine,
      logger: new NoOpLogger(),
      analytics: { track } as unknown as IAnalytics,
    });
    scheduler.registerUserCron({
      id: 'nightly', schedule: '0 2 * * *', workflow: 'nightly-workflow', enabled: true,
    } as UserCron, {
      name: 'Nightly workflow', version: '1.0.0', on: { manual: true }, jobs: {},
    } as WorkflowSpec);

    await scheduler.triggerNow('nightly');

    expect(track).toHaveBeenCalledWith('workflow.cron.job.submitted', expect.objectContaining({
      cronJobId: 'nightly',
      runId: 'workflow-run-active',
      source: 'user',
    }));
    expect(track).not.toHaveBeenCalledWith('workflow.cron.job.completed', expect.anything());
  });

  it('submits the handler and input with project cron metadata', async () => {
    const submit = vi.fn(async () => ({ id: 'job-run-1' }));
    const scheduler = new CronScheduler({
      jobBroker: { submit } as unknown as JobBroker,
      workflowEngine: {} as WorkflowEngine,
      logger: new NoOpLogger(),
    });
    scheduler.registerUserCron({
      id: 'review', schedule: '0 2 * * *', handler: 'steward:daily-review',
      input: { channel: 'team' }, enabled: true,
    } as UserCron);

    await scheduler.triggerNow('review');

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      handler: 'steward:daily-review', input: { channel: 'team' },
      metadata: expect.objectContaining({ cronId: 'review', scheduledBy: 'cron' }),
    }));
    expect(scheduler.getJob('review')?.lastRun).toMatchObject({ id: 'job-run-1', status: 'queued' });
  });

  it('persists the workflow ID when a project cron runs a workflow spec', async () => {
    const runFromInline = vi.fn(async () => ({ id: 'workflow-run-1', status: 'queued' }));
    const scheduler = new CronScheduler({
      jobBroker: {} as JobBroker,
      workflowEngine: { runFromInline } as unknown as WorkflowEngine,
      logger: new NoOpLogger(),
    });
    scheduler.registerUserCron({
      id: 'nightly', schedule: '0 2 * * *', workflow: 'nightly-workflow',
      input: { branch: 'main' }, enabled: true,
    } as UserCron, {
      name: 'Nightly workflow', version: '1.0.0', on: { manual: true }, jobs: {},
    } as WorkflowSpec);

    await scheduler.triggerNow('nightly');

    expect(runFromInline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      metadata: expect.objectContaining({ workflowId: 'nightly-workflow' }),
    }));
  });

  it('persists generated workflow identity for a scheduled handler run', async () => {
    const runFromInline = vi.fn(async () => ({ id: 'handler-run-1', status: 'queued' }));
    const engine = { runFromInline };
    const broker = new JobBrokerImpl(engine as unknown as WorkflowEngine, new NoOpLogger(), {} as unknown as PlatformContainer);
    const scheduler = new CronScheduler({
      jobBroker: broker,
      workflowEngine: engine as unknown as WorkflowEngine,
      logger: new NoOpLogger(),
    });
    scheduler.registerUserCron({
      id: 'review', schedule: '0 2 * * *', handler: 'steward:daily-review', enabled: true,
    } as UserCron);

    await scheduler.triggerNow('review');

    expect(runFromInline).toHaveBeenCalledWith(expect.objectContaining({ name: 'job-steward:daily-review' }), expect.objectContaining({
      metadata: expect.objectContaining({ workflowId: 'job-steward:daily-review', cronId: 'review' }),
    }));
  });
});
