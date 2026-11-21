/**
 * @module @kb-labs/core-runtime/transport
 * Abstract transport layer for cross-process adapter communication.
 *
 * Provides a transport-agnostic interface for sending adapter calls
 * between parent and child processes. Implementations can use:
 * - IPC (process.send/process.on('message'))
 * - HTTP REST API
 * - Docker exec
 * - gRPC
 * - WebSockets
 *
 * @example
 * ```typescript
 * import { ITransport, IPCTransport } from '@kb-labs/core-runtime/transport';
 *
 * const transport: ITransport = new IPCTransport();
 * const response = await transport.send({
 *   type: 'adapter:call',
 *   requestId: 'uuid-123',
 *   adapter: 'vectorStore',
 *   method: 'search',
 *   args: [[0.1, 0.2, 0.3], 10],
 * });
 * ```
 */

import type { AdapterCall, AdapterResponse } from '@kb-labs/core-platform/serializable';
import { classifyFailure } from '@kb-labs/core-retry';

/**
 * Transport configuration options.
 */
export interface TransportConfig {
  /**
   * Default timeout for adapter calls in milliseconds.
   * @default 30000 (30 seconds)
   */
  timeout?: number;

  /**
   * Number of retry attempts for transient errors.
   * @default 0 (no retries)
   */
  retries?: number;

  /**
   * Delay between retry attempts in milliseconds.
   * @default 1000 (1 second)
   */
  retryDelay?: number;

  /**
   * Exponential backoff multiplier for retries.
   * @default 2 (doubles delay each retry)
   */
  backoffMultiplier?: number;
}

/**
 * Abstract transport for sending adapter calls.
 *
 * Implementations must handle:
 * - Reliable message delivery
 * - Timeout enforcement
 * - Error propagation
 * - Resource cleanup
 *
 * Thread-safety: Implementations must be safe to call concurrently
 * from multiple async contexts.
 */
export interface ITransport {
  /**
   * Send adapter call and await response.
   *
   * @param call - Adapter method call to send
   * @returns Response with result or error
   * @throws TransportError if communication fails
   * @throws TimeoutError if timeout exceeded
   * @throws SerializationError if message cannot be serialized
   */
  send(call: AdapterCall, signal?: AbortSignal): Promise<AdapterResponse>;

  /**
   * Send a fire-and-forget message (no response expected).
   * Used for EventBus subscribe/unsubscribe control messages.
   */
  sendMessage(msg: unknown): void;

  /**
   * Register a handler for push messages received from the parent (Parent → Child).
   * Used by EventBusProxy to receive event bus events.
   *
   * @returns Unsubscribe function
   */
  onPushMessage(handler: (msg: unknown) => void): () => void;

  /**
   * Close transport and cleanup resources.
   *
   * After close():
   * - No new calls can be sent
   * - Pending calls are rejected with TransportError
   * - Listeners/connections are cleaned up
   */
  close(): Promise<void>;

  /**
   * Check if transport is closed.
   */
  isClosed(): boolean;
}

/**
 * Base error for transport failures.
 */
export class TransportError extends Error {
  public override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'TransportError';
    this.cause = cause;
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

/**
 * Error thrown when adapter call times out.
 */
export class TimeoutError extends TransportError {
  public readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Error thrown when circuit breaker is open.
 */
export class CircuitOpenError extends TransportError {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Check if error is retryable (transient failure).
 *
 * Retryable errors:
 * - Network timeouts (TimeoutError)
 * - Connection errors (ECONNRESET, ECONNREFUSED, ETIMEDOUT)
 * - Temporary server errors (503 Service Unavailable)
 *
 * Non-retryable errors:
 * - Invalid requests (400 Bad Request)
 * - Authentication failures (401, 403)
 * - Not found (404)
 * - Application errors from adapter (e.g., VectorStoreError)
 *
 * @param error - Error to check
 * @returns true if error should be retried
 */
export function isRetryableError(error: Error): boolean {
  // Circuit breaker open is NOT retryable (wait for half-open state)
  if (error instanceof CircuitOpenError) {
    return false;
  }
  return classifyFailure(error, { source: 'transport', phase: 'dispatch' }).transient;
}

/**
 * Internal pending request tracking.
 * Used by transport implementations to match responses with requests.
 */
export interface PendingRequest {
  resolve: (response: AdapterResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

export function createTransportAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) { return signal.reason; }
  const error = new Error('Adapter call aborted');
  error.name = 'AbortError';
  return error;
}
