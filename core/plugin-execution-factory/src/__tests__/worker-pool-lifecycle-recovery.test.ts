import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerPoolConfig } from '../backends/worker-pool/types.js';

const workerControl = vi.hoisted(() => ({ attempts: 0, resolveThird: undefined as (() => void) | undefined }));

vi.mock('../backends/worker-pool/worker.js', () => ({
  Worker: class extends EventEmitter {
    readonly id = `worker-${++workerControl.attempts}`;
    state: 'idle' | 'stopped' = 'idle';
    readonly treeUnverified = false;
    readonly info = { id: this.id, state: this.state, createdAt: Date.now(), requestCount: 0, healthy: true };
    async spawn(): Promise<void> {
      if (workerControl.attempts === 2) {throw new Error('replacement spawn failed');}
      if (workerControl.attempts === 3) {workerControl.resolveThird?.();}
    }
    async shutdown(): Promise<void> { this.state = 'stopped'; }
    healthCheck(): Promise<boolean> { return Promise.resolve(true); }
    kill(): void {}
    shouldRecycle(): boolean { return false; }
  },
}));

import { WorkerLifecycleManager } from '../backends/worker-pool/pool-lifecycle.js';

const config: WorkerPoolConfig = {
  min: 1, max: 1, maxRequestsPerWorker: 10, maxUptimeMsPerWorker: 60_000,
  maxQueueSize: 10, acquireTimeoutMs: 100, healthCheckIntervalMs: 60_000,
  warmup: { mode: 'none', topN: 0, maxHandlers: 0 },
};

describe('pool lifecycle replacement recovery', () => {
  let manager: WorkerLifecycleManager | undefined;
  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    workerControl.attempts = 0;
    workerControl.resolveThird = undefined;
  });

  it('retries a failed replacement through the capacity recovery owner', async () => {
    let resolveThird: (() => void) | undefined;
    const thirdAttempt = new Promise<void>((resolve) => { resolveThird = resolve; });
    workerControl.resolveThird = () => resolveThird?.();
    const workers = new Map();
    manager = new WorkerLifecycleManager(workers, config, 'fixture.js', {
      onWorkerSpawned() {}, onWorkerExited() {}, onWorkerRecycled() {}, onHealthCheckFailed() {},
      onProcessQueue() {}, onWorkersRecycled() {}, onWorkerStartFailure() {},
    });

    await manager.startInitialWorkers();
    const original = [...workers.values()][0];
    original.emit('exit', original, 1, null);
    await Promise.race([
      thirdAttempt,
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('replacement recovery did not retry')), 2_000); }),
    ]);
    expect(workerControl.attempts).toBe(3);
    expect(workers.size).toBe(1);
  });
});
