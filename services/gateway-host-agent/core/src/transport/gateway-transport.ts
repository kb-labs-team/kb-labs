/**
 * GatewayTransport — ITransport implementation over WebSocket via GatewayClient.
 *
 * Used by createProxyPlatform() to proxy platform service calls
 * (LLM, cache, vectorStore, etc.) from Workspace Agent back to Platform
 * through the Gateway WS connection.
 *
 * Flow:
 *   plugin → ctx.llm.complete() → LLMProxy → RemoteAdapter.callRemote()
 *     → GatewayTransport.send(AdapterCall) → GatewayClient.sendAdapterCall()
 *     → WS adapter:call → Gateway → REST API → platform.llm.complete()
 *     → adapter:response → GatewayTransport resolves → LLMProxy returns
 *
 * @see ADR-0051: Bidirectional Gateway Protocol
 */

import type { GatewayClient, AdapterCallResponse } from '../ws/gateway-client.js';

/** Adapter call structure (matches @kb-labs/core-platform/serializable AdapterCall) */
export interface AdapterCall {
  version?: string;
  type: 'adapter:call';
  requestId: string;
  adapter: string;
  method: string;
  args: unknown[];
  timeout?: number;
  context?: {
    traceId?: string;
    spanId?: string;
    pluginId?: string;
    tenantId?: string;
    executionId?: string;
    [key: string]: unknown;
  };
}

/** Adapter response structure (matches @kb-labs/core-platform/serializable AdapterResponse) */
export interface AdapterResponse {
  requestId: string;
  result?: unknown;
  error?: unknown;
}

/** ITransport interface (matches @kb-labs/core-runtime/transport) */
export interface ITransport {
  send(call: AdapterCall): Promise<AdapterResponse>;
  close(): Promise<void>;
  isClosed(): boolean;
}

/**
 * Transport implementation that proxies adapter calls through Gateway WS.
 *
 * Thin wrapper — all pending/timeout logic lives in GatewayClient.sendAdapterCall().
 */
export class GatewayTransport implements ITransport {
  private closed = false;

  constructor(
    private readonly client: GatewayClient,
    private readonly defaultContext: {
      namespaceId: string;
      hostId: string;
      workspaceId?: string;
    },
  ) {}

  async send(call: AdapterCall): Promise<AdapterResponse> {
    if (this.closed) {
      throw new Error('GatewayTransport is closed');
    }

    const response: AdapterCallResponse = await this.client.sendAdapterCall({
      adapter: call.adapter,
      method: call.method,
      args: call.args,
      timeout: call.timeout,
      context: {
        namespaceId: this.defaultContext.namespaceId,
        hostId: this.defaultContext.hostId,
        workspaceId: this.defaultContext.workspaceId,
        executionRequestId: call.context?.executionId,
      },
    });

    // Map GatewayClient response → ITransport AdapterResponse
    if (response.error) {
      return {
        requestId: response.requestId,
        error: response.error,
      };
    }

    return {
      requestId: response.requestId,
      result: response.result,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}
