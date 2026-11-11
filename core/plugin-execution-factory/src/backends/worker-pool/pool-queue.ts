/**
 * @module @kb-labs/plugin-execution-factory/backends/worker-pool/pool-queue
 *
 * Request queue management for worker pool.
 */

import type { QueuedRequest, UIPromptMessage, WorkerPoolConfig } from './types.js';
import type { ExecutionRequest, ExecutionResult } from '../../types.js';
import type { Worker } from './worker.js';
import { AbortError, AcquireTimeoutError } from '../../errors.js';
import { normalizeExecutionFailure } from '../../utils.js';

/**
 * Queue manager for WorkerPool.
 */
export class PoolQueueManager {
  private queue: QueuedRequest[] = [];
  private config: WorkerPoolConfig;

  // Callbacks
  private onTrackQueueWaitTime: (waitTimeMs: number) => void;
  private onGetAvailableWorker: () => Worker | null;
  private onExecuteOnWorker: (
    worker: Worker,
    request: ExecutionRequest,
    timeoutMs: number,
    startTime: number,
    onLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void,
    onUIPrompt?: (prompt: UIPromptMessage) => Promise<unknown>,
    onLoggerLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void,
    uiPromptHint?: string,
    signal?: AbortSignal,
  ) => Promise<ExecutionResult>;
  private onAcquireTimeout: () => void;

  constructor(
    config: WorkerPoolConfig,
    callbacks: {
      onTrackQueueWaitTime: (waitTimeMs: number) => void;
      onGetAvailableWorker: () => Worker | null;
      onExecuteOnWorker: (
        worker: Worker,
        request: ExecutionRequest,
        timeoutMs: number,
        startTime: number,
        onLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void,
        onUIPrompt?: (prompt: UIPromptMessage) => Promise<unknown>,
        onLoggerLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void,
        uiPromptHint?: string,
        signal?: AbortSignal,
      ) => Promise<ExecutionResult>;
      onAcquireTimeout: () => void;
    }
  ) {
    this.config = config;
    this.onTrackQueueWaitTime = callbacks.onTrackQueueWaitTime;
    this.onGetAvailableWorker = callbacks.onGetAvailableWorker;
    this.onExecuteOnWorker = callbacks.onExecuteOnWorker;
    this.onAcquireTimeout = callbacks.onAcquireTimeout;
  }

  /**
   * Get current queue length.
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Clear all queued requests with error.
   */
  clearQueue(error: Error): void {
    for (const queued of this.queue) {
      queued.reject(error);
    }
    this.queue.length = 0;
  }

  /**
   * Queue a request and wait for execution.
   */
  queueRequest(
    request: ExecutionRequest,
    signal: AbortSignal | undefined,
    startTime: number,
    onLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void,
    onLoggerLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void,
    onUIPrompt?: (prompt: UIPromptMessage) => Promise<unknown>,
    uiPromptHint?: string,
  ): Promise<ExecutionResult> {
    return new Promise<ExecutionResult>((resolve, reject) => {
      const queuedAt = Date.now();

      // Acquire timeout
      const acquireTimeout = setTimeout(() => {
        // Remove from queue
        const idx = this.queue.findIndex((q) => q.id === request.executionId);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }

        this.onAcquireTimeout();
        resolve({
          ok: false,
          ...normalizeExecutionFailure(
            new AcquireTimeoutError(this.config.acquireTimeoutMs)
          ),
          executionTimeMs: performance.now() - startTime,
        });
      }, this.config.acquireTimeoutMs);

      // Abort handler
      const onAbort = () => {
        clearTimeout(acquireTimeout);
        const idx = this.queue.findIndex((q) => q.id === request.executionId);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        resolve({
          ok: false,
          ...normalizeExecutionFailure(new AbortError('Request aborted')),
          executionTimeMs: performance.now() - startTime,
        });
      };

      if (signal) {
        if (signal.aborted) {
          clearTimeout(acquireTimeout);
          resolve({
            ok: false,
            ...normalizeExecutionFailure(new AbortError('Request aborted')),
            executionTimeMs: performance.now() - startTime,
          });
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // Queue the request
      const queuedRequest: QueuedRequest = {
        id: request.executionId,
        request,
        signal,
        queuedAt,
        onLog,
        onLoggerLog,
        onUIPrompt,
        uiPromptHint,
        resolve: (result) => {
          clearTimeout(acquireTimeout);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }

          // Track queue wait time
          const waitTime = Date.now() - queuedAt;
          this.onTrackQueueWaitTime(waitTime);

          resolve(result);
        },
        reject: (error) => {
          clearTimeout(acquireTimeout);
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          reject(error);
        },
      };

      this.queue.push(queuedRequest);
    });
  }

  /**
   * Process queued requests.
   */
  processQueue(): void {
    while (this.queue.length > 0) {
      const worker = this.onGetAvailableWorker();
      if (!worker) {
        break;
      }

      const queued = this.queue.shift()!;

      // Skip if aborted
      if (queued.signal?.aborted) {
        queued.resolve({
          ok: false,
          ...normalizeExecutionFailure(new AbortError('Request aborted')),
          executionTimeMs: 0,
        });
        continue;
      }

      const timeoutMs = queued.request.timeoutMs ?? 30_000;
      const startTime = queued.queuedAt;

      this.onExecuteOnWorker(worker, queued.request, timeoutMs, startTime, queued.onLog, queued.onUIPrompt, queued.onLoggerLog, queued.uiPromptHint, queued.signal)
        .then((result) => {
          queued.resolve(result);
          // Process more from queue
          this.processQueue();
        })
        .catch((error) => {
          queued.reject(error);
          this.processQueue();
        });
    }
  }
}
