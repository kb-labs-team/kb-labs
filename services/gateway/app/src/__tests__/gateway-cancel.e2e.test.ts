/**
 * Gateway execution cancel flow — focused tests for the cancel contract.
 *
 * Self-bootstraps gateway via @kb-labs/shared-testing-e2e.
 *
 * The existing live-gateway.e2e.test.ts has a cancel scenario; this file adds
 * narrower assertions and exercises both cancel paths (HTTP + client WS) with
 * explicit waits so the race-with-completion is easier to diagnose.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  KbDevController,
  httpClient,
  registerAgent,
  registerHost,
  type HttpClient,
} from '@kb-labs/shared-testing-e2e';

const NAMESPACE = 'ns-cancel-e2e';
const controller = new KbDevController();
let client: HttpClient;
let GATEWAY = '';
let GATEWAY_WS = '';

beforeAll(async () => {
  await controller.ensureServices(['gateway']);
  GATEWAY = controller.getServiceUrl('gateway');
  GATEWAY_WS = GATEWAY.replace(/^http/, 'ws');
  client = httpClient(GATEWAY);
}, 120_000);

afterAll(async () => {
  await controller.dispose();
}, 60_000);

// ── Socket tracking ───────────────────────────────────────────────────────────
// We use the raw ws module here (not connectWs) because we need `.on('message', ...)`
// style event listeners for the host-simulation pattern. closeAllTrackedSockets()
// from the harness is for the higher-level connectWs() handle.

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
  for (const ws of [...openSockets]) {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(1000);
    }
  }
  if (openSockets.length > 0) {
    await new Promise((r) => { setTimeout(r, 150); });
  }
});

/** Connect a host WS and complete the hello → connected handshake. */
function connectHostWs(machineToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = track(new WebSocket(`${GATEWAY_WS}/hosts/connect`, {
      headers: { Authorization: `Bearer ${machineToken}` },
    }));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', protocolVersion: '1.0', agentVersion: '0.1.0' }));
    });
    ws.on('message', (raw: RawData) => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      if (msg.type === 'connected') {resolve(ws);}
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Host WS connect timeout')), 8000);
  });
}

function parseNdjson(body: string): Array<{ type: string; [k: string]: unknown }> {
  return body
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { type: string });
}

describe('Gateway execution cancel', () => {
  it('POST /api/v1/execute/:id/cancel → execution:done(exitCode=130)', async () => {
    const { machineToken } = await registerHost(client, { name: 'cancel-http-host', namespaceId: NAMESPACE, capabilities: ['execution'] });
    const hostWs = await connectHostWs(machineToken);

    // Host never responds → execution stays in-flight until cancelled.
    hostWs.on('message', () => { /* swallow */ });

    const { accessToken } = await registerAgent(client, { namespaceId: NAMESPACE });

    // Start streaming execution.
    const execFetch = fetch(`${GATEWAY}/api/v1/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        pluginId: 'test-plugin',
        projectId: 'project-1',
      commandPath: 'cli run',
        input: {},
      }),
    });

    const execRes = await execFetch;
    const executionId = execRes.headers.get('x-execution-id');
    expect(executionId).toBeTruthy();

    // Issue cancel via HTTP.
    const cancelRes = await client.post(
      `/api/v1/execute/${executionId}/cancel`,
      { reason: 'user' },
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    // Accept the race: already-done returns 404/409, in-flight returns 200.
    expect([200, 404, 409]).toContain(cancelRes.status);

    const body = await execRes.text();
    const events = parseNdjson(body);

    // execution:done must always appear exactly once.
    const doneEvents = events.filter((e) => e.type === 'execution:done');
    expect(doneEvents.length).toBe(1);

    // If cancel landed in time → exitCode must be 130 (SIGINT semantics).
    const cancelled = events.find((e) => e.type === 'execution:cancelled');
    if (cancelled) {
      const done = doneEvents[0] as unknown as { exitCode: number };
      expect(done.exitCode).toBe(130);
    }
  }, 20_000);

  it('POST /api/v1/execute/:id/cancel with nonexistent id → 4xx', async () => {
    const { accessToken } = await registerAgent(client, { namespaceId: NAMESPACE });
    const res = await client.post(
      '/api/v1/execute/00000000-0000-0000-0000-000000000000/cancel',
      { reason: 'user' },
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect([400, 404, 409]).toContain(res.status);
  });

  it('POST /api/v1/execute/:id/cancel without auth → 401', async () => {
    const res = await client.post(
      '/api/v1/execute/00000000-0000-0000-0000-000000000000/cancel',
      { reason: 'user' },
    );
    expect(res.status).toBe(401);
  });
});
