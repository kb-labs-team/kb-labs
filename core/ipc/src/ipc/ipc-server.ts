/**
 * @module @kb-labs/core-runtime/ipc
 * IPC server for handling adapter calls from child processes.
 *
 * The IPCServer runs in the parent process (CLI bin) and listens for
 * adapter method calls from child processes (sandbox workers).
 *
 * When a call arrives:
 * 1. Deserializes the arguments
 * 2. Executes the method on the real adapter (e.g., QdrantVectorStore)
 * 3. Serializes the result or error
 * 4. Sends response back to child
 *
 * @example
 * ```typescript
 * import { IPCServer } from '@kb-labs/core-runtime/ipc';
 * import { platform } from '@kb-labs/core-runtime';
 *
 * // In CLI bin after initPlatform()
 * const ipcServer = new IPCServer(platform);
 * ipcServer.start();
 *
 * // Server now handles all IPC adapter calls
 * ```
 */

import type { IPlatformAdapters } from '@kb-labs/core-platform';
import type { AdapterResponse, SerializableError } from '@kb-labs/core-platform/serializable';
import { isAdapterCall, isAdapterCancel, serialize, deserialize, IPC_PROTOCOL_VERSION } from '@kb-labs/core-platform/serializable';
import { resolveIPCAdapter } from './adapter-route.js';
import { attachLlmCallAbortSignal } from './llm-call-signal.js';

/**
 * IPC server for handling adapter calls from child processes.
 *
 * Responsibilities:
 * - Listen for adapter calls on process 'message' event
 * - Validate and route calls to correct adapter
 * - Execute methods with deserialized arguments
 * - Serialize and send responses back
 * - Handle errors gracefully
 */
export class IPCServer {
  private messageHandler: (msg: unknown, sendHandle: unknown) => void;
  private started = false;
  private activeLlmCalls = new Map<string, AbortController>();

  /**
   * Create an IPC server.
   *
   * @param platform - Platform container with real adapters
   */
  constructor(private readonly platform: IPlatformAdapters) {
    // Bind handler to preserve 'this' context
    this.messageHandler = this.handleMessage.bind(this);
  }

  /**
   * Start listening for IPC messages.
   *
   * Call this in the parent process (CLI bin) after initPlatform().
   * The server will handle all adapter calls from child processes.
   *
   * @throws Error if already started
   * @throws Error if not running in parent process with IPC
   */
  start(): void {
    if (this.started) {
      throw new Error('IPCServer already started');
    }

    // Check if we can listen for messages
    if (typeof process.on !== 'function') {
      throw new Error('IPCServer requires Node.js process object');
    }

    // Listen for messages from child processes
    process.on('message', this.messageHandler);
    this.started = true;

    this.platform.logger.debug('IPCServer started listening for adapter calls');
  }

  /**
   * Stop listening for IPC messages.
   *
   * Removes the message listener. Pending calls will not receive responses.
   */
  stop(): void {
    if (!this.started) {
      return;
    }

    process.off('message', this.messageHandler);
    this.started = false;
    for (const controller of this.activeLlmCalls.values()) { controller.abort(new Error('IPC server stopped')); }
    this.activeLlmCalls.clear();

    this.platform.logger.debug('IPCServer stopped listening for adapter calls');
  }

  /**
   * Handle incoming IPC message.
   *
   * Validates message format, executes adapter call, and sends response.
   */
  private async handleMessage(msg: unknown, sendHandle: unknown): Promise<void> {
    if (isAdapterCancel(msg)) {
      this.activeLlmCalls.get(msg.requestId)?.abort(new Error('LLM request cancelled by caller'));
      return;
    }
    // Ignore non-adapter-call messages
    if (!isAdapterCall(msg)) {
      return;
    }

    // Check protocol version compatibility
    if (msg.version !== IPC_PROTOCOL_VERSION) {
      this.platform.logger.warn('IPCServer: protocol version mismatch', {
        received: msg.version,
        expected: IPC_PROTOCOL_VERSION,
        adapter: msg.adapter,
        method: msg.method,
        note: 'Child process may be using outdated protocol. Consider rebuilding.',
      });
    }

    // Log context for debugging/tracing (if provided)
    if (msg.context) {
      this.platform.logger.debug('IPCServer: adapter call', {
        version: msg.version,
        traceId: msg.context.traceId,
        pluginId: msg.context.pluginId,
        sessionId: msg.context.sessionId,
        tenantId: msg.context.tenantId,
        adapter: msg.adapter,
        method: msg.method,
      });
    }

    let activeRequestId: string | undefined;
    try {
      // Get the adapter from platform
      const adapter = resolveIPCAdapter(this.platform, msg.adapter);

      // Get the method on the adapter
      const method = (adapter as Record<string, unknown>)[msg.method];

      if (typeof method !== 'function') {
        throw new Error(
          `Method '${msg.method}' not found on adapter '${msg.adapter}'. ` +
            `Available methods: ${Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).join(', ')}`
        );
      }

      // Deserialize arguments
      const args = msg.args.map((arg) => deserialize(arg));
      const controller = new AbortController();
      if (attachLlmCallAbortSignal(msg.adapter, msg.method, args, controller.signal)) {
        activeRequestId = msg.requestId;
        this.activeLlmCalls.set(msg.requestId, controller);
      }

      // Execute method on adapter
      const result = await method.apply(adapter, args);

      // Serialize and send successful response
      const response: AdapterResponse = {
        type: 'adapter:response',
        requestId: msg.requestId,
        result: serialize(result),
      };

      if (process.send) {
        process.send(response);
      }
    } catch (error) {
      // Serialize and send error response
      const response: AdapterResponse = {
        type: 'adapter:response',
        requestId: msg.requestId,
        error: serialize(error) as SerializableError,
      };

      if (process.send) {
        process.send(response);
      }

      // Log error for debugging
      this.platform.logger.error(
        'IPCServer: error handling adapter call',
        error instanceof Error ? error : new Error(String(error)),
        { adapter: msg.adapter, method: msg.method },
      );
    } finally {
      if (activeRequestId) { this.activeLlmCalls.delete(activeRequestId); }
    }
  }

  /**
   * Check if server is started.
   */
  isStarted(): boolean {
    return this.started;
  }
}

/**
 * Create and start an IPC server.
 *
 * Convenience function that creates the server and starts it immediately.
 *
 * @param platform - Platform container with real adapters
 * @returns Started IPC server instance
 *
 * @example
 * ```typescript
 * import { createIPCServer } from '@kb-labs/core-runtime/ipc';
 * import { platform } from '@kb-labs/core-runtime';
 *
 * const server = createIPCServer(platform);
 * // Server is now handling IPC calls
 * ```
 */
export function createIPCServer(platform: IPlatformAdapters): IPCServer {
  const server = new IPCServer(platform);
  server.start();
  return server;
}
