import { describe, it, expect, vi } from 'vitest';
import { GatewayTransport } from '../transport/gateway-transport.js';
import type { GatewayClient, AdapterCallResponse } from '../ws/gateway-client.js';
import { createErrorEnvelope } from '@kb-labs/core-platform';

function createMockClient(responseOrError?: AdapterCallResponse | Error): GatewayClient {
  return {
    sendAdapterCall: vi.fn().mockImplementation(async () => {
      if (responseOrError instanceof Error) { throw responseOrError; }
      return responseOrError ?? { requestId: 'test-id', result: 'ok' };
    }),
  } as unknown as GatewayClient;
}

describe('GatewayTransport', () => {
  it('sends AdapterCall through GatewayClient and returns response', async () => {
    const client = createMockClient({ requestId: 'r1', result: { answer: 42 } });
    const transport = new GatewayTransport(client, {
      namespaceId: 'default',
      hostId: 'host-1',
    });

    const response = await transport.send({
      type: 'adapter:call',
      requestId: 'ignored', // GatewayTransport generates its own
      adapter: 'llm',
      method: 'complete',
      args: [{ prompt: 'test' }],
    });

    expect(response.result).toEqual({ answer: 42 });
    expect((client.sendAdapterCall as any).mock.calls[0][0]).toMatchObject({
      adapter: 'llm',
      method: 'complete',
      context: { namespaceId: 'default', hostId: 'host-1' },
    });
  });

  it('maps error response correctly', async () => {
    const client = createMockClient({
      requestId: 'r2',
      error: createErrorEnvelope('KB_ADAPTER_OPERATION_FAILED', {
        correlationId: 'r2',
        details: { operation: 'get', slot: 'cache' },
        message: 'Adapter call failed.',
        hint: 'Check the adapter configuration and try again.',
      }),
    });
    const transport = new GatewayTransport(client, {
      namespaceId: 'default',
      hostId: 'host-1',
    });

    const response = await transport.send({
      type: 'adapter:call',
      requestId: 'x',
      adapter: 'cache',
      method: 'get',
      args: ['key'],
    });

    expect(response.error).toBeDefined();
    expect(response.error).toMatchObject({
      code: 'KB_ADAPTER_OPERATION_FAILED',
      correlationId: 'r2',
      hint: 'Check the adapter configuration and try again.',
    });
  });

  it('throws when closed', async () => {
    const client = createMockClient();
    const transport = new GatewayTransport(client, {
      namespaceId: 'default',
      hostId: 'host-1',
    });

    await transport.close();
    expect(transport.isClosed()).toBe(true);

    await expect(
      transport.send({
        type: 'adapter:call',
        requestId: 'x',
        adapter: 'llm',
        method: 'complete',
        args: [],
      }),
    ).rejects.toThrow(/closed/i);
  });

  it('propagates workspaceId from default context', async () => {
    const client = createMockClient();
    const transport = new GatewayTransport(client, {
      namespaceId: 'ns-1',
      hostId: 'host-1',
      workspaceId: 'ws-123',
    });

    await transport.send({
      type: 'adapter:call',
      requestId: 'x',
      adapter: 'storage',
      method: 'read',
      args: ['path'],
    });

    const callArg = (client.sendAdapterCall as any).mock.calls[0][0];
    expect(callArg.context.workspaceId).toBe('ws-123');
    expect(callArg.context.namespaceId).toBe('ns-1');
  });

  it('propagates timeout from AdapterCall', async () => {
    const client = createMockClient();
    const transport = new GatewayTransport(client, {
      namespaceId: 'default',
      hostId: 'host-1',
    });

    await transport.send({
      type: 'adapter:call',
      requestId: 'x',
      adapter: 'llm',
      method: 'complete',
      args: [],
      timeout: 60000,
    });

    const callArg = (client.sendAdapterCall as any).mock.calls[0][0];
    expect(callArg.timeout).toBe(60000);
  });
});
