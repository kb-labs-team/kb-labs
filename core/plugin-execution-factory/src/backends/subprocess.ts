/**
 * @module @kb-labs/plugin-execution/backends/subprocess
 *
 * SubprocessBackend - Level 0.5 execution.
 * Runs handlers in separate subprocess with IPC communication.
 * Process isolation without worker pool overhead.
 *
 * ## Use Cases
 *
 * - Development/testing with process isolation
 * - Single-shot execution without pool management
 * - Debugging handler failures without affecting main process
 * - Sandboxed execution for untrusted code
 *
 * ## Comparison with other backends
 *
 * - InProcessBackend: Same process, no isolation, fastest
 * - SubprocessBackend: Single subprocess per execution, isolated, simple
 * - WorkerPoolBackend: Pool of reusable workers, production-ready
 * - RemoteExecutionBackend: Remote executor service (Phase 3)
 *
 * ## Architecture
 *
 * Parent Process:
 * 1. Spawns the bootstrap with piped stdin, stdout, and stderr
 * 2. Sends execution and platform requests over one framed stdio channel
 * 3. Receives result, error, platform messages, and log frames
 * 4. Closes stdin so the child exits
 *
 * Child Process:
 * 1. Reads execution and platform frames from stdin
 * 2. Executes the handler with a host-served platform proxy
 * 3. Writes result, error, RPC, and log frames to stdout
 * 4. Exits when the host closes stdin
 *
 * ## runInSubprocess Contract (v5)
 *
 * This backend delegates to `runInSubprocess()` from @kb-labs/plugin-runtime.
 * The contract is:
 *
 * - Input: descriptor, platform, handlerPath, input, timeoutMs, signal
 * - Output: RunResult<T> { data: T, meta: ExecutionMeta }
 * - Throws: PluginError on handler failure, TimeoutError on timeout
 *
 * Handler returns raw data (T), runner wraps it in RunResult.
 * Backend passes data to caller; CLI/REST hosts add their own formatting.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { logDiagnosticEvent } from '@kb-labs/core-platform';
import type { IPlatformAdapters } from '@kb-labs/core-platform';
import type {
  RawExecutionBackend,
  ExecutionRequest,
  ExecutionResult,
  ExecuteOptions,
  HealthStatus,
  ExecutionStats,
  HostType,
} from '../types.js';
import type { PlatformServices, UIFacade } from '@kb-labs/plugin-contracts';
import { noopUI } from '@kb-labs/plugin-contracts';
import type { ISubprocessRunner } from '@kb-labs/core-platform';
import { localWorkspaceManager } from '../workspace/local.js';
import type { WorkspaceLease } from '../workspace/types.js';
import { normalizeExecutionFailure } from '../utils.js';
import { resolveExecutionTarget } from '../target-resolver.js';
import {
  AbortError,
  HandlerNotFoundError,
} from '../errors.js';

/**
 * SubprocessBackend options.
 */
export interface SubprocessBackendOptions {
  /** Platform services */
  platform: PlatformServices;

  /**
   * Subprocess runner implementation (dependency injection).
   * Allows swapping different subprocess execution strategies.
   */
  runner: ISubprocessRunner;

  /**
   * UI provider for different host types.
   * Default: always noopUI (silent).
   * For CLI: return real UI when hostType === 'cli'.
   */
  uiProvider?: (hostType: HostType) => UIFacade;

  /**
   * Default timeout for subprocess execution in milliseconds.
   * Default: 30000 (30 seconds)
   */
  defaultTimeoutMs?: number;

}

/**
 * SubprocessBackend - executes handlers in separate subprocess.
 *
 * Features:
 * - Process isolation (crashes don't affect main process)
 * - Simple lifecycle (one subprocess per execution)
 * - Framed stdio for execution control and platform API communication
 * - Timeout support with SIGKILL
 * - Abort signal support
 * - No pool overhead
 *
 * Limitations:
 * - No worker reuse (slower than WorkerPoolBackend)
 * - No concurrency control
 * - No warmup support
 */
export class SubprocessBackend implements RawExecutionBackend {
  private _stats: ExecutionStats = {
    totalExecutions: 0,
    successCount: 0,
    errorCount: 0,
    avgExecutionTimeMs: 0,
  };
  private executionTimes: number[] = [];
  private startTime = Date.now();
  private readonly platform: PlatformServices;
  private readonly runner: ISubprocessRunner;
  private readonly uiProvider: (hostType: HostType) => UIFacade;
  private readonly defaultTimeoutMs: number;
  private activeSubprocesses = 0;

  constructor(options: SubprocessBackendOptions) {
    this.platform = options.platform;
    this.runner = options.runner;
    this.uiProvider = options.uiProvider ?? (() => noopUI);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }


  async execute(
    request: ExecutionRequest,
    options?: ExecuteOptions
  ): Promise<ExecutionResult> {
    const start = performance.now();
    let lease: WorkspaceLease | undefined;
    let subprocessStarted = false;
    let resolvedExecutionId = request.executionId;
    let resolvedTarget = request.target;

    try {
      // 1. Check abort before starting
      if (options?.signal?.aborted) {
        throw new AbortError('Execution aborted before start');
      }

      const requestToExecute = await resolveExecutionTarget(request, this.platform);
      resolvedExecutionId = requestToExecute.executionId;
      resolvedTarget = requestToExecute.target;

      // 2. Lease workspace (trivial for local)
      lease = await localWorkspaceManager.lease(requestToExecute.workspace, {
        executionId: requestToExecute.executionId,
        pluginRoot: requestToExecute.pluginRoot,
      });

      // 3. Resolve handler path and verify existence
      const hashIndex = requestToExecute.handlerRef.indexOf('#');
      const relPath = hashIndex > 0 ? requestToExecute.handlerRef.slice(0, hashIndex) : requestToExecute.handlerRef;
      let handlerPath = path.resolve(lease.pluginRoot, relPath);
      // Manifest handler paths are relative to the manifest file (typically in dist/).
      // If not found at pluginRoot, try resolving from dist/ subdirectory.
      if (!fs.existsSync(handlerPath)) {
        const distPath = path.resolve(lease.pluginRoot, 'dist', relPath.replace(/^\.\//, ''));
        if (fs.existsSync(distPath)) {
          handlerPath = distPath;
        }
      }

      if (!fs.existsSync(handlerPath)) {
        logDiagnosticEvent(this.platform.logger, {
          event: 'plugin.handler.resolve',
          level: 'error',
          reasonCode: 'handler_not_found',
          message: 'Plugin handler file not found',
          outcome: 'failed',
          pluginId: requestToExecute.descriptor.pluginId,
          pluginVersion: requestToExecute.descriptor.pluginVersion,
          handlerRef: requestToExecute.handlerRef,
          handlerPath,
          evidence: {
            executionId: requestToExecute.executionId,
            pluginRoot: lease.pluginRoot,
            hostType: requestToExecute.descriptor.hostType,
          },
        });
        throw new HandlerNotFoundError(handlerPath);
      }

      // 4. Get timeout (from request or default)
      const timeoutMs = requestToExecute.timeoutMs ?? this.defaultTimeoutMs;

      // 7. Execute via subprocess runner (dependency injection)
      // NOTE: UI is not passed to subprocess - subprocess uses platform proxy
      // UI would need to be serialized and proxied, which is complex
      // For now, subprocess handlers use noopUI or log via platform.logger
      let runResult;
      try {
        this.activeSubprocesses++;
        subprocessStarted = true;
        runResult = await this.runner.runInSubprocess({
          descriptor: requestToExecute.descriptor,
          platform: this.platform as unknown as IPlatformAdapters,
          handlerPath,
          exportName: requestToExecute.exportName,
          input: requestToExecute.input,
          environment: {
            ...requestToExecute.env,
            KB_EXECUTION_ID: requestToExecute.executionId,
            KB_TENANT_ID: requestToExecute.context?.tenantId ?? requestToExecute.descriptor.tenantId,
            KB_TRACE_ID: requestToExecute.context?.traceId,
          },
          timeoutMs,
          signal: options?.signal,
          cwd: lease.cwd,
          outdir: undefined, // Optional, defaults to ${cwd}/.kb/output
          onLog: options?.onLog,
        });
      } finally {
        if (subprocessStarted) { this.activeSubprocesses--; }
      }

      // 7. Success - handler completed without throwing
      const executionTimeMs = performance.now() - start;
      this.updateStats(true, executionTimeMs);

      return {
        ok: true,
        data: runResult.data,
        executionTimeMs,
        metadata: {
          backend: 'subprocess',
          workspaceId: lease.workspaceId,
          executionMeta: runResult.executionMeta,
          target: resolvedTarget,
        },
      };
    } catch (error) {
      const executionTimeMs = performance.now() - start;
      this.updateStats(false, executionTimeMs);

      return {
        ok: false,
        ...normalizeExecutionFailure(error, request),
        executionTimeMs,
        metadata: {
          backend: 'subprocess',
          workspaceId: lease?.workspaceId,
          target: resolvedTarget,
        },
      };
    } finally {
      // CRITICAL: Always cleanup
      // 1. Release workspace
      if (lease) {
        await localWorkspaceManager.release(lease).catch(() => {
          // Swallow release errors - already handling main error
        });
      }
    }
  }

  /**
   * Update execution statistics.
   */
  private updateStats(success: boolean, durationMs: number): void {
    this._stats.totalExecutions++;

    if (success) {
      this._stats.successCount++;
    } else {
      this._stats.errorCount++;
    }

    // Track execution times for percentiles (keep last 1000)
    this.executionTimes.push(durationMs);
    if (this.executionTimes.length > 1000) {
      this.executionTimes.shift();
    }

    // Calculate average
    const sum = this.executionTimes.reduce((a, b) => a + b, 0);
    this._stats.avgExecutionTimeMs = sum / this.executionTimes.length;

    // Calculate percentiles
    if (this.executionTimes.length >= 10) {
      const sorted = [...this.executionTimes].sort((a, b) => a - b);
      this._stats.p95ExecutionTimeMs = sorted[Math.floor(sorted.length * 0.95)];
      this._stats.p99ExecutionTimeMs = sorted[Math.floor(sorted.length * 0.99)];
    }
  }

  async health(): Promise<HealthStatus> {
    return {
      healthy: true,
      backend: 'subprocess',
      details: {
        uptimeMs: Date.now() - this.startTime,
        activeSubprocesses: this.activeSubprocesses,
      },
    };
  }

  async stats(): Promise<ExecutionStats> {
    return { ...this._stats };
  }

  async shutdown(): Promise<void> {
    if (this.activeSubprocesses > 0) {
      this.platform.logger.warn('Subprocess backend shutdown while executions are active', {
        activeSubprocesses: this.activeSubprocesses,
      });
    }
  }
}
