import { afterEach, describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCatalog } from '@kb-labs/core-registry';
import { InMemoryCache, InMemoryEventBus, InMemoryStorage } from '@kb-labs/core-platform/inmemory';
import { FaultInjectingCache } from '@kb-labs/shared-testing';
import { mockLogger } from '@kb-labs/shared-testing';
import { createErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { PlatformContainer } from '@kb-labs/core-runtime';
import { createDefaultProcessExecutor } from '@kb-labs/plugin-runtime';
import { isTerminal } from '@kb-labs/workflow-constants';
import { EnvSecretProvider, WorkflowEngine, workflowDeadLetterCacheKey, workflowProjectCacheKey } from '@kb-labs/workflow-engine';
import { createExecutionBackend, createNormalizedExecutionBackend } from '@kb-labs/plugin-execution-factory/construct';
import { createWorkflowWorker } from '../src/worker.js';

// case: S-029.2, S-009.4
describe('live workflow failure terminalization', () => {
  let roots: string[] = [];
  let children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
    }
    await Promise.all(children.map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once('exit', () => resolve());
    })));
    children = [];
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots = [];
  });

  it.each([
    ['handler throws', 'builtin:shell', { command: 'throw-handler' }, 'failed unexpectedly'],
    ['plugin is missing', 'plugin:@kb-labs/missing/handle', {}, 'Plugin not found'],
    ['command is unknown', 'command:missing:command', {}, 'CLI command not found'],
    ['shell exits non-zero', 'builtin:shell', { command: 'exit 23' }, 'shell exited 23'],
  ])('%s reaches failed run and persisted history without restart', async (_kind, uses, input, diagnostic) => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workflow-live-failure-'));
    roots.push(workspaceRoot);
    const logger = mockLogger();
    let deadLetterKey: string | undefined;
    const projectId = 'prj_0000000000000001';
    const cache = new FaultInjectingCache(new InMemoryCache(), (operation) =>
      operation.name === 'set' && operation.key === deadLetterKey
        ? new Error('dead-letter cache unavailable')
        : undefined,
    );
    const storage = new InMemoryStorage();
    const events = new InMemoryEventBus();
    const engine = new WorkflowEngine({
      projectId, cache, storage, events, logger,
      secretProvider: new EnvSecretProvider(), workspaceRoot,
    });
    const run = await engine.createRun({
      spec: {
        name: 'terminal-failure', version: '1.0.0', on: { manual: true },
        jobs: { failure: { runsOn: 'local', steps: [{ name: 'Fail', uses, with: input }] } },
      },
      trigger: { type: 'manual' }, metadata: { workflowId: 'terminal-failure' },
    });
    const failedJobId = run.jobs[0]!.id;
    deadLetterKey = workflowProjectCacheKey(projectId, workflowDeadLetterCacheKey(run.id, failedJobId));
    const registry = await openCatalog({ platformRoot: workspaceRoot, projectRoot: workspaceRoot }, { resolvePlatformVersion: async () => 'test' });
    let executionCount = 0;
    const backend = createNormalizedExecutionBackend({
      async execute(request) {
        executionCount++;
        if (request.input && typeof request.input === 'object' && 'command' in request.input
            && request.input.command === 'exit 23') {
          return { ok: true as const, data: { exitCode: 23, stderr: 'shell exited 23' }, executionTimeMs: 1 };
        }
        throw new Error('handler threw');
      },
      async health() { return { healthy: true, backend: 'in-process' }; },
      async stats() { return { totalExecutions: executionCount, successCount: 0, errorCount: executionCount, avgExecutionTimeMs: 1 }; },
      async shutdown() {},
    }, logger, 'in-process');
    const worker = await createWorkflowWorker({
      engine, secretProvider: new EnvSecretProvider(), cliApi: registry,
      logger,
      platform: { executionBackend: backend, hasExecutionBackend: true, getAdapter: () => undefined },
      workspaceRoot, projectRoot: workspaceRoot, projectId: 'prj_0000000000000001', concurrency: 1,
    });

    const workerRun = worker.start();
    try {
      await vi.waitFor(async () => {
        const current = await engine.getRun(run.id);
        expect(current?.status).toBe('failed');
      }, { timeout: 3000 });
      const current = await engine.getRun(run.id);
      expect(current?.jobs[0]).toMatchObject({
        status: 'failed', error: { message: expect.stringContaining(diagnostic) },
        steps: [{ status: 'failed', error: { message: expect.stringContaining(diagnostic) } }],
      });
      expect(current?.result).toMatchObject({ status: 'failed', error: { message: expect.stringContaining(diagnostic) } });
      await expect(engine.listRuns()).resolves.toEqual([expect.objectContaining({ id: run.id, status: 'failed' })]);
    } finally {
      await worker.stop();
      await workerRun;
      await registry.dispose();
    }
  });

  // case: S-243.5
  it('expires a real shell step at its declared timeout and terminalizes the run with the catalogue error', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workflow-live-timeout-'));
    roots.push(workspaceRoot);
    const pidFile = join(workspaceRoot, 'sleep.pid');
    const logger = mockLogger();
    const projectId = 'prj_0000000000000001';
    const cache = new InMemoryCache();
    const storage = new InMemoryStorage();
    const events = new InMemoryEventBus();
    const engine = new WorkflowEngine({
      projectId, cache, storage, events, logger,
      secretProvider: new EnvSecretProvider(), workspaceRoot,
    });
    const run = await engine.createRun({
      spec: {
        name: 'terminal-timeout', version: '1.0.0', on: { manual: true },
        jobs: {
          timeout: {
            runsOn: 'local',
            steps: [{
              name: 'Timed shell',
              uses: 'builtin:shell',
              timeoutMs: 1500,
              with: { command: `sleep 30 & echo $! > '${pidFile}'; wait`, throwOnError: true },
            }],
          },
        },
      },
      trigger: { type: 'manual' }, metadata: { workflowId: 'terminal-timeout' },
    });
    const platform = new PlatformContainer();
    platform.setAdapter('logger', logger);
    platform.setAdapter('processExecutor', createDefaultProcessExecutor(logger));
    const executionBackend = createExecutionBackend({ platform, mode: 'in-process' });
    const registry = await openCatalog({ platformRoot: workspaceRoot, projectRoot: workspaceRoot });
    const worker = await createWorkflowWorker({
      engine, secretProvider: new EnvSecretProvider(), cliApi: registry,
      logger,
      platform: { executionBackend, hasExecutionBackend: true, getAdapter: () => undefined },
      workspaceRoot, projectRoot: workspaceRoot, projectId, concurrency: 1,
    });

    let childPid: number | undefined;
    let workerRun: Promise<void> | undefined;
    try {
      workerRun = worker.start();
      await vi.waitFor(async () => {
        let pidContents: string | undefined;
        try { pidContents = await readFile(pidFile, 'utf8'); }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') { throw error; }
        }
        if (pidContents === undefined) {
          const current = await engine.getRun(run.id);
          if (current?.status === 'failed') {
            throw new Error(`workflow failed before shell child start (${current.status}): ${current.jobs[0]?.steps[0]?.error?.message}`);
          }
          throw new Error('waiting for the real shell child to start');
        }
        childPid = Number(pidContents);
        expect(childPid).toBeGreaterThan(1);
      }, { timeout: 4000 });
      await vi.waitFor(async () => {
        const current = await engine.getRun(run.id);
        expect(current?.status).toBe('failed');
      }, { timeout: 8000 });

      const current = await engine.getRun(run.id);
      const timeout = createErrorEnvelope('KB_RUNTIME_TIMEOUT', {
        correlationId: run.id,
        details: { timeoutMs: '1500' },
      });
      expect(isTerminal(current!.status, 'run')).toBe(true);
      expect(current?.jobs[0]?.steps[0]?.error).toMatchObject({
        code: timeout.code,
        message: timeout.message,
        hint: timeout.hint,
      });
      expect(current?.result?.error).toMatchObject({
        code: timeout.code,
        message: timeout.message,
        hint: timeout.hint,
      });
      await vi.waitFor(() => {
        expect(() => process.kill(childPid!, 0)).toThrow();
      }, { timeout: 2000 });
    } finally {
      if (childPid) {
        try { process.kill(childPid, 'SIGKILL'); }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') { throw error; }
        }
      }
      await worker.stop();
      await workerRun;
      await executionBackend.shutdown();
      await platform.shutdown();
      await registry.dispose();
    }
  }, 15000);

  // case: S-027.6
  it('detects a real worker process death and persists the failed run through terminalization', async () => {
    const logger = mockLogger();
    const cache = new InMemoryCache();
    const storage = new InMemoryStorage();
    const events = new InMemoryEventBus();
    const projectId = 'prj_0000000000000001';
    const engine = new WorkflowEngine({ projectId, cache, storage, events, logger, secretProvider: new EnvSecretProvider() });
    const child = fork(fileURLToPath(new URL('../test-fixtures/workflow-worker-death-child.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'advanced',
    });
    children.push(child);
    child.on('message', async (message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'adapter') { return; }
      const request = message as AdapterRequest;
      try {
        const result = request.adapter === 'cache'
          ? await performCacheOperation(cache, request)
          : await performStorageOperation(storage, request);
        child.send?.({ type: 'adapter-result', id: request.id, result });
      } catch (error) {
        child.send?.({ type: 'adapter-result', id: request.id, error: error instanceof Error ? error.message : String(error) });
      }
    });
    await waitForChildMessage(child, 'ready');
    const workerReady = waitForChildMessage(child, 'worker-ready');
    child.send({ type: 'start' });
    await workerReady;
    const run = await engine.createRun({
      spec: { name: 'worker-dies', version: '1.0.0', on: { manual: true }, jobs: {
        job: { runsOn: 'local', steps: [{ name: 'Hold', uses: 'builtin:shell', with: { run: 'hold' } }] },
      } },
      trigger: { type: 'manual' },
    });
    const startedMessage = waitForChildMessage(child, 'step-started');
    await startedMessage;
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60_000);
      const restartedLogger = mockLogger();
      const restartedEngine = new WorkflowEngine({ projectId, cache, storage, events, logger: restartedLogger, secretProvider: new EnvSecretProvider() });
      await restartedEngine.cleanupStaleRuns();
      const failed = await restartedEngine.getRun(run.id);
      expect(failed).toMatchObject({
        status: 'failed',
        jobs: [{ status: 'failed', error: { message: 'Daemon restarted — run was abandoned' } }],
        result: { status: 'failed', error: { message: expect.stringContaining('Daemon restarted — run was abandoned') } },
      });
      await expect(restartedEngine.listRuns()).resolves.toEqual([expect.objectContaining({ id: run.id, status: 'failed' })]);
      expect(restartedLogger.messages).toContainEqual(expect.objectContaining({
        msg: 'Workflow run terminal state persisted', meta: { runId: run.id, status: 'failed' },
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});

type AdapterRequest = { type: 'adapter'; id: number; adapter: 'cache' | 'storage'; method: string; args: unknown[] };

async function performCacheOperation(cache: InMemoryCache, request: AdapterRequest): Promise<unknown> {
  const method = cache[request.method as keyof InMemoryCache];
  if (typeof method !== 'function') { throw new Error(`Unsupported cache method ${request.method}`); }
  return Reflect.apply(method, cache, request.args);
}

async function performStorageOperation(storage: InMemoryStorage, request: AdapterRequest): Promise<unknown> {
  const args = [...request.args];
  if (request.method === 'write' && typeof args[1] === 'string') { args[1] = Buffer.from(args[1], 'base64'); }
  if (request.method === 'read') {
    const result = await storage.read(String(args[0]));
    return result?.toString('base64') ?? null;
  }
  const method = storage[request.method as keyof InMemoryStorage];
  if (typeof method !== 'function') { throw new Error(`Unsupported storage method ${request.method}`); }
  return Reflect.apply(method, storage, args);
}

function waitForChildMessage(child: ChildProcess, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === type) {
        child.off('message', onMessage);
        resolve();
      }
    };
    child.on('message', onMessage);
    child.once('error', reject);
    child.once('exit', (code, signal) => reject(new Error(`Worker exited before ${type}: ${code ?? signal}`)));
  });
}
