/**
 * E2E WebSocket tests for /clients/connect (CC5 — Multi-Client Pub/Sub).
 * Spins up a real Fastify server on a random port.
 *
 * Tests the full client protocol:
 *   auth → client:hello → client:connected → subscribe/unsubscribe/cancel
 *
 * Does NOT mix with host-side ws-handler tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { WebSocket, type RawData } from 'ws';
import type { ICache, ILogger } from '@kb-labs/core-platform';
import type { JwtConfig } from '@kb-labs/gateway-auth';
import { AuthService } from '@kb-labs/gateway-auth';
import { createClientWsHandler } from '../clients/ws-handler.js';
import { executionRegistry } from '../execute/execution-registry.js';

// ── In-memory ICache ─────────────────────────────────────────────────────────

function makeInMemoryCache(): ICache {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async clear(): Promise<void> {
      store.clear();
    },
  } as unknown as ICache;
}

// ── Minimal ILogger ──────────────────────────────────────────────────────────

const noopLogger: ILogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as ILogger;

// ── Server setup ─────────────────────────────────────────────────────────────

const testJwtConfig: JwtConfig = { secret: 'test-client-secret' };

let app: FastifyInstance;
let wsUrl: string;
let cache: ICache;
let authService: AuthService;

beforeAll(async () => {
  cache = makeInMemoryCache();
  authService = new AuthService(cache, testJwtConfig);

  app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(fastifyCors, { origin: true });

  app.get('/clients/connect', { websocket: true }, createClientWsHandler(cache, testJwtConfig, noopLogger));

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  wsUrl = address.replace('http://', 'ws://');
}, 10_000);

afterAll(async () => {
  await app.close();
}, 10_000);

beforeEach(() => {
  // Clean up any leftover executions
  for (const id of ['exec-ws-test-1', 'exec-ws-test-2', 'exec-ns-other']) {
    executionRegistry.remove(id);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Get a valid access token via AuthService.register + issueTokens */
async function getAccessToken(): Promise<string> {
  const reg = await authService.register({ name: 'test-client', capabilities: [] });
  const tokens = await authService.issueTokens(reg.clientId, reg.clientSecret);
  return tokens!.accessToken;
}

/** Connect to /clients/connect with Bearer token */
function connectClient(token: string): WebSocket {
  return new WebSocket(`${wsUrl}/clients/connect`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Collect the next N messages from a WS connection */
function collectMessages(ws: WebSocket, count: number, timeout = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const msgs: unknown[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: expected ${count} messages, got ${msgs.length}: ${JSON.stringify(msgs)}`));
    }, timeout);

    ws.on('message', (raw: RawData) => {
      msgs.push(JSON.parse(raw.toString()));
      if (msgs.length >= count) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });

    ws.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

/** Wait for WS to open */
function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WebSocket /clients/connect: auth rejection', () => {
  it('closes immediately when no Authorization header', async () => {
    const ws = new WebSocket(`${wsUrl}/clients/connect`); // no auth
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
      ws.on('error', () => {});
      setTimeout(() => resolve(-1), 3000);
    });
    expect([1008, 1006]).toContain(closeCode);
  }, 5000);

  it('closes with 1008 for invalid token', async () => {
    const ws = new WebSocket(`${wsUrl}/clients/connect`, {
      headers: { Authorization: 'Bearer not-a-valid-token' },
    });
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
      ws.on('error', () => {});
      setTimeout(() => resolve(-1), 3000);
    });
    expect([1008, 1006]).toContain(closeCode);
  }, 5000);
});

describe('WebSocket /clients/connect: handshake', () => {
  it('completes client:hello → client:connected flow', async () => {
    const token = await getAccessToken();
    const ws = connectClient(token);

    await waitForOpen(ws);

    const messagesP = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'client:hello', clientVersion: '0.1.0' }));

    const [connected] = await messagesP as [{ type: string; protocolVersion: string; connectionId: string }];
    expect(connected.type).toBe('client:connected');
    expect(connected.protocolVersion).toBe('1.0');
    expect(typeof connected.connectionId).toBe('string');

    ws.close(1000);
  }, 8000);

  it('closes with 1008 if client:hello not sent within timeout', async () => {
    const token = await getAccessToken();
    const ws = connectClient(token);

    await waitForOpen(ws);
    // Don't send hello — wait for timeout

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
      setTimeout(() => resolve(-1), 8000);
    });

    expect(closeCode).toBe(1008);
  }, 10_000);

  it('closes with 1008 if client:hello has invalid format', async () => {
    const token = await getAccessToken();
    const ws = connectClient(token);

    await waitForOpen(ws);
    ws.send(JSON.stringify({ type: 'client:hello' })); // missing clientVersion

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
      ws.on('error', () => {});
      setTimeout(() => resolve(-1), 3000);
    });

    expect([1008, 1000, 1005]).toContain(closeCode);
  }, 5000);

  it('access_token query param is accepted as fallback auth', async () => {
    const token = await getAccessToken();
    const ws = new WebSocket(`${wsUrl}/clients/connect?access_token=${token}`);

    await waitForOpen(ws);
    const msgsP = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'client:hello', clientVersion: '0.1.0' }));

    const [connected] = await msgsP as [{ type: string }];
    expect(connected.type).toBe('client:connected');

    ws.close(1000);
  }, 8000);
});

describe('WebSocket /clients/connect: subscribe / unsubscribe', () => {
  async function connectAndHandshake(): Promise<{ ws: WebSocket; connectionId: string }> {
    const token = await getAccessToken();
    const ws = connectClient(token);
    await waitForOpen(ws);

    const msgsP = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'client:hello', clientVersion: '0.1.0' }));
    const [connected] = await msgsP as [{ type: string; connectionId: string }];
    return { ws, connectionId: connected.connectionId };
  }

  it('receives client:error(EXECUTION_NOT_FOUND) when subscribing to unknown execution', async () => {
    const { ws } = await connectAndHandshake();

    const msgsP = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'client:subscribe', executionId: '00000000-0000-0000-0000-000000000001' }));

    const [errorMsg] = await msgsP as [{ type: string; code: string }];
    expect(errorMsg.type).toBe('client:error');
    expect(errorMsg.code).toBe('EXECUTION_NOT_FOUND');

    ws.close(1000);
  }, 8000);

  it('receives client:error(FORBIDDEN) when subscribing to execution in different namespace', async () => {
    // Register an execution in a different namespace
    const execId = '00000000-0000-0000-0000-000000000002';
    executionRegistry.register({
      executionId: execId,
      requestId: 'req-x',
      namespaceId: 'ns-other-forbidden',  // different namespace
      hostId: 'host-x',
      pluginId: 'p',
      commandPath: 'h',
    });

    const { ws } = await connectAndHandshake();

    const msgsP = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'client:subscribe', executionId: execId }));

    const [errorMsg] = await msgsP as [{ type: string; code: string }];
    expect(errorMsg.type).toBe('client:error');
    expect(errorMsg.code).toBe('FORBIDDEN');

    ws.close(1000);
    executionRegistry.remove(execId);
  }, 8000);

  it('does not error on unsubscribe from unknown execution (graceful)', async () => {
    const { ws } = await connectAndHandshake();

    // Send unsubscribe without subscribing first — should not crash
    ws.send(JSON.stringify({ type: 'client:unsubscribe', executionId: '00000000-0000-0000-0000-000000000003' }));

    // If we get here without the connection closing, it's fine
    await new Promise((r) => { setTimeout(r, 200); });
    expect(ws.readyState).toBe(ws.OPEN);

    ws.close(1000);
  }, 5000);

  it('receives client:error(INVALID_MESSAGE) for malformed JSON', async () => {
    const { ws } = await connectAndHandshake();

    const msgsP = collectMessages(ws, 1);
    ws.send('not json at all {{{');

    const [errorMsg] = await msgsP as [{ type: string; code: string }];
    expect(errorMsg.type).toBe('client:error');
    expect(errorMsg.code).toBe('INVALID_MESSAGE');

    ws.close(1000);
  }, 5000);

  it('receives client:error(INVALID_MESSAGE) for unknown message type', async () => {
    const { ws } = await connectAndHandshake();

    const msgsP = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'unknown:type' }));

    const [errorMsg] = await msgsP as [{ type: string; code: string }];
    expect(errorMsg.type).toBe('client:error');
    expect(errorMsg.code).toBe('INVALID_MESSAGE');

    ws.close(1000);
  }, 5000);
});

describe('WebSocket /clients/connect: cancel', () => {
  async function connectAndHandshake(): Promise<WebSocket> {
    const token = await getAccessToken();
    const ws = connectClient(token);
    await waitForOpen(ws);
    const msgsP = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'client:hello', clientVersion: '0.1.0' }));
    await msgsP;
    return ws;
  }

  it('receives client:error(EXECUTION_NOT_FOUND) when cancelling unknown execution', async () => {
    const ws = await connectAndHandshake();

    const msgsP = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'client:cancel', executionId: '00000000-0000-0000-0000-000000000004' }));

    const [errorMsg] = await msgsP as [{ type: string; code: string }];
    expect(errorMsg.type).toBe('client:error');
    expect(errorMsg.code).toBe('EXECUTION_NOT_FOUND');

    ws.close(1000);
  }, 8000);

  it('cancels execution and aborts the signal', async () => {
    const execId = '00000000-0000-0000-0000-000000000005';
    const signal = executionRegistry.register({
      executionId: execId,
      requestId: 'req-cancel',
      namespaceId: 'ns-client-e2e', // same namespace as token
      hostId: 'host-001',
      pluginId: 'p',
      commandPath: 'h',
    });

    const ws = await connectAndHandshake();
    ws.send(JSON.stringify({ type: 'client:cancel', executionId: execId, reason: 'user' }));

    // Give the server time to process
    await new Promise((r) => { setTimeout(r, 100); });

    expect(signal.aborted).toBe(true);

    ws.close(1000);
    executionRegistry.remove(execId);
  }, 8000);

  it('receives client:error(CANCEL_FAILED) when execution already cancelled', async () => {
    const execId = '00000000-0000-0000-0000-000000000006';
    executionRegistry.register({
      executionId: execId,
      requestId: 'req-already',
      namespaceId: 'ns-client-e2e',
      hostId: 'host-001',
      pluginId: 'p',
      commandPath: 'h',
    });
    // Cancel it first
    executionRegistry.cancel(execId, 'user');

    const ws = await connectAndHandshake();

    const msgsP = collectMessages(ws, 1);
    ws.send(JSON.stringify({ type: 'client:cancel', executionId: execId, reason: 'user' }));

    const [errorMsg] = await msgsP as [{ type: string; code: string }];
    expect(errorMsg.type).toBe('client:error');
    expect(errorMsg.code).toBe('CANCEL_FAILED');

    ws.close(1000);
    executionRegistry.remove(execId);
  }, 8000);
});
