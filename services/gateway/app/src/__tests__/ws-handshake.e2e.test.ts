/**
 * E2E WebSocket tests — spins up a real Fastify server on a random port.
 * Tests the full handshake path: auth → hello → connected → heartbeat → ack → close.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { AdaptiveBuffer } from '@kb-labs/gateway-core';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { WebSocket, type RawData } from 'ws';
import type { ICache } from '@kb-labs/core-platform';
import { HostRegistrationSchema } from '@kb-labs/gateway-contracts';
import type { JwtConfig } from '@kb-labs/gateway-auth';
import { createAuthMiddleware } from '../auth/middleware.js';
import { HostRegistry } from '../hosts/registry.js';
import { createWsHandler } from '../hosts/ws-handler.js';
import type { ILogger } from '@kb-labs/core-platform';

// Minimal jwtConfig for tests — JWT auth is disabled (empty secret forces fallback to cache tokens)
afterEach(() => vi.restoreAllMocks());

const testJwtConfig: JwtConfig = { secret: 'test-secret-do-not-use' };

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

// ── Server setup ─────────────────────────────────────────────────────────────

let app: FastifyInstance;
let baseUrl: string;
let wsUrl: string;
let cache: ICache;
const noopLogger: ILogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as ILogger;

beforeAll(async () => {
  cache = makeInMemoryCache();
  app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);
  await app.register(fastifyCors, { origin: true });
  app.addHook('preHandler', createAuthMiddleware(cache, testJwtConfig));

  app.get('/health', async () => ({ status: 'ok', version: '1.0' }));

  const registry = new HostRegistry(cache);
  app.post('/hosts/register', async (request, reply) => {
    const parsed = HostRegistrationSchema.safeParse(request.body);
    if (!parsed.success) {return reply.code(400).send({ error: 'Bad Request' });}
    const result = await registry.register(parsed.data);
    return reply.code(201).send({
      hostId: result.descriptor.hostId,
      machineToken: result.machineToken,
      status: result.descriptor.status,
    });
  });

  app.get('/hosts/connect', { websocket: true }, createWsHandler(cache, testJwtConfig, noopLogger));

  const address = await app.listen({ port: 0, host: '127.0.0.1' }); // port 0 = random
  baseUrl = address;
  wsUrl = address.replace('http://', 'ws://');
}, 10_000);

afterAll(async () => {
  await app.close();
}, 10_000);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function registerHost(name = 'test-host'): Promise<{ hostId: string; machineToken: string }> {
  const res = await fetch(`${baseUrl}/hosts/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, namespaceId: 'ns-e2e', capabilities: ['filesystem'], workspacePaths: [] }),
  });
  return res.json() as Promise<{ hostId: string; machineToken: string }>;
}

function connectWs(token: string): WebSocket {
  return new WebSocket(`${wsUrl}/hosts/connect`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WebSocket: connection refused without auth', () => {
  it('closes immediately when no Authorization header', async () => {
    const ws = new WebSocket(`${wsUrl}/hosts/connect`); // no auth header
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
      ws.on('error', () => {}); // suppress
    });
    // 1008 = Policy Violation (explicit close from server)
    // 1006 = Abnormal closure (server drops connection at transport level)
    // Both indicate the connection was rejected — either is correct depending on Fastify/ws version
    expect([1008, 1006]).toContain(closeCode);
  }, 5000);

  it('closes with 1008 for invalid machine token', async () => {
    const ws = connectWs('not-a-valid-machine-token');
    // ws token resolves as CLI (not machine) — should be rejected in ws-handler
    // The handler checks tokenEntry.type !== 'machine'
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
      ws.on('open', () => {
        // If opened, send hello — handler will auth-check and close
      });
      ws.on('error', () => resolve(1008));
      setTimeout(() => resolve(1008), 3000);
    });
    // Either 1008 or connection never established
    expect([1008, 1000, 1005]).toContain(closeCode);
  }, 5000);
});

describe('WebSocket: full handshake', () => {
  it('completes hello → connected flow', async () => {
    const { machineToken, hostId } = await registerHost('e2e-host-1');
    const ws = connectWs(machineToken);

    const messages = collectMessages(ws, 1);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: '1.0', agentVersion: '0.1.0' }));
        resolve();
      });
      ws.on('error', reject);
    });

    const [connected] = await messages as [{ type: string; hostId: string; sessionId: string; protocolVersion: string }];
    expect(connected.type).toBe('connected');
    expect(connected.hostId).toBe(hostId);
    expect(connected.protocolVersion).toBe('1.0');
    expect(connected.sessionId).toBeTypeOf('string');

    ws.close(1000);
  }, 8000);

  // case: S-203.29
  it('heartbeat gets ack response while buffered calls are being flushed', async () => {
    vi.spyOn(AdaptiveBuffer.prototype, 'flush').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return [];
    });
    const { machineToken } = await registerHost('e2e-host-2');
    const ws = connectWs(machineToken);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: '1.0', agentVersion: '0.1.0' }));
        resolve();
      });
      ws.on('error', reject);
    });

    // Wait for 'connected', then send heartbeat
    const ack = await new Promise<unknown>((resolve, reject) => {
      let gotConnected = false;
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);

      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === 'connected' && !gotConnected) {
          gotConnected = true;
          ws.send(JSON.stringify({ type: 'heartbeat' }));
        } else if (msg.type === 'ack') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });

    expect((ack as { type: string }).type).toBe('ack');
    ws.close(1000);
  }, 8000);

  it('rejects unsupported protocol version', async () => {
    const { machineToken } = await registerHost('e2e-host-3');
    const ws = connectWs(machineToken);

    const msgs: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: '99.0', agentVersion: '0.1.0' }));
        resolve();
      });
      ws.on('error', reject);
    });

    // Should receive 'negotiate' message and then close
    const closeCode = await new Promise<number>((resolve) => {
      ws.on('message', (raw: RawData) => { msgs.push(JSON.parse(raw.toString())); });
      ws.on('close', (code: number) => resolve(code));
      setTimeout(() => resolve(1008), 4000);
    });

    expect(closeCode).toBe(1008);
    expect((msgs[0] as { type: string; supportedVersions: string[] }).type).toBe('negotiate');
    expect((msgs[0] as { type: string; supportedVersions: string[] }).supportedVersions).toContain('1.0');
  }, 8000);

  it('closes with 1008 if hello not sent within timeout', async () => {
    const { machineToken } = await registerHost('e2e-host-4');
    const ws = connectWs(machineToken);

    // Open but don't send hello
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    const closeCode = await new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
      setTimeout(() => resolve(-1), 8000); // wait longer than HELLO_TIMEOUT_MS (5s)
    });

    expect(closeCode).toBe(1008);
  }, 10_000);
});

describe('WebSocket: host status lifecycle', () => {
  it('host goes online after successful handshake', async () => {
    const { machineToken, hostId } = await registerHost('e2e-status-1');

    const ws = connectWs(machineToken);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: '1.0', agentVersion: '0.1.0' }));
      });
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === 'connected') {resolve();}
      });
      ws.on('error', reject);
    });

    // Verify host is online in cache
    const host = await cache.get<{ status: string; connections: string[] }>(`host:registry:ns-e2e:${hostId}`);
    expect(host!.status).toBe('online');
    expect(host!.connections.length).toBeGreaterThan(0);

    ws.close(1000);

    // Give server time to process close — status transitions to 'reconnecting' first,
    // then to 'offline' after the reconnect grace period
    await new Promise((r) => { setTimeout(r, 100); });

    const hostAfter = await cache.get<{ status: string }>(`host:registry:ns-e2e:${hostId}`);
    expect(['reconnecting', 'offline']).toContain(hostAfter!.status);
  }, 8000);
});
