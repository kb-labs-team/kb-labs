/**
 * @module @kb-labs/plugin-execution-factory/backends/worker-pool/pool
 *
 * WorkerPool - manages pool of workers with bounded queue.
 * Refactored to use modular components for lifecycle, queue, execution, and stats.
 */

import { EventEmitter } from 'node:events';
import type { WorkerPoolConfig, UIPromptMessage } from './types.js';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import type { Worker } from './worker.js';
import type { ProcessTableSource, ProcessTreeResult } from './process-tree.js';
import type { ExecutionRequest, ExecutionResult, PlatformTransportFactory } from '../../types.js';
import { AbortError, QueueFullError, WorkerUnavailableError } from '../../errors.js';
import { normalizeExecutionFailure } from '../../utils.js';

// Modular components
import { PoolStatsTracker } from './pool-stats.js';
import { WorkerLifecycleManager, createWorkerFailureRecord } from './pool-lifecycle.js';
import { PoolQueueManager } from './pool-queue.js';
import { PoolExecutor } from './pool-executor.js';

/**
 * Pool events.
 */
export interface PoolEvents {
  workerSpawned: [worker: Worker];
  workerExited: [worker: Worker, code: number | null];
  workerRecycled: [worker: Worker];
  queueFull: [queueSize: number];
  healthCheckFailed: [worker: Worker];
  treeUnverified: [worker: Worker, result: ProcessTreeResult];
}

/**
 * WorkerPool - manages a pool of worker processes.
 *
 * Features:
 * - Bounded queue with QUEUE_FULL error when at capacity
 * - Acquire timeout for getting available worker
 * - Per-plugin concurrency limits
 * - Worker recycling (max requests, max uptime)
 * - Health checks with automatic worker replacement
 * - Graceful shutdown
 */
export class WorkerPool extends EventEmitter<PoolEvents> {
  private readonly config: WorkerPoolConfig;
  private readonly workers = new Map<string, Worker>();

  // Modular managers
  private readonly statsTracker: PoolStatsTracker;
  private readonly lifecycleManager: WorkerLifecycleManager;
  private readonly queueManager: PoolQueueManager;
  private readonly executor: PoolExecutor;

  constructor(
    workerScript: string,
    config: Partial<WorkerPoolConfig> = {},
    platform?: PlatformServices,
    platformTransport?: PlatformTransportFactory,
    processTableSource?: ProcessTableSource,
  ) {
    super();

    this.config = {
      min: config.min ?? 2,
      max: config.max ?? 10,
      maxRequestsPerWorker: config.maxRequestsPerWorker ?? 1000,
      maxUptimeMsPerWorker: config.maxUptimeMsPerWorker ?? 30 * 60 * 1000,
      maxQueueSize: config.maxQueueSize ?? 100,
      acquireTimeoutMs: config.acquireTimeoutMs ?? 5000,
      maxConcurrentPerPlugin: config.maxConcurrentPerPlugin,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 10_000,
      warmup: config.warmup ?? {
        mode: 'none',
        topN: 5,
        maxHandlers: 20,
      },
    };

    // Initialize stats tracker
    this.statsTracker = new PoolStatsTracker();

    // Initialize lifecycle manager
    this.lifecycleManager = new WorkerLifecycleManager(
      this.workers,
      this.config,
      workerScript,
      {
        onWorkerSpawned: (worker) => {
          worker.on('treeUnverified', (w, result) => {
            if (!result.verified) {
              this.statsTracker.stats.treeUnverifiedWorkers++;
              this.statsTracker.stats.lastStartFailure = {
                code: 'WORKER_TREE_UNVERIFIED',
                message: result.reason,
                at: new Date().toISOString(),
                attempt: 0,
                retryInMs: 0,
              };
            }
            this.emit('treeUnverified', w, result);
            platform?.logger.warn('Worker process tree could not be verified after termination', { workerId: w.id, code: 'WORKER_TREE_UNVERIFIED', reason: result.verified ? 'verified' : result.reason, descendants: result.descendants, error: result.verified ? undefined : result.error });
          });
          this.emit('workerSpawned', worker);
        },
        onWorkerExited: (worker, code) => this.emit('workerExited', worker, code),
        onWorkerRecycled: (worker) => this.emit('workerRecycled', worker),
        onHealthCheckFailed: (worker) => this.emit('healthCheckFailed', worker),
        onProcessQueue: () => this.queueManager.processQueue(),
        onWorkersRecycled: () => {
          this.statsTracker.stats.workersRecycled++;
        },
        onWorkerStartFailure: (failure) => {
          this.queueManager?.clearQueue(new WorkerUnavailableError(failure));
        },
      },
      platform,
      platformTransport,
      processTableSource,
    );

    // Initialize queue manager
    this.queueManager = new PoolQueueManager(this.config, {
      onTrackQueueWaitTime: (waitTimeMs) =>
        this.statsTracker.trackQueueWaitTime(waitTimeMs),
      onGetAvailableWorker: () => this.executor.getAvailableWorker(),
      onExecuteOnWorker: (worker, request, timeoutMs, startTime, onLog, onUIPrompt, onLoggerLog, uiPromptHint, signal) =>
        this.executor.executeOnWorker(worker, request, timeoutMs, startTime, onLog, onUIPrompt, onLoggerLog, uiPromptHint, signal),
      onAcquireTimeout: () => {
        this.statsTracker.stats.acquireTimeouts++;
      },
    });

    // Initialize executor
    this.executor = new PoolExecutor(this.workers, this.config, {
      onTotalRequests: () => {
        this.statsTracker.stats.totalRequests++;
      },
      onSuccessCount: () => {
        this.statsTracker.stats.successCount++;
      },
      onErrorCount: () => {
        this.statsTracker.stats.errorCount++;
      },
      onWorkerCrash: () => {
        this.statsTracker.stats.workerCrashes++;
      },
      onQueueFullRejection: () => {
        this.statsTracker.stats.queueFullRejections++;
      },
      onRecycleWorker: (worker) => this.lifecycleManager.scheduleRecycle(worker),
    });
  }

  /**
   * Start the pool.
   */
  async start(): Promise<void> {
    await this.lifecycleManager.startInitialWorkers();
  }

  /**
   * Execute request using pool.
   *
   * Flow:
   * 1. Check per-plugin concurrency
   * 2. Check queue capacity
   * 3. Try to get available worker
   * 4. If no worker, queue request
   * 5. Wait for result or timeout
   */
  async execute(
    request: ExecutionRequest,
    options?: {
      signal?: AbortSignal;
      onLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void;
      onLoggerLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void;
      onUIPrompt?: (prompt: UIPromptMessage) => Promise<unknown>;
      uiPromptHint?: string;
    }
  ): Promise<ExecutionResult> {
    if (this.lifecycleManager.isShuttingDownState()) {
      return {
        ok: false,
        ...normalizeExecutionFailure(new AbortError('Pool is shutting down')),
        executionTimeMs: 0,
      };
    }

    const pluginId = request.descriptor.pluginId;
    const timeoutMs = request.timeoutMs ?? 30_000;
    const startTime = performance.now();

    // Check per-plugin concurrency
    if (this.config.maxConcurrentPerPlugin) {
      const current = this.statsTracker.getPluginConcurrency(pluginId);
      if (current >= this.config.maxConcurrentPerPlugin) {
        this.statsTracker.stats.queueFullRejections++;
        return {
          ok: false,
          ...normalizeExecutionFailure(
            new QueueFullError(current, this.config.maxConcurrentPerPlugin)
          ),
          executionTimeMs: performance.now() - startTime,
        };
      }
    }

    // Check abort signal
    if (options?.signal?.aborted) {
      return {
        ok: false,
        ...normalizeExecutionFailure(new AbortError('Request aborted')),
        executionTimeMs: performance.now() - startTime,
      };
    }

    // Increment plugin concurrency
    this.statsTracker.incrementPluginConcurrency(pluginId);

    try {
      // Try to get available worker immediately
      const worker = this.executor.getAvailableWorker();

      if (worker) {
        return await this.executor.executeOnWorker(
          worker,
          request,
          timeoutMs,
          startTime,
          options?.onLog,
          options?.onUIPrompt,
          options?.onLoggerLog,
          options?.uiPromptHint,
          options?.signal,
        );
      }

      // Capacity maintenance owns every spawn attempt. Requests with no
      // available worker fail promptly while that shared recovery runs.
      if (this.workers.size === 0) {
        this.lifecycleManager.scheduleCapacityRecovery(1);
        const failure = this.lifecycleManager.getLastStartFailure()
          ?? createWorkerFailureRecord(new Error('No worker capacity is available'), 1, 0);
        return {
          ok: false,
          ...normalizeExecutionFailure(new WorkerUnavailableError(failure), request),
          executionTimeMs: performance.now() - startTime,
        };
      }

      // Check queue capacity
      if (this.queueManager.getQueueLength() >= this.config.maxQueueSize) {
        this.statsTracker.stats.queueFullRejections++;
        this.emit('queueFull', this.queueManager.getQueueLength());
        return {
          ok: false,
          ...normalizeExecutionFailure(
            new QueueFullError(
              this.queueManager.getQueueLength(),
              this.config.maxQueueSize
            )
          ),
          executionTimeMs: performance.now() - startTime,
        };
      }

      // Ask the lifecycle owner for one more slot when all current workers are busy.
      // Concurrent requests coalesce into the same bounded maintenance task.
      if (this.workers.size < this.config.max) {
        this.lifecycleManager.scheduleCapacityRecovery(this.workers.size + 1);
      }

      // Queue the request
      return await this.queueManager.queueRequest(
        request,
        options?.signal,
        startTime,
        options?.onLog,
        options?.onLoggerLog,
        options?.onUIPrompt,
        options?.uiPromptHint,
      );
    } finally {
      this.statsTracker.decrementPluginConcurrency(pluginId);
    }
  }

  /**
   * Get pool statistics.
   */
  getStats() {
    return {
      ...this.statsTracker.getStats(
      this.workers,
      this.queueManager.getQueueLength()
      ),
      lastStartFailure: this.lifecycleManager.getLastStartFailure() ?? this.statsTracker.stats.lastStartFailure,
    };
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    // Reject all queued requests
    this.queueManager.clearQueue(new Error('Pool shutdown'));

    // Shutdown all workers
    await this.lifecycleManager.shutdown(timeoutMs);
  }
}
