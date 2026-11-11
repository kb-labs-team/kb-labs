import { test, expect, type APIRequestContext } from '@playwright/test';
import { withWs, expectWsMessage, expectWsClose } from '@kb-labs/shared-testing-e2e';
import { GATEWAY, WORKFLOW } from '@kb-labs/e2e-shared/urls.js';
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js';
import { projectWorkflowRoute } from '@kb-labs/workflow-contracts/routes';

const GATEWAY_WS = GATEWAY.replace(/^http/, 'ws');
const projectId = process.env.KB_PROJECT_ID;

async function startRun(request: APIRequestContext): Promise<string> {
  const catalogRes = await request.get(`${WORKFLOW}/api/v1/workflows`);
  const catalog = await catalogRes.json();
  const workflows: Array<{ id?: string; name?: string }> =
    catalog.data?.workflows ?? catalog.data ?? catalog.workflows ?? [];
  const wf = workflows.find((w) => (w.name ?? w.id) === 'e2e-hello') ?? workflows[0];
  const id = wf?.id ?? wf?.name;
  if (!id) throw new Error('No workflow found in catalog');

  const runRes = await request.post(`${WORKFLOW}/api/v1/workflows/${encodeURIComponent(id)}/runs`, { data: {} });
  const body = await runRes.json();
  const runId: string = body.data?.runId ?? body.data?.id ?? body.runId;
  if (!runId) throw new Error(`Failed to start run: ${JSON.stringify(body)}`);
  return runId;
}

function logsWsUrl(jobId: string): string {
  return `${GATEWAY_WS}${projectWorkflowRoute(projectId!, `ws/logs/${encodeURIComponent(jobId)}`)}`;
}

// WS upgrade requests go through the gateway like any other route since the
// GHSA-75rf-rhxh-2p52 fix — a valid token is required here too.
async function authHeaders(request: APIRequestContext) {
  const token = await getAccessToken(request);
  return { headers: { Authorization: `Bearer ${token}` } };
}

test('WS-L01: subscribe → receive log stream', async ({ request }) => {
  expect(projectId, 'KB_PROJECT_ID must identify the registered workflow project').toBeTruthy();
  const runId = await startRun(request);

  await withWs(logsWsUrl(runId), async (ws) => {
    ws.send({ type: 'subscribe', jobId: runId, level: 'info' });

    // Should receive at least one log message
    const msg = await expectWsMessage<{ type: string; payload?: { level?: string; message?: string } }>(
      ws,
      (m) => m.type === 'log',
      { timeoutMs: 15_000, label: 'first log message' },
    );

    expect(msg.type).toBe('log');
    expect(msg.payload?.level).toBeTruthy();
  }, await authHeaders(request));
});

test('WS-L02: level filter — warn level excludes debug/info messages', async ({ request }) => {
  expect(projectId, 'KB_PROJECT_ID must identify the registered workflow project').toBeTruthy();
  const runId = await startRun(request);

  await withWs(logsWsUrl(runId), async (ws) => {
    ws.send({ type: 'subscribe', jobId: runId, level: 'warn' });

    // Collect a few messages with short timeout (may receive none if no warn/error logs)
    const messages = await ws.collect<{ type: string; payload?: { level?: string } }>(3, 5_000).catch(() => []);

    // All received log messages must be warn or error level
    const logMessages = messages.filter((m) => m.type === 'log');
    for (const msg of logMessages) {
      expect(['warn', 'error']).toContain(msg.payload?.level);
    }
  }, await authHeaders(request));
});

test('WS-L03: unknown runId — server sends a classified error, does not hang', async ({ request }) => {
  expect(projectId, 'KB_PROJECT_ID must identify the registered workflow project').toBeTruthy();
  await withWs(logsWsUrl('nonexistent-job-xyz'), async (ws) => {
    ws.send({ type: 'subscribe', jobId: 'nonexistent-job-xyz' });

    const msg = await expectWsMessage<{ type: string; payload?: { error?: string; code?: string } }>(
      ws,
      (m) => m.type === 'error',
      { timeoutMs: 5_000, label: 'error message for unknown job' },
    );

    expect(msg.type).toBe('error');
    expect(msg.payload?.error).toBeTruthy();
    expect(msg.payload?.code).toBe('NOT_FOUND');
  }, await authHeaders(request));
});

test('WS-L04: unsubscribe stops the log stream', async ({ request }) => {
  expect(projectId, 'KB_PROJECT_ID must identify the registered workflow project').toBeTruthy();
  const runId = await startRun(request);

  await withWs(logsWsUrl(runId), async (ws) => {
    ws.send({ type: 'subscribe', jobId: runId });

    // Wait for at least one log
    await ws.waitForMessage<{ type: string }>({ timeoutMs: 10_000, predicate: (m) => m.type === 'log' }).catch(() => null);

    ws.send({ type: 'unsubscribe' });

    // After unsubscribe, no new messages should arrive (short window check)
    const after = await ws.collect<{ type: string }>(1, 1_000).catch(() => []);
    const logs = after.filter((m) => m.type === 'log');
    expect(logs.length).toBe(0);
  }, await authHeaders(request));
});

test('WS-L05: client disconnect does not leak — server handles cleanup', async ({ request }) => {
  expect(projectId, 'KB_PROJECT_ID must identify the registered workflow project').toBeTruthy();
  const runId = await startRun(request);

  // Connect, subscribe, then immediately close
  await withWs(logsWsUrl(runId), async (ws) => {
    ws.send({ type: 'subscribe', jobId: runId });
    // Close before receiving any messages — server must not crash
    ws.close(1000);
    await expectWsClose(ws, 1000, { timeoutMs: 3_000 });
  }, await authHeaders(request));

  // Verify daemon is still healthy after forced disconnect
  const health = await fetch(`${WORKFLOW}/health`);
  expect(health.ok).toBe(true);
});
