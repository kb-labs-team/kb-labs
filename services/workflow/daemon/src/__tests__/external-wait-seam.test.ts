import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IStorage } from '@kb-labs/core-platform';
import { InMemoryCache, InMemoryEventBus } from '@kb-labs/core-platform/inmemory';
import { discoverAdapters } from '@kb-labs/core-runtime';
import type { IEntityRegistry, PlatformServices } from '@kb-labs/plugin-contracts';
import { createDefaultProcessExecutor } from '@kb-labs/plugin-runtime';
import { createExecutionBackend } from '@kb-labs/plugin-execution-factory/construct';
import { mockLogger } from '@kb-labs/shared-testing';
import { EnvSecretProvider, WorkflowEngine } from '@kb-labs/workflow-engine';
import { SandboxRunner } from '@kb-labs/workflow-runtime';

describe('durable shell external wait', () => {
  it('recovers a shell-produced wait from real filesystem storage after engine restart', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workflow-wait-seam-'));
    const logger = mockLogger();
    const platform = { logger, processExecutor: createDefaultProcessExecutor(logger), getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = createExecutionBackend({ platform, mode: 'in-process' });
    try {
      const root = resolve(process.cwd(), '../../..');
      const adapters = await discoverAdapters(root, { development: true, workspaceRoot: root, configuredPackages: [{ packageName: '@kb-labs/adapters-fs', slot: 'storage' }] });
      const factory = adapters.get('@kb-labs/adapters-fs')?.createAdapter;
      if (!factory) { throw new Error('Filesystem storage adapter was not discovered'); }
      const makeEngine = () => new WorkflowEngine({ projectId: 'prj_0000000000000001', cache: new InMemoryCache(),
        storage: factory({ baseDir: join(workspace, 'state') }) as IStorage,
        events: new InMemoryEventBus(), logger, secretProvider: new EnvSecretProvider(), workspaceRoot: workspace });
      const engine = makeEngine();
      const command = `if test -f retry-once; then printf 'done\\n'; else touch retry-once; printf '%s\\n' '::kb-output::{"ok":false,"error":{"kind":"rate_limit","retryable":true,"retryAfterMs":1500,"dependency":"registry","message":"busy"}}'; fi`;
      const run = await engine.createRun({ spec: { name: 'wait', version: '1.0.0', on: { manual: true }, jobs: {
        main: { runsOn: 'local', steps: [{ name: 'shell', uses: 'builtin:shell', with: { command } }] },
      } }, trigger: { type: 'manual' } });
      await engine.nextJob();
      const job = run.jobs[0]!;
      const step = job.steps[0]!;
      await engine.markJobStarted(run.id, job.id);
      await engine.markStepStarted(run.id, job.id, step.id);
      const runner = new SandboxRunner({ backend, cliApi: {} as IEntityRegistry, workspaceRoot: workspace });
      const result = await runner.execute({ workspace, spec: step.spec, context: {
        runId: run.id, jobId: job.id, stepId: step.id, attempt: 0, env: {}, secrets: {},
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } });
      expect(result.status).toBe('failed');
      if (result.status !== 'failed' || !result.failure) { throw new Error('shell did not produce a typed failure'); }
      const error = new Error(result.failure.message);
      await engine.markStepFailed(run.id, job.id, step.id, error, result.outputs, result.failure);
      await engine.markJobFailed(run.id, job.id, error, result.failure, { max: 1, on: ['rate_limit'] });
      const restarted = makeEngine();
      await restarted.cleanupStaleRuns();
      await restarted.resumeInterruptedJobs();
      expect(await restarted.getRun(run.id)).toMatchObject({ jobs: [{ status: 'waiting', steps: [{ status: 'waiting', wait: { dependency: 'registry' }, error: { details: { failure: { kind: 'rate_limit', retryable: true } } } }] }] });
      expect(await restarted.nextJob()).toBeNull();
      await new Promise((done) => setTimeout(done, 1550));
      expect(await restarted.nextJob()).toMatchObject({ runId: run.id, jobId: job.id });
      await restarted.markJobStarted(run.id, job.id);
      await restarted.markStepStarted(run.id, job.id, step.id);
      const retry = await runner.execute({ workspace, spec: step.spec, context: {
        runId: run.id, jobId: job.id, stepId: step.id, attempt: 1, env: {}, secrets: {},
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      } });
      expect(retry.status).toBe('success');
      if (retry.status !== 'success') { throw new Error('retry did not succeed'); }
      expect(retry.outputs).toMatchObject({ stdout: 'done\n', exitCode: 0 });
      await restarted.markStepCompleted(run.id, job.id, step.id, retry.outputs);
      await restarted.markJobCompleted(run.id, job.id);
      expect((await restarted.getRun(run.id))?.status).toBe('success');
    } finally {
      await backend.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 10000);
});
