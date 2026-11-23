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

vi.mock('@kb-labs/plugin-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kb-labs/plugin-runtime')>();
  return {
    ...actual,
    runInProcess: vi.fn().mockResolvedValue({ data: 'ok', executionMeta: {} }),
    resolveAdapterMiddlewares: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn().mockReturnValue(true) };
});

import { runInProcess } from '@kb-labs/plugin-runtime';
import { createErrorEnvelope } from '@kb-labs/core-platform/error-envelope';
import { InProcessBackend } from '../backends/in-process.js';
import type { ExecutionRequest } from '../types.js';
import { useLoader } from '@kb-labs/shared-cli-ui';
import { createStreamingUI } from '@kb-labs/plugin-runtime';
import { noopUI } from '@kb-labs/plugin-contracts';

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

  it('streams useLoader progress through the request-scoped execution log callback', async () => {
    vi.mocked(runInProcess).mockImplementation(async () => {
      const loader = useLoader('In-process phase');
      loader.start();
      await new Promise((resolve) => setTimeout(resolve, 220));
      loader.stop();
      return { data: 'ok', executionMeta: {} } as never;
    });
    const backend = new InProcessBackend({ platform: new FakePlatformContainer() as unknown as ConstructorParameters<typeof InProcessBackend>[0]['platform'] });
    const logs: string[] = [];

    await backend.execute(makeRequest(), { onLog: (entry) => {
      logs.push(entry.message);
      if (logs.length === 1) { process.stderr.write('host loader callback\n'); }
    } });

    expect(logs.join('')).toContain('In-process phase');
    expect(logs.join('')).not.toContain('host loader callback');
    expect(logs.join('')).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  // case: S-203.28
  it('suppresses useLoader output for JSON command results', async () => {
    vi.mocked(runInProcess).mockImplementation(async () => {
      const loader = useLoader('JSON phase');
      loader.start();
      loader.succeed('JSON phase complete');
      return { data: 'ok', executionMeta: {} } as never;
    });
    const backend = new InProcessBackend({ platform: new FakePlatformContainer() as unknown as ConstructorParameters<typeof InProcessBackend>[0]['platform'] });
    const logs: string[] = [];

    await backend.execute(makeRequest({ input: { flags: { json: true } } }), {
      onLog: (entry) => logs.push(entry.message),
    });

    expect(logs).toEqual([]);
  });

  // case: S-203.26
  it('redacts request secrets from raw console and stdout/stderr writes', async () => {
    vi.mocked(runInProcess).mockImplementation(async () => {
      console.log('console in-process-secret');
      process.stdout.write('stdout in-process-secret\n');
      process.stderr.write('stderr in-process-secret\r');
      return { data: 'ok', executionMeta: {} } as never;
    });
    const backend = new InProcessBackend({ platform: new FakePlatformContainer() as unknown as ConstructorParameters<typeof InProcessBackend>[0]['platform'] });
    const logs: string[] = [];

    await backend.execute(makeRequest({ context: { sensitiveValues: ['in-process-secret'] } }), {
      onLog: (entry) => logs.push(entry.message),
    });

    expect(logs).toEqual([
      'console [REDACTED]',
      'stdout [REDACTED]',
      'stderr [REDACTED]',
    ]);
    expect(logs.join('')).not.toContain('in-process-secret');
  });

  it('keeps raw plugin output off stdout in JSON mode and does not recapture the host callback', async () => {
    vi.mocked(runInProcess).mockImplementation(async () => {
      console.log('plugin diagnostic');
      return { data: { ok: true }, executionMeta: {} } as never;
    });
    const backend = new InProcessBackend({ platform: new FakePlatformContainer() as unknown as ConstructorParameters<typeof InProcessBackend>[0]['platform'] });
    const logs: Array<{ message: string; stream: string }> = [];

    await backend.execute(makeRequest({ input: { argv: [], flags: { json: true } } }), {
      onLog: (entry) => {
        logs.push({ message: entry.message, stream: entry.stream });
        // A host-side callback that writes while handling output must not be
        // intercepted as a second plugin write by the same ALS scope.
        if (logs.length === 1) { process.stderr.write('host callback output\n'); }
      },
    });

    expect(logs).toEqual([{ message: 'plugin diagnostic', stream: 'stderr' }]);
  });

  // case: S-030.1
  it('streams the final human plan through the host callback when the base UI is noop', async () => {
    vi.mocked(runInProcess).mockImplementation(async (input) => {
      const ui = createStreamingUI(noopUI, input.eventEmitter!);
      ui.success('Commit plan generated', { sections: [{ header: 'Planned Commits', items: ['feat: host-owned output'] }] });
      return { data: { applied: false }, executionMeta: {} } as never;
    });
    const backend = new InProcessBackend({ platform: new FakePlatformContainer() as unknown as ConstructorParameters<typeof InProcessBackend>[0]['platform'] });
    const output: string[] = [];

    await backend.execute(makeRequest(), { onLog: (entry) => output.push(entry.message) });

    expect(output.join('\n')).toContain('Commit plan generated');
    expect(output.join('\n')).toContain('feat: host-owned output');
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
