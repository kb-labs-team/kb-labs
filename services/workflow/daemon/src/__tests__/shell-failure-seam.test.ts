import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IEntityRegistry, PlatformServices } from '@kb-labs/plugin-contracts';
import { createDefaultProcessExecutor } from '@kb-labs/plugin-runtime';
import { createExecutionBackend } from '@kb-labs/plugin-execution-factory/construct';
import { mockLogger } from '@kb-labs/shared-testing';
import { SandboxRunner } from '@kb-labs/workflow-runtime';
import { StepSpecSchema } from '@kb-labs/workflow-contracts';

describe('shell failure through the execution backend', () => {
  it('retains the exit and stderr of a failed shell step', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workflow-shell-failure-'));
    const logger = mockLogger();
    const platform = { logger, processExecutor: createDefaultProcessExecutor(logger), getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = createExecutionBackend({ platform, mode: 'in-process' });
    const runner = new SandboxRunner({ backend, cliApi: {} as IEntityRegistry, workspaceRoot: workspace });
    try {
      const result = await runner.execute({
        workspace,
        spec: { name: 'Fail', uses: 'builtin:shell', with: { command: "printf 'failure detail\\n' >&2; exit 23" } },
        context: {
          runId: 'run', jobId: 'job', stepId: 'step', attempt: 0, env: {}, secrets: {},
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
      });
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') { throw new Error('expected failure'); }
      expect(result.error.message).toContain('failure detail');
      expect(result.failure).toMatchObject({ kind: 'exit', retryable: false, exitCode: 23 });
    } finally {
      await backend.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reports an idle shell as stalled and terminates its child', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workflow-shell-idle-'));
    const pidFile = join(workspace, 'child.pid');
    const logger = mockLogger();
    const platform = { logger, processExecutor: createDefaultProcessExecutor(logger), getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = createExecutionBackend({ platform, mode: 'in-process' });
    const runner = new SandboxRunner({ backend, cliApi: {} as IEntityRegistry, workspaceRoot: workspace, defaultTimeout: 1000 });
    let childPid = 0;
    try {
      const result = await runner.execute({
        workspace,
        spec: StepSpecSchema.parse({ name: 'Silent', run: `sleep 30 & echo $! > '${pidFile}'; wait`, idleTimeoutMs: 100 }),
        context: {
          runId: 'run', jobId: 'job', stepId: 'step', attempt: 0, env: {}, secrets: {},
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        },
      });
      childPid = Number(await readFile(pidFile, 'utf8'));
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') { throw new Error('expected failure'); }
      expect(result.failure).toMatchObject({ kind: 'stalled' });
      await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 1000 });
    } finally {
      if (childPid > 1) { try { process.kill(childPid, 'SIGKILL'); } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') { throw error; } } }
      await backend.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 5000);

  it('keeps a shell alive while output arrives without newline boundaries', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workflow-shell-activity-'));
    const logger = mockLogger();
    const platform = { logger, processExecutor: createDefaultProcessExecutor(logger), getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = createExecutionBackend({ platform, mode: 'in-process' });
    const runner = new SandboxRunner({ backend, cliApi: {} as IEntityRegistry, workspaceRoot: workspace });
    try {
      const result = await runner.execute({ workspace,
        spec: StepSpecSchema.parse({ name: 'Active', run: "printf a; sleep 0.06; printf b; sleep 0.06; printf c", idleTimeoutMs: 100 }),
        context: { runId: 'run', jobId: 'job', stepId: 'step', attempt: 0, env: {}, secrets: {},
          logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
      });
      expect(result.status).toBe('success');
    } finally {
      await backend.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  }, 5000);

});
