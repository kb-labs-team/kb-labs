/**
 * @module @kb-labs/core-runtime/transport
 * IPC transport implementation using process.send/process.on('message').
 *
 * This transport is used for communication between parent (CLI) and
 * child (sandbox worker) processes created by child_process.fork().
 *
 * Features:
 * - Thread-safe: Uses request IDs to match responses with requests
 * - Timeout enforcement: Rejects calls that exceed timeout
 * - Error propagation: Deserializes errors from parent
 * - Cleanup: Properly removes listeners on close()
 *
 * @example
 * ```typescript
 * import { IPCTransport } from '@kb-labs/core-runtime/transport';
 *
 * // In child process
 * const transport = new IPCTransport({ timeout: 10000 });
 *
 * const response = await transport.send({
 *   type: 'adapter:call',
 *   requestId: 'uuid-123',
 *   adapter: 'vectorStore',
 *   method: 'search',
 *   args: [[0.1, 0.2, 0.3], 10],
 * });
 *
 * await transport.close();
 * ```
 */

import type { AdapterCall, AdapterResponse } from '@kb-labs/core-platform/serializable';
import { isAdapterResponse } from '@kb-labs/core-platform/serializable';
import {
  type ITransport,
  type TransportConfig,
  type PendingRequest,
  TransportError,
  TimeoutError,
  createTransportAbortError,
} from './transport';
import { selectTimeout } from './timeout-config';

/**
 * IPC transport using process.send/process.on('message').
 *
 * Requires:
 * - process.send() must be available (running as forked child)
 * - Parent process must listen for messages and respond
 *
 * Thread-safety:
 * - Uses Map for pending requests (safe for concurrent access in single thread)
 * - Uses request IDs to match responses (no race conditions)
 *
 * Limitations:
 * - Only works in forked child processes (not worker threads)
 * - Parent must implement IPCServer to handle calls
 * - Message size limited by Node.js IPC buffer (typically 1MB)
 */
export class IPCTransport implements ITransport {
  private pending = new Map<string, PendingRequest>();
  private pushHandlers = new Set<(msg: unknown) => void>();
  private messageHandler: (msg: unknown) => void;
  private closed = false;

  constructor(private config: TransportConfig = {}) {
    // Bind handler to preserve 'this' context
    this.messageHandler = this.handleMessage.bind(this);

    // Listen for responses from parent
    process.on('message', this.messageHandler);

    // Check if IPC channel is available
    if (!process.send) {
      throw new TransportError(
        'No IPC channel available. IPCTransport can only be used in forked child processes.'
      );
    }
  }

  async send(call: AdapterCall, signal?: AbortSignal): Promise<AdapterResponse> {
    if (signal?.aborted) { throw createTransportAbortError(signal); }
    if (this.closed) {
      throw new TransportError('Transport is closed');
    }

    // Smart timeout selection based on operation type
    const timeout = selectTimeout(call, this.config.timeout);

    return new Promise((resolve, reject) => {
      // Create timeout timer
      const timer = setTimeout(() => {
        this.pending.delete(call.requestId);
        pending.signal?.removeEventListener('abort', pending.abortHandler!);
        this.sendCancel(call.requestId);
        reject(new TimeoutError(`Adapter call timed out after ${timeout}ms`, timeout));
      }, timeout);

      // Store pending request
      const pending: PendingRequest = { resolve, reject, timer, signal };
      if (signal) {
        pending.abortHandler = () => {
          if (this.pending.get(call.requestId) !== pending) { return; }
          clearTimeout(timer);
          this.pending.delete(call.requestId);
          this.sendCancel(call.requestId);
          reject(createTransportAbortError(signal));
        };
        signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      this.pending.set(call.requestId, pending);

      // Try to send message, with backpressure handling
      this.sendCall(call).catch((error) => {
        const pending = this.pending.get(call.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.signal?.removeEventListener('abort', pending.abortHandler!);
          this.pending.delete(call.requestId);
          reject(error);
        }
      });
    });
  }

  private async sendCall(call: AdapterCall): Promise<void> {
    if (!this.pending.has(call.requestId)) { return; }

    await new Promise<void>((resolve, reject) => {
      try {
        // `false` means queued under backpressure, not rejected. The callback
        // owns asynchronous disconnect/EPIPE errors; never retry this message.
        process.send!(call, undefined, undefined, (error) => {
          if (!error) { resolve(); return; }
          reject(new TransportError(`Failed to send IPC message: ${error.message}`, error));
        });
      } catch (error) {
        // Synchronous error (e.g., serialization failure or closed channel).
        const cause = error instanceof Error ? error : new Error(String(error));
        reject(new TransportError(`Failed to send IPC message: ${cause.message}`, cause));
      }
    });
  }

  sendMessage(msg: unknown): void {
    if (!this.closed && process.send) {
      // Push messages are best-effort. The callback prevents Node from
      // surfacing a later channel error as an unhandled process error.
      process.send(msg, undefined, undefined, () => {});
    }
  }

  private sendCancel(requestId: string): void {
    try {
      process.send?.({ type: 'adapter:cancel', requestId }, undefined, undefined, () => {});
    } catch { /* disconnected parent has already stopped dispatch */ }
  }

  onPushMessage(handler: (msg: unknown) => void): () => void {
    this.pushHandlers.add(handler);
    return () => { this.pushHandlers.delete(handler); };
  }

  private handleMessage(msg: unknown) {
    if (isAdapterResponse(msg)) {
      const pending = this.pending.get(msg.requestId);
      if (!pending) { return; }
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abortHandler!);
      this.pending.delete(msg.requestId);
      pending.resolve(msg);
      return;
    }

    // Dispatch non-response messages (e.g. eventbus:push) to registered handlers
    for (const handler of this.pushHandlers) {
      handler(msg);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    // Remove message listener
    process.off('message', this.messageHandler);

    // Reject all pending requests
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abortHandler!);
      pending.reject(new TransportError('Transport closed'));
    }
    this.pending.clear();
    this.pushHandlers.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/**
 * Create IPCTransport with default configuration.
 *
 * @example
 * ```typescript
 * import { createIPCTransport } from '@kb-labs/core-runtime/transport';
 *
 * const transport = createIPCTransport();
 * // Use transport...
 * await transport.close();
 * ```
 */
export function createIPCTransport(config?: TransportConfig): IPCTransport {
  return new IPCTransport(config);
}
