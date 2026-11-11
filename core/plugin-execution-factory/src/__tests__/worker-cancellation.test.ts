import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Worker } from '../backends/worker-pool/worker.js';
import { WorkerPool } from '../backends/worker-pool/pool.js';
import type { ExecutionRequest } from '../types.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hanging-worker-script.mjs');

function makeRequest(): ExecutionRequest {
  return {
    executionId: `cancel-${Math.random().toString(36).slice(2)}`,
    handlerRef: './dist/handler.js',
    pluginRoot: '/tmp/plugin',
    input: {},
    descriptor: {
      hostType: 'cli',
      pluginId: '@kb-labs/test',
      handlerId: 'hang',
    } as unknown as ExecutionRequest['descriptor'],
  };
}

describe('Worker active cancellation', () => {
  let worker: Worker | undefined;

  afterEach(() => {
    worker?.kill();
    worker = undefined;
  });

  it('aborts active work and kills the worker before returning capacity', async () => {
    worker = new Worker({ workerScript: fixture });
    await worker.spawn();
    const controller = new AbortController();
    const exited = new Promise<void>((resolve) => { worker!.once('exit', () => resolve()); });
    const execution = worker.execute(makeRequest(), 5000, undefined, undefined, undefined, undefined, controller.signal);
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: 'ABORTED' });
    await exited;
    expect(worker.state).toBe('stopped');
  }, 10_000);
});


describe('WorkerPool active cancellation', () => {
  it('cancels an active pool request and replaces its killed worker', async () => {
    const pool = new WorkerPool(fixture, { min: 1, max: 1, healthCheckIntervalMs: 60_000 }, undefined, undefined, { read: () => [] });
    let spawnCount = 0;
    let resolveReplacement: (() => void) | undefined;
    const replacement = new Promise<void>((resolve) => { resolveReplacement = resolve; });
    pool.on('workerSpawned', () => {
      spawnCount++;
      if (spawnCount === 2) { resolveReplacement?.(); }
    });

    try {
      await pool.start();
      const controller = new AbortController();
      const request = makeRequest();
      request.timeoutMs = 2000;
      const execution = pool.execute(request, { signal: controller.signal });
      controller.abort();

      const result = await execution;
      expect(result.error?.code).toBe('KB_PLUGIN_ABORTED');
      await replacement;
      expect(pool.getStats().workersByState.idle).toBe(1);
      expect(pool.getStats().totalWorkers).toBe(1);
    } finally {
      await pool.shutdown();
    }
  }, 10_000);
});

describe('WorkerPoolBackend process-tree health', () => {
  // case: S-242.2
  it('reports tree enumeration failure and degrades pool health', async () => {
    const { WorkerPoolBackend } = await import('../backends/worker-pool/backend.js');
    const backend = new WorkerPoolBackend({
      platform: { logger: { info() {}, debug() {}, warn() {} }, getAdapter: () => undefined } as never,
      platformTransport: { type: 'ipc', createServer: () => ({ start() {}, stop() {} }) },
      workerScript: fixture,
      processTableSource: { read: () => { throw new Error('process table denied'); } },
      min: 1,
      max: 1,
      healthCheckIntervalMs: 60_000,
    });
    try {
      await backend.start();
      const request = makeRequest();
      request.descriptor = { ...request.descriptor, hostContext: { host: 'cli', binaryName: 'kb', argv: [], flags: {} } } as typeof request.descriptor;
      request.timeoutMs = 100;
      await backend.execute(request);
      let health = await backend.health();
      const deadline = Date.now() + 2_000;
      while ((health.details?.workers as { treeUnverified?: number }).treeUnverified !== 1 && Date.now() < deadline) {
        await new Promise(resolve => { setTimeout(resolve, 10); });
        health = await backend.health();
      }
      expect(health.healthy).toBe(false);
      expect(health.details).toMatchObject({ workers: { treeUnverified: 1 }, lastStartFailure: { code: 'WORKER_TREE_UNVERIFIED' } });
      expect(health.details).toMatchObject({ workers: { total: 1, idle: 0 } });
    } finally {
      await backend.shutdown();
    }
  }, 10_000);
});
