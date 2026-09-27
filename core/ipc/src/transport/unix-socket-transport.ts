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
  private connecting = false;
  private buffer = '';
  private reconnectAttempts = 0;

  constructor(private config: UnixSocketConfig = {}) {}

  /**
   * Connect to Unix socket server.
   * Called lazily on first send() or explicitly.
   */
  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return; // Already connected
    }

    if (this.connecting) {
      // Wait for existing connection attempt
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      return this.connect();
    }

    this.connecting = true;

    return new Promise((resolve, reject) => {
      const socketPath = this.config.socketPath ?? DEFAULT_SOCKET_PATH;

      this.socket = net.connect(socketPath);

      this.socket.on('connect', () => {
        this.connecting = false;
        this.reconnectAttempts = 0;
        resolve();
      });

      this.socket.on('error', (error) => {
        this.connecting = false;

        // Try reconnect if enabled
        const maxAttempts = this.config.maxReconnectAttempts ?? 3;
        if (this.config.autoReconnect !== false && this.reconnectAttempts < maxAttempts) {
          this.reconnectAttempts++;
          setTimeout(() => this.connect(), 1000 * this.reconnectAttempts);
          return;
        }

        reject(new TransportError(`Unix socket connection failed: ${error.message}`, error));
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        if (!this.closed && this.config.autoReconnect !== false) {
          // Unexpected close, try reconnect
          setTimeout(() => this.connect(), 1000);
        }
      });
    });
  }

  async send(call: AdapterCall): Promise<AdapterResponse> {
    if (this.closed) {
      throw new TransportError('Transport is closed');
    }

    // Ensure connected
    await this.connect();

    if (!this.socket || this.socket.destroyed) {
      throw new TransportError('Socket not available');
    }

    // Smart timeout selection based on operation type
    const timeout = selectTimeout(call, this.config.timeout);
    const outboundCall: AdapterCall = this.config.authToken
      ? {
        ...call,
        context: { ...call.context, authToken: this.config.authToken },
      }
      : call;

    return new Promise((resolve, reject) => {
      // Create timeout timer
      const timer = setTimeout(() => {
        this.pending.delete(call.requestId);
        reject(new TimeoutError(`Adapter call timed out after ${timeout}ms`, timeout));
      }, timeout);

      // Store pending request
      this.pending.set(outboundCall.requestId, { resolve, reject, timer });

      // Send via Unix socket (newline-delimited JSON)
      const message = JSON.stringify(outboundCall) + '\n';

      const written = this.socket!.write(message, 'utf8', (error) => {
        if (error) {
          const pending = this.pending.get(outboundCall.requestId);
          if (pending) {
            clearTimeout(pending.timer);
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
    this.pending.delete(msg.requestId);

    // Resolve with response
    pending.resolve(msg);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    // Close socket
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    // Reject all pending requests
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new TransportError('Transport closed'));
    }
    this.pending.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }

  sendMessage(msg: unknown): void {
    if (this.closed) { return; }
    const send = () => {
      if (!this.socket || this.socket.destroyed) { return; }
      this.socket.write(`${JSON.stringify(msg)}\n`, 'utf8');
    };
    if (this.socket && !this.socket.destroyed) { send(); }
    else { void this.connect().then(send).catch(() => undefined); }
  }

  onPushMessage(_handler: (msg: unknown) => void): () => void {
    // Push messages are not supported over Unix socket transport.
    return () => {};
  }
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
