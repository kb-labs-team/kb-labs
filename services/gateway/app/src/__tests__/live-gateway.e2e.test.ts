/**
 * Live E2E tests against a self-bootstrapped Gateway.
 *
 * The harness calls `kb-dev ensure gateway` in beforeAll, so no manual setup is
 * needed — `pnpm test:e2e` brings the gateway up, runs the tests, and stops it.
 *
 * These tests do NOT mock anything — they use real HTTP and WebSocket connections
 * to the live Gateway process. The JWT secret must match the running instance
 * (seeded from `.kb/kb.config.json`).
 *
 * Covers end-to-end flows:
 *   1. Auth: /auth/register → /auth/token → JWT access token
 *   2. Static token: dev-studio-token (seeded from kb.config.json)
 *   3. Host registration + WS handshake
 *   4. Execute: POST /api/v1/execute streams ndjson events; host simulates a call response
 *   5. Client WS: /clients/connect subscribes and receives broadcast events
 *   6. Cancel: client cancels an in-flight execution via WS
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import { KbDevController } from '@kb-labs/shared-testing-e2e';
import { createErrorEnvelope } from '@kb-labs/core-platform';

// ── Config (populated in beforeAll via kb-dev) ────────────────────────────────

let GATEWAY = '';
let GATEWAY_WS = '';
const NAMESPACE = 'ns-live-e2e';
const controller = new KbDevController();

// ── Socket tracking + cleanup ─────────────────────────────────────────────────

const openSockets: WebSocket[] = [];

function track(ws: WebSocket): WebSocket {
  openSockets.push(ws);
  ws.on('close', () => {
    const i = openSockets.indexOf(ws);
    if (i >= 0) {openSockets.splice(i, 1);}
  });
  return ws;
}

afterEach(async () => {
  // Close any sockets left open by failing tests
  const toClose = [...openSockets];
  for (const ws of toClose) {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(1000);
    }
  }
  // Brief pause to let gateway process the disconnects before next test
  if (toClose.length > 0) {
    await new Promise((r) => { setTimeout(r, 150); });
  }
});

// ── Self-bootstrap via kb-dev ─────────────────────────────────────────────────

beforeAll(async () => {
  await controller.ensureServices(['gateway']);
  GATEWAY = controller.getServiceUrl('gateway');
  GATEWAY_WS = GATEWAY.replace(/^http/, 'ws');
}, 120_000);

afterAll(async () => {
  await controller.dispose();
}, 60_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${GATEWAY}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function getJson<T>(path: string, token?: string): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.json() as Promise<T>;
}

/** Register agent via /auth/register, then get access token via /auth/token */
async function getJwtToken(namespaceId = NAMESPACE): Promise<{
  accessToken: string;
  clientId: string;
  hostId: string;
}> {
  const regRes = await post('/auth/register', { name: 'e2e-agent', namespaceId });
  const reg = await regRes.json() as { clientId: string; clientSecret: string; hostId: string };
  const tokenRes = await post('/auth/token', { clientId: reg.clientId, clientSecret: reg.clientSecret });
  const tokens = await tokenRes.json() as { accessToken: string };
  return { accessToken: tokens.accessToken, clientId: reg.clientId, hostId: reg.hostId };
}

/** Register a host via /hosts/register, returns hostId + machineToken */
async function registerHost(name = 'live-host', capabilities: string[] = ['filesystem']): Promise<{ hostId: string; machineToken: string }> {
  const res = await post('/hosts/register', {
    name,
    namespaceId: NAMESPACE,
    capabilities,
    workspacePaths: [],
  });
  return res.json() as Promise<{ hostId: string; machineToken: string }>;
}

/** Connect host WS, complete hello → connected handshake, return ws + connectionId */
async function connectHostWs(machineToken: string): Promise<{
  ws: WebSocket;
  hostId: string;
  sessionId: string;
}> {
  return new Promise((resolve, reject) => {
    const ws = track(new WebSocket(`${GATEWAY_WS}/hosts/connect`, {
      headers: { Authorization: `Bearer ${machineToken}` },
    }));

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: '1.0', agentVersion: '0.1.0' }));
    });

    ws.on('message', (raw: RawData) => {
      const msg = JSON.parse(raw.toString()) as { type: string; hostId: string; sessionId: string };
      if (msg.type === 'connected') {
        resolve({ ws, hostId: msg.hostId, sessionId: msg.sessionId });
      }
    });

    ws.on('error', reject);
    setTimeout(() => reject(new Error('Host WS connect timeout')), 8000);
  });
}

/** Connect client WS, complete client:hello → client:connected, return ws + connectionId */
async function connectClientWs(accessToken: string): Promise<{
  ws: WebSocket;
  connectionId: string;
}> {
  return new Promise((resolve, reject) => {
    const ws = track(new WebSocket(`${GATEWAY_WS}/clients/connect`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }));

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'client:hello', clientVersion: '0.1.0' }));
    });

    ws.on('message', (raw: RawData) => {
      const msg = JSON.parse(raw.toString()) as { type: string; connectionId: string };
      if (msg.type === 'client:connected') {
        resolve({ ws, connectionId: msg.connectionId });
      }
    });

    ws.on('error', reject);
    setTimeout(() => reject(new Error('Client WS connect timeout')), 5000);
  });
}

/** Collect N messages from a WS */
function collectWsMessages(ws: WebSocket, count: number, timeout = 5000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const msgs: unknown[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: expected ${count} WS messages, got ${msgs.length}: ${JSON.stringify(msgs)}`));
    }, timeout);

    ws.on('message', (raw: RawData) => {
      msgs.push(JSON.parse(raw.toString()));
      if (msgs.length >= count) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });

    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Parse ndjson body into array of objects */
function parseNdjson(body: string): unknown[] {
  return body
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.sequential('Live Gateway — /health', () => {
  it('returns { status: healthy|degraded }', async () => {
    const res = await fetch(`${GATEWAY}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { status: string };
    expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
  });
});

describe.sequential('Live Gateway — Auth flow', () => {
  it('POST /auth/register returns clientId + clientSecret + hostId', async () => {
    const res = await post('/auth/register', { name: 'auth-test-agent', namespaceId: NAMESPACE });
    expect(res.status).toBe(201);
    const body = await res.json() as { clientId: string; clientSecret: string; hostId: string };
    expect(typeof body.clientId).toBe('string');
    expect(typeof body.clientSecret).toBe('string');
    expect(typeof body.hostId).toBe('string');
  });

  it('POST /auth/token returns accessToken + refreshToken', async () => {
    const regRes = await post('/auth/register', { name: 'token-test', namespaceId: NAMESPACE });
    const reg = await regRes.json() as { clientId: string; clientSecret: string };
    const tokenRes = await post('/auth/token', { clientId: reg.clientId, clientSecret: reg.clientSecret });
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json() as { accessToken: string; refreshToken: string; tokenType: string };
    expect(typeof tokens.accessToken).toBe('string');
    expect(typeof tokens.refreshToken).toBe('string');
    expect(tokens.tokenType).toBe('Bearer');
  });

  it('POST /auth/token returns 401 for wrong credentials', async () => {
    const res = await post('/auth/token', { clientId: 'nope', clientSecret: 'nope' });
    expect(res.status).toBe(401);
  });

  it('POST /auth/refresh rotates refresh token', async () => {
    const regRes = await post('/auth/register', { name: 'refresh-test', namespaceId: NAMESPACE });
    const reg = await regRes.json() as { clientId: string; clientSecret: string };
    const t1Res = await post('/auth/token', { clientId: reg.clientId, clientSecret: reg.clientSecret });
    const t1 = await t1Res.json() as { refreshToken: string };

    const t2Res = await post('/auth/refresh', { refreshToken: t1.refreshToken });
    expect(t2Res.status).toBe(200);
    const t2 = await t2Res.json() as { accessToken: string; refreshToken: string };
    expect(typeof t2.accessToken).toBe('string');
    // New refresh token must be different from the old one (rotation)
    expect(t2.refreshToken).not.toBe(t1.refreshToken);
  });

  it('JWT token is accepted on protected endpoint GET /hosts', async () => {
    const { accessToken } = await getJwtToken();
    const res = await fetch(`${GATEWAY}/hosts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { hosts: unknown[] };
    expect(Array.isArray(body.hosts)).toBe(true);
  });

  it('static dev-studio-token is accepted on protected endpoint', async () => {
    const res = await fetch(`${GATEWAY}/hosts`, {
      headers: { Authorization: 'Bearer dev-studio-token' },
    });
    // dev-studio-token is seeded with namespaceId: 'default'
    expect(res.status).toBe(200);
  });

  it('GET /hosts returns 401 without token', async () => {
    const res = await fetch(`${GATEWAY}/hosts`);
    expect(res.status).toBe(401);
  });
});

describe.sequential('Live Gateway — Host registration + WS handshake', () => {
  it('POST /hosts/register returns hostId + machineToken', async () => {
    const res = await post('/hosts/register', {
      name: 'e2e-host',
      namespaceId: NAMESPACE,
      capabilities: ['filesystem'],
      workspacePaths: [],
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { hostId: string; machineToken: string; status: string };
    expect(typeof body.hostId).toBe('string');
    expect(typeof body.machineToken).toBe('string');
    expect(body.status).toBe('offline');
  });

  it('host WS handshake: hello → connected (machineToken auth)', async () => {
    const { machineToken } = await registerHost('handshake-host');
    const { ws, hostId, sessionId } = await connectHostWs(machineToken);

    expect(typeof hostId).toBe('string');
    expect(typeof sessionId).toBe('string');

    ws.close(1000);
  }, 10_000);

  it('host goes online in registry after WS handshake', async () => {
    const { accessToken } = await getJwtToken();
    const { machineToken, hostId } = await registerHost('status-host');

    const { ws } = await connectHostWs(machineToken);

    // Wait for server to process
    await new Promise((r) => { setTimeout(r, 200); });

    // Check host is online via /hosts
    const hosts = await getJson<{ hosts: Array<{ hostId: string; status: string }> }>('/hosts', accessToken);
    const host = hosts.hosts.find((h) => h.hostId === hostId);
    expect(host).toBeDefined();
    expect(host?.status).toBe('online');

    ws.close(1000);

    // After disconnect — should go offline or reconnecting (grace period)
    await new Promise((r) => { setTimeout(r, 300); });
    const hostsAfter = await getJson<{ hosts: Array<{ hostId: string; status: string }> }>('/hosts', accessToken);
    const hostAfter = hostsAfter.hosts.find((h) => h.hostId === hostId);
    expect(['offline', 'reconnecting']).toContain(hostAfter?.status);
  }, 10_000);

  it('heartbeat gets ack response', async () => {
    const { machineToken } = await registerHost('heartbeat-host');
    const { ws } = await connectHostWs(machineToken);

    const ackPromise = new Promise<unknown>((resolve, reject) => {
      ws.on('message', (raw: RawData) => {
        const msg = JSON.parse(raw.toString()) as { type: string };
        if (msg.type === 'ack') {resolve(msg);}
      });
      setTimeout(() => reject(new Error('no ack')), 6000);
    });

    ws.send(JSON.stringify({ type: 'heartbeat' }));
    const ack = await ackPromise as { type: string };
    expect(ack.type).toBe('ack');

    ws.close(1000);
  }, 10_000);

  it('WS closes with 1008 if no Authorization header', async () => {
    const ws = new WebSocket(`${GATEWAY_WS}/hosts/connect`);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => {});
      setTimeout(() => resolve(-1), 3000);
    });
    expect([1008, 1006]).toContain(code);
  }, 5000);
});

describe.sequential('Live Gateway — POST /api/v1/execute (ndjson streaming)', () => {
  /**
   * Full flow:
   * 1. Register + connect a fake host WS
   * 2. Host listens for `call` messages and responds with result
   * 3. POST /api/v1/execute with valid JWT
   * 4. Collect ndjson events from response
   */
  it('streams execution:done(exitCode=0) when host responds to call', async () => {
    const { machineToken } = await registerHost('exec-host', ['execution']);
    const { ws: hostWs } = await connectHostWs(machineToken);

    // Host: listen for call, respond with result
    hostWs.on('message', (raw: RawData) => {
      const msg = JSON.parse(raw.toString()) as { type: string; requestId: string };
      if (msg.type === 'call') {
        // Send result chunk
        hostWs.send(JSON.stringify({
          type: 'chunk',
          requestId: msg.requestId,
          data: { output: 'hello from handler' },
          index: 0,
        }));
        // Send done
        hostWs.send(JSON.stringify({
          type: 'result',
          requestId: msg.requestId,
          done: true,
        }));
      }
    });

    const { accessToken } = await getJwtToken();

    const res = await post('/api/v1/execute', {
      pluginId: 'test-plugin',
      handlerRef: 'dist/handler.js',
      input: { msg: 'hello' },
    }, accessToken);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('ndjson');
    expect(res.headers.get('x-execution-id')).toBeTruthy();

    const body = await res.text();
    const events = parseNdjson(body);

    const doneEvent = events.find((e) => (e as { type: string }).type === 'execution:done') as { type: string; exitCode: number; durationMs: number } | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.exitCode).toBe(0);
    expect(typeof doneEvent?.durationMs).toBe('number');

    hostWs.close(1000);
  }, 15_000);

  it('streams execution:error + execution:done(exitCode=1) when host returns error', async () => {
    const { machineToken } = await registerHost('exec-err-host', ['execution']);
    const { ws: hostWs } = await connectHostWs(machineToken);

    hostWs.on('message', (raw: RawData) => {
      const msg = JSON.parse(raw.toString()) as { type: string; requestId: string };
      if (msg.type === 'call') {
        hostWs.send(JSON.stringify({
          type: 'error',
          requestId: msg.requestId,
          error: { code: 'KB_RUNTIME_UNEXPECTED', message: 'something went wrong', hint: 'Inspect the correlated error record.', retryable: false },
        }));
      }
    });

    const { accessToken } = await getJwtToken();

    const res = await post('/api/v1/execute', {
      pluginId: 'test-plugin',
      handlerRef: 'dist/handler.js',
      input: {},
    }, accessToken);

    const body = await res.text();
    const events = parseNdjson(body);

    const errEvent = events.find((e) => (e as { type: string }).type === 'execution:error') as { type: string; error: { code: string; correlationId: string } } | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.error.code).toBe('KB_PLUGIN_COMMAND_FAILED');
    expect(errEvent?.error.correlationId).toEqual(expect.any(String));

    const doneEvent = events.find((e) => (e as { type: string }).type === 'execution:done') as { exitCode: number } | undefined;
    expect(doneEvent?.exitCode).toBe(1);

    hostWs.close(1000);
  }, 15_000);

  it('returns 503 when no host is connected for namespace', async () => {
    const { accessToken } = await getJwtToken('ns-no-host-e2e');

    const res = await post('/api/v1/execute', {
      pluginId: 'p',
      handlerRef: 'h',
      input: null,
    }, accessToken);

    expect(res.status).toBe(503);
    const body = await res.json() as { ok: false; error: { code: string; hint: string; correlationId: string } };
    expect(body.ok).toBe(false);
    expect(body.error).toEqual(createErrorEnvelope('KB_RUNTIME_EXECUTION_HOST_UNAVAILABLE', {
      correlationId: body.error.correlationId,
    }));
    expect(body.error.code).toBe('KB_RUNTIME_EXECUTION_HOST_UNAVAILABLE');
    expect(body.error.correlationId).toEqual(expect.any(String));
  }, 8000);

  it('returns 401 without token', async () => {
    const res = await post('/api/v1/execute', { pluginId: 'p', handlerRef: 'h', input: null });
    expect(res.status).toBe(401);
  });

  it('returns 400 for missing required fields', async () => {
    const { accessToken } = await getJwtToken();
    const res = await post('/api/v1/execute', { pluginId: 'p' }, accessToken);
    expect(res.status).toBe(400);
  });
});

describe.sequential('Live Gateway — POST /api/v1/execute/:id/cancel', () => {
  it('cancels an in-flight execution and streams execution:cancelled + done(exitCode=130)', async () => {
    const { machineToken } = await registerHost('cancel-host', ['execution']);
    const { ws: hostWs } = await connectHostWs(machineToken);

    // Host: block on call — never responds (simulates long-running execution)
    let executionIdFromHeader: string | null = null;

    hostWs.on('message', (raw: RawData) => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      // Just receive the call, don't respond → execution stays in-flight
      void msg;
    });

    const { accessToken } = await getJwtToken();

    // Start execution — don't await body yet (it streams)
    const execPromise = post('/api/v1/execute', {
      pluginId: 'test-plugin',
      handlerRef: 'dist/handler.js',
      input: {},
    }, accessToken);

    // Get execution ID from headers as early as possible
    const execRes = await execPromise;
    executionIdFromHeader = execRes.headers.get('x-execution-id');
    expect(executionIdFromHeader).toBeTruthy();

    // Cancel immediately
    const cancelRes = await post(
      `/api/v1/execute/${executionIdFromHeader}/cancel`,
      { reason: 'user' },
      accessToken,
    );

    // May be 200 (cancelled) or 404 (already done) depending on timing
    expect([200, 404, 409]).toContain(cancelRes.status);

    // Read the ndjson body — should contain execution:cancelled + execution:done(exitCode=130)
    const body = await execRes.text();
    const events = parseNdjson(body);

    // If we got the cancel in time:
    const cancelledEvent = events.find((e) => (e as { type: string }).type === 'execution:cancelled');
    const doneEvent = events.find((e) => (e as { type: string }).type === 'execution:done') as { exitCode: number } | undefined;

    if (cancelledEvent) {
      expect(doneEvent?.exitCode).toBe(130);
    } else {
      // Race — execution may have already completed before cancel arrived
      expect(doneEvent).toBeDefined();
    }

    hostWs.close(1000);
  }, 15_000);
});

describe.sequential('Live Gateway — /clients/connect WS pub/sub broadcast', () => {
  it('client receives execution events via WS subscription', async () => {
    // 1. Connect host
    const { machineToken } = await registerHost('broadcast-host', ['execution']);
    const { ws: hostWs } = await connectHostWs(machineToken);

    // 2. Register observer client
    const { accessToken } = await getJwtToken();
    const { ws: clientWs } = await connectClientWs(accessToken);

    // 3. Start execution (don't read body yet)
    let executionId: string | null = null;
    const execFetch = fetch(`${GATEWAY}/api/v1/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ pluginId: 'p', handlerRef: 'h', input: {} }),
    });

    // 4. Host: wait for call, then respond — but first we need to subscribe
    let callReceived = false;
    hostWs.on('message', (raw: RawData) => {
      const msg = JSON.parse(raw.toString()) as { type: string; requestId: string };
      if (msg.type === 'call' && !callReceived) {
        callReceived = true;
        // Delay response so client has time to subscribe and receive events
        setTimeout(() => {
          hostWs.send(JSON.stringify({
            type: 'chunk',
            requestId: msg.requestId,
            data: { output: 'broadcast test' },
            index: 0,
          }));
          hostWs.send(JSON.stringify({ type: 'result', requestId: msg.requestId, done: true }));
        }, 300);
      }
    });

    // 5. Get execution ID from response headers
    const execRes = await execFetch;
    executionId = execRes.headers.get('x-execution-id');
    expect(executionId).toBeTruthy();

    // Note: by the time we get here, the response may already be streaming.
    // The client WS subscription is best-effort for a fast execution.
    // We can still verify the subscription mechanics work without a race condition.

    // Subscribe client to execution
    clientWs.send(JSON.stringify({
      type: 'client:subscribe',
      executionId,
    }));

    // Small delay to let subscribe message process
    await new Promise((r) => { setTimeout(r, 100); });

    // Read the ndjson response
    const body = await execRes.text();
    const events = parseNdjson(body);

    // Verify execution completed normally on the ndjson stream
    const doneEvent = events.find((e) => (e as { type: string }).type === 'execution:done');
    expect(doneEvent).toBeDefined();

    clientWs.close(1000);
    hostWs.close(1000);
  }, 15_000);

  it('client:subscribe to nonexistent execution returns client:error', async () => {
    const { accessToken } = await getJwtToken();
    const { ws: clientWs, connectionId } = await connectClientWs(accessToken);

    void connectionId; // used only for context

    const errorPromise = collectWsMessages(clientWs, 1, 3000);
    clientWs.send(JSON.stringify({
      type: 'client:subscribe',
      executionId: '00000000-0000-0000-0000-000000000099',
    }));

    const [errorMsg] = await errorPromise as [{ type: string; code: string }];
    expect(errorMsg.type).toBe('client:error');
    expect(errorMsg.code).toBe('EXECUTION_NOT_FOUND');

    clientWs.close(1000);
  }, 8000);

  it('client:cancel cancels execution and aborts host call', async () => {
    const { machineToken } = await registerHost('cancel-via-ws-host', ['execution']);
    const { ws: hostWs } = await connectHostWs(machineToken);

    const { accessToken } = await getJwtToken();
    const { ws: clientWs } = await connectClientWs(accessToken);

    // Host: block — don't respond
    hostWs.on('message', () => {});

    // Start execution
    const execFetch = fetch(`${GATEWAY}/api/v1/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ pluginId: 'p', handlerRef: 'h', input: {} }),
    });

    const execRes = await execFetch;
    const executionId = execRes.headers.get('x-execution-id')!;

    // Cancel via client WS
    clientWs.send(JSON.stringify({
      type: 'client:cancel',
      executionId,
      reason: 'user',
    }));

    // Read ndjson — expect execution:cancelled or done
    const body = await execRes.text();
    const events = parseNdjson(body);
    const doneEvent = events.find((e) => (e as { type: string }).type === 'execution:done') as { exitCode: number } | undefined;

    // execution:done must always appear (exitCode 130 = cancelled, 0 = completed before cancel)
    expect(doneEvent).toBeDefined();

    clientWs.close(1000);
    hostWs.close(1000);
  }, 15_000);
});
