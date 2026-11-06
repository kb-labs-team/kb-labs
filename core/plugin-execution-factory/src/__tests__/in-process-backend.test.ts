/**
 * Regression test for InProcessBackend's loggerOverride handling.
 *
 * PlatformServices fields (processExecutor, cache, llm, storage, ...) are
 * implemented as class getters on PlatformContainer.prototype — not own
 * instance properties. A plain object spread (`{ ...platform, logger: x }`)
 * only copies own enumerable properties, so it silently drops every
 * getter-backed field except the one being overridden. This broke every
 * workflow-daemon step (which always passes a loggerOverride for per-step
 * SQLite logging, see ADR-0019): `ctx.api.shell.exec()` threw "Governed
 * process executor is unavailable in this execution host" because
 * `effectivePlatform.processExecutor` silently resolved to undefined.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@kb-labs/plugin-runtime', () => ({
  runInProcess: vi.fn().mockResolvedValue({ data: 'ok', executionMeta: {} }),
  resolveAdapterMiddlewares: vi.fn().mockResolvedValue([]),
}));

vi.mock('node:fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
});

import { runInProcess } from '@kb-labs/plugin-runtime';
import { createErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { InProcessBackend } from '../backends/in-process.js';
import type { ExecutionRequest } from '../types.js';

/** Mimics PlatformContainer: processExecutor is a prototype getter, not an own property. */
class FakePlatformContainer {
  private readonly adapters = new Map<string, unknown>();

  constructor() {
    this.adapters.set('processExecutor', { execute: vi.fn(), capabilities: vi.fn() });
  }

  getAdapter(key: string): unknown {
    return this.adapters.get(key);
  }

  get processExecutor() {
    return this.getAdapter('processExecutor');
  }

  get logger() {
    return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) };
  }
}

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    executionId: 'exec-001',
    handlerRef: './dist/handler.js',
    pluginRoot: '/tmp/plugin',
    input: {},
    descriptor: {
      hostType: 'workflow',
      pluginId: '@kb-labs/test-plugin',
      pluginVersion: '1.0.0',
      permissions: {},
      hostContext: { host: 'workflow', workflowId: 'workflow-1', runId: 'run-1', jobId: 'job-1', stepId: 'step-1', attempt: 0 },
    } as unknown as ExecutionRequest['descriptor'],
    ...overrides,
  };
}

describe('InProcessBackend — loggerOverride platform handoff', () => {
  beforeEach(() => {
    vi.mocked(runInProcess).mockClear();
  });

  it('regression: processExecutor (and other getter-backed fields) survive a loggerOverride', async () => {
    const platform = new FakePlatformContainer() as unknown as ConstructorParameters<typeof InProcessBackend>[0]['platform'];
    const backend = new InProcessBackend({ platform });
    const stepLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => ({}) };

    await backend.execute(
      makeRequest({ context: { loggerOverride: stepLogger } } as unknown as Partial<ExecutionRequest>),
    );

    expect(runInProcess).toHaveBeenCalledOnce();
    const passedPlatform = vi.mocked(runInProcess).mock.calls[0]?.[0]?.platform as {
      processExecutor?: unknown;
      logger?: unknown;
    };

    expect(passedPlatform.logger).toBe(stepLogger);
    expect(passedPlatform.processExecutor).toBeDefined();
  });

  it('passes the raw platform through unchanged when no loggerOverride is given', async () => {
    const platform = new FakePlatformContainer() as unknown as ConstructorParameters<typeof InProcessBackend>[0]['platform'];
    const backend = new InProcessBackend({ platform });

    await backend.execute(makeRequest());

    const passedPlatform = vi.mocked(runInProcess).mock.calls[0]?.[0]?.platform;
    expect(passedPlatform).toBe(platform);
  });

  it('preserves a named handler export through in-process dispatch', async () => {
    const backend = new InProcessBackend({
      platform: new FakePlatformContainer() as unknown as ConstructorParameters<typeof InProcessBackend>[0]['platform'],
    });

    await backend.execute(makeRequest({ handlerRef: './dist/sessions-handler.js#createSessionHandler' }));

    expect(vi.mocked(runInProcess).mock.calls[0]?.[0]?.handlerPath)
      .toMatch(/sessions-handler\.js#createSessionHandler$/);
  });

  it('enforces the execution request timeout and returns the catalogue timeout code', async () => {
    vi.mocked(runInProcess).mockImplementation(async (input) => {
      const signal = input.signal;
      if (!signal) { throw new Error('execution timeout signal was not provided'); }
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return {
        ok: true,
        data: undefined,
        executionMeta: {
          startTime: 0,
          endTime: 20,
          duration: 20,
          pluginId: 'test-plugin',
          pluginVersion: '1.0.0',
          requestId: 'timeout-test',
        },
      };
    });
    const backend = new InProcessBackend({
      platform: new FakePlatformContainer() as unknown as ConstructorParameters<typeof InProcessBackend>[0]['platform'],
    });

    const result = await backend.execute(makeRequest({ timeoutMs: 20 }));

    expect(result.ok).toBe(false);
    if (result.ok) { throw new Error('expected timeout failure'); }
    const timeout = createErrorEnvelope('KB_RUNTIME_TIMEOUT', {
      correlationId: 'exec-001',
      details: { timeoutMs: '20' },
    });
    expect(result.error).toMatchObject({
      code: timeout.code,
      message: timeout.message,
      hint: timeout.hint,
      details: timeout.details,
    });
  });
});
