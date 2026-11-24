/**
 * @module @kb-labs/core-runtime/transport
 * Unix Domain Socket transport for high-throughput IPC.
 *
 * Unix sockets provide 100-1000x better performance than process.send()
 * for large messages (>16KB), making them ideal for bulk operations like
 * VectorStore upsert with thousands of vectors.
 *
 * @example
 * ```typescript
 * import { UnixSocketTransport } from '@kb-labs/core-runtime/transport';
 *
 * // In child process
 * const transport = new UnixSocketTransport({ socketPath: '/tmp/kb-ipc.sock' });
 * const response = await transport.send(call);
 * await transport.close();
 * ```
 */

import * as net from 'net';
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
import { DEFAULT_SOCKET_PATH } from '../socket-path';

/**
 * Configuration for Unix Socket transport.
 */
export interface UnixSocketConfig extends TransportConfig {
  /** Path to Unix socket file (default: /tmp/kb-ipc.sock) */
  socketPath?: string;
  /** Reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Max reconnect attempts (default: 3) */
  maxReconnectAttempts?: number;
  /** Optional token required by an authenticated UnixSocketServer. */
  authToken?: string;
}

/**
 * Unix Domain Socket transport for high-performance IPC.
 *
 * Features:
 * - 100-1000x faster than process.send() for large messages
 * - No backpressure issues (TCP flow control handles it)
 * - Auto-reconnect on connection loss
 * - Message framing with newline delimiter
 *
 * Performance:
 * - process.send(): ~16KB buffer, 250-300s for 40MB
 * - Unix socket: ~1-2 GB/s throughput, <1s for 40MB
 */
export class UnixSocketTransport implements ITransport {
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingRequest>();
  private closed = false;
  private connectionPromise?: Promise<void>;
  private connectionAbortController?: AbortController;
  private connectionWaiters = 0;
  private buffer = '';
  private reconnectAttempts = 0;

  constructor(private config: UnixSocketConfig = {}) {}

  /**
   * Connect to Unix socket server.
   * Called lazily on first send() or explicitly.
   */
  connect(): Promise<void> {
    if (this.connectionPromise) { return this.connectionPromise; }
    if (this.socket && !this.socket.destroyed && !this.socket.connecting) { return Promise.resolve(); }
    if (this.closed) { return Promise.reject(new TransportError('Transport is closed')); }

    const controller = new AbortController();
    this.connectionAbortController = controller;
    this.connectionPromise = this.connectWithRetry(controller.signal).finally(() => {
      this.connectionPromise = undefined;
      if (this.connectionAbortController === controller) { this.connectionAbortController = undefined; }
    });
    return this.connectionPromise;
  }

  private async connectWithRetry(signal: AbortSignal): Promise<void> {
    const maxRetries = this.config.autoReconnect === false ? 0 : (this.config.maxReconnectAttempts ?? 3);
    let lastError: unknown;
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      if (this.closed || signal.aborted) { throw connectionAbortError(signal); }
      try {
        await this.openSocket(signal);
        this.reconnectAttempts = 0;
        return;
      } catch (error) {
        if (signal.aborted || this.closed) { throw connectionAbortError(signal); }
        lastError = error;
        if (retry === maxRetries) { break; }
        this.reconnectAttempts = retry + 1;
        await waitForDelay(1000 * this.reconnectAttempts, signal);
      }
    }
    const cause = lastError instanceof Error ? lastError : undefined;
    throw new TransportError(`Unix socket connection failed: ${cause?.message ?? String(lastError)}`, cause);
  }

  private openSocket(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.config.socketPath ?? DEFAULT_SOCKET_PATH);
      this.socket = socket;
      let connected = false;
      let settled = false;

      const failConnect = (error: Error) => {
        if (settled) { return; }
        settled = true;
        signal.removeEventListener('abort', abortHandler);
        if (this.socket === socket) { this.socket = null; }
        socket.destroy();
        reject(error);
      };
      const abortHandler = () => failConnect(connectionAbortError(signal));
      signal.addEventListener('abort', abortHandler, { once: true });

      socket.once('connect', () => {
        connected = true;
        settled = true;
        signal.removeEventListener('abort', abortHandler);
        this.reconnectAttempts = 0;
        resolve();
      });
      socket.on('error', (error) => {
        if (!connected) { failConnect(error); }
        else if (this.socket === socket) { socket.destroy(); }
      });
      socket.on('data', (data) => this.handleData(data));
      socket.on('close', () => {
        if (!connected || this.socket !== socket) { return; }
        this.socket = null;
        this.rejectPending(new TransportError('Unix socket connection closed'));
        if (!this.closed && this.config.autoReconnect !== false) {
          setTimeout(() => { void this.connect().catch(() => {}); }, 1000);
        }
      });
    });
  }

  async send(call: AdapterCall, signal?: AbortSignal): Promise<AdapterResponse> {
    if (signal?.aborted) { throw createTransportAbortError(signal); }
    if (this.closed) {
      throw new TransportError('Transport is closed');
    }

    const timeout = selectTimeout(call, this.config.timeout);
    const startedAt = Date.now();
    this.connectionWaiters += 1;
    try {
      await waitForConnection(this.connect(), signal, timeout);
    } catch (error) {
      this.releaseConnectionWaiter(true);
      throw error;
    }
    this.releaseConnectionWaiter(false);
    if (signal?.aborted) { throw createTransportAbortError(signal); }

    if (!this.socket || this.socket.destroyed) {
      throw new TransportError('Socket not available');
    }

    const remainingTimeout = timeout - (Date.now() - startedAt);
    if (remainingTimeout <= 0) { throw new TimeoutError(`Adapter call timed out after ${timeout}ms`, timeout); }
    const outboundCall: AdapterCall = this.config.authToken
      ? {
        ...call,
        context: { ...call.context, authToken: this.config.authToken },
      }
      : call;

    return new Promise((resolve, reject) => {
      // Create timeout timer
      const timer = setTimeout(() => {
        const pending = this.pending.get(outboundCall.requestId);
        pending?.signal?.removeEventListener('abort', pending.abortHandler!);
        this.pending.delete(outboundCall.requestId);
        this.sendCancel(outboundCall.requestId);
        reject(new TimeoutError(`Adapter call timed out after ${timeout}ms`, timeout));
      }, remainingTimeout);

      // Store pending request
      const pending: PendingRequest = { resolve, reject, timer, signal };
      if (signal) {
        pending.abortHandler = () => {
          if (this.pending.get(outboundCall.requestId) !== pending) { return; }
          clearTimeout(timer);
          this.pending.delete(outboundCall.requestId);
          this.sendCancel(outboundCall.requestId);
          reject(createTransportAbortError(signal));
        };
        signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      this.pending.set(outboundCall.requestId, pending);

      // Send via Unix socket (newline-delimited JSON)
      const message = JSON.stringify(outboundCall) + '\n';

      const written = this.socket!.write(message, 'utf8', (error) => {
        if (error) {
          const pending = this.pending.get(outboundCall.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pending.signal?.removeEventListener('abort', pending.abortHandler!);
            this.pending.delete(outboundCall.requestId);
            reject(new TransportError(`Failed to write to socket: ${error.message}`, error));
          }
        }
      });

      // Unix sockets handle backpressure via TCP flow control
      // If write() returns false, 'drain' event will fire when ready
      if (!written) {
        this.socket!.once('drain', () => {
          // Socket ready for more data (TCP handled backpressure)
        });
      }
    });
  }

  private sendCancel(requestId: string): void {
    const cancel = {
      type: 'adapter:cancel',
      requestId,
      ...(this.config.authToken ? { context: { authToken: this.config.authToken } } : {}),
    };
    try { this.socket?.write(`${JSON.stringify(cancel)}\n`, 'utf8'); } catch { /* disconnected sockets abort server-side on close */ }
  }

  private releaseConnectionWaiter(cancelWhenIdle: boolean): void {
    this.connectionWaiters = Math.max(0, this.connectionWaiters - 1);
    if (cancelWhenIdle && this.connectionWaiters === 0) {
      this.connectionAbortController?.abort(new TransportError('Connection wait was cancelled'));
    }
  }

  /**
   * Handle incoming data from Unix socket.
   * Messages are newline-delimited JSON.
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString('utf8');

    // Process all complete messages (newline-delimited)
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim().length === 0) {
        continue;
      }

      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Ignore parse errors - corrupt message or incomplete fragment
      }
    }
  }

  private handleMessage(msg: unknown): void {
    // Ignore non-response messages
    if (!isAdapterResponse(msg)) {
      return;
    }

    // Find pending request
    const pending = this.pending.get(msg.requestId);
    if (!pending) {
      // Response for unknown request (may have timed out)
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.abortHandler!);
    this.pending.delete(msg.requestId);

    // Resolve with response
    pending.resolve(msg);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abortHandler!);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.connectionAbortController?.abort(new TransportError('Transport is closed'));

    // Close socket
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    // Reject all pending requests
    this.rejectPending(new TransportError('Transport closed'));
  }

  isClosed(): boolean {
    return this.closed;
  }

  sendMessage(msg: unknown): void {
    // Unix socket transport: serialize and write as a JSON line to the socket.
    // Push messages are not yet supported over Unix sockets; ignore silently.
    void msg;
  }

  onPushMessage(_handler: (msg: unknown) => void): () => void {
    // Push messages are not supported over Unix socket transport.
    return () => {};
  }
}

function waitForConnection(connection: Promise<void>, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  if (signal?.aborted) { return Promise.reject(createTransportAbortError(signal)); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
    };
    const finish = (error?: Error) => {
      if (settled) { return; }
      settled = true;
      cleanup();
      if (error) { reject(error); } else { resolve(); }
    };
    const abortHandler = () => finish(createTransportAbortError(signal));
    const timer = setTimeout(() => finish(new TimeoutError(`Adapter call timed out after ${timeoutMs}ms`, timeoutMs)), timeoutMs);
    signal?.addEventListener('abort', abortHandler, { once: true });
    connection.then(() => finish(), (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

function connectionAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) { return signal.reason; }
  const error = new Error('Unix socket connection attempt was aborted');
  error.name = 'AbortError';
  return error;
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) { return Promise.reject(connectionAbortError(signal)); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(connectionAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Create UnixSocketTransport with configuration.
 *
 * @example
 * ```typescript
 * import { createUnixSocketTransport } from '@kb-labs/core-runtime/transport';
 *
 * const transport = createUnixSocketTransport({
 *   socketPath: '/tmp/kb-ipc.sock',
 *   timeout: 60000,
 * });
 * ```
 */
export function createUnixSocketTransport(config?: UnixSocketConfig): UnixSocketTransport {
  return new UnixSocketTransport(config);
}
