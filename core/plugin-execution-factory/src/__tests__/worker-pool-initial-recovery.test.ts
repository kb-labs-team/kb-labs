import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import type { PlatformTransportFactory } from '../types.js';
import type { ExecutionRequest } from '../types.js';
import { WorkerPoolBackend } from '../backends/worker-pool/backend.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'crashing-worker-script.mjs');

function makeRequest(index: number): ExecutionRequest {
  return {
    executionId: `initial-retry-${index}`,
    handlerRef: './handler.js',
    pluginRoot: '/tmp/plugin',
    input: {},
    descriptor: {
      hostType: 'cli',
      pluginId: '@kb-labs/test',
      pluginVersion: '1.0.0',
      requestId: `initial-retry-${index}`,
      handlerId: 'test',
      permissions: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    },
  };
}

describe('worker pool initial capacity recovery', () => {
  let backend: WorkerPoolBackend | undefined;

  afterEach(async () => {
    await backend?.shutdown();
    backend = undefined;
  });

  it('owns initial spawn retries and fails requests fast while bounded recovery is pending', async () => {
    let attempts = 0;
    let failedAttempts = 0;
    let resolveFailures: (() => void) | undefined;
    const failuresObserved = new Promise<void>((resolve) => { resolveFailures = resolve; });
    const platform = {
      getAdapter() { return undefined; },
      logger: {
        debug() {}, info() {},
        warn(_message: string, fields?: unknown) {
          if (fields && typeof fields === 'object' && 'code' in fields && fields.code === 'WORKER_START_FAILED') {
            failedAttempts++;
            if (failedAttempts === 2) {resolveFailures?.();}
          }
        },
      },
    } as unknown as PlatformServices;
    const transport = {
      type: 'ipc',
      createServer: () => ({
        start() {
          attempts++;
          if (attempts <= 2) {throw new Error(`initial spawn ${attempts} failed`);}
        },
        stop() {},
      }),
    } as PlatformTransportFactory;
    backend = new WorkerPoolBackend({
      platform,
      platformTransport: transport,
      min: 1,
      max: 1,
      workerScript: fixture,
      healthCheckIntervalMs: 60_000,
    });

    await backend.start();
    await failuresObserved;
    const beforeRequests = attempts;
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) => backend!.execute(makeRequest(index))));
    expect(attempts).toBe(beforeRequests);
    expect(outcomes.every(result => result.error?.code === 'WORKER_UNAVAILABLE')).toBe(true);
    const degraded = await backend.health();
    expect(degraded.healthy).toBe(false);
    expect(degraded.details?.lastStartFailure).toMatchObject({
      code: 'WORKER_START_FAILED',
      message: 'Error',
      attempt: 2,
      retryInMs: 200,
      at: expect.any(String),
    });
    expect(failedAttempts).toBe(2);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(await backend.health()).healthy) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    expect((await backend.health()).healthy).toBe(true);
    expect(attempts).toBe(3);
  }, 10_000);

  // case: S-242.4
  it('preserves the startup cause in health, structured logs, and the unavailable hint', async () => {
    const warnings: unknown[] = [];
    let missingExecutablePath = '';
    let resolveWarning: (() => void) | undefined;
    const warningObserved = new Promise<void>((resolve) => { resolveWarning = resolve; });
    const platform = {
      getAdapter() { return undefined; },
      logger: {
        debug() {}, info() {},
        warn(_message: string, fields?: unknown) {
          warnings.push(fields);
          resolveWarning?.();
        },
      },
    } as unknown as PlatformServices;
    const transport = {
      type: 'ipc',
      createServer: () => ({
        start() {
          missingExecutablePath = join(tmpdir(), `x60-missing-worker-${randomUUID()}`);
          const result = spawnSync(missingExecutablePath, []);
          if (!result.error) { throw new Error('Expected the missing worker executable to fail with ENOENT'); }
          throw result.error;
        },
        stop() {},
      }),
    } as PlatformTransportFactory;
    backend = new WorkerPoolBackend({
      platform,
      platformTransport: transport,
      min: 1,
      max: 1,
      workerScript: fixture,
      processTableSource: { read: () => [] },
      healthCheckIntervalMs: 60_000,
    });

    await backend.start();
    await warningObserved;
    const health = await backend.health();
    const failure = health.details?.lastStartFailure as Record<string, unknown> | undefined;
    expect(failure).toMatchObject({
      code: 'WORKER_START_FAILED',
      message: 'ENOENT',
      attempt: 1,
      retryInMs: 100,
    });
    expect(warnings).toContainEqual(expect.objectContaining({
      code: 'WORKER_START_FAILED',
      message: 'ENOENT',
      attempt: 1,
      retryInMs: 100,
    }));

    const result = await backend.execute(makeRequest(99));
    expect(result.error).toMatchObject({
      code: 'WORKER_UNAVAILABLE',
      hint: expect.stringContaining('WORKER_START_FAILED'),
    });
    expect(result.error?.hint).toContain('kb health');
    const visibleDiagnostics = JSON.stringify({ failure, warnings, error: result.error });
    expect(visibleDiagnostics).not.toContain(missingExecutablePath);
  }, 10_000);
});
