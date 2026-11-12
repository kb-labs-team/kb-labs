/**
 * @module @kb-labs/plugin-execution-factory/backends/worker-pool/pool-lifecycle
 *
 * Worker lifecycle management for worker pool.
 */

import type { WorkerFailureDiagnostic } from '../../errors.js';
import { createContextLogger, type IContextLogger } from '@kb-labs/core-platform';
import type { UIPromptMessage, WorkerPoolBackendOptions, WorkerPoolConfig } from './types.js';
import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutionStartOutcome,
  ExecutionStats,
  ExecuteOptions,
  HealthStatus,
  HostType,
  PlatformTransportFactory,
} from '../../types.js';
import type { PlatformServices, UIFacade } from '@kb-labs/plugin-contracts';
import { noopUI } from '@kb-labs/plugin-contracts';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from './worker.js';
import type { ProcessTableSource } from './process-tree.js';
import { WorkerPool } from './pool.js';
import { UnixSocketPlatformTransportFactory } from '../../platform-transport/unix-socket-factory.js';
import { resolveExecutionTarget } from '../../target-resolver.js';
import { normalizeExecutionFailure } from '../../utils.js';
import { WorkerUnavailableError } from '../../errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WorkerPoolServingOwner {
  ensureServing(): Promise<ExecutionStartOutcome>;
  execute(request: ExecutionRequest, options?: ExecuteOptions): Promise<ExecutionResult>;
  health(): Promise<HealthStatus>;
  stats(): Promise<ExecutionStats>;
  shutdown(): Promise<void>;
}

export function createWorkerFailureRecord(error: unknown, attempt: number, retryInMs: number): WorkerFailureDiagnostic {
  let message = 'NonErrorFailure';
  if (error instanceof Error) {
    const code = 'code' in error ? error.code : undefined;
    message = typeof code === 'string' ? code : error.name || 'Error';
  }
  return {
    code: 'WORKER_START_FAILED',
    message: message.slice(0, 128),
    at: new Date().toISOString(),
    attempt,
    retryInMs,
  };
}

/**
 * Owns resource construction and every step required to publish a serving
 * worker pool. The backend facade receives only WorkerPoolServingOwner.
 */
export class PoolLifecycleManager implements WorkerPoolServingOwner {
  private recoveryPromise: Promise<void> | null = null;
  private firstAttempt: Promise<ExecutionStartOutcome> | null = null;
  private lastStartFailure?: WorkerFailureDiagnostic;
  private retryDelayMs = 100;
  private failureAttempt = 0;
  private isShuttingDown = false;
  private started = false;
  private readonly logger: IContextLogger;
  private readonly platform: PlatformServices;
  private readonly platformTransport: PlatformTransportFactory;
  private readonly processTableSource?: ProcessTableSource;
  private readonly workerScript: string;
  private readonly config: WorkerPoolConfig;
  private readonly uiProvider: (hostType: HostType) => UIFacade;
  private pool: WorkerPool | null = null;
  private startingPool: WorkerPool | null = null;
  private startTime = Date.now();
  private totalExecutions = 0;
  private successCount = 0;
  private errorCount = 0;
  private executionTimes: number[] = [];

  constructor(options: WorkerPoolBackendOptions) {
    this.platform = options.platform;
    this.platformTransport = options.platformTransport ?? new UnixSocketPlatformTransportFactory();
    this.processTableSource = options.processTableSource;
    this.uiProvider = options.uiProvider ?? (() => noopUI);
    this.workerScript = options.workerScript ?? path.join(__dirname, 'backends', 'worker-pool', 'worker-script.js');
    this.config = {
      min: options.min ?? 2,
      max: options.max ?? 10,
      maxRequestsPerWorker: options.maxRequestsPerWorker ?? 1000,
      maxUptimeMsPerWorker: options.maxUptimeMsPerWorker ?? 30 * 60 * 1000,
      maxQueueSize: options.maxQueueSize ?? 100,
      acquireTimeoutMs: options.acquireTimeoutMs ?? 5000,
      maxConcurrentPerPlugin: options.maxConcurrentPerPlugin,
      healthCheckIntervalMs: options.healthCheckIntervalMs ?? 10_000,
      warmup: {
        mode: options.warmup?.mode ?? 'none',
        topN: options.warmup?.topN ?? 5,
        maxHandlers: options.warmup?.maxHandlers ?? 20,
      },
    };
    this.logger = createContextLogger(this.platform.logger, {
      applicationId: 'kb',
      serviceId: 'plugin-execution',
      instanceId: String(process.pid),
      layer: 'core',
    }).forComponent('worker-pool-startup');
  }

  ensureServing(): Promise<ExecutionStartOutcome> {
    if (this.started) { return Promise.resolve({ status: 'ready' }); }
    if (this.isShuttingDown) { return Promise.resolve({ status: 'stopped' }); }
    if (this.recoveryPromise) {
      if (this.lastStartFailure) {
        return Promise.resolve({ status: 'recovering', failure: this.lastStartFailure });
      }
      return this.firstAttempt ?? Promise.resolve({ status: 'stopped' });
    }

    let resolveFirstAttempt: ((outcome: ExecutionStartOutcome) => void) | undefined;
    this.firstAttempt = new Promise<ExecutionStartOutcome>((resolve) => { resolveFirstAttempt = resolve; });
    const task = this.recover(resolveFirstAttempt).finally(() => {
      this.recoveryPromise = null;
      this.firstAttempt = null;
    });
    this.recoveryPromise = task;
    return this.firstAttempt;
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    if (this.recoveryPromise) { await this.recoveryPromise; }
    if (this.pool) {
      this.platform.logger.info('Shutting down worker pool');
      await this.pool.shutdown();
      this.pool = null;
    }
    if (this.startingPool) {
      const candidate = this.startingPool;
      this.startingPool = null;
      await candidate.shutdown();
    }
    if ('dispose' in this.platformTransport) {
      const transport = this.platformTransport as { dispose: () => Promise<void> };
      await transport.dispose();
      this.platform.logger.debug('Platform transport disposed', { type: this.platformTransport.type });
    }
  }

  getLastStartFailure(): WorkerFailureDiagnostic | undefined {
    return this.lastStartFailure;
  }

  private async recover(resolveFirstAttempt: ((outcome: ExecutionStartOutcome) => void) | undefined): Promise<void> {
    let firstAttempt = true;
    while (!this.isShuttingDown) {
      try {
        await this.startPhase();
        this.started = true;
        if (firstAttempt) { resolveFirstAttempt?.({ status: 'ready' }); }
        return;
      } catch (error) {
        const failure = this.recordStartFailure(error);
        if (firstAttempt) {
          resolveFirstAttempt?.({ status: 'recovering', failure });
          firstAttempt = false;
        }
        try {
          await this.cleanupFailedPhase();
        } catch (cleanupError) {
          this.recordStartFailure(cleanupError);
        }
        await new Promise<void>((resolve) => { setTimeout(resolve, this.retryDelayMs); });
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, 5_000);
      }
    }
    if (firstAttempt) { resolveFirstAttempt?.({ status: 'stopped' }); }
  }

  private recordStartFailure(error: unknown): WorkerFailureDiagnostic {
    const failure = createWorkerFailureRecord(error, ++this.failureAttempt, this.retryDelayMs);
    this.lastStartFailure = failure;
    this.logger.warn('Worker pool startup failed; lifecycle recovery will retry', { ...failure });
    return failure;
  }

  private async startPhase(): Promise<void> {
    if ('init' in this.platformTransport) {
      const transport = this.platformTransport as { init: (platform: PlatformServices) => Promise<void> };
      await transport.init(this.platform);
      this.platform.logger.debug('Platform transport initialized', { type: this.platformTransport.type });
    }

    const pool = this.createPool();
    this.startingPool = pool;
    await pool.start();
    this.platform.logger.info('Worker pool started', {
      minWorkers: this.config.min,
      maxWorkers: this.config.max,
    });
    this.pool = pool;
    this.startingPool = null;
  }

  private createPool(): WorkerPool {
    const pool = new WorkerPool(this.workerScript, this.config, this.platform, this.platformTransport, this.processTableSource);
    pool.on('workerSpawned', (worker) => {
      this.platform.logger.debug('Worker spawned', { workerId: worker.id });
    });
    pool.on('workerExited', (worker, code) => {
      const log = code === 0 ? this.platform.logger.debug.bind(this.platform.logger) : this.platform.logger.warn.bind(this.platform.logger);
      log('Worker exited', { workerId: worker.id, exitCode: code });
    });
    pool.on('workerRecycled', (worker) => {
      this.platform.logger.debug('Worker recycled', { workerId: worker.id });
    });
    pool.on('queueFull', (queueSize) => {
      this.platform.logger.warn('Queue full', { queueSize });
    });
    pool.on('healthCheckFailed', (worker) => {
      this.platform.logger.warn('Worker health check failed', { workerId: worker.id });
    });
    return pool;
  }

  private async cleanupFailedPhase(): Promise<void> {
    const candidate = this.startingPool;
    this.startingPool = null;
    const cleanup: Array<Promise<void>> = [];
    if (candidate) { cleanup.push(candidate.shutdown()); }
    if ('dispose' in this.platformTransport) {
      const transport = this.platformTransport as { dispose: () => Promise<void> };
      cleanup.push(transport.dispose());
    }
    const results = await Promise.allSettled(cleanup);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Worker pool startup cleanup failed');
    }
  }

  async execute(request: ExecutionRequest, options?: ExecuteOptions): Promise<ExecutionResult> {
    if (!this.pool) {
      const startup = await this.ensureServing();
      if (!this.pool) {
        const failure = startup.status === 'recovering'
          ? startup.failure
          : this.getLastStartFailure() ?? createWorkerFailureRecord(new Error('Worker pool lifecycle is stopped'), 1, 0);
        const error = new WorkerUnavailableError(failure);
        return {
          ok: false,
          ...normalizeExecutionFailure(error, request),
          executionTimeMs: 0,
          metadata: { backend: 'worker-pool' },
        };
      }
    }

    const start = performance.now();
    const requestToExecute = await resolveExecutionTarget(request, this.platform);
    this.totalExecutions++;
    const hostType: HostType = request.descriptor.hostContext.host;
    const ui = this.uiProvider(hostType);
    const onUIPrompt = async (prompt: UIPromptMessage): Promise<unknown> => {
      switch (prompt.kind) {
        case 'select': return ui.select(prompt.message, prompt.choices ?? []);
        case 'multiSelect': return ui.multiSelect(prompt.message, prompt.choices ?? []);
        case 'confirm': return ui.confirm(prompt.message, { defaultValue: (prompt.defaultValue as boolean) ?? false });
        case 'text': return ui.prompt(prompt.message, { default: prompt.defaultValue as string });
      }
    };

    try {
      const result = await this.pool.execute(requestToExecute, {
        signal: options?.signal,
        onLog: options?.onLog,
        onLoggerLog: options?.onLoggerLog,
        onProcessStarted: options?.onProcessStarted,
        onUIPrompt,
        uiPromptHint: options?.uiPromptHint,
      });
      const executionTimeMs = performance.now() - start;
      if (result.ok) { this.successCount++; } else { this.errorCount++; }
      this.trackExecutionTime(executionTimeMs);
      result.executionTimeMs = executionTimeMs;
      result.metadata = { ...result.metadata, backend: 'worker-pool', target: requestToExecute.target };
      return result;
    } catch (error) {
      this.errorCount++;
      const executionTimeMs = performance.now() - start;
      this.trackExecutionTime(executionTimeMs);
      return {
        ok: false,
        ...normalizeExecutionFailure(error, request),
        executionTimeMs,
        metadata: { backend: 'worker-pool', target: requestToExecute.target },
      };
    }
  }

  async health(): Promise<HealthStatus> {
    if (!this.pool) {
      return {
        healthy: false,
        backend: 'worker-pool',
        details: {
          workers: { total: 0, busy: 0, idle: 0, queued: 0, queueLimit: this.config.maxQueueSize, treeUnverified: 0 },
          limits: { min: this.config.min, max: this.config.max },
          lastStartFailure: this.getLastStartFailure(),
        },
      };
    }
    const stats = this.pool.getStats();
    const idleWorkers = stats.workersByState.idle;
    const busyWorkers = stats.workersByState.busy;
    const totalWorkers = stats.totalWorkers;
    const belowMinimumAfterFailure = stats.lastStartFailure !== undefined && totalWorkers < this.config.min;
    const healthy = idleWorkers > 0 && !belowMinimumAfterFailure && stats.treeUnverifiedWorkers === 0;
    return {
      healthy,
      backend: 'worker-pool',
      details: {
        workers: {
          total: totalWorkers,
          idle: idleWorkers,
          busy: busyWorkers,
          queued: stats.queueLength,
          queueLimit: this.config.maxQueueSize,
          treeUnverified: stats.treeUnverifiedWorkers,
        },
        limits: { min: this.config.min, max: this.config.max },
        lastStartFailure: stats.lastStartFailure ?? this.getLastStartFailure(),
        uptimeMs: Date.now() - this.startTime,
      },
    };
  }

  async stats(): Promise<ExecutionStats> {
    let p95: number | undefined;
    let p99: number | undefined;
    if (this.executionTimes.length >= 10) {
      const sorted = [...this.executionTimes].sort((a, b) => a - b);
      p95 = sorted[Math.floor(sorted.length * 0.95)];
      p99 = sorted[Math.floor(sorted.length * 0.99)];
    }
    return {
      totalExecutions: this.totalExecutions,
      successCount: this.successCount,
      errorCount: this.errorCount,
      avgExecutionTimeMs: this.executionTimes.length > 0
        ? this.executionTimes.reduce((a, b) => a + b, 0) / this.executionTimes.length
        : 0,
      p95ExecutionTimeMs: p95,
      p99ExecutionTimeMs: p99,
    };
  }

  private trackExecutionTime(durationMs: number): void {
    this.executionTimes.push(durationMs);
    if (this.executionTimes.length > 1000) { this.executionTimes.shift(); }
  }
}

/**
 * Owns worker spawn, replacement, and health-check lifecycle after startup.
 */
export class WorkerLifecycleManager {
  private workers: Map<string, Worker>;
  private config: WorkerPoolConfig;
  private workerScript: string;
  private platform?: PlatformServices;
  private logger?: IContextLogger;
  private platformTransport?: PlatformTransportFactory;
  private isShuttingDown = false;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private healthCheckPromise: Promise<void> | null = null;
  private minimumMaintenancePromise: Promise<void> | null = null;
  private firstMaintenanceAttempt: Promise<void> | null = null;
  private readonly recyclePromises = new Map<string, Promise<void>>();
  private lastStartFailure?: WorkerFailureDiagnostic;
  private retryDelayMs = 100;
  private failureAttempt = 0;
  private desiredWorkerCount: number;

  // Callbacks
  private onWorkerSpawned: (worker: Worker) => void;
  private onWorkerExited: (worker: Worker, code: number | null) => void;
  private onWorkerRecycled: (worker: Worker) => void;
  private onHealthCheckFailed: (worker: Worker) => void;
  private onProcessQueue: () => void;
  private onWorkersRecycled: () => void;
  private onWorkerStartFailure: (failure: WorkerFailureDiagnostic) => void;

  constructor(
    workers: Map<string, Worker>,
    config: WorkerPoolConfig,
    workerScript: string,
    callbacks: {
      onWorkerSpawned: (worker: Worker) => void;
      onWorkerExited: (worker: Worker, code: number | null) => void;
      onWorkerRecycled: (worker: Worker) => void;
      onHealthCheckFailed: (worker: Worker) => void;
      onProcessQueue: () => void;
      onWorkersRecycled: () => void;
      onWorkerStartFailure: (failure: WorkerFailureDiagnostic) => void;
    },
    platform?: PlatformServices,
    platformTransport?: PlatformTransportFactory,
    private readonly processTableSource?: ProcessTableSource,
  ) {
    this.workers = workers;
    this.config = config;
    this.desiredWorkerCount = config.min;
    this.workerScript = workerScript;
    this.platform = platform;
    this.logger = platform
      ? createContextLogger(platform.logger, {
        applicationId: 'kb',
        serviceId: 'plugin-execution',
        instanceId: String(process.pid),
        layer: 'core',
      }).forComponent('worker-pool')
      : undefined;
    this.platformTransport = platformTransport;
    this.onWorkerSpawned = callbacks.onWorkerSpawned;
    this.onWorkerExited = callbacks.onWorkerExited;
    this.onWorkerRecycled = callbacks.onWorkerRecycled;
    this.onHealthCheckFailed = callbacks.onHealthCheckFailed;
    this.onProcessQueue = callbacks.onProcessQueue;
    this.onWorkersRecycled = callbacks.onWorkersRecycled;
    this.onWorkerStartFailure = callbacks.onWorkerStartFailure;
  }

  /**
   * Start the pool by spawning minimum workers and starting health checks.
   */
  async startInitialWorkers(): Promise<void> {
    for (let i = 0; i < this.config.min; i++) {
      await this.spawnWorker();
    }
    this.healthCheckInterval = setInterval(
      () => this.scheduleHealthChecks(),
      this.config.healthCheckIntervalMs
    );
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.isShuttingDown = true;

    // Stop health checks
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // Shutdown all workers
    const shutdownPromises = Array.from(this.workers.values()).map((worker) =>
      worker.shutdown(timeoutMs)
    );

    await Promise.allSettled(shutdownPromises);
    if (this.minimumMaintenancePromise) { await this.minimumMaintenancePromise; }
    if (this.healthCheckPromise) { await this.healthCheckPromise; }
    await Promise.allSettled(this.recyclePromises.values());
    this.workers.clear();
  }

  /**
   * Spawn a new worker.
   */
  private async spawnWorker(): Promise<void> {
    const worker = new Worker({
      workerScript: this.workerScript,
      platform: this.platform,
      platformTransport: this.platformTransport,
      processTableSource: this.processTableSource,
    });

    // Setup event handlers
    worker.on('exit', (w, code, signal) => {
      this.handleWorkerExit(w, code, signal);
    });

    worker.on('healthUpdate', (w, healthy) => {
      if (!healthy) {
        this.onHealthCheckFailed(w);
      }
    });

    this.workers.set(worker.id, worker);

    try {
      await worker.spawn();
      this.onWorkerSpawned(worker);
      this.failureAttempt = 0;

      // Process queue after worker is ready
      this.onProcessQueue();
    } catch (error) {
      this.workers.delete(worker.id);
      throw error;
    }
  }

  /**
   * Handle worker exit.
   */
  private handleWorkerExit(
    worker: Worker,
    code: number | null,
    _signal: string | null
  ): void {
    this.onWorkerExited(worker, code);
    if (worker.treeUnverified) {
      this.platform?.logger.warn('Worker capacity remains reserved because its process tree is unverified', { workerId: worker.id, code: 'WORKER_TREE_UNVERIFIED' });
      this.onProcessQueue();
      return;
    }
    this.workers.delete(worker.id);

    // Spawn replacement if not shutting down and below min
    if (!this.isShuttingDown && this.workers.size < this.config.min) {
      this.scheduleCapacityRecovery(this.config.min);
    }

    // Process queue in case worker freed up work
    this.onProcessQueue();
  }

  /**
   * Recycle worker (replace with fresh one).
   */
  scheduleRecycle(worker: Worker): void {
    if (this.recyclePromises.has(worker.id)) { return; }
    const task = this.recycleWorker(worker)
      .catch((error: unknown) => { this.recordStartFailure(error); })
      .finally(() => { this.recyclePromises.delete(worker.id); });
    this.recyclePromises.set(worker.id, task);
  }

  private async recycleWorker(worker: Worker): Promise<void> {
    this.onWorkersRecycled();
    this.onWorkerRecycled(worker);

    await worker.shutdown(5000);

    // Replacements use the same capacity owner as initial starts and crash
    // recovery. The exit handler schedules recovery once the old slot is gone.
    if (!this.isShuttingDown && this.workers.size < this.config.min) {
      this.scheduleCapacityRecovery(this.config.min);
    }
  }

  getLastStartFailure(): WorkerFailureDiagnostic | undefined {
    return this.lastStartFailure;
  }

  scheduleCapacityRecovery(target = this.config.min): Promise<void> {
    this.desiredWorkerCount = Math.max(this.desiredWorkerCount, target);
    if (this.isShuttingDown) { return Promise.resolve(); }
    if (this.minimumMaintenancePromise) { return this.firstMaintenanceAttempt ?? Promise.resolve(); }

    let resolveFirstAttempt: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => { resolveFirstAttempt = resolve; });
    this.firstMaintenanceAttempt = firstAttempt;
    const task = this.maintainMinimumWorkers(resolveFirstAttempt)
      .finally(() => {
        this.minimumMaintenancePromise = null;
        this.firstMaintenanceAttempt = null;
      });
    this.minimumMaintenancePromise = task;
    return firstAttempt;
  }

  private async maintainMinimumWorkers(resolveFirstAttempt: (() => void) | undefined): Promise<void> {
    let firstAttempt = true;
    while (!this.isShuttingDown && this.workers.size < Math.max(this.config.min, this.desiredWorkerCount)) {
      try {
        await this.spawnWorker();
        if (firstAttempt) { resolveFirstAttempt?.(); firstAttempt = false; }
        this.retryDelayMs = 100;
      } catch (error) {
        this.recordStartFailure(error);
        if (firstAttempt) { resolveFirstAttempt?.(); firstAttempt = false; }
        await new Promise<void>((resolve) => { setTimeout(resolve, this.retryDelayMs); });
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, 5_000);
      }
    }
    if (firstAttempt) { resolveFirstAttempt?.(); }
  }

  private recordStartFailure(error: unknown): void {
    const failure = createWorkerFailureRecord(error, ++this.failureAttempt, this.retryDelayMs);
    this.lastStartFailure = failure;
    this.logger?.warn('Worker start failed; pool recovery will retry', { ...failure });
    this.onWorkerStartFailure(failure);
  }

  private scheduleHealthChecks(): void {
    if (this.healthCheckPromise) { return; }
    const task = this.runHealthChecks()
      .catch((error: unknown) => { this.recordStartFailure(error); })
      .finally(() => { this.healthCheckPromise = null; });
    this.healthCheckPromise = task;
  }

  /**
   * Run health checks on all workers.
   */
  private async runHealthChecks(): Promise<void> {
    const workers = Array.from(this.workers.values());

    for (const worker of workers) {
      if (worker.state === 'idle') {
        const healthy = await worker.healthCheck();

        if (!healthy) {
          // Replace unhealthy worker
          // Keep it accounted for until ChildProcess emits exit. Capacity is
          // released only after the worker process has actually terminated.
          worker.kill();
        }
      }
    }
  }

  /**
   * Check if worker should be recycled based on limits.
   */
  shouldRecycleWorker(worker: Worker): boolean {
    return worker.shouldRecycle(
      this.config.maxRequestsPerWorker,
      this.config.maxUptimeMsPerWorker
    );
  }

  /**
   * Check if pool is shutting down.
   */
  isShuttingDownState(): boolean {
    return this.isShuttingDown;
  }
}
