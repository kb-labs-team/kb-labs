/**
 * @module @kb-labs/core-runtime/ipc
 * Unix Socket server for handling adapter calls from child processes.
 *
 * This server runs in the parent process (CLI bin) and listens for
 * adapter method calls from child processes (sandbox workers) via Unix sockets.
 *
 * Unix sockets provide 100-1000x better performance than process.send()
 * for large messages (>16KB), making them ideal for bulk operations.
 *
 * @example
 * ```typescript
 * import { UnixSocketServer } from '@kb-labs/core-runtime/ipc';
 * import { platform } from '@kb-labs/core-runtime';
 *
 * // In CLI bin after initPlatform()
 * const server = new UnixSocketServer(platform);
 * await server.start();
 *
 * // Server now handles all Unix socket adapter calls
 * ```
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import type { IPlatformAdapters } from '@kb-labs/core-platform';
import type { AdapterCall, AdapterResponse, SerializableError } from '@kb-labs/core-platform/serializable';
import { serialize, deserialize, IPC_PROTOCOL_VERSION } from '@kb-labs/core-platform/serializable';
import { BulkTransferHelper } from '../transport/bulk-transfer';
import { DEFAULT_SOCKET_PATH } from '../socket-path';
import { resolveIPCAdapter } from './adapter-route.js';

export interface UnixSocketServerConfig {
  /** Path to Unix socket file (default: /tmp/kb-ipc.sock) */
  socketPath?: string;
  /** Optional auth token; when set, every adapter call must include matching context.authToken */
  authToken?: string;
}

/**
 * Unix Socket server for parent process.
 *
 * Responsibilities:
 * - Listen for adapter calls via Unix socket
 * - Validate and route calls to correct adapter
 * - Execute methods with deserialized arguments
 * - Serialize and send responses back
 * - Handle errors gracefully
 */
export class UnixSocketServer {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private readonly inFlight = new Map<net.Socket, Map<string, AbortController>>();
  private socketPath: string;
  private authToken?: string;
  private started = false;

  /**
   * Create a Unix Socket server.
   *
   * @param platform - Platform container with real adapters
   * @param config - Server configuration
   */
  constructor(
    private readonly platform: IPlatformAdapters,
    config: UnixSocketServerConfig = {}
  ) {
    this.socketPath = config.socketPath ?? DEFAULT_SOCKET_PATH;
    this.authToken = config.authToken;
  }

  /**
   * Get the socket path.
   * Used by parent process to pass to child processes via env var.
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Start listening for connections.
   */
  async start(): Promise<void> {
    BulkTransferHelper.registerSignalHandlers();

    // Remove existing socket file if exists
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleClient(socket);
      });

      this.server.on('error', (error) => {
        reject(error);
      });

      this.server.listen(this.socketPath, () => {
        // Set socket permissions (readable/writable by all)
        fs.chmodSync(this.socketPath, 0o666);
        this.started = true;
        this.platform.logger.debug('UnixSocketServer started listening for adapter calls');
        resolve();
      });
    });
  }

  /**
   * Handle new client connection.
   */
  private handleClient(socket: net.Socket): void {
    this.clients.add(socket);

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString('utf8');

      // Process all complete messages (newline-delimited)
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim().length === 0) {
          continue;
        }

        try {
          const message: unknown = JSON.parse(line);
          if (isAdapterCancel(message)) {
            this.handleCancel(socket, message);
          } else {
            this.handleCall(socket, message as AdapterCall);
          }
        } catch (error) {
          this.platform.logger.warn('UnixSocketServer: failed to parse message', { error });
        }
      }
    });

    socket.on('close', () => {
      for (const controller of this.inFlight.get(socket)?.values() ?? []) { controller.abort(); }
      this.inFlight.delete(socket);
      this.clients.delete(socket);
    });

    socket.on('error', (error) => {
      this.platform.logger.warn('UnixSocketServer: client socket error', { error });
      for (const controller of this.inFlight.get(socket)?.values() ?? []) { controller.abort(); }
      this.inFlight.delete(socket);
      this.clients.delete(socket);
    });
  }

  /**
   * Handle adapter call from client.
   */
  private async handleCall(socket: net.Socket, call: AdapterCall): Promise<void> {
    const callAuthToken = (call.context as { authToken?: string } | undefined)?.authToken;
    if (this.authToken && callAuthToken !== this.authToken) {
      const response: AdapterResponse = {
        type: 'adapter:response',
        requestId: call.requestId,
        error: toSerializableError(new Error('Unauthorized IPC call: invalid auth token')),
      };
      socket.write(JSON.stringify(response) + '\n', 'utf8');
      return;
    }

    const controller = new AbortController();
    const socketRequests = this.inFlight.get(socket) ?? new Map<string, AbortController>();
    this.inFlight.set(socket, socketRequests);
    socketRequests.set(call.requestId, controller);

    // Check protocol version compatibility
    if (call.version !== IPC_PROTOCOL_VERSION) {
      this.platform.logger.warn('UnixSocketServer: protocol version mismatch', {
        received: call.version,
        expected: IPC_PROTOCOL_VERSION,
        adapter: call.adapter,
        method: call.method,
        note: 'Child process may be using outdated protocol. Consider rebuilding.',
      });
    }

    // Log context for debugging/tracing (if provided)
    if (call.context) {
      this.platform.logger.debug('UnixSocketServer: adapter call', {
        version: call.version,
        traceId: call.context.traceId,
        pluginId: call.context.pluginId,
        sessionId: call.context.sessionId,
        tenantId: call.context.tenantId,
        adapter: call.adapter,
        method: call.method,
      });
    }

    try {
      // Get the adapter from platform
      const adapter = resolveIPCAdapter(this.platform, call.adapter);

      // Get the method on the adapter
      if (adapter === null || (typeof adapter !== 'object' && typeof adapter !== 'function')) {
        throw new Error(`Adapter '${call.adapter}' is not callable`);
      }

      const method = Reflect.get(adapter, call.method);

      if (typeof method !== 'function') {
        throw new Error(
          `Method '${call.method}' not found on adapter '${call.adapter}'. ` +
            `Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).join(', ')}`
        );
      }

      // Deserialize arguments (handle BulkTransfer)
      const args = await Promise.all(
        call.args.map(async (arg) => {
          const deserialized = deserialize(arg);
          if (BulkTransferHelper.isBulkTransfer(deserialized)) {
            return BulkTransferHelper.deserialize(deserialized);
          }
          return deserialized;
        })
      );

      if (call.adapter === 'llm' && (call.method === 'complete' || call.method === 'chatWithTools')) {
        const options = args[1];
        args[1] = {
          ...(options && typeof options === 'object' ? options as Record<string, unknown> : {}),
          signal: controller.signal,
        };
      }

      // Execute method on adapter
      const result = await method.apply(adapter, args);

      // Serialize result (handle BulkTransfer)
      let serializedResult;
      if (result !== undefined && result !== null && typeof result === 'object') {
        // For large results, use BulkTransfer
        const resultJson = JSON.stringify(result);
        if (resultJson.length > 1_000_000) {
          const transfer = await BulkTransferHelper.serialize(result, {
            maxInlineSize: 1_000_000,
            tempDir: process.env.KB_TEMP_DIR ?? os.tmpdir(),
          });
          serializedResult = serialize(transfer);
        } else {
          serializedResult = serialize(result);
        }
      } else {
        serializedResult = serialize(result);
      }

      // Send successful response
      const response: AdapterResponse = {
        type: 'adapter:response',
        requestId: call.requestId,
        result: serializedResult,
      };

      const message = JSON.stringify(response) + '\n';
      socket.write(message, 'utf8');
    } catch (error) {
      // Serialize and send error response
      const response: AdapterResponse = {
        type: 'adapter:response',
        requestId: call.requestId,
        error: toSerializableError(error),
      };

      const message = JSON.stringify(response) + '\n';
      socket.write(message, 'utf8');

      // Log error for debugging
      const cause = error instanceof Error ? error.message : String(error);
      this.platform.logger.error(
        `UnixSocketServer: ${call.adapter}.${call.method} failed — ${cause}`,
        error instanceof Error ? error : new Error(String(error)),
        { adapter: call.adapter, method: call.method },
      );
    } finally {
      socketRequests.delete(call.requestId);
      if (socketRequests.size === 0) { this.inFlight.delete(socket); }
    }
  }

  private handleCancel(socket: net.Socket, message: AdapterCancel): void {
    const token = message.context?.authToken;
    if (this.authToken && token !== this.authToken) { return; }
    this.inFlight.get(socket)?.get(message.requestId)?.abort();
  }

  /**
   * Stop server and close all connections.
   */
  async close(): Promise<void> {
    if (!this.started) {
      return;
    }

    // Close all client connections
    for (const client of this.clients) {
      for (const controller of this.inFlight.get(client)?.values() ?? []) { controller.abort(); }
      client.destroy();
    }
    this.inFlight.clear();
    this.clients.clear();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          resolve();
        });
      });
      this.server = null;
    }

    // Remove socket file
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    this.started = false;
    this.platform.logger.debug('UnixSocketServer stopped listening for adapter calls');
  }

  /**
   * Check if server is started.
   */
  isStarted(): boolean {
    return this.started;
  }
}

interface AdapterCancel {
  type: 'adapter:cancel';
  requestId: string;
  context?: { authToken?: string };
}

function isAdapterCancel(message: unknown): message is AdapterCancel {
  return typeof message === 'object' && message !== null
    && 'type' in message && message.type === 'adapter:cancel'
    && 'requestId' in message && typeof message.requestId === 'string';
}

function toSerializableError(error: unknown): SerializableError {
  const serialized = serialize(error);
  if (
    serialized &&
    typeof serialized === 'object' &&
    '__type' in serialized &&
    serialized.__type === 'Error'
  ) {
    return serialized as SerializableError;
  }

  const fallback = error instanceof Error ? error : new Error(String(error));
  return {
    __type: 'Error',
    name: fallback.name,
    message: fallback.message,
    stack: fallback.stack,
  };
}

/**
 * Create and start a Unix Socket server.
 *
 * Convenience function that creates the server and starts it immediately.
 *
 * @param platform - Platform container with real adapters
 * @param config - Server configuration
 * @returns Started Unix Socket server instance
 *
 * @example
 * ```typescript
 * import { createUnixSocketServer } from '@kb-labs/core-runtime/ipc';
 * import { platform } from '@kb-labs/core-runtime';
 *
 * const server = await createUnixSocketServer(platform);
 * // Server is now handling Unix socket calls
 * ```
 */
export async function createUnixSocketServer(
  platform: IPlatformAdapters,
  config?: UnixSocketServerConfig
): Promise<UnixSocketServer> {
  const server = new UnixSocketServer(platform, config);
  await server.start();
  return server;
}
