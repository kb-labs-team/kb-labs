import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import type { PlatformTransportFactory } from '../types.js';
import type { ExecutionRequest } from '../types.js';

const poolState = vi.hoisted(() => ({ attempts: 0, failures: 2 }));
vi.mock('../backends/worker-pool/pool.js', () => ({
  WorkerPool: class {
    on(): void {}
    async start(): Promise<void> {
      poolState.attempts++;
      if (poolState.attempts <= poolState.failures) { throw new Error(`spawn attempt ${poolState.attempts} failed`); }
    }
    async shutdown(): Promise<void> {}
    getStats() {
      return {
        totalWorkers: 1,
        treeUnverifiedWorkers: 0,
        workersByState: { starting: 0, idle: 1, busy: 0, draining: 0, stopped: 0 },
        queueLength: 0,
      };
    }
  },
}));

import { WorkerPoolBackend } from '../backends/worker-pool/backend.js';

let activeBackend: WorkerPoolBackend | undefined;

afterEach(async () => {
  await activeBackend?.shutdown();
  activeBackend = undefined;
});

function makeRequest(): ExecutionRequest {
  return {
    executionId: 'worker-pool-start-retry',
    handlerRef: './handler.js',
    pluginRoot: '/tmp/plugin',
    input: {},
    descriptor: {
      hostType: 'cli',
      pluginId: '@kb-labs/test',
      pluginVersion: '1.0.0',
      requestId: 'worker-pool-start-retry',
      handlerId: 'test',
      permissions: {},
      hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} },
    },
  };
}

describe('WorkerPoolBackend startup retry', () => {
  it('does not publish failed pools and retries through the serialized lifecycle owner', async () => {
    poolState.attempts = 0;
    const warnings: unknown[] = [];
    const platform = {
      logger: {
        debug() {}, info() {}, warn(message: string, fields?: unknown) { warnings.push({ message, fields }); },
      },
    } as unknown as PlatformServices;
    const transport = {
      type: 'ipc',
      createServer: () => ({ start() {}, stop() {} }),
    } as PlatformTransportFactory;
    const backend = activeBackend = new WorkerPoolBackend({
      platform,
      platformTransport: transport,
      min: 1,
      max: 1,
      workerScript: 'fixture.js',
    });

    const first = await backend.execute(makeRequest());
    expect(first.error?.code).toBe('WORKER_UNAVAILABLE');
    expect((await backend.health()).healthy).toBe(false);
    expect(poolState.attempts).toBe(1);

    const second = await backend.execute(makeRequest());
    expect(second.error?.code).toBe('WORKER_UNAVAILABLE');
    expect((await backend.health()).healthy).toBe(false);
    expect(poolState.attempts).toBe(1);

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !(await backend.health()).healthy) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
    }
    expect(poolState.attempts).toBe(3);
    expect((await backend.health()).healthy).toBe(true);
    expect(warnings).toHaveLength(2);
    await backend.shutdown();
  });

  // case: S-242.4
  it('serializes transport initialization failures under lifecycle backoff', async () => {
    poolState.attempts = 0;
    poolState.failures = 0;
    let initCalls = 0;
    let activeInitCalls = 0;
    let maxActiveInitCalls = 0;
    let resolveRecovered: (() => void) | undefined;
    const recovered = new Promise<void>((resolve) => { resolveRecovered = resolve; });
    let resolveSecondFailure: (() => void) | undefined;
    const secondFailure = new Promise<void>((resolve) => { resolveSecondFailure = resolve; });
    const warnings: unknown[] = [];
    const platform = {
      logger: {
        debug() {}, info() {}, warn(message: string, fields?: unknown) {
          warnings.push({ message, fields });
          if (fields && typeof fields === 'object' && 'attempt' in fields && fields.attempt === 2) {
            resolveSecondFailure?.();
          }
        },
      },
    } as unknown as PlatformServices;
    const transport = {
      type: 'ipc',
      async init() {
        initCalls++;
        activeInitCalls++;
        maxActiveInitCalls = Math.max(maxActiveInitCalls, activeInitCalls);
        await Promise.resolve();
        activeInitCalls--;
        if (initCalls < 3) {
          throw Object.assign(new Error('private transport startup details'), { code: 'EINIT' });
        }
        resolveRecovered?.();
      },
      createServer: () => ({ start() {}, stop() {} }),
    } as unknown as PlatformTransportFactory;
    const backend = activeBackend = new WorkerPoolBackend({
      platform,
      platformTransport: transport,
      min: 1,
      max: 1,
      workerScript: 'fixture.js',
    });

    const firstBurst = await Promise.allSettled(Array.from({ length: 12 }, () => backend.execute(makeRequest())));
    expect(firstBurst.filter(result => result.status === 'rejected')).toHaveLength(0);
    const duringBackoff = firstBurst.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    expect(duringBackoff).toHaveLength(12);
    expect({ initCalls, maxActiveInitCalls }).toEqual({ initCalls: 1, maxActiveInitCalls: 1 });
    expect(duringBackoff.every(result => result.error?.code === 'WORKER_UNAVAILABLE')).toBe(true);
    expect(duringBackoff.every(result => result.error?.hint.includes('WORKER_START_FAILED'))).toBe(true);
    const firstOutcome = await backend.start();
    expect(firstOutcome).toMatchObject({
      status: 'recovering',
      failure: { code: 'WORKER_START_FAILED', message: 'EINIT', attempt: 1, retryInMs: 100 },
    });
    const firstHealth = await backend.health();
    expect(firstHealth.healthy).toBe(false);
    expect(firstHealth.details?.lastStartFailure).toMatchObject({
      code: 'WORKER_START_FAILED',
      message: 'EINIT',
      attempt: 1,
      retryInMs: 100,
    });

    expect(warnings).toContainEqual(expect.objectContaining({
      fields: expect.objectContaining({ code: 'WORKER_START_FAILED', message: 'EINIT', attempt: 1, retryInMs: 100 }),
    }));
    expect(initCalls).toBe(1);
    expect(maxActiveInitCalls).toBe(1);
    expect(JSON.stringify({ health: firstHealth, warnings })).not.toContain('private transport startup details');

    await secondFailure;
    const secondBackoffStorm = await Promise.all(Array.from({ length: 12 }, () => backend.execute(makeRequest())));
    expect(secondBackoffStorm.every(result => result.error?.code === 'WORKER_UNAVAILABLE')).toBe(true);
    expect(secondBackoffStorm.every(result => result.error?.hint.includes('WORKER_START_FAILED'))).toBe(true);
    expect(secondBackoffStorm.every(result => result.error?.details?.failureAttempt === '2')).toBe(true);
    expect(initCalls).toBe(2);
    expect(maxActiveInitCalls).toBe(1);

    await recovered;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !(await backend.health()).healthy) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    expect(initCalls).toBe(3);
    expect(maxActiveInitCalls).toBe(1);
    expect((await backend.health()).healthy).toBe(true);
    await backend.shutdown();
  }, 5_000);
});
