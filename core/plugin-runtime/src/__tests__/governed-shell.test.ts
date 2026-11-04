import { describe, expect, it, vi } from 'vitest';
import type { IProcessExecutor, ILogger, ProcessResult } from '@kb-labs/core-platform/adapters';
import { toErrorEnvelope } from '@kb-labs/core-platform';
import { PermissionError } from '@kb-labs/plugin-contracts';
import { createShellAPI } from '../api/shell.js';
import { GovernedProcessError } from '../process/errors.js';
import { createDefaultProcessExecutor, DarwinProcessBackend, LinuxProcessBackend } from '../process/index.js';
import { BrokeredProcessExecutor } from '../process/brokered-executor.js';
import { InMemoryRateLimitBackend, ResourceBroker } from '@kb-labs/core-resource-broker';

function executor(result: ProcessResult): IProcessExecutor {
  return {
    capabilities: () => ({ platform: 'other', processGroups: true, hardMemoryLimit: false, hardCpuLimit: false, processTreeAccounting: true, maxProcesses: false }),
    execute: vi.fn(async () => result),
    cancel: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  };
}

const identity = { executionId: 'exec-1', requestId: 'req-1', pluginId: 'test-plugin' };

describe('governed ShellAPI', () => {
  // case: S-284.7
  it('surfaces governed memory termination as the catalogued process-limit error', async () => {
    const run = executor(delegateResult());
    run.execute = vi.fn(async () => {
      throw new GovernedProcessError('PROCESS_MEMORY_LIMIT', 'Process terminated: memory_limit', {
        result: { usage: { wallTimeMs: 1200, cpuMs: 500, peakMemoryMb: 4100, processCount: 12, stdoutBytes: 100, stderrBytes: 20 } },
      }, { resource: 'memory (MB)', observed: 4100, allowed: 4096 });
    });
    const shell = createShellAPI({
      pluginId: '@kb-labs/release',
      permissions: { shell: { allow: ['pnpm'] }, quotas: { memoryMb: 4096 } },
      cwd: '/workspace',
      processExecutor: run,
      processIdentity: identity,
    });

    const thrown = await shell.exec('pnpm', ['run', 'build'], { cwd: '/workspace/studio/app' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const envelope = toErrorEnvelope(thrown);

    expect(envelope.code).toBe('KB_RUNTIME_PROCESS_LIMIT_EXCEEDED');
    expect(envelope.message).toContain('4100');
    expect(envelope.message).toContain('4096');
    expect(envelope.message).toContain('pnpm run build');
    expect(envelope.message).toContain('/workspace/studio/app');
    expect(envelope.hint).not.toBe('');
    expect(envelope.details).toMatchObject({ allowed: '4096', observed: '4100' });
  });

  it('denies shell when no command is declared', async () => {
    const shell = createShellAPI({ pluginId: identity.pluginId, permissions: {}, cwd: process.cwd(), processIdentity: identity });
    await expect(shell.exec('echo', ['hello'])).rejects.toBeInstanceOf(PermissionError);
  });

  it('passes identity, quotas and signal to the process executor', async () => {
    const run = executor({ processId: 'p1', code: 0, stdout: 'ok', stderr: '', ok: true, terminationReason: 'completed', attempts: 1, usage: { wallTimeMs: 1, cpuMs: 0, peakMemoryMb: 1, processCount: 1, stdoutBytes: 2, stderrBytes: 0 } });
    const signal = new AbortController().signal;
    const shell = createShellAPI({ pluginId: identity.pluginId,
      permissions: { shell: { allow: ['echo'] }, quotas: { timeoutMs: 1000, memoryMb: 64, cpuMs: 500 } },
      cwd: '/tmp', processExecutor: run, processIdentity: identity, signal,
    });
    await expect(shell.exec('echo', ['hello'], { maxOutputBytes: 10 })).resolves.toMatchObject({ ok: true, processId: 'p1' });
    expect(run.execute).toHaveBeenCalledWith(expect.objectContaining({
      command: 'echo', cwd: '/tmp', signal, identity,
      limits: expect.objectContaining({ timeoutMs: 1000, memoryMb: 64, cpuMs: 500, maxOutputBytes: 10 }),
    }));
  });

  it('forwards retry policy to the governed executor', async () => {
    const run = executor({ processId: 'p1', code: 0, stdout: '', stderr: '', ok: true, terminationReason: 'completed', attempts: 1, usage: { wallTimeMs: 1, cpuMs: 0, peakMemoryMb: 1, processCount: 1, stdoutBytes: 0, stderrBytes: 0 } });
    const shell = createShellAPI({ pluginId: identity.pluginId, permissions: { shell: { allow: ['echo'] } }, cwd: process.cwd(), processExecutor: run, processIdentity: identity });
    await expect(shell.exec('echo', [], { retry: { maxAttempts: 2 } })).resolves.toMatchObject({ ok: true });
    expect(run.execute).toHaveBeenCalledWith(expect.objectContaining({ retry: { maxAttempts: 2 } }));
  });

  it('uses separate Darwin and Linux implementations behind one contract', () => {
    expect(new DarwinProcessBackend().capabilities().processGroups).toBe(true);
    expect(new LinuxProcessBackend().capabilities().processGroups).toBe(true);
    expect(createDefaultProcessExecutor().capabilities().platform).toBe(process.platform === 'darwin' ? 'darwin' : 'linux');
  });

  it('uses ResourceBroker admission and releases the lease after execution', async () => {
    const broker = new ResourceBroker(new InMemoryRateLimitBackend());
    const delegate = executor({ processId: 'p1', code: 0, stdout: '', stderr: '', ok: true, terminationReason: 'completed', attempts: 1, usage: { wallTimeMs: 1, cpuMs: 0, peakMemoryMb: 1, processCount: 1, stdoutBytes: 0, stderrBytes: 0 } });
    const governed = new BrokeredProcessExecutor(broker, delegate);
    await governed.execute({ identity, command: 'echo', args: [], cwd: process.cwd(), limits: { timeoutMs: 1000 } });
    expect(delegate.execute).toHaveBeenCalledTimes(1);
    expect(broker.getStats().resources['process:shell:test-plugin']?.rateLimits.activeRequests).toBe(0);
    await broker.shutdown();
  });

  it('bounds concurrent executions and times out queued admission', async () => {
    const broker = new ResourceBroker(new InMemoryRateLimitBackend());
    let releaseFirst!: () => void;
    const delegate = executor(delegateResult());
    delegate.execute = vi.fn(() => new Promise<ProcessResult>((resolve) => {
      releaseFirst = () => resolve(delegateResult());
    }));
    const governed = new BrokeredProcessExecutor(broker, delegate);
    const first = governed.execute({ identity, command: 'echo', args: [], cwd: process.cwd(), limits: { timeoutMs: 1000, maxConcurrent: 1 } });
    await vi.waitFor(() => expect(delegate.execute).toHaveBeenCalledTimes(1));
    await expect(governed.execute({ identity, command: 'echo', args: [], cwd: process.cwd(), limits: { timeoutMs: 80, maxConcurrent: 1 } })).rejects.toMatchObject({ code: 'PROCESS_ADMISSION_TIMEOUT' });
    releaseFirst();
    await first;
    await broker.shutdown();
  });

  it('retries transient spawn failures only for idempotent requests', async () => {
    const backend = createDefaultProcessExecutor();
    await expect(backend.execute({ identity, command: `${process.cwd()}/does-not-exist-kb-process`, args: [], cwd: process.cwd(), limits: { timeoutMs: 3000 }, retry: { maxAttempts: 2, idempotent: true, initialDelayMs: 1, maxDelayMs: 2, jitter: 0 } })).rejects.toMatchObject({ code: 'PROCESS_SPAWN_FAILED' });
    await backend.shutdown();
  });

  it('terminates active processes on shutdown with a governed cancellation reason', async () => {
    const backend = createDefaultProcessExecutor();
    const running = backend.execute({ identity, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'], cwd: process.cwd(), limits: { timeoutMs: 10000 } });
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    await backend.shutdown();
    await expect(running).rejects.toMatchObject({ code: 'PROCESS_CANCELLED', details: { result: { terminationReason: 'shutdown' } } });
  });
});

function delegateResult(): ProcessResult {
  return { processId: 'p', code: 0, stdout: '', stderr: '', ok: true, terminationReason: 'completed', attempts: 1, usage: { wallTimeMs: 1, cpuMs: 0, peakMemoryMb: 1, processCount: 1, stdoutBytes: 0, stderrBytes: 0 } };
}

describe('node process backend', () => {
  it('emits structured lifecycle logs for a governed command', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const backend = createDefaultProcessExecutor(logger as unknown as ILogger);
    const result = await backend.execute({
      identity,
      command: process.execPath,
      args: ['-e', 'process.stdout.write("logged")'],
      cwd: process.cwd(),
      limits: { timeoutMs: 5_000 },
    });
    expect(result.stdout).toBe('logged');
    expect(logger.info).toHaveBeenCalledWith('process.execution.started', expect.objectContaining({
      component: 'process-executor', operation: 'execute',
      executionId: identity.executionId, requestId: identity.requestId, pluginId: identity.pluginId,
    }));
    expect(logger.info).toHaveBeenCalledWith('process.execution.finished', expect.objectContaining({
      processId: result.processId, terminationReason: 'completed', usage: result.usage,
    }));
    await backend.shutdown();
  });

  it('executes argv without invoking a shell', async () => {
    const shell = createShellAPI({ pluginId: identity.pluginId, permissions: { shell: { allow: ['node'] } }, cwd: process.cwd(), processExecutor: createDefaultProcessExecutor(), processIdentity: identity });
    const result = await shell.exec(process.execPath, ['-e', 'process.stdout.write("hello")']);
    expect(result).toMatchObject({ ok: true, stdout: 'hello', stderr: '' });
    expect(result.usage?.processCount).toBeGreaterThanOrEqual(1);
  });

  it('returns a structured timeout and terminates the process group', async () => {
    const shell = createShellAPI({ pluginId: identity.pluginId, permissions: { shell: { allow: ['node'] } }, cwd: process.cwd(), processExecutor: createDefaultProcessExecutor(), processIdentity: identity });
    const thrown = await shell.exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 100 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(toErrorEnvelope(thrown)).toMatchObject({ code: 'KB_RUNTIME_PROCESS_LIMIT_EXCEEDED', details: { resource: 'time (ms)', allowed: '100' } });
  });

  it('enforces bounded output', async () => {
    const shell = createShellAPI({ pluginId: identity.pluginId, permissions: { shell: { allow: ['node'] } }, cwd: process.cwd(), processExecutor: createDefaultProcessExecutor(), processIdentity: identity });
    const thrown = await shell.exec(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxOutputBytes: 1024 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(toErrorEnvelope(thrown)).toMatchObject({ code: 'KB_RUNTIME_PROCESS_LIMIT_EXCEEDED', details: { resource: 'captured output (bytes)', allowed: '1024' } });
  });

  it('cancels a running process', async () => {
    const controller = new AbortController();
    const shell = createShellAPI({ pluginId: identity.pluginId, permissions: { shell: { allow: ['node'] } }, cwd: process.cwd(), processExecutor: createDefaultProcessExecutor(), processIdentity: identity });
    const promise = shell.exec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toMatchObject({ code: 'PROCESS_CANCELLED' });
  });

  it('rejects non-idempotent execution retry before spawning', async () => {
    const shell = createShellAPI({ pluginId: identity.pluginId, permissions: { shell: { allow: ['node'] } }, cwd: process.cwd(), processExecutor: createDefaultProcessExecutor(), processIdentity: identity });
    await expect(shell.exec(process.execPath, ['-e', ''], { retry: { maxAttempts: 2 } })).rejects.toBeInstanceOf(GovernedProcessError);
  });
});
