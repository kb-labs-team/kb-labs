/**
 * @module @kb-labs/plugin-execution-factory/backends/worker-pool/pool-executor
 *
 * Execution logic for worker pool.
 */

import type { WorkerPoolConfig, UIPromptMessage } from './types.js';
import type { Worker } from './worker.js';
import type { ExecutionRequest, ExecutionResult } from '../../types.js';
import { WorkerCrashedError } from '../../errors.js';
import { normalizeExecutionFailure } from '../../utils.js';

/**
 * Execution manager for WorkerPool.
 */
export class PoolExecutor {
  private workers: Map<string, Worker>;
  private config: WorkerPoolConfig;

  // Statistics callbacks
  private onTotalRequests: () => void;
  private onSuccessCount: () => void;
  private onErrorCount: () => void;
  private onWorkerCrash: () => void;
  private onQueueFullRejection: () => void;

  // Other callbacks
  private onRecycleWorker: (worker: Worker) => void;

  constructor(
    workers: Map<string, Worker>,
    config: WorkerPoolConfig,
    callbacks: {
      onTotalRequests: () => void;
      onSuccessCount: () => void;
      onErrorCount: () => void;
      onWorkerCrash: () => void;
      onQueueFullRejection: () => void;
      onRecycleWorker: (worker: Worker) => void;
    }
  ) {
    this.workers = workers;
    this.config = config;
    this.onTotalRequests = callbacks.onTotalRequests;
    this.onSuccessCount = callbacks.onSuccessCount;
    this.onErrorCount = callbacks.onErrorCount;
    this.onWorkerCrash = callbacks.onWorkerCrash;
    this.onQueueFullRejection = callbacks.onQueueFullRejection;
    this.onRecycleWorker = callbacks.onRecycleWorker;
  }

  /**
   * Get first available worker.
   */
  getAvailableWorker(): Worker | null {
    for (const worker of this.workers.values()) {
      if (worker.isAvailable) {
        // Check if worker needs recycling
        if (
          worker.shouldRecycle(
            this.config.maxRequestsPerWorker,
            this.config.maxUptimeMsPerWorker
          )
        ) {
          this.onRecycleWorker(worker);
          continue;
        }
        return worker;
      }
    }
    return null;
  }

  /**
   * Execute request on specific worker.
   */
  async executeOnWorker(
    worker: Worker,
    request: ExecutionRequest,
    timeoutMs: number,
    startTime: number,
    onLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void,
    onUIPrompt?: (prompt: UIPromptMessage) => Promise<unknown>,
    onLoggerLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void,
    uiPromptHint?: string,
    signal?: AbortSignal,
    onProcessStarted?: (identity: import('@kb-labs/plugin-contracts').ProcessIdentity) => Promise<void>,
  ): Promise<ExecutionResult> {
    this.onTotalRequests();

    try {
      const result = await worker.execute(request, timeoutMs, onLog, onUIPrompt, onLoggerLog, uiPromptHint, signal, onProcessStarted);

      if (result.ok) {
        this.onSuccessCount();
      } else {
        this.onErrorCount();
      }

      // Add worker metadata
      result.metadata = {
        ...result.metadata,
        workerId: worker.id,
        backend: 'worker-pool',
      };

      return result;
    } catch (error) {
      this.onErrorCount();

      if (error instanceof WorkerCrashedError) {
        this.onWorkerCrash();
      }

      return {
        ok: false,
        ...normalizeExecutionFailure(error, request),
        executionTimeMs: performance.now() - startTime,
        metadata: {
          workerId: worker.id,
          backend: 'worker-pool',
        },
      };
    }
  }
}
