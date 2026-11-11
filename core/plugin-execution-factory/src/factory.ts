/**
 * @module @kb-labs/plugin-execution/factory
 *
 * Factory for creating execution backends.
 * Simple by default, enterprise when needed.
 */

import type { BackendOptions, ExecutionBackend, ExecutionRequest, ExecutionResult, NormalizedHealthStatus, RawExecutionBackend } from './types.js';
import { InProcessBackend } from './backends/in-process.js';
import { SubprocessBackend } from './backends/subprocess.js';
import { WorkerPoolBackend } from './backends/worker-pool/backend.js';
import { SubprocessRunnerAdapter } from './adapters/index.js';
import { BrokeredProcessExecutor, createDefaultProcessExecutor } from '@kb-labs/plugin-runtime';
import { LOG_PERSISTENCE_ERROR_FLUSH_TIMEOUT_MS, logDiagnosticEvent, type IPlatformAdapters } from '@kb-labs/core-platform';
import { isUxResultCandidate } from '@kb-labs/core-platform/ux-result';
import type { IResourceBroker } from '@kb-labs/core-resource-broker';
import type { ILogger } from '@kb-labs/core-platform';
import { normalizePluginHandlerFailure } from './plugin-handler-failure.js';
import { brandNormalizedExecutionResult, isFactoryNormalizedExecutionResult } from './normalized-result.js';
import type { NormalizedExecutionResult } from './normalized-result.js';
import { normalizeExecutionFailure } from './utils.js';

export function ensureHostProcessExecutor(platform: BackendOptions['platform']): void {
  const host = platform as BackendOptions['platform'] & IPlatformAdapters & {
    hasResourceBroker?: boolean;
    resourceBroker?: IResourceBroker;
    setAdapter?: (key: string, value: unknown) => void;
  };
  if (host.processExecutor || !host.setAdapter || host.hasResourceBroker !== true || !host.resourceBroker) {
    return;
  }
  host.setAdapter('processExecutor', new BrokeredProcessExecutor(
    host.resourceBroker,
    createDefaultProcessExecutor(host.logger),
    host.logger,
  ));
}

/**
 * Create execution backend based on options.
 *
 * Mode detection:
 * - 'auto' (default): Detect based on environment
 * - 'in-process': Always use InProcessBackend (same process, no isolation)
 * - 'subprocess': Always use SubprocessBackend (single subprocess, process isolation)
 * - 'worker-pool': Always use WorkerPoolBackend (pool of workers, production-ready)
 *
 * @example
 * ```typescript
 * // Simplest - just works
 * const backend = createExecutionBackend({ platform });
 *
 * // Explicit mode
 * const backend = createExecutionBackend({
 *   platform,
 *   mode: 'worker-pool',
 *   workerPool: { min: 2, max: 10 },
 * });
 * ```
 */
export function createExecutionBackend(options: BackendOptions): ExecutionBackend {
  // Install the single host-owned executor before creating any backend. Worker
  // and subprocess platforms already expose a proxy and therefore are left
  // untouched; they forward execution to this host over IPC.
  ensureHostProcessExecutor(options.platform);
  const mode = options.mode === 'auto' || !options.mode
    ? detectMode()
    : options.mode;

  let backend: RawExecutionBackend;
  switch (mode) {
    case 'in-process':
      backend = new InProcessBackend({
        platform: options.platform,
        uiProvider: options.uiProvider,
        pluginInvoker: options.pluginInvoker,
      });
      break;

    case 'subprocess':
      backend = new SubprocessBackend({
        platform: options.platform,
        runner: new SubprocessRunnerAdapter(),
        uiProvider: options.uiProvider,
      });
      break;


    case 'worker-pool':
      backend = new WorkerPoolBackend({
        platform: options.platform,
        platformTransport: options.platformTransport,
        uiProvider: options.uiProvider,
        min: options.workerPool?.min ?? 2,
        max: options.workerPool?.max ?? 10,
        maxRequestsPerWorker: options.workerPool?.maxRequestsPerWorker ?? 1000,
        maxUptimeMsPerWorker: options.workerPool?.maxUptimeMsPerWorker ?? 30 * 60 * 1000,
        maxConcurrentPerPlugin: options.workerPool?.maxConcurrentPerPlugin,
        warmup: options.workerPool?.warmup ?? { mode: 'none', topN: 5, maxHandlers: 20 },
      });
      break;

    default:
      throw new Error(`Unknown execution mode: ${mode}`);
  }
  return createNormalizedExecutionBackend(backend, options.platform.logger, mode);
}

/** Every execution backend crosses this owner before a result reaches a surface. */
export function createNormalizedExecutionBackend(
  backend: DispatchExecutionBackend,
  logger: ILogger,
  executionMode: ExecutionBackend['executionMode'],
): ExecutionBackend {
  return new NormalizingExecutionBackend(backend, logger, executionMode);
}

class NormalizingExecutionBackend implements ExecutionBackend {
  constructor(
    private readonly backend: DispatchExecutionBackend,
    private readonly logger: ILogger,
    readonly executionMode: ExecutionBackend['executionMode'],
  ) {}

  async execute(request: ExecutionRequest, options?: Parameters<ExecutionBackend['execute']>[1]): Promise<NormalizedExecutionResult> {
    let result: ExecutionResult;
    try {
      result = await this.backend.execute(request, options);
    } catch (error) {
      const failure = normalizeExecutionFailure(error, request);
      result = {
        ok: false as const,
        error: failure.error,
        diagnostics: failure.diagnostics,
        executionTimeMs: 0,
      };
    }
    if (isFactoryNormalizedExecutionResult(result)) {
      return brandNormalizedExecutionResult({
        ...result,
        metadata: { ...result.metadata, backend: this.executionMode },
      });
    }

    let returnedFailure = false;
    let returnedFailureError: unknown;
    if (result.ok) {
      if (isUxResultCandidate(result.data) && result.data.ok === false) {
        returnedFailure = true;
        returnedFailureError = result.data.error;
        const failure = normalizeExecutionFailure(result.data.error, request);
        result = {
          ...result,
          ok: false,
          diagnostics: failure.diagnostics,
          error: failure.error,
        };
      } else {
        return brandNormalizedExecutionResult({
          ...result,
          ok: true as const,
          metadata: { ...result.metadata, backend: this.executionMode },
        });
      }
    }

    let executionError = result.error;
    let executionDiagnostics = result.diagnostics;
    if (!executionError) {
      const missingFailure = normalizeExecutionFailure(new Error('Backend returned a failed execution without an error value.'), request);
      executionError = missingFailure.error;
      executionDiagnostics ??= missingFailure.diagnostics;
    }

    const descriptor = request.descriptor;
    const correlationId = descriptor.requestId || request.executionId;
    const hostType = descriptor.hostType;
    const { diagnostics: _diagnostics, ...normalizedResult } = result;
    const { error: _serializedError, ...executionEnvelope } = executionError;
    const error = normalizePluginHandlerFailure(executionError, {
      pluginId: descriptor.pluginId,
      pluginVersion: descriptor.pluginVersion,
      command: request.context?.commandPath ?? request.handlerRef,
      correlationId,
      logger: this.logger,
      diagnosticStack: executionDiagnostics?.errorStack,
      workerDiagnostic: executionDiagnostics?.worker,
      serializedError: executionError.error,
      returnedFailureError,
      executionEnvelope,
      logContext: {
        applicationId: 'kb-labs',
        serviceId: `${hostType}-plugin-execution`,
        instanceId: String(process.pid),
        layer: hostType,
      },
      returnedFailure,
    });
    await this.flushFailureLog(correlationId);
    return brandNormalizedExecutionResult({
      ...normalizedResult,
      ok: false,
      metadata: { ...normalizedResult.metadata, backend: this.executionMode },
      error: {
        ...error,
        error: executionError.error,
        envelope: error,
      },
    });
  }

  private async flushFailureLog(correlationId: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const flush = Promise.resolve().then(() => this.logger.flush());
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('log persistence flush timed out')), LOG_PERSISTENCE_ERROR_FLUSH_TIMEOUT_MS);
    });

    try {
      await Promise.race([flush, deadline]);
    } catch (persistenceFailure) {
      const error = persistenceFailure instanceof Error
        ? persistenceFailure
        : new Error(String(persistenceFailure));
      logDiagnosticEvent(this.logger, {
        event: 'platform.log.persistence.flush.failed',
        message: 'Failed to persist a normalized plugin handler failure.',
        reasonCode: 'LOG_PERSISTENCE_FLUSH_FAILED',
        level: 'error',
        domain: 'service',
        outcome: 'failed',
        error,
        evidence: { correlationId, timeoutMs: LOG_PERSISTENCE_ERROR_FLUSH_TIMEOUT_MS },
      });
    } finally {
      if (timeout) {clearTimeout(timeout);}
    }
  }

  async health(): Promise<NormalizedHealthStatus> {
    return { ...(await this.backend.health()), executionMode: this.executionMode };
  }
  stats() { return this.backend.stats(); }
  shutdown() { return this.backend.shutdown(); }
}


interface DispatchExecutionBackend {
  execute(request: ExecutionRequest, options?: Parameters<ExecutionBackend['execute']>[1]): Promise<import('./types.js').ExecutionResult | NormalizedExecutionResult>;
  health(): ReturnType<RawExecutionBackend['health']>;
  stats(): ReturnType<RawExecutionBackend['stats']>;
  shutdown(): ReturnType<RawExecutionBackend['shutdown']>;
}

/** Resolve auto to one first-release backend mode. */
function detectMode(): Exclude<ExecutionBackend['executionMode'], 'container'> {
  // Worker pool if explicitly enabled or Kubernetes
  if (
    process.env.EXECUTION_MODE === 'worker-pool' ||
    process.env.KUBERNETES_SERVICE_HOST
  ) {
    return 'worker-pool';
  }

  // Default: in-process (simplest)
  return 'in-process';
}
