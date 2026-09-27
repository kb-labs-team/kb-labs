/**
 * @module @kb-labs/core-ipc/proxy
 * Generic base class for remote adapter proxies.
 *
 * This class provides the foundation for all IPC proxy adapters.
 * It handles serialization, transport, and error propagation automatically.
 *
 * @example
 * ```typescript
 * import { RemoteAdapter } from '@kb-labs/core-ipc/proxy';
 * import type { IVectorStore } from '@kb-labs/core-platform';
 *
 * class VectorStoreProxy extends RemoteAdapter<IVectorStore> implements IVectorStore {
 *   constructor(transport: ITransport) {
 *     super('vectorStore', transport);
 *   }
 *
 *   async search(query: number[], limit: number): Promise<VectorSearchResult[]> {
 *     return this.callRemote('search', [query, limit]) as Promise<VectorSearchResult[]>;
 *   }
 * }
 * ```
 */

import { randomUUID } from 'crypto';
import type { ITransport } from '../transport/transport';
import type { AdapterCall, AdapterType, AdapterCallContext } from '@kb-labs/core-platform/serializable';
import { serialize, deserialize, IPC_PROTOCOL_VERSION } from '@kb-labs/core-platform/serializable';
import { BulkTransferHelper } from '../transport/bulk-transfer';

/**
 * Generic base class for remote adapter proxies.
 *
 * Automatically handles:
 * - Method call serialization
 * - Transport communication
 * - Response deserialization
 * - Error propagation
 * - Context propagation (traceId, pluginId, etc.)
 *
 * Type parameter T should be the adapter interface (e.g., IVectorStore).
 */
export abstract class RemoteAdapter<T, TOperation extends string = string> {
  private context?: AdapterCallContext;

  /**
   * Create a remote adapter proxy.
   *
   * @param adapterName - Name of the adapter (e.g., 'vectorStore', 'cache')
   * @param transport - Transport layer for IPC communication
   * @param context - Optional execution context for tracing/debugging
   */
  constructor(
    private readonly adapterName: AdapterType,
    private readonly transport: ITransport,
    context?: AdapterCallContext
  ) {
    this.context = context;
  }

  /**
   * Set execution context for this adapter.
   * Context is included in all subsequent adapter calls for tracing/debugging.
   *
   * @param context - Execution context (traceId, pluginId, sessionId, etc.)
   *
   * @example
   * ```typescript
   * proxy.setContext({
   *   traceId: 'trace-abc',
   *   pluginId: '@kb-labs/mind',
   *   sessionId: 'session-xyz',
   * });
   * ```
   */
  setContext(context: AdapterCallContext): void {
    this.context = context;
  }

  /**
   * Get current execution context.
   */
  getContext(): AdapterCallContext | undefined {
    return this.context;
  }

  /**
   * Call a method on the remote adapter (in parent process).
   *
   * This method:
   * 1. Generates a unique request ID
   * 2. Serializes the method arguments
   * 3. Sends the call via transport
   * 4. Waits for response
   * 5. Deserializes and returns the result (or throws error)
   *
   * @param method - Method name to call on the adapter
   * @param args - Method arguments (will be serialized)
   * @param timeout - Optional timeout in milliseconds (overrides transport default)
   * @returns Promise resolving to deserialized result
   * @throws Error if remote method throws or communication fails
   *
   * @example
   * ```typescript
   * // In VectorStoreProxy.search():
   * return this.callRemote('search', [query, limit, filter]);
   *
   * // With custom timeout for bulk operations:
   * return this.callRemote('upsert', [vectors], 120000); // 2 min timeout
   * ```
   */
  protected async callRemote(method: TOperation, args: unknown[], timeout?: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Adapter call aborted');
    }
    // Generate unique request ID
    const requestId = randomUUID();

    // Create adapter call message with context (if available)
    const call: AdapterCall = {
      version: IPC_PROTOCOL_VERSION, // Protocol version for backward compatibility
      type: 'adapter:call',
      requestId,
      adapter: this.adapterName,
      method,
      args: args.map((arg) => serialize(arg)),
      timeout, // Optional timeout for this specific call
      context: this.context, // Include execution context for tracing/debugging
    };

    const onAbort = () => this.transport.sendMessage({ type: 'adapter:cancel', requestId });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // Cancellation is a separate control message so the host can abort the
      // real adapter request while this transport call waits for its response.
      const response = await this.transport.send(call);

      if (response.error) {
        throw deserialize(response.error);
      }

      if (response.result === undefined) {
        return undefined;
      }
      const result = deserialize(response.result);
      // Server sends large results via BulkTransfer (temp file) to avoid IPC size limits.
      if (BulkTransferHelper.isBulkTransfer(result)) {
        return BulkTransferHelper.deserialize(result);
      }
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Get the adapter name this proxy represents.
   */
  protected getAdapterName(): AdapterType {
    return this.adapterName;
  }

  /**
   * Get the transport used by this proxy.
   * Useful for advanced use cases (e.g., checking if transport is closed).
   */
  protected getTransport(): ITransport {
    return this.transport;
  }
}
