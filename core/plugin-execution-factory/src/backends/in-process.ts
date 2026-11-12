/**
 * @module @kb-labs/plugin-execution/backends/in-process
 *
 * InProcessBackend - Level 0 execution.
 * Runs handlers in same process as caller.
 * No isolation, fast, for dev/tests/trusted plugins.
 *
 * ## runInProcess Contract (v5)
 *
 * This backend delegates to `runInProcess()` from @kb-labs/plugin-runtime.
 * The contract is:
 *
 * - Input: handlerPath (absolute), input, descriptor, platform, ui, signal
 * - Output: RunResult<T> { data: T, meta: ExecutionMeta }
 * - Throws: PluginError on handler failure
 *
 * Handler returns raw data (T), runner wraps it in RunResult.
 * Backend passes data to caller; CLI/REST hosts add their own formatting.
 *
 * ## Unified Types (v3)
 *
 * `request.descriptor` is PluginContextDescriptor from plugin-contracts.
 * We pass it to runInProcess() AS-IS - no conversion needed!
 *
 * ## v4 Fixes
 *
 * - executionId: uses request.executionId (not descriptor.requestId)
 * - stats: counts ok correctly based on result.exitCode
 * - uiProvider: supports CLI UI via BackendOptions
 *
 * ## v5 Changes
 *
 * - runInProcess now returns RunResult<T> instead of CommandResultWithMeta
 * - Backend extracts data from RunResult, no exitCode handling
 * - Success is determined by absence of thrown error
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type {
  RawExecutionBackend,
  ExecutionRequest,
  ExecutionResult,
  ExecuteOptions,
  HealthStatus,
  ExecutionStats,
  HostType,
  PluginInvokerFn,
} from '../types.js';
import type { PlatformServices, UIFacade } from '@kb-labs/plugin-contracts';
import type { ILogger, IWorkspaceProvider, WorkspaceDescriptor } from '@kb-labs/core-platform';
import { noopUI } from '@kb-labs/plugin-contracts';
import { runInProcess, resolveAdapterMiddlewares } from '@kb-labs/plugin-runtime';
import type { LoadedMiddleware, RawMiddlewareDecl } from '@kb-labs/plugin-runtime';
interface WithMiddlewareDecls {
  getAdapter(key: '_middlewareDecls'): RawMiddlewareDecl[] | undefined;
}
import { localWorkspaceManager } from '../workspace/local.js';
import type { WorkspaceLease } from '../workspace/types.js';
import { normalizeExecutionFailure } from '../utils.js';
import { resolveExecutionTarget } from '../target-resolver.js';
import {
  AbortError,
  HandlerNotFoundError,
  TimeoutError,
} from '../errors.js';

/**
 * InProcessBackend options.
 */
export interface InProcessBackendOptions {
  platform: PlatformServices;
  /**
   * UI provider for different host types.
   * Default: always noopUI (silent).
   * For CLI: return real UI when hostType === 'cli'.
   */
  uiProvider?: (hostType: HostType) => UIFacade;
  /**
   * Optional default plugin invoker for ctx.api.invoke.
   */
  pluginInvoker?: PluginInvokerFn;
}

/**
 * InProcessBackend - executes handlers in current process.
 */
export class InProcessBackend implements RawExecutionBackend {
  private _stats: ExecutionStats = {
    totalExecutions: 0,
    successCount: 0,
    errorCount: 0,
    avgExecutionTimeMs: 0,
  };
  private executionTimes: number[] = [];
  private startTime = Date.now();
  private readonly platform: PlatformServices;
  private readonly uiProvider: (hostType: HostType) => UIFacade;
  private _middlewaresCache: LoadedMiddleware[] | null = null;
  private readonly pluginInvoker?: PluginInvokerFn;

  constructor(options: InProcessBackendOptions) {
    this.platform = options.platform;
    this.uiProvider = options.uiProvider ?? (() => noopUI);
    this.pluginInvoker = options.pluginInvoker;
  }

  private async getMiddlewares(): Promise<LoadedMiddleware[]> {
    if (this._middlewaresCache !== null) { return this._middlewaresCache; }
    const rawDecls = (this.platform as unknown as WithMiddlewareDecls)
      .getAdapter('_middlewareDecls') ?? [];
    const logger = this.platform.logger;
    const resolved = await resolveAdapterMiddlewares(rawDecls, {
      warn: (msg, meta) => logger.warn(msg, meta),
    });
    this._middlewaresCache = resolved;
    return resolved;
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity
  async execute(
    request: ExecutionRequest,
    options?: ExecuteOptions
  ): Promise<ExecutionResult> {
    const start = performance.now();
    const timeoutController = request.timeoutMs === undefined ? undefined : new AbortController();
    let timeoutExpired = false;
    const timeoutId = request.timeoutMs === undefined ? undefined : setTimeout(() => {
      timeoutExpired = true;
      timeoutController?.abort();
    }, request.timeoutMs);
    const executionSignal = timeoutController
      ? options?.signal
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal
      : options?.signal;
    let lease: WorkspaceLease | undefined;
    let resolvedTarget = request.target;
    let workspaceDescriptor: WorkspaceDescriptor | undefined;
    const workspaceProvider = (this.platform as { getAdapter?: (name: string) => unknown }).getAdapter?.('workspace') as IWorkspaceProvider | undefined;

    try {
      // 1. Check abort before starting
      if (executionSignal?.aborted) {
        throw new AbortError('Execution aborted before start');
      }

      let requestToExecute = await resolveExecutionTarget(request, this.platform);
      resolvedTarget = requestToExecute.target;

      // Workspace materialize: если зарегистрирован IWorkspaceProvider (e.g. AgentWorkspaceAdapter),
      // fetches файлы плагина с удалённого хоста перед выполнением.
      // При отсутствии provider или ошибке — fallback к оригинальному pluginRoot.
      if (workspaceProvider?.materialize) {
        try {
          workspaceDescriptor = await workspaceProvider.materialize({
            sourceRef: requestToExecute.pluginRoot,
            basePath: requestToExecute.pluginRoot,
            projectRoot: process.env.KB_PROJECT_ROOT,
            platformRoot: process.env.KB_PLATFORM_ROOT,
            metadata: { executionId: requestToExecute.executionId },
          });
          if (workspaceDescriptor.rootPath) {
            requestToExecute = { ...requestToExecute, pluginRoot: workspaceDescriptor.rootPath };
          }
        } catch {
          // Best-effort: fall back to original pluginRoot if materialize fails
          workspaceDescriptor = undefined;
        }
      }

      // 2. Lease workspace (trivial for local)
      // NOTE: Uses request.executionId, NOT descriptor.requestId (v4 fix)
      lease = await localWorkspaceManager.lease(requestToExecute.workspace, {
        executionId: requestToExecute.executionId,
        pluginRoot: requestToExecute.pluginRoot,
      });

      // 3. Resolve handler path and verify existence
      // handlerRef format: './path/to/file.js#exportName' or './path/to/file.js'
      const hashIndex = requestToExecute.handlerRef.indexOf('#');
      const relPath = hashIndex > 0 ? requestToExecute.handlerRef.slice(0, hashIndex) : requestToExecute.handlerRef;
      const exportSelector = hashIndex > 0 ? requestToExecute.handlerRef.slice(hashIndex) : '';
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
        throw new HandlerNotFoundError(handlerPath);
      }

      // 4. Get UI based on host type (v4: supports CLI UI)
      const ui = this.uiProvider(request.descriptor.hostType);
      const pluginInvoker = options?.pluginInvoker ?? this.pluginInvoker;

      // 5. Create eventEmitter from onLog/onLoggerLog callbacks (if provided).
      // Routes by event name — no payload inspection.
      // See: services/workflow/docs/adr/0019-log-stream-separation.md
      const onLog = options?.onLog;
      const onLoggerLog = options?.onLoggerLog;
      const onProcessStarted = options?.onProcessStarted;
      const eventEmitter = (onLog || onLoggerLog || onProcessStarted)
        ? async (name: string, payload?: unknown) => {
            if (name === 'process.started') {
              await onProcessStarted?.(payload as import('@kb-labs/plugin-contracts').ProcessIdentity);
              return;
            }
            const isLogLine = name === 'log.line' || name.endsWith(':log.line');
            const isLoggerLine = name === 'logger.line' || name.endsWith(':logger.line');
            if ((isLogLine || isLoggerLine) && payload && typeof payload === 'object') {
              const p = payload as Record<string, unknown>;
              const entry = {
                level: (p.level as string) ?? 'info',
                message: (p.line as string) ?? '',
                stream: (p.stream as 'stdout' | 'stderr') ?? 'stdout',
                lineNo: (p.lineNo as number) ?? 0,
                timestamp: new Date().toISOString(),
                meta: p.meta as Record<string, unknown>,
              };
              if (isLogLine) { onLog?.(entry); }
              else { onLoggerLog?.(entry); }
            }
          }
        : undefined;

      // 6. Execute via runtime
      // NOTE: request.descriptor is PluginContextDescriptor - passed AS-IS!
      // No conversion needed (v3 unified types).
      // v5: runInProcess returns RunResult<T> with raw data
      //
      // Optional loggerOverride in request.context allows hosts (e.g. workflow daemon)
      // to replace platform.logger with a context-aware logger (e.g. stepLogger with runId/jobId/stepId).
      // This makes ctx.logger.* write to SQLite with workflow context instead of generic platform context.
      // See: services/workflow/docs/adr/0019-log-stream-separation.md
      const loggerOverride = requestToExecute.context?.loggerOverride as ILogger | undefined;
      // PlatformServices fields (processExecutor, cache, llm, storage, ...) are class
      // getters on PlatformContainer.prototype, not own properties of the instance —
      // `{ ...this.platform, logger: loggerOverride }` (plain object spread) only copies
      // own enumerable properties, so it silently drops every getter-backed field except
      // the one being overridden. Object.create() keeps this.platform in the prototype
      // chain so untouched getters (including processExecutor) keep resolving through it;
      // only `logger` is shadowed as an own property.
      const effectivePlatform = loggerOverride
        ? Object.create(this.platform, {
            logger: { value: loggerOverride, enumerable: true, configurable: true },
          }) as PlatformServices
        : this.platform;

      const adapterMiddlewares = await this.getMiddlewares();
      const runResult = await runInProcess({
        descriptor: requestToExecute.descriptor,  // Direct pass-through!
        platform: effectivePlatform,
        ui,
        pluginInvoker,
        eventEmitter,
        handlerPath: `${handlerPath}${exportSelector}`,
        input: requestToExecute.input,
        environment: requestToExecute.env,
        signal: executionSignal,
        cwd: lease.cwd,           // From WorkspaceLease
        outdir: undefined,        // Optional, defaults to cwd/.kb/output
        adapterMiddlewares,
      });

      if (timeoutExpired) {
        throw new TimeoutError(`Execution timed out after ${request.timeoutMs}ms`, request.timeoutMs);
      }

      // 6. Success is determined by absence of thrown error
      // v5: No exitCode - handlers throw on failure
      const executionTimeMs = performance.now() - start;
      this.updateStats(true, executionTimeMs);

      // 7. Return result with raw data from handler
      return {
        ok: true,
        data: runResult.data,
        executionTimeMs,
        metadata: {
          backend: 'in-process',
          workspaceId: lease.workspaceId,
          // v5: Include execution meta for consumers who need it
          executionMeta: runResult.executionMeta,
          target: resolvedTarget,
        },
      };
    } catch (error) {
      const executionTimeMs = performance.now() - start;
      this.updateStats(false, executionTimeMs);
      const executionFailure = timeoutExpired
        ? new TimeoutError(`Execution timed out after ${request.timeoutMs}ms`, request.timeoutMs)
        : error;

      return {
        ok: false,
        ...normalizeExecutionFailure(executionFailure, request),
        executionTimeMs,
        metadata: {
          backend: 'in-process',
          workspaceId: lease?.workspaceId,
          target: resolvedTarget,
        },
      };
    } finally {
      if (timeoutId) { clearTimeout(timeoutId); }
      // Release materialized workspace (best-effort)
      if (workspaceDescriptor?.workspaceId && workspaceProvider?.release) {
        await workspaceProvider.release(workspaceDescriptor.workspaceId).catch(() => {});
      }
      // CRITICAL: Always release workspace (even on error)
      if (lease) {
        await localWorkspaceManager.release(lease).catch(() => {
          // Swallow release errors - already handling main error
        });
      }
    }
  }

  // NOTE: v3/v4 - No converter methods needed!
  // - buildRuntimeDescriptor() - REMOVED (descriptor passed as-is)
  // - getHostType() - REMOVED (host field already in descriptor.host)
  // - convertHostContext() - REMOVED (hostContext already in descriptor.hostContext)

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
      backend: 'in-process',
      details: {
        uptimeMs: Date.now() - this.startTime,
      },
    };
  }

  async stats(): Promise<ExecutionStats> {
    return { ...this._stats };
  }

  async shutdown(): Promise<void> {
    // No-op for in-process backend
  }
}
