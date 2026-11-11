import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import type { PlatformTransportFactory } from '../types.js';
import type { ExecutionRequest } from '../types.js';
import { WorkerPoolBackend } from '../backends/worker-pool/backend.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'crashing-worker-script.mjs');

function makeRequest(): ExecutionRequest {
  return {
    executionId: `crash-${Math.random().toString(36).slice(2)}`,
    handlerRef: './dist/handler.js',
    pluginRoot: '/tmp/plugin',
    input: {},
    timeoutMs: 2000,
    descriptor: {
      hostType: 'cli',
      pluginId: '@kb-labs/test',
      pluginVersion: '1.0.0',
      requestId: 'replacement-recovery',
      handlerId: 'crash',
      permissions: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    },
  };
}

async function waitForHealthy(backend: WorkerPoolBackend): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await backend.health()).healthy) { return; }
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  throw new Error('Worker pool did not recover before the test deadline.');
}

describe('worker pool replacement recovery', () => {
  let backend: WorkerPoolBackend | undefined;

  afterEach(async () => {
    await backend?.shutdown();
    backend = undefined;
  });

  it('logs each failed replacement, degrades health, retries with backoff, and recovers', async () => {
    let serverStarts = 0;
    let warningCount = 0;
    let resolveFailures: (() => void) | undefined;
    const failuresVisible = new Promise<void>((resolve) => { resolveFailures = resolve; });
    let resolveWarnings: (() => void) | undefined;
    const warningsVisible = new Promise<void>((resolve) => { resolveWarnings = resolve; });
    const platform = {
      getAdapter() { return undefined; },
      logger: {
        debug() {}, info() {},
        warn(_message: string, fields?: unknown) {
          if (fields && typeof fields === 'object' && 'code' in fields && fields.code === 'WORKER_START_FAILED') {
            warningCount++;
            if (warningCount === 2) { resolveWarnings?.(); }
          }
        },
      },
    } as unknown as PlatformServices;
    const transport = {
      type: 'ipc',
      createServer: () => ({
        start() {
          serverStarts++;
          if (serverStarts === 2) { resolveFailures?.(); }
          if (serverStarts === 2 || serverStarts === 3) { throw new Error(`replacement attempt ${serverStarts} failed`); }
        },
        stop() {},
      }),
    } as PlatformTransportFactory;
    backend = new WorkerPoolBackend({
      platform,
      platformTransport: transport,
      workerScript: fixture,
      min: 1,
      max: 1,
      healthCheckIntervalMs: 60_000,
    });

    await backend.start();
    expect((await backend.health()).healthy).toBe(true);
    const crashed = await backend.execute(makeRequest());
    expect(crashed.error?.code).toBe('WORKER_CRASHED');

    await failuresVisible;
    await warningsVisible;
    const degraded = await backend.health();
    expect(degraded.healthy).toBe(false);
    expect(degraded.details?.lastStartFailure).toMatchObject({
      code: 'WORKER_START_FAILED',
      message: 'Error',
      attempt: 2,
      retryInMs: 200,
      at: expect.any(String),
    });
    expect(warningCount).toBe(2);

    await waitForHealthy(backend);
    expect(serverStarts).toBe(4);
    const unavailable = await backend.execute(makeRequest());
    expect(unavailable.error?.code).toBe('WORKER_CRASHED');
  }, 10_000);
});
