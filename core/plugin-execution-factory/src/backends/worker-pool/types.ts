/**
 * @module @kb-labs/plugin-execution/backends/worker-pool/types
 *
 * Types for worker pool backend.
 * These are internal types - not exposed in public API.
 */

import type {
  ExecutionRequest,
  ExecutionResult,
  HostType,
  PlatformTransportFactory,
  WorkerPoolOptions,
} from '../../types.js';
import type { WorkerFailureDiagnostic } from '../../errors.js';
import type { ExecutionError } from '@kb-labs/core-platform';
import type { RawMiddlewareDecl } from '@kb-labs/plugin-runtime';
import type { PlatformServices, ProcessIdentity, UIFacade } from '@kb-labs/plugin-contracts';
import type { ProcessTableSource } from './process-tree.js';

export interface WorkerPoolBackendOptions extends WorkerPoolOptions {
  platform: PlatformServices;
  platformTransport?: PlatformTransportFactory;
  uiProvider?: (hostType: HostType) => UIFacade;
  workerScript?: string;
  processTableSource?: ProcessTableSource;
  maxQueueSize?: number;
  acquireTimeoutMs?: number;
  healthCheckIntervalMs?: number;
}

// ============================================================================
// Worker Pool Configuration
// ============================================================================

/**
 * Internal worker pool configuration (with defaults applied).
 */
export interface WorkerPoolConfig {
  /** Minimum workers (default: 2) */
  min: number;

  /** Maximum workers (default: 10) */
  max: number;

  /** Max requests per worker before recycle (default: 1000) */
  maxRequestsPerWorker: number;

  /** Max uptime per worker before recycle in ms (default: 30 min) */
  maxUptimeMsPerWorker: number;

  /** Maximum queue size for pending requests (default: 100) */
  maxQueueSize: number;

  /** Maximum time to wait for available worker in ms (default: 5000) */
  acquireTimeoutMs: number;

  /** Max concurrent executions per plugin (default: no limit) */
  maxConcurrentPerPlugin?: number;

  /** Health check interval in ms (default: 10000) */
  healthCheckIntervalMs: number;

  /** Warmup policy */
  warmup: {
    mode: 'none' | 'top-n' | 'marked';
    topN: number;
    maxHandlers: number;
  };
}

/**
 * Default worker pool configuration.
 */
export const DEFAULT_WORKER_POOL_CONFIG: WorkerPoolConfig = {
  min: 2,
  max: 10,
  maxRequestsPerWorker: 1000,
  maxUptimeMsPerWorker: 30 * 60 * 1000, // 30 minutes
  maxQueueSize: 100,
  acquireTimeoutMs: 5000,
  healthCheckIntervalMs: 10_000,
  warmup: {
    mode: 'none',
    topN: 5,
    maxHandlers: 20,
  },
};

// ============================================================================
// Worker State
// ============================================================================

/**
 * Worker state.
 */
export type WorkerState =
  | 'starting'    // Worker is being spawned
  | 'idle'        // Worker is ready for work
  | 'busy'        // Worker is executing a request
  | 'draining'    // Worker is finishing current work before shutdown
  | 'stopped';    // Worker has terminated

/**
 * Worker info for pool management.
 */
export interface WorkerInfo {
  /** Unique worker ID */
  id: string;

  /** Current state */
  state: WorkerState;

  /** PID of subprocess (if running) */
  pid?: number;

  /** Time when worker was created */
  createdAt: number;

  /** Number of requests handled */
  requestCount: number;

  /** Last request start time (for timeout detection) */
  lastRequestStartedAt?: number;

  /** Current request execution ID (if busy) */
  currentExecutionId?: string;

  /** Last error (for health tracking) */
  lastError?: string;

  /** Last health check time */
  lastHealthCheckAt?: number;

  /** Is healthy flag */
  healthy: boolean;
}

// ============================================================================
// IPC Messages
// ============================================================================

/**
 * Message types for IPC between pool and workers.
 */
export type WorkerMessageType =
  | 'execute'         // Pool -> Worker: execute request
  | 'result'          // Worker -> Pool: execution result
  | 'error'           // Worker -> Pool: execution error
  | 'log'             // Worker -> Pool: ui/shell log entry (log.line events)
  | 'loggerLog'       // Worker -> Pool: ctx.logger.* log entry (logger.line events). See ADR-0019.
  | 'health'          // Pool -> Worker: health check request
  | 'healthOk'        // Worker -> Pool: health check response
  | 'shutdown'        // Pool -> Worker: graceful shutdown
  | 'ready'           // Worker -> Pool: worker is ready
  | 'middlewares'     // Pool -> Worker: adapter middleware declarations (sent once after ready)
  | 'uiPrompt'        // Worker -> Pool: request interactive prompt from host TTY
  | 'uiPromptResult'  // Pool -> Worker: result of interactive prompt
  | 'processStarted'  // Worker -> Pool: governed child process identity
  | 'processStartedAck'; // Pool -> Worker: identity persistence completed

/**
 * Base IPC message.
 */
export interface BaseWorkerMessage {
  type: WorkerMessageType;
  requestId?: string;
}

/**
 * Execute request message (Pool -> Worker).
 */
export interface ExecuteMessage extends BaseWorkerMessage {
  type: 'execute';
  requestId: string;
  request: ExecutionRequest;
  timeoutMs: number;
}

/**
 * Result message (Worker -> Pool).
 */
export interface ResultMessage extends BaseWorkerMessage {
  type: 'result';
  requestId: string;
  result: ExecutionResult;
}

/**
 * Error message (Worker -> Pool).
 */
export interface ErrorMessage extends BaseWorkerMessage {
  type: 'error';
  requestId: string;
  error: ExecutionError;
}

/**
 * Health check request (Pool -> Worker).
 */
export interface HealthMessage extends BaseWorkerMessage {
  type: 'health';
}

/**
 * Health check response (Worker -> Pool).
 */
export interface HealthOkMessage extends BaseWorkerMessage {
  type: 'healthOk';
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
  uptime: number;
}

/**
 * Shutdown request (Pool -> Worker).
 */
export interface ShutdownMessage extends BaseWorkerMessage {
  type: 'shutdown';
  graceful: boolean;
}

/**
 * Ready notification (Worker -> Pool).
 */
export interface ReadyMessage extends BaseWorkerMessage {
  type: 'ready';
  pid: number;
}

/**
 * Log entry message (Worker -> Pool) for ui/shell log streaming ('log.line' events).
 * Host is responsible for SQLite persistence. See ADR-0019.
 */
export interface LogWorkerMessage extends BaseWorkerMessage {
  type: 'log';
  requestId: string;
  entry: {
    level: string;
    message: string;
    stream: 'stdout' | 'stderr';
    lineNo: number;
    timestamp: string;
    meta?: Record<string, unknown>;
  };
}

/**
 * Logger log entry message (Worker -> Pool) for ctx.logger.* streaming ('logger.line' events).
 * Base logger has already persisted to SQLite. Host typically only calls publishLog(). See ADR-0019.
 */
export interface LoggerLogWorkerMessage extends BaseWorkerMessage {
  type: 'loggerLog';
  requestId: string;
  entry: {
    level: string;
    message: string;
    stream: 'stdout' | 'stderr';
    lineNo: number;
    timestamp: string;
    meta?: Record<string, unknown>;
  };
}

/**
 * Interactive UI prompt request (Worker -> Pool).
 * Worker asks the host to render a prompt in the TTY and return the result.
 */
export interface UIPromptMessage extends BaseWorkerMessage {
  type: 'uiPrompt';
  promptId: string;
  requestId: string;
  kind: 'select' | 'multiSelect' | 'text' | 'confirm';
  message: string;
  choices?: Array<{ label: string; value: unknown; hint?: string; checked?: boolean }>;
  defaultValue?: unknown;
}

/**
 * Interactive UI prompt result (Pool -> Worker).
 */
export type UIPromptResultMessage = BaseWorkerMessage & ({
  type: 'uiPromptResult';
  promptId: string;
  value: unknown;
  failure?: never;
} | {
  type: 'uiPromptResult';
  promptId: string;
  value: undefined;
  failure: ExecutionError;
});

export interface ProcessStartedMessage extends BaseWorkerMessage {
  type: 'processStarted';
  requestId: string;
  identity: ProcessIdentity;
}

export interface ProcessStartedAckMessage extends BaseWorkerMessage {
  type: 'processStartedAck';
  requestId: string;
  failure?: string;
}

/**
 * Adapter middleware declarations (Pool -> Worker).
 * Sent once after worker signals ready; worker resolves and caches LoadedMiddleware[].
 */
export interface MiddlewaresInitMessage extends BaseWorkerMessage {
  type: 'middlewares';
  decls: RawMiddlewareDecl[];
}

/**
 * All message types union.
 */
export type WorkerMessage =
  | ExecuteMessage
  | ResultMessage
  | ErrorMessage
  | LogWorkerMessage
  | LoggerLogWorkerMessage
  | HealthMessage
  | HealthOkMessage
  | ShutdownMessage
  | ReadyMessage
  | MiddlewaresInitMessage
  | UIPromptMessage
  | UIPromptResultMessage
  | ProcessStartedMessage
  | ProcessStartedAckMessage;

// ============================================================================
// Queue Types
// ============================================================================

/**
 * Queued execution request.
 */
export interface QueuedRequest {
  /** Unique ID for queue tracking */
  id: string;

  /** The execution request */
  request: ExecutionRequest;

  /** Abort signal (if provided) */
  signal?: AbortSignal;

  /** Time when request was queued */
  queuedAt: number;

  /** Resolve callback for promise */
  resolve: (result: ExecutionResult) => void;

  /** Reject callback for promise (for timeout/abort) */
  reject: (error: Error) => void;

  /** ui/shell log callback — passed through to worker.execute() */
  onLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void;

  /** ctx.logger.* log callback — passed through to worker.execute() */
  onLoggerLog?: (entry: { level: string; message: string; stream: 'stdout' | 'stderr'; lineNo: number; timestamp: string; meta?: Record<string, unknown> }) => void;

  /** UI prompt callback — passed through to worker.execute() */
  onUIPrompt?: (prompt: UIPromptMessage) => Promise<unknown>;
  /** Persist the identity of a governed process started by this request. */
  onProcessStarted?: (identity: ProcessIdentity) => Promise<void>;
  /** Context-specific hint used when no UI prompt responder is available. */
  uiPromptHint?: string;
}

// ============================================================================
// Pool Statistics
// ============================================================================

/**
 * Worker pool statistics.
 */
export interface WorkerPoolStats {
  /** Total workers (all states) */
  totalWorkers: number;

  /** Workers whose descendant process tree could not be verified after kill. */
  treeUnverifiedWorkers: number;

  /** Workers in each state */
  workersByState: Record<WorkerState, number>;

  /** Current queue length */
  queueLength: number;

  /** Total requests since start */
  totalRequests: number;

  /** Successful requests */
  successCount: number;

  /** Failed requests */
  errorCount: number;

  /** Requests that timed out waiting for worker */
  acquireTimeouts: number;

  /** Requests rejected due to full queue */
  queueFullRejections: number;

  /** Worker crashes since start */
  workerCrashes: number;

  /** Workers recycled (due to max requests/uptime) */
  workersRecycled: number;

  /** Average wait time in queue (ms) */
  avgQueueWaitMs: number;

  /** P99 wait time in queue (ms) */
  p99QueueWaitMs?: number;
  /** Most recent worker startup or replacement failure, when recovery is pending. */
  lastStartFailure?: WorkerFailureDiagnostic;
}
