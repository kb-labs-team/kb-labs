import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoOpLogger } from '@kb-labs/core-platform/noop';
import type { IEntityRegistry } from '@kb-labs/plugin-contracts';
import type { WorkflowService } from '@kb-labs/workflow-engine';
import type { CronScheduler } from '../cron-scheduler.js';
import { CronDiscovery } from '../cron-discovery.js';

describe('CronDiscovery', () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it('keeps plugin manifest job targets as read-only handler crons', async () => {
    const registerPluginJob = vi.fn();
    const declaration = {
      id: 'daily-review', schedule: '0 0 * * *',
      job: { type: 'daily-review', payload: { channel: 'team' } },
    };
    const registry = {
      queryEntities: () => [{ ref: { pluginId: 'steward', entityId: 'daily-review' }, declaration }],
    } as unknown as IEntityRegistry;
    const scheduler = { registerPluginJob, registerUserCron: vi.fn() } as unknown as CronScheduler;
    const workflowService = { get: vi.fn() } as unknown as WorkflowService;
    const discovery = new CronDiscovery({
      cliApi: registry, scheduler, logger: new NoOpLogger(), workspaceRoot: '/missing', workflowService,
    });

    const result = await discovery.discoverAll();

    expect(result.plugins).toBe(1);
    expect(registerPluginJob).toHaveBeenCalledWith('steward', expect.objectContaining({
      id: 'daily-review', handler: 'steward:daily-review', input: { channel: 'team' },
    }));
  });

  it('discovers workflow crons and reports invalid files with their path and reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-cron-discovery-'));
    roots.push(root);
    await mkdir(join(root, '.kb', 'crons'), { recursive: true });
    await mkdir(join(root, '.kb', 'workflows'), { recursive: true });
    await writeFile(join(root, '.kb', 'workflows', 'nightly.yml'),
      'name: nightly\nversion: 1.0.0\ninputs:\n  channel:\n    type: string\n    required: true\non:\n  manual: true\njobs:\n  build:\n    runsOn: local\n    steps:\n      - name: echo\n        uses: builtin:shell\n        with:\n          command: echo ok\n');
    await writeFile(join(root, '.kb', 'crons', 'valid.yml'),
      'schedule: "0 2 * * *"\nworkflow: nightly\ninput:\n  channel: stable\n');
    await writeFile(join(root, '.kb', 'crons', 'invalid.yml'),
      'schedule: nope\nworkflow: missing\n');
    const registerUserCron = vi.fn();
    const scheduler = { registerUserCron, registerPluginJob: vi.fn() } as unknown as CronScheduler;
    const registry = { queryEntities: () => [] } as unknown as IEntityRegistry;
    const workflowService = { get: vi.fn(async (id: string) => id === 'nightly' ? { id } : null) } as unknown as WorkflowService;
    const discovery = new CronDiscovery({ cliApi: registry, scheduler, logger: new NoOpLogger(), workspaceRoot: root, workflowService });

    const result = await discovery.discoverAll();
    expect(result.users).toBe(1);
    expect(registerUserCron).toHaveBeenCalledWith(expect.objectContaining({ id: 'valid', workflow: 'nightly' }), expect.objectContaining({ name: 'nightly' }));
    expect(result.errors).toEqual([expect.objectContaining({ file: join(root, '.kb', 'crons', 'invalid.yml') })]);
    expect(result.errors[0]?.reason).toContain('Invalid cron expression');
  });

  it('discovers project handler crons only when the handler is registered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-cron-handler-'));
    roots.push(root);
    await mkdir(join(root, '.kb', 'crons'), { recursive: true });
    await writeFile(join(root, '.kb', 'crons', 'user-job.yml'),
      'schedule: "0 2 * * *"\nhandler: steward:daily-review\ninput:\n  channel: team\n');
    await writeFile(join(root, '.kb', 'crons', 'missing-job.yml'),
      'schedule: "0 3 * * *"\nhandler: steward:missing\n');
    const registerUserCron = vi.fn();
    const registry = {
      queryEntities: (query: { kind: string }) => query.kind === 'job'
        ? [{ ref: { pluginId: 'steward', entityId: 'daily-review' } }]
        : [],
    } as unknown as IEntityRegistry;
    const scheduler = { registerUserCron, registerPluginJob: vi.fn() } as unknown as CronScheduler;
    const workflowService = { get: vi.fn() } as unknown as WorkflowService;
    const discovery = new CronDiscovery({ cliApi: registry, scheduler, logger: new NoOpLogger(), workspaceRoot: root, workflowService });

    const result = await discovery.discoverAll();

    expect(result.users).toBe(1);
    expect(registerUserCron).toHaveBeenCalledWith(expect.objectContaining({
      id: 'user-job', handler: 'steward:daily-review', input: { channel: 'team' },
    }));
    expect(result.errors).toEqual([expect.objectContaining({
      file: join(root, '.kb', 'crons', 'missing-job.yml'), reason: 'unknown job handler steward:missing',
    })]);
  });

  it('persists enable state into the project cron file and reloads discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-cron-enable-'));
    roots.push(root);
    await mkdir(join(root, '.kb', 'crons'), { recursive: true });
    await mkdir(join(root, '.kb', 'workflows'), { recursive: true });
    const cronFile = join(root, '.kb', 'crons', 'nightly.yml');
    await writeFile(cronFile, 'schedule: "0 2 * * *"\nworkflow: nightly\nenabled: false\n');
    await writeFile(join(root, '.kb', 'workflows', 'nightly.yml'),
      'name: nightly\nversion: 1.0.0\non:\n  manual: true\njobs:\n  build:\n    runsOn: local\n    steps:\n      - name: echo\n        uses: builtin:shell\n        with:\n          command: echo ok\n');
    const scheduler = { registerUserCron: vi.fn(), registerPluginJob: vi.fn(), clearUserJobs: vi.fn() } as unknown as CronScheduler;
    const registry = { queryEntities: () => [] } as unknown as IEntityRegistry;
    const workflowService = { get: vi.fn(async (id: string) => ({ id })) } as unknown as WorkflowService;
    const discovery = new CronDiscovery({ cliApi: registry, scheduler, logger: new NoOpLogger(), workspaceRoot: root, workflowService });

    await discovery.setUserCronEnabled('nightly', true);
    expect(await readFile(cronFile, 'utf8')).toContain('enabled: true');
    expect(scheduler.clearUserJobs).toHaveBeenCalledOnce();
    expect(scheduler.registerUserCron).toHaveBeenCalledOnce();
  });
});
