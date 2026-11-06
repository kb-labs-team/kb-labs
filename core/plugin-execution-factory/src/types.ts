/**
 * @module @kb-labs/plugin-execution/types
 *
 * Core type definitions for the Execution Layer.
 * These types are the CONTRACT - do not change without versioning.
 *
 * ## Type Strategy: Composition (v3)
 *
 * We use PluginContextDescriptor from plugin-contracts DIRECTLY.
 * No custom ExecutionDescriptor, no converters, no custom HostContext.
 *
 * ExecutionRequest = PluginContextDescriptor + execution-specific fields
 *
 * This means:
 * - `request.descriptor` is passed to `runInProcess()` as-is
 * - Execution-specific fields (pluginRoot, handlerRef, timeout) are separate
 * - No type conversion code = no bugs from conversion
 * - HostContext uses runtime types (host: 'cli' | 'rest' | 'workflow' | 'webhook' | 'cron')
 */

import type {
  PlatformServices,
  PluginContextV3,
  PluginContextDescriptor,
  HostContext,
  HostType,
  PermissionSpec,
  UIFacade,
  InvokeOptions,
} from '@kb-labs/plugin-contracts';
import type { WorkerFailureDiagnostic } from './errors.js';
import type {
  ExecutionRequest as CoreExecutionRequest,
  WorkspaceConfig as CoreWorkspaceConfig,
  ArtifactsConfig as CoreArtifactsConfig,
  ExecutionResult as CoreExecutionResult,
  ExecutionResponse as CoreExecutionResponse,
  ExecutionError as CoreExecutionError,
  ExecutionDiagnostics as CoreExecutionDiagnostics,
  ExecutionErrorCode as CoreExecutionErrorCode,
  ExecutionMetadata as CoreExecutionMetadata,
} from '@kb-labs/core-platform';
import type {
  HealthStatus as CoreHealthStatus,
  ResolvedExecutionMode,
  ExecutionStats as CoreExecutionStats,
} from '@kb-labs/core-contracts';
import type { NormalizedExecutionFailure, NormalizedExecutionResult } from './normalized-result.js';

// Re-export runtime types for convenience (consumers use these, not custom types)
export type { PluginContextDescriptor, HostContext, HostType, PermissionSpec };

/**
 * Plugin invoker callback for ctx.api.invoke wiring.
 */
export type PluginInvokerFn = <T = unknown>(
  pluginId: string,
  input?: unknown,
  options?: InvokeOptions
) => Promise<T>;

// ============================================================================
// Protocol Version
// ============================================================================

/**
 * Current protocol version.
 * Increment when making breaking changes to ExecutionRequest/ExecutionResult.
 */
export const PROTOCOL_VERSION = 1 as const;

// ============================================================================
// Handler Contract
// ============================================================================

/**
 * Plugin handler contract - UNIFIED for all handler types.
 * All handlers MUST export default satisfying this interface.
 *
 * @example
 * ```typescript
 * // my-handler.ts
 * export default {
 *   execute: async (ctx, input) => {
 *     return { success: true };
 *   }
 * } satisfies PluginHandler;
 * ```
 */
export interface PluginHandler<TInput = unknown, TOutput = unknown> {
  /** Main execution method */
  execute(ctx: PluginContextV3, input: TInput): Promise<TOutput>;

  /** Optional: describe handler for tooling/introspection */
  describe?(): HandlerMetadata;

  /** Optional: input/output schema for validation */
  schema?(): HandlerSchema;

  /** Optional: warmup hook for preloading resources */
  warmup?(): Promise<void>;
}

/**
 * Handler metadata for tooling
 */
export interface HandlerMetadata {
  name: string;
  description?: string;
  version?: string;
  tags?: string[];
}

/**
 * Handler schema for validation
 */
export interface HandlerSchema {
  input?: unknown;   // JSON Schema or Zod schema
  output?: unknown;  // JSON Schema or Zod schema
}

// ============================================================================
// Execution Request
// ============================================================================

/**
 * Execution request - universal for all handler types.
 * This is what consumers pass to backend.execute().
 *
 * ## Composition Approach
 *
 * `descriptor` is PluginContextDescriptor from plugin-contracts.
 * It is passed to runInProcess() AS-IS, no conversion needed.
 *
 * ## Separation of Concerns (v4)
 *
 * - `descriptor` = runtime context (permissions, hostContext, config)
 * - `executionId` = execution layer tracing (NOT same as descriptor.requestId)
 * - `pluginRoot/handlerRef` = file resolution (execution layer concern)
 * - `timeoutMs/workspace/artifacts` = execution configuration
 *
 * Note: descriptor.requestId is for request correlation in distributed tracing.
 * executionId is for this specific execution attempt (may retry same requestId).
 */
export type ExecutionRequest = CoreExecutionRequest<PluginContextDescriptor>;

// ============================================================================
// Workspace Configuration
// ============================================================================

/**
 * Workspace configuration.
 * Defaults to 'local' type with process.cwd().
 */
export type WorkspaceConfig = CoreWorkspaceConfig;

// ============================================================================
// Artifacts Configuration
// ============================================================================

/**
 * Artifacts configuration.
 */
export type ArtifactsConfig = CoreArtifactsConfig;

// ============================================================================
// Execution Result
// ============================================================================

/**
 * Execution result - returned by backend.execute().
 */
export type ExecutionResult = CoreExecutionResult;
export type ExecutionResponse = CoreExecutionResponse;

/**
 * Structured error with code and details.
 */
export type ExecutionError = CoreExecutionError;
export type ExecutionDiagnostics = CoreExecutionDiagnostics;

/**
 * Standardized error codes.
 *
 * Phase 1: Core codes (all implemented)
 * Phase 2: Pool-specific codes (reserved, not yet implemented)
 */
export type ExecutionErrorCode = CoreExecutionErrorCode;

/**
 * Execution metadata for observability.
 */
export type ExecutionMetadata = CoreExecutionMetadata;

// ============================================================================
// Execution Backend Interface
// ============================================================================

/**
 * Execution backend interface - ONE interface for ALL execution.
 *
 * Implementations:
 * - InProcessBackend (Level 0)
 * - WorkerPoolBackend (Level 1)
 * - Container routing through the factory-owned isolation backend
 */
interface CoreExecutionBackendLifecycle {
  health(): Promise<HealthStatus>;
  stats(): Promise<ExecutionStats>;
  shutdown(): Promise<void>;
}

/** Internal raw backend contract. It is only used by the factory package. */
export interface RawExecutionBackend extends CoreExecutionBackendLifecycle {
  execute(request: ExecutionRequest, options?: ExecuteOptions): Promise<ExecutionResult>;
  start?(): Promise<ExecutionStartOutcome>;
}

export type ExecutionStartOutcome =
  | { status: 'ready' }
  | { status: 'recovering'; failure: WorkerFailureDiagnostic }
  | { status: 'stopped' };

export type { ResolvedExecutionMode } from '@kb-labs/core-contracts';

export type NormalizedHealthStatus = CoreHealthStatus & {
  /** Concrete local mode selected by the platform execution backend. */
  executionMode: ResolvedExecutionMode;
};

export interface ExecutionBackend extends Omit<CoreExecutionBackendLifecycle, 'health'> {
  health(): Promise<NormalizedHealthStatus>;
  /** Concrete execution mode selected by the backend owner. */
  readonly executionMode: ResolvedExecutionMode;
  /**
   * Execute plugin request with plugin-typed descriptor.
   */
  execute(
    request: ExecutionRequest,
    options?: ExecuteOptions
  ): Promise<NormalizedExecutionResult>;

  /**
   * Optional initialization hook for backends that need startup work.
   */
  start?(): Promise<ExecutionStartOutcome>;
}

/**
 * Structured log entry emitted during plugin execution.
 * Used by `onLog` callback in `ExecuteOptions` to stream logs to the host.
 */
export interface LogEntry {
  /** Log level */
  level: string;
  /** Log message text */
  message: string;
  /** Output stream: stdout for info/debug, stderr for warn/error */
  stream: 'stdout' | 'stderr';
  /** Monotonic line number within this execution */
  lineNo: number;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Optional structured metadata */
  meta?: Record<string, unknown>;
}

/**
 * Callback for receiving log entries during execution.
 * Called by the backend as logs are produced — host-agnostic.
 */
export type OnLogCallback = (entry: LogEntry) => void;

/**
 * Execute options.
 *
 * Two log callbacks are provided to implement stream separation.
 * See: services/workflow/docs/adr/0019-log-stream-separation.md
 */
export interface ExecuteOptions {
  signal?: AbortSignal;
  pluginInvoker?: PluginInvokerFn;
  /** Context-specific instruction shown when this execution cannot answer a UI prompt. */
  uiPromptHint?: string;
  /**
   * Callback for ui/shell log entries ('log.line' events from StreamingUI + shell capture).
   * Host is responsible for SQLite persistence (e.g. stepLogger.info()).
   * Each backend implements this differently:
   * - InProcess: eventEmitter → onLog directly
   * - WorkerPool: IPC type:'log' → parent → onLog
   */
  onLog?: OnLogCallback;
  /**
   * Callback for ctx.logger.* entries ('logger.line' events from StreamingLogger).
   * Base logger has already persisted to SQLite. Host typically only calls publishLog() for SSE.
   * - InProcess: eventEmitter → onLoggerLog directly
   * - WorkerPool: IPC type:'loggerLog' → parent → onLoggerLog
   */
  onLoggerLog?: OnLogCallback;
  [key: string]: unknown;
}

/**
 * Health status.
 */
export type HealthStatus = CoreHealthStatus;

/**
 * Execution statistics.
 */
export type ExecutionStats = CoreExecutionStats;

// ============================================================================
// Backend Options
// ============================================================================

/**
 * Backend options for factory.
 */
export interface BackendOptions {
  /**
   * Execution mode.
   * - 'auto': Detect based on environment (default)
   * - 'in-process': Always use InProcessBackend (same process, no isolation)
   * - 'subprocess': Always use SubprocessBackend (single subprocess, process isolation)
   * - 'worker-pool': Always use WorkerPoolBackend (pool of workers, production-ready)
   */
  mode?: 'auto' | Exclude<ResolvedExecutionMode, 'container'>;

  /**
   * Platform services.
   * REQUIRED for in-process and worker-pool modes.
   */
  platform: PlatformServices;

  /**
   * UI provider for CLI execution.
   *
   * By default, backend uses noopUI (silent).
   * For CLI, pass a function that returns real UI based on host type.
   *
   * @example
   * ```typescript
   * uiProvider: (hostType) => hostType === 'cli' ? cliUI : noopUI
   * ```
   */
  uiProvider?: (hostType: HostType) => UIFacade;

  /**
   * Optional default plugin invoker for ctx.api.invoke.
   * Used by InProcess backend and can be overridden per execute() call.
   */
  pluginInvoker?: PluginInvokerFn;

  /**
   * Platform transport factory for cross-process adapter calls.
   * Determines how plugin handlers in worker/subprocess access platform services.
   *
   * Default: IPC transport (ChildIPCServer via Node.js fork channel).
   * Custom: pass your own factory for unix-socket, gateway-ws, etc.
   */
  platformTransport?: PlatformTransportFactory;

  /**
   * Worker pool options (only for worker-pool mode).
   */
  workerPool?: WorkerPoolOptions;

}

/**
 * Worker pool options.
 */
export interface WorkerPoolOptions {
  /** Minimum workers (default: 2) */
  min?: number;

  /** Maximum workers (default: 10) */
  max?: number;

  /** Max requests per worker before recycle (default: 1000) */
  maxRequestsPerWorker?: number;

  /** Max uptime per worker before recycle in ms (default: 30 min) */
  maxUptimeMsPerWorker?: number;

  /** Max concurrent executions per plugin (default: no limit) */
  maxConcurrentPerPlugin?: number;

  /** Warmup policy */
  warmup?: WarmupPolicy;
}

/**
 * Warmup policy for worker pool.
 *
 * NOTE: 'all' mode removed - too dangerous (can OOM with many handlers).
 * Use 'marked' or 'top-n' instead.
 */
export interface WarmupPolicy {
  /**
   * Warmup mode.
   * - 'none': No warmup (cold start on first request)
   * - 'top-n': Warmup top N most-used handlers
   * - 'marked': Warmup handlers marked with warmup: true in manifest
   */
  mode: 'none' | 'top-n' | 'marked';

  /** For 'top-n': how many handlers to warmup (default: 5) */
  topN?: number;

  /** Max handlers to warmup (safety limit, default: 20) */
  maxHandlers?: number;
}

/**
 * Platform transport factory — creates the server-side handler for platform adapter calls.
 *
 * Each execution mode needs a way to forward platform adapter calls (LLM, cache, etc.)
 * from the isolated execution environment back to the parent process.
 *
 * Built-in implementations:
 * - `ipc`: Uses Node.js fork IPC channel (ChildIPCServer). Default for worker-pool.
 * - `unix-socket`: Uses Unix domain socket (UnixSocketServer). Default for subprocess.
 *
 * Custom: implement this interface and pass via BackendOptions.platformTransport.
 */
export interface PlatformTransportFactory {
  /**
   * Transport type identifier.
   * Passed to child process via KB_PLATFORM_TRANSPORT env var.
   * Child uses this to create the matching client-side transport.
   */
  readonly type: string;

  /**
   * Create server-side handler for a child process.
   * Called once per worker/subprocess spawn.
   *
   * @param platform - Real platform adapters to dispatch calls to
   * @param child - Child process reference (for IPC-based transports)
   * @returns Server with start/stop lifecycle
   */
  createServer(
    platform: PlatformServices,
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    child: import('node:child_process').ChildProcess,
  ): PlatformTransportServer;

  /**
   * Optional: extra env vars to pass to child process.
   * E.g., unix-socket transport passes KB_PLATFORM_SOCKET_PATH.
   */
  getChildEnv?(): Record<string, string>;
}

/**
 * Server-side platform transport handler.
 */
export interface PlatformTransportServer {
  start(): void;
  stop(): void;
}
