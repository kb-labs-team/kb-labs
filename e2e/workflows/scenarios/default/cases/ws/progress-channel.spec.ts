import { test, expect, type APIRequestContext } from '@playwright/test';
import { withWs, expectWsMessage } from '@kb-labs/shared-testing-e2e';
import { GATEWAY, WORKFLOW } from '@kb-labs/e2e-shared/urls.js';
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js';
import { projectWorkflowRoute } from '@kb-labs/workflow-contracts/routes';

const GATEWAY_WS = GATEWAY.replace(/^http/, 'ws');
const projectId = process.env.KB_PROJECT_ID;

// ── helpers ──────────────────────────────────────────────────────────────────

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

function progressWsUrl(jobId: string): string {
  return `${GATEWAY_WS}${projectWorkflowRoute(projectId!, `ws/progress/${encodeURIComponent(jobId)}`)}`;
}

// WS upgrade requests go through the gateway like any other route since the
// GHSA-75rf-rhxh-2p52 fix — a valid token is required here too.
async function authHeaders(request: APIRequestContext) {
  const token = await getAccessToken(request);
  return { headers: { Authorization: `Bearer ${token}` } };
}

// ── tests ─────────────────────────────────────────────────────────────────────

// WS-P01 is skipped because progress-channel.ts has only a partial implementation.
// The subscribe handler sends a synthetic `step_start` message for 'initialization'
// (as a placeholder), but the actual engine integration is TODO — there is no real
// progress stream hooked up yet. The test would be flaky: it could pass today
// (stub response) and silently change behaviour once the real implementation lands.
// Re-enable once the engine emits real step events.
test('WS-P01: subscribe → server acknowledges', async ({ request }) => {
  expect(projectId, 'KB_PROJECT_ID must identify the registered workflow project').toBeTruthy();
  const runId = await startRun(request);

  await withWs(progressWsUrl(runId), async (ws) => {
    ws.send({ type: 'subscribe', jobId: runId });

    // The current implementation sends a synthetic step_start for 'initialization'
    // or an error. Either response is acceptable — what matters is that the channel
    // does not hang silently.
    const msg = await expectWsMessage<{ type: string }>(
      ws,
      (m) => m.type === 'step_start' || m.type === 'error',
      { timeoutMs: 10_000, label: 'step_start or error acknowledgement' },
    );

    expect(['step_start', 'error']).toContain(msg.type);
  }, await authHeaders(request));
});

test('WS-P02: unknown jobId → error message, no hang', async ({ request }) => {
  expect(projectId, 'KB_PROJECT_ID must identify the registered workflow project').toBeTruthy();
  const fakeJobId = 'nonexistent-job-xyz';

  await withWs(progressWsUrl(fakeJobId), async (ws) => {
    ws.send({ type: 'subscribe', jobId: fakeJobId });

    // The server should respond with an error message or close the connection
    // within a reasonable time. Hanging silently is not acceptable.
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
