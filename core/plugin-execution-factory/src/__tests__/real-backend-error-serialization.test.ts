import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_PERSISTENCE_ERROR_FLUSH_TIMEOUT_MS, validateErrorEnvelope, type ILogger } from '@kb-labs/core-platform';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import { createExecutionBackend, createNormalizedExecutionBackend } from '../factory.js';
import { WorkerPoolBackend } from '../backends/worker-pool/backend.js';
import type { ExecutionBackend, ExecutionRequest } from '../types.js';

interface StructuredLogRecord {
  level: string;
  message: string;
  error?: Error;
  [field: string]: unknown;
}

class MemoryLoggerSink implements ILogger {
  readonly records: StructuredLogRecord[] = [];
  flushCount = 0;
  readonly flushRecordCounts: number[] = [];

  trace(message: string, meta?: Record<string, unknown>) { this.write('trace', message, undefined, meta); }
  debug(message: string, meta?: Record<string, unknown>) { this.write('debug', message, undefined, meta); }
  info(message: string, meta?: Record<string, unknown>) { this.write('info', message, undefined, meta); }
  warn(message: string, meta?: Record<string, unknown>) { this.write('warn', message, undefined, meta); }
  error(message: string, error?: Error, meta?: Record<string, unknown>) { this.write('error', message, error, meta); }
  fatal(message: string, error?: Error, meta?: Record<string, unknown>) { this.write('fatal', message, error, meta); }
  flush(): Promise<void> {
    this.flushCount += 1;
    this.flushRecordCounts.push(this.records.length);
    return Promise.resolve();
  }
  child(_bindings: Record<string, unknown>) { return this; }

  queryByCorrelationId(correlationId: string): StructuredLogRecord[] {
    return this.records.filter((record) => record.correlationId === correlationId);
  }

  private write(level: string, message: string, error?: Error, meta?: Record<string, unknown>) {
    this.records.push({ level, message, ...(meta ?? {}), ...(error ? { error } : {}) });
  }
}

const returnedStack = 'Error: serialized returned failure\n    at registeredHandler (handler.js:7:3)';
const thrownMessage = 'FIXTURE_THROW_STACK';
const productStack = 'PluginError: typed plugin failure\n    at registeredHandler (bundled-plugin.js:31:5)';
const platformStack = 'AdapterUnavailableError: fixture adapter unavailable\n    at registeredHandler (adapter-plugin.js:19:7)';
const backends = ['in-process', 'worker-pool', 'subprocess'] as const;
interface FailureCase {
  label: string;
  handler: string;
  expectedCode: string;
  name: string;
  message: string;
  stack?: string;
  stackIncludes?: string;
}

const failures: FailureCase[] = [
  {
    label: 'returned serialized failure',
    handler: 'returned-serialized-failure-handler.js',
    expectedCode: 'KB_PLUGIN_CONTRACT_VIOLATION',
    name: 'Error',
    message: 'returned handler failure',
    stack: returnedStack,
  },
  {
    label: 'plain thrown Error',
    handler: 'thrown-failure-handler.js',
    expectedCode: 'KB_PLUGIN_COMMAND_FAILED',
    name: 'Error',
    message: thrownMessage,
    stackIncludes: thrownMessage,
  },
  {
    label: 'typed plugin error with a catalogued code',
    handler: 'typed-product-failure-handler.js',
    expectedCode: 'KB_PLUGIN_PERMISSION_DENIED',
    name: 'PluginError',
    message: 'typed plugin failure',
    stack: productStack,
  },
  {
    label: 'catalogued platform adapter error',
    handler: 'platform-adapter-failure-handler.js',
    expectedCode: 'KB_ADAPTER_NOT_CONFIGURED',
    name: 'AdapterUnavailableError',
    message: 'fixture adapter unavailable',
    stack: platformStack,
  },
];

type FailureFixture = FailureCase['handler'];

function makeBackend(mode: (typeof backends)[number], platform: PlatformServices, logger: ILogger): ExecutionBackend {
  if (mode !== 'worker-pool') {
    return createExecutionBackend({
      platform,
      mode,
      workerPool: { min: 1, max: 1 },
    });
  }

  const workerScript = fileURLToPath(new URL('../../dist/backends/worker-pool/worker-script.js', import.meta.url));
  const rawBackend = new WorkerPoolBackend({
    platform,
    min: 1,
    max: 1,
    workerScript,
  });
  return createNormalizedExecutionBackend(rawBackend, logger, mode);
}

function makeRequest(handler: FailureFixture, correlationId: string, hostType: 'cli' | 'rest' = 'cli'): ExecutionRequest {
  const fixturePath = fileURLToPath(new URL(`./fixtures/${handler}`, import.meta.url));
  return {
    executionId: `${correlationId}-execution`,
    handlerRef: `./${handler}`,
    pluginRoot: path.dirname(fixturePath),
    input: { correlationId },
    descriptor: {
      hostType,
      pluginId: '@kb-labs/failure-fixture',
      pluginVersion: '1.0.0',
      requestId: correlationId,
      handlerId: 'fixture:failure',
      permissions: {},
      hostContext: hostType === 'cli'
        ? { host: 'cli', binaryName: 'kb', argv: [], flags: {} }
        : { host: 'rest', method: 'POST', path: '/plugins/failure', headers: {} },
    } as ExecutionRequest['descriptor'],
    context: { commandPath: 'fixture failure' },
  };
}

describe.each(backends)('%s real health mode', (mode) => {
  it('reports its resolved execution mode', async () => {
    const logger = new MemoryLoggerSink();
    const platform = { logger, getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = makeBackend(mode, platform, logger);
    try {
      await expect(backend.health()).resolves.toMatchObject({ executionMode: mode });
    } finally {
      await backend.shutdown();
    }
  });
});

describe('persistence failure at the normalized result boundary', () => {
  it.each([
    ['hung', () => new Promise<void>(() => {})],
    ['rejected', () => Promise.reject(new Error('log sink unavailable'))],
  ] as const)('%s persistence preserves the normalized handler error and reports one diagnostic', async (_failure, flush) => {
    class FailingFlushLogger extends MemoryLoggerSink {
      override flush(): Promise<void> {
        this.flushCount += 1;
        this.flushRecordCounts.push(this.records.length);
        return flush();
      }
    }
    const logger = new FailingFlushLogger();
    const platform = { logger, getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = makeBackend('in-process', platform, logger);
    const correlationId = `persistence-failure-${_failure}`;
    const started = Date.now();

    try {
      const result = await backend.execute(makeRequest('thrown-failure-handler.js', correlationId));
      expect(Date.now() - started).toBeLessThan(LOG_PERSISTENCE_ERROR_FLUSH_TIMEOUT_MS + 1000);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.envelope).toMatchObject({
        code: 'KB_PLUGIN_COMMAND_FAILED',
        correlationId,
      });
      const diagnostics = logger.records.filter(record =>
        record.diagnosticEvent === 'platform.log.persistence.flush.failed'
        && record.reasonCode === 'LOG_PERSISTENCE_FLUSH_FAILED'
      );
      expect(diagnostics).toHaveLength(1);
    } finally {
      await backend.shutdown();
    }
  });
});

describe.each(backends)('%s real failure dispatch', (mode) => {
  it.each(failures)('validates the $label envelope and records safe correlated diagnostics', async (failure) => {
    const logger = new MemoryLoggerSink();
    const platform = { logger, getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = makeBackend(mode, platform, logger);
    const correlationId = `${mode}-${failure.handler}`;

    try {
      expect(backend.executionMode).toBe(mode);
      await expect(backend.health()).resolves.toMatchObject({ executionMode: mode });
      const result = await backend.execute(makeRequest(failure.handler, correlationId));

      expect(result.metadata?.backend).toBe(mode);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code, `${mode} ${failure.handler} returned ${result.error.error.name}: ${result.error.error.message}`).toBe(failure.expectedCode);
      expect(result.error.envelope.code).toBe(failure.expectedCode);
      expect(result.error).not.toHaveProperty('stack');
      expect(result.error.envelope).not.toHaveProperty('stack');
      expect(validateErrorEnvelope(result.error.envelope)).toEqual([]);

      const records = logger.queryByCorrelationId(correlationId);
      expect(records).toHaveLength(1);
      const [record] = records;
      expect(record).toEqual(expect.objectContaining({
        event: 'plugin.handler.failed',
        correlationId,
      }));
      if (failure.expectedCode === 'KB_PLUGIN_CONTRACT_VIOLATION') {
        expect(record).toMatchObject({
          sourceErrorClass: failure.name,
          sourceMessage: failure.message,
          failureMode: 'returned',
          sourceHintType: 'absent',
          pluginId: '@kb-labs/failure-fixture',
          pluginVersion: '1.0.0',
          command: 'fixture failure',
        });
        expect(result.error.envelope.details).toMatchObject({
          sourceErrorClass: failure.name,
          sourceMessage: failure.message,
          failureMode: 'returned',
        });
        expect(JSON.stringify(record)).toContain(failure.message);
        expect(record).not.toHaveProperty('serializedError');
        expect(record).not.toHaveProperty('error');
      } else {
        expect(record).toMatchObject({
          serializedError: expect.objectContaining({
            name: failure.name,
            message: failure.message,
            ...(failure.stack ? { stack: failure.stack } : {}),
            ...(failure.stackIncludes ? { stack: expect.stringContaining(failure.stackIncludes) } : {}),
          }),
        });
        expect((record?.serializedError as { stack?: string } | undefined)?.stack).toContain(
          failure.stackIncludes ?? failure.stack,
        );
        if (failure.expectedCode === 'KB_PLUGIN_COMMAND_FAILED') {
          expect(result.error.envelope.details).toMatchObject({
            sourceErrorClass: failure.name,
            sourceMessage: failure.message,
            failureMode: 'thrown',
          });
          expect(record).toMatchObject({
            sourceErrorClass: failure.name,
            sourceMessage: failure.message,
            failureMode: 'thrown',
            pluginId: '@kb-labs/failure-fixture',
            pluginVersion: '1.0.0',
            command: 'fixture failure',
          });
        }
      }
    } finally {
      await backend.shutdown();
    }
  });

  // case: S-243.7
  it('preserves source identity when a plain Error is thrown', async () => {
    const logger = new MemoryLoggerSink();
    const platform = { logger, getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = makeBackend(mode, platform, logger);
    const correlationId = `${mode}-plain-thrown-error`;

    try {
      const result = await backend.execute(makeRequest('thrown-failure-handler.js', correlationId));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.envelope).toMatchObject({
        code: 'KB_PLUGIN_COMMAND_FAILED',
        correlationId,
        details: {
          sourceErrorClass: 'Error',
          sourceMessage: thrownMessage,
          failureMode: 'thrown',
        },
      });
      expect(result.error.envelope).not.toHaveProperty('stack');
      const records = logger.queryByCorrelationId(correlationId);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: 'plugin.handler.failed',
        correlationId,
        sourceErrorClass: 'Error',
        sourceMessage: thrownMessage,
        failureMode: 'thrown',
        pluginId: '@kb-labs/failure-fixture',
        pluginVersion: '1.0.0',
        command: 'fixture failure',
      });
    } finally {
      await backend.shutdown();
    }
  });

  // case: S-243.6
  it('turns a returned malformed hint into a valid platform envelope', async () => {
    const logger = new MemoryLoggerSink();
    const platform = { logger, getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = makeBackend(mode, platform, logger);
    const correlationId = `${mode}-returned-invalid-envelope`;

    try {
      const result = await backend.execute(makeRequest('returned-invalid-envelope-handler.js', correlationId));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.envelope).toMatchObject({
        code: 'KB_PLUGIN_CONTRACT_VIOLATION',
        correlationId,
        details: {
          field: 'hint',
          sourceCode: 'COMMIT_COMMAND_FAILED',
          sourceErrorClass: 'Object',
          sourceMessage: 'Commit command failed.',
          failureMode: 'returned',
        },
      });
      expect(validateErrorEnvelope(result.error.envelope)).toEqual([]);
      const records = logger.queryByCorrelationId(correlationId);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: 'plugin.handler.failed',
        correlationId,
        sourceCode: 'COMMIT_COMMAND_FAILED',
        sourceErrorClass: 'Object',
        sourceMessage: 'Commit command failed.',
        failureMode: 'returned',
        pluginId: '@kb-labs/failure-fixture',
        pluginVersion: '1.0.0',
        command: 'fixture failure',
      });
    } finally {
      await backend.shutdown();
    }
  });
});

describe('REST handler failure persistence', () => {
  it('records an unexpected handler cause under the response correlation ID', async () => {
    const logger = new MemoryLoggerSink();
    const platform = { logger, getAdapter: () => undefined } as unknown as PlatformServices;
    const backend = makeBackend('in-process', platform, logger);
    const correlationId = 'rest-failure-correlation';

    try {
      const result = await backend.execute(makeRequest('runtime-unexpected-failure-handler.js', correlationId, 'rest'));

      expect(result.ok).toBe(false);
      expect(logger.flushCount).toBeGreaterThan(0);
      expect(logger.flushRecordCounts.at(-1)).toBeGreaterThan(0);
      if (result.ok) return;
      expect(result.error.envelope).toMatchObject({
        code: 'KB_RUNTIME_UNEXPECTED',
        correlationId,
      });
      const [record] = logger.queryByCorrelationId(correlationId);
      expect(record).toMatchObject({
        event: 'plugin.handler.failed',
        correlationId,
        serializedError: expect.objectContaining({
          cause: expect.objectContaining({ message: 'unexpected REST handler fixture cause' }),
        }),
      });
    } finally {
      await backend.shutdown();
    }
  });
});
