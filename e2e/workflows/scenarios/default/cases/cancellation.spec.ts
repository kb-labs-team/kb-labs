import { test, expect, type APIRequestContext } from '@playwright/test';
import { collectSseEvents } from '@kb-labs/shared-testing-e2e';
import { WORKFLOW } from '@kb-labs/e2e-shared/urls.js';

// ── helpers ──────────────────────────────────────────────────────────────────

async function findFirstWorkflow(
  request: APIRequestContext,
): Promise<{ id?: string; name?: string } | undefined> {
  const res = await request.get(`${WORKFLOW}/api/v1/workflows`);
  const body = await res.json();
  const list: Array<{ id?: string; name?: string }> =
    body.data?.workflows ?? body.data ?? body.workflows ?? [];
  return list.find((w) => w.id === 'e2e-hello') ?? list[0];
}

async function startRun(
  request: APIRequestContext,
  workflowId: string,
): Promise<string> {
  const res = await request.post(`${WORKFLOW}/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`, { data: {} });
  expect([200, 201]).toContain(res.status());
  const body = await res.json();
  const runId: string = body.data?.runId ?? body.data?.id ?? body.runId;
  expect(runId).toBeTruthy();
  return runId;
}

async function pollRunStatus(
  request: APIRequestContext,
  runId: string,
): Promise<string | undefined> {
  const res = await request.get(`${WORKFLOW}/api/v1/runs/${runId}`);
  const body = await res.json();
  return body.data?.run?.status ?? body.data?.status ?? body.status;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('WC-01: cancel a running run — run transitions to cancelled or was already terminal', async ({ request }) => {
  const wf = await findFirstWorkflow(request);
  expect(!wf, 'No workflow found in catalog — run kb-dev start first').toBe(false);

  const runId = await startRun(request, wf!.id ?? wf!.name!);

  const cancelRes = await request.post(`${WORKFLOW}/api/v1/runs/${runId}/cancel`, { data: {} });
  expect([200, 204, 409]).toContain(cancelRes.status());

  // After cancel, run must be in a terminal state
  await expect.poll(
    () => pollRunStatus(request, runId),
    { timeout: 15_000, intervals: [500, 1000] },
  ).toMatch(/cancelled|success|completed|failed/);
});

test('WC-02: cancel already-finished run returns graceful response (not 5xx)', async ({ request }) => {
  const wf = await findFirstWorkflow(request);
  expect(!wf, 'No workflow found in catalog — run kb-dev start first').toBe(false);

  const runId = await startRun(request, wf!.id ?? wf!.name!);

  // Wait for run to reach terminal state
  await expect.poll(
    () => pollRunStatus(request, runId),
    { timeout: 30_000, intervals: [1000, 2000] },
  ).toMatch(/success|completed|failed|cancelled/);

  // Cancel an already-terminal run
  const cancelRes = await request.post(`${WORKFLOW}/api/v1/runs/${runId}/cancel`, { data: {} });
  expect(cancelRes.status()).toBeLessThan(500);
});

test('WC-03: SSE stream terminates after run is cancelled', async ({ request }) => {
  const wf = await findFirstWorkflow(request);
  expect(!wf, 'No workflow found in catalog — run kb-dev start first').toBe(false);

  const runId = await startRun(request, wf!.id ?? wf!.name!);

  // Cancel immediately (may cancel while queued)
  await request.post(`${WORKFLOW}/api/v1/runs/${runId}/cancel`, { data: {} });

  // SSE stream must terminate (run is terminal = cancelled or already finished)
  const events = await collectSseEvents(
    `${WORKFLOW}/api/v1/runs/${runId}/events`,
    { timeoutMs: 15_000 },
  );

  const types = events.map((e) => e.event);
  const hasTerminal = types.some((t) =>
    t === 'run.finished' || t === 'run.failed' || t === 'run.cancelled',
  );
  expect(events.length).toBeGreaterThan(0);
  expect(hasTerminal).toBe(true);
});
