import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GatewayClient } from '../ws/gateway-client.js';
import { EventEmitter } from 'node:events';
import { AdapterCredentialsMissingError, ErrorEnvelopeError, toErrorEnvelope } from '@kb-labs/core-platform';

/**
 * Mock WebSocket that simulates Gateway WS connection.
 * Extends EventEmitter so GatewayClient can attach handlers.
 */
class MockWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  /** Simulate receiving a message from Gateway */
  receive(msg: Record<string, unknown>): void {
    // Emit as string — matches ws 'message' event which gives Buffer/string
    this.emit('message', JSON.stringify(msg));
  }

  /** Simulate receiving raw string message */
  receiveRaw(data: string): void {
    this.emit('message', data);
  }

  /** Get last sent message as parsed JSON */
  lastSent(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]!);
  }
}

/**
 * Create a GatewayClient with a mock WS, already past handshake.
 * Manually wires up message listener since we skip doConnect().
 */
function createConnectedClient(): { client: GatewayClient; ws: MockWebSocket } {
  const ws = new MockWebSocket();

  const client = new GatewayClient({
    gatewayUrl: 'ws://localhost:4000',
    agentVersion: '0.1.0',
    getAccessToken: () => 'test-token',
    capabilities: ['filesystem', 'execution'],
  });

  // Inject mock WS and mark as connected
  (client as any).ws = ws;
  (client as any).hostId = 'test-host-id';
  (client as any).stopped = false;

  // Wire up the message handler (normally done in doConnect → ws.on('message'))
  ws.on('message', (data: string) => (client as any).onMessage(data));
  // Wire up close handler
  ws.on('close', () => (client as any).onClose());

  return { client, ws };
}

describe('GatewayClient.sendAdapterCall', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends adapter:call message and resolves on adapter:response', async () => {
    const { client, ws } = createConnectedClient();

    const promise = client.sendAdapterCall({
      adapter: 'llm',
      method: 'complete',
      args: [{ prompt: 'hello' }],
      context: { namespaceId: 'default', hostId: 'test-host' },
    });

    // Client should have sent an adapter:call message
    expect(ws.sent.length).toBe(1);
    const sent = ws.lastSent();
    expect(sent.type).toBe('adapter:call');
    expect(sent.adapter).toBe('llm');
    expect(sent.method).toBe('complete');
    expect(sent.args).toEqual([{ prompt: 'hello' }]);
    expect(typeof sent.requestId).toBe('string');

    // Simulate Gateway response
    ws.receive({
      type: 'adapter:response',
      requestId: sent.requestId,
      result: { text: 'world' },
    });

    const response = await promise;
    expect(response.result).toEqual({ text: 'world' });
    expect(response.error).toBeUndefined();

    client.stop();
  });

  it('resolves with error on adapter:error', async () => {
    const { client, ws } = createConnectedClient();

    const promise = client.sendAdapterCall({
      adapter: 'llm',
      method: 'complete',
      args: [],
      context: { namespaceId: 'default', hostId: 'test-host' },
    });

    const sent = ws.lastSent();

    ws.receive({
      type: 'adapter:error',
      requestId: sent.requestId,
      error: { code: 'ADAPTER_ERROR', message: 'LLM unavailable', retryable: true },
    });

    const response = await promise;
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe('ADAPTER_ERROR');
    expect(response.error!.message).toBe('LLM unavailable');

    client.stop();
  });

  it('rejects on timeout', async () => {
    const { client } = createConnectedClient();

    const promise = client.sendAdapterCall({
      adapter: 'cache',
      method: 'get',
      args: ['key'],
      timeout: 5000,
      context: { namespaceId: 'default', hostId: 'test-host' },
    });

    // Attach catch to avoid unhandled rejection during timer advance
    const caught = promise.catch((err: Error) => err);

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(5001);

    const error = await caught;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out/i);

    client.stop();
  });

  it('rejects when WS is not connected', async () => {
    const { client, ws } = createConnectedClient();
    ws.readyState = 3; // CLOSED

    await expect(
      client.sendAdapterCall({
        adapter: 'llm',
        method: 'complete',
        args: [],
        context: { namespaceId: 'default', hostId: 'test-host' },
      }),
    ).rejects.toThrow(/not connected/i);

    client.stop();
  });

  it('rejects all pending on disconnect', async () => {
    const { client, ws } = createConnectedClient();

    const p1 = client.sendAdapterCall({
      adapter: 'llm',
      method: 'complete',
      args: [1],
      context: { namespaceId: 'default', hostId: 'test-host' },
    });

    const p2 = client.sendAdapterCall({
      adapter: 'cache',
      method: 'get',
      args: [2],
      context: { namespaceId: 'default', hostId: 'test-host' },
    });

    // Simulate disconnect
    (client as any).stopped = true; // prevent reconnect
    ws.emit('close');

    await expect(p1).rejects.toThrow(/disconnect/i);
    await expect(p2).rejects.toThrow(/disconnect/i);

    client.stop();
  });

  it('matches responses by requestId (concurrent calls)', async () => {
    const { client, ws } = createConnectedClient();

    const p1 = client.sendAdapterCall({
      adapter: 'llm',
      method: 'complete',
      args: ['first'],
      context: { namespaceId: 'default', hostId: 'test-host' },
    });

    const p2 = client.sendAdapterCall({
      adapter: 'cache',
      method: 'get',
      args: ['second'],
      context: { namespaceId: 'default', hostId: 'test-host' },
    });

    // Two messages sent
    expect(ws.sent.length).toBe(2);
    const req1 = JSON.parse(ws.sent[0]!);
    const req2 = JSON.parse(ws.sent[1]!);

    // Respond in reverse order
    ws.receive({ type: 'adapter:response', requestId: req2.requestId, result: 'second-result' });
    ws.receive({ type: 'adapter:response', requestId: req1.requestId, result: 'first-result' });

    const r1 = await p1;
    const r2 = await p2;

    expect(r1.result).toBe('first-result');
    expect(r2.result).toBe('second-result');

    client.stop();
  });
});

describe('GatewayClient capability handler errors', () => {
  it('transports a plain handler exception so the execution boundary owns normalisation', async () => {
    const { client, ws } = createConnectedClient();
    const requestId = 'host-call-correlation';
    client.registerHandler('llm', async () => { throw new Error('adapter failed'); });
    await (client as unknown as { handleCall(call: { requestId: string; adapter: string }): Promise<void> })
      .handleCall({ requestId, adapter: 'llm' });

    const response = ws.lastSent();
    expect(response).toMatchObject({
      type: 'error', requestId,
      error: { __type: 'Error', name: 'Error', message: 'adapter failed', stack: expect.any(String) },
    });
    expect(JSON.stringify(response)).not.toContain('HANDLER_ERROR');
    client.stop();
  });

  it('preserves a typed platform envelope across the reverse host path', async () => {
    const { client, ws } = createConnectedClient();
    const failure = toErrorEnvelope(new AdapterCredentialsMissingError('llm', 'OPENAI_API_KEY', 'platform.adapters.llm.apiKey'), {
      correlationId: 'host-call-correlation',
    });
    client.registerHandler('llm', async () => { throw new ErrorEnvelopeError(failure); });
    await (client as unknown as { handleCall(call: { requestId: string; adapter: string }): Promise<void> })
      .handleCall({ requestId: 'host-call-correlation', adapter: 'llm' });

    expect(ws.lastSent()).toMatchObject({ type: 'error', error: failure });
    client.stop();
  });
});
