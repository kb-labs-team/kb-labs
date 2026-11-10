import { describe, expect, it, vi } from 'vitest';
import { noopUI } from '@kb-labs/plugin-contracts';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { ExecutionRequest } from '@kb-labs/plugin-execution-factory';
import { createErrorEnvelope, createProductErrorEnvelope } from '@kb-labs/core-platform';
import { executeCommandV3 } from './execute-command.js';
import { useLoader } from '@kb-labs/shared-cli-ui';

describe('executeCommandV3 environment', () => {
  // case: S-010.7
  it('passes the CLI-resolved gateway address to the execution backend without mutating process.env', async () => {
    const previousGatewayUrl = process.env.KB_GATEWAY_URL;
    const execute = vi.fn(async (request: ExecutionRequest) => {
      expect(request.env).toEqual({ KB_GATEWAY_URL: 'http://127.0.0.1:43123' });
      return { ok: true, data: null, executionTimeMs: 0 };
    });
    const platformContainer = {
      executionBackend: { execute },
    } as unknown as PlatformContainer;

    await executeCommandV3({
      binaryName: 'kb',
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      commandPath: 'test run',
      pluginRoot: '/tmp/test-plugin',
      handlerPath: 'dist/commands/test.js',
      argv: [],
      flags: {},
      env: { KB_GATEWAY_URL: 'http://127.0.0.1:43123' },
      ui: noopUI,
      platform: {} as unknown as PlatformServices,
      platformContainer,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(process.env.KB_GATEWAY_URL).toBe(previousGatewayUrl);
  });
});

describe('executeCommandV3 plugin command result output', () => {
  // case: S-203.1
  it('returns the normalized result and forwards backend logs by declared stream', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const json = vi.fn();
    const execute = vi.fn(async (_request: ExecutionRequest, options?: { onLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string }) => void }) => {
      const loader = useLoader('Analyzing with native tools...', { spinner: false, total: 2, current: 1, jsonMode: true });
      loader.start();
      loader.update({ current: 1 });
      loader.stop();
      options?.onLog?.({ level: 'info', message: 'worker stdout', stream: 'stdout', lineNo: 1, timestamp: new Date().toISOString() });
      options?.onLog?.({ level: 'error', message: 'worker stderr', stream: 'stderr', lineNo: 2, timestamp: new Date().toISOString() });
      return { ok: true as const, data: { complete: true }, executionTimeMs: 1 };
    });
    const platformContainer = { executionBackend: { execute, executionMode: 'in-process' } } as unknown as PlatformContainer;

    try {
      const exitCode = await executeCommandV3({
        binaryName: 'kb', pluginId: '@kb-labs/test-plugin', pluginVersion: '1.0.0',
        commandPath: 'test run', handlerPath: 'dist/commands/test.js', argv: [], flags: { json: true },
        ui: { ...noopUI, json }, platform: {} as unknown as PlatformServices, platformContainer,
      });
      expect(exitCode).toBe(0);
      expect(json).toHaveBeenCalledOnce();
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: { complete: true } }));
      expect(stdout.join('')).toContain('worker stdout');
      expect(stderr.join('')).toContain('worker stderr');
      expect(stderr.join('')).not.toContain('Analyzing with native tools...');
    } finally {
      stdoutWrite.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('frames the already-normalized backend envelope without logging or reclassifying it', async () => {
    const json = vi.fn();
    const error = createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
      correlationId: 'cli-failure-123',
      details: { plugin: '@kb-labs/test-plugin', command: 'test run', failureReason: 'timed out' },
    });
    const loggerError = vi.fn();
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { envelope: error },
      executionTimeMs: 1,
    }));
    const platformContainer = { executionBackend: { execute } } as unknown as PlatformContainer;

    const exitCode = await executeCommandV3({
      binaryName: 'kb',
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      commandPath: 'test run',
      handlerPath: 'dist/commands/test.js',
      argv: [],
      flags: { json: true },
      ui: { ...noopUI, json },
      platform: { logger: { error: loggerError } } as unknown as PlatformServices,
      platformContainer,
    });

    expect(exitCode).toBe(1);
    expect(json).toHaveBeenCalledWith({ ok: false, error });
    expect(loggerError).not.toHaveBeenCalled();
  });

  // case: S-203.1, S-203.2
  it('frames a factory-normalized returned typed failure once in JSON mode', async () => {
    const json = vi.fn();
    const error = vi.fn();
    const envelope = createErrorEnvelope('KB_RUNTIME_COMMAND_FAILED', {
      templateValues: { binary: 'kb' },
      correlationId: 'returned-failure-correlation',
      message: 'The operation failed.',
      hint: 'Resolve the reported command failure, then run the command again.',
      details: { resource: 'record-17' },
    });
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { envelope },
      executionTimeMs: 1,
    }));
    const platformContainer = { executionBackend: { execute } } as unknown as PlatformContainer;

    const exitCode = await executeCommandV3({
      binaryName: 'kb',
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      commandPath: 'test run',
      handlerPath: 'dist/commands/test.js',
      argv: [],
      flags: { json: true },
      ui: { ...noopUI, json, error },
      platform: {} as unknown as PlatformServices,
      platformContainer,
    });

    expect(exitCode).toBe(1);
    expect(json).toHaveBeenCalledWith({ ok: false, error: envelope });
    expect(error).not.toHaveBeenCalled();
  });

  // case: S-203.2
  it('preserves nested plain data that resembles a legacy string failure', async () => {
    const json = vi.fn();
    const execute = vi.fn(async () => ({
      ok: true as const,
      data: { payload: { ok: false, error: 'free text failure' } },
      executionTimeMs: 1,
    }));
    const platformContainer = { executionBackend: { execute } } as unknown as PlatformContainer;

    const exitCode = await executeCommandV3({
      binaryName: 'kb',
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      commandPath: 'test run',
      handlerPath: 'dist/commands/test.js',
      argv: [],
      flags: { json: true },
      ui: { ...noopUI, json },
      platform: {} as unknown as PlatformServices,
      platformContainer,
    });

    expect(exitCode).toBe(0);
    expect(json).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith({
      ok: true,
      data: { payload: { ok: false, error: 'free text failure' } },
      meta: expect.any(Object),
    });
  });

  // case: S-203.2, S-051.2
  it('frames a factory-normalized plugin-not-found failure as the shared human error', async () => {
    const json = vi.fn();
    const error = vi.fn();
    const envelope = createErrorEnvelope('KB_PLUGIN_NOT_FOUND', {
      correlationId: 'plugin-not-found-correlation',
      details: { plugin: '@kb-labs/not-published' },
      message: 'Plugin @kb-labs/not-published was not found in the registry.',
      hint: 'Check the exact package name and package source. If available, run `kb marketplace install @kb-labs/not-published`; `kb marketplace plugins list` shows installed plugins.',
    });
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { envelope },
      executionTimeMs: 1,
    }));
    const platformContainer = { executionBackend: { execute } } as unknown as PlatformContainer;

    const exitCode = await executeCommandV3({
      binaryName: 'kb',
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      commandPath: 'test run',
      handlerPath: 'dist/commands/test.js',
      argv: [],
      flags: {},
      ui: { ...noopUI, json, error },
      platform: {} as unknown as PlatformServices,
      platformContainer,
    });

    expect(exitCode).toBe(1);
    expect(json).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^Plugin @kb-labs\/not-published was not found in the registry\. \[KB_PLUGIN_NOT_FOUND\]\n  plugin: @kb-labs\/not-published\n  Hint:  Check the exact package name and package source\. If available, run `kb marketplace install @kb-labs\/not-published`; `kb marketplace plugins list` shows installed plugins\.\n  Correlation ID: plugin-not-found-correlation$/), {
      hint: 'Check the exact package name and package source. If available, run `kb marketplace install @kb-labs/not-published`; `kb marketplace plugins list` shows installed plugins.',
    });
  });

  // case: S-203.2
  it('keeps a catalogued execution error code and its message', async () => {
    const json = vi.fn();
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { envelope: createErrorEnvelope('KB_PLUGIN_NOT_FOUND', { message: 'Plugin @acme/missing was not found.', hint: 'Install the plugin and retry.', correlationId: 'worker-correlation-17', details: { plugin: '@acme/missing' } }) },
      executionTimeMs: 1,
    }));
    const platform = { logger: { error: vi.fn() } } as unknown as PlatformServices;
    const platformContainer = { executionBackend: { execute } } as unknown as PlatformContainer;

    const exitCode = await executeCommandV3({
      binaryName: 'kb',
      pluginId: '@kb-labs/test-plugin', pluginVersion: '1.0.0', commandPath: 'test run', handlerPath: 'dist/commands/test.js',
      argv: [], flags: { json: true }, ui: { ...noopUI, json }, platform, platformContainer,
    });

    expect(exitCode).toBe(1);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'KB_PLUGIN_NOT_FOUND',
        message: 'Plugin @acme/missing was not found.',
        hint: expect.any(String),
        correlationId: 'worker-correlation-17',
        details: { plugin: '@acme/missing' },
      }),
    }));
    expect(platform.logger.error).not.toHaveBeenCalled();
  });

  // case: S-203.3
  it('presents the backend-normalized unexpected failure without logging or reclassifying it', async () => {
    const json = vi.fn();
    const logError = vi.fn();
    const envelope = createErrorEnvelope('KB_PLUGIN_COMMAND_FAILED', {
      correlationId: 'failure-correlation-31',
      details: { plugin: '@kb-labs/test-plugin', command: 'test run', failureReason: 'failed unexpectedly' },
    });
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: { envelope },
      executionTimeMs: 1,
    }));
    const platform = { logger: { error: logError } } as unknown as PlatformServices;
    const platformContainer = { executionBackend: { execute } } as unknown as PlatformContainer;

    const exitCode = await executeCommandV3({
      binaryName: 'kb',
      pluginId: '@kb-labs/test-plugin', pluginVersion: '1.0.0', commandPath: 'test run', handlerPath: 'dist/commands/test.js',
      argv: [], flags: { json: true }, ui: { ...noopUI, json }, platform, platformContainer,
    });

    expect(exitCode).toBe(1);
    expect(json).toHaveBeenCalledWith({ ok: false, error: envelope });
    expect(logError).not.toHaveBeenCalled();
  });

  // case: S-203.2
  it('passes a typed plugin product error through unchanged', async () => {
    const json = vi.fn();
    const productError = createProductErrorEnvelope({
      code: 'COMMIT_PLAN_INVALID',
      message: 'The commit plan is invalid.',
      hint: 'Run `kb commit plan create` and inspect the proposed plan.',
      details: { reason: 'empty' },
      retryable: false,
    });
    const execute = vi.fn(async () => ({ ok: false as const, error: { envelope: productError }, executionTimeMs: 1 }));
    const platformContainer = { executionBackend: { execute } } as unknown as PlatformContainer;

    await executeCommandV3({
      binaryName: 'kb',
      pluginId: '@kb-labs/commit', pluginVersion: '1.0.0', commandPath: 'commit plan show',
      handlerPath: 'dist/commands/open.js', argv: [], flags: { json: true },
      ui: { ...noopUI, json }, platform: {} as unknown as PlatformServices, platformContainer,
    });

    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining(productError),
    }));
  });
});
