import { listPendingApprovals, resolveApproval, startWorkflowRun } from '../../approvals.js';
import { collectAuthenticatedSseEvents, expectAuthenticatedSseTerminates, sseAuthHeaders } from '../../sse-auth.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  assertNoSseDuplicates, readSse,
} from '@kb-labs/shared-testing-e2e';
import type { SseEvent } from '@kb-labs/shared-testing-e2e';
import { WORKFLOW, WORKFLOW_API_PREFIX } from '@kb-labs/e2e-shared/urls.js';

// ── helpers ──────────────────────────────────────────────────────────────────

// Extract the logical event type from an SSE event.
// Installed daemon always sends event: "workflow.event" with actual type in json.type.
// Workspace daemon sends the type directly as the SSE event field.
function eventType(e: SseEvent): string {
  return (e.json as Record<string, string> | undefined)?.type ?? e.event;
}

function isTerminal(e: SseEvent): boolean {
  return ['run.finished', 'run.failed', 'run.cancelled'].includes(eventType(e));
}

async function startRun(request: APIRequestContext): Promise<string> {
  const catalogRes = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/workflows`);
  const catalog = await catalogRes.json();
  const workflows: Array<{ id?: string; name?: string }> =
    catalog.data?.workflows ?? catalog.data ?? catalog.workflows ?? [];
  const wf = workflows.find((w) => (w.name ?? w.id) === 'e2e-hello') ?? workflows[0];
  if (!wf?.id && !wf?.name) throw new Error('No workflow found in catalog');

  const id = wf.id ?? wf.name!;
  const runRes = await request.post(`${WORKFLOW}${WORKFLOW_API_PREFIX}/workflows/${encodeURIComponent(id)}/runs`, { data: {} });
  const body = await runRes.json();
  const runId: string = body.data?.runId ?? body.data?.id ?? body.runId;
  if (!runId) throw new Error(`Failed to start run: ${JSON.stringify(body)}`);
  return runId;
}

async function pollRunStatus(
  request: APIRequestContext,
  runId: string,
): Promise<string | undefined> {
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/runs/${runId}`);
  const body = await res.json();
  return body.data?.run?.status ?? body.data?.status ?? body.status;
}

function eventsUrl(runId: string): string {
  return `${WORKFLOW}${WORKFLOW_API_PREFIX}/runs/${runId}/events`;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('SE-01: run.snapshot arrives first, terminal event closes stream', async ({ request }) => {
  const runId = await startRun(request);
  // Collect until stream closes naturally (terminal event triggers cleanup + raw.end())
  const events = await collectAuthenticatedSseEvents(request, eventsUrl(runId), { timeoutMs: 30_000 });

  expect(events.length).toBeGreaterThan(0);
  // First event must always be the snapshot
  expect(eventType(events[0])).toBe('run.snapshot');
  // Stream must have delivered a terminal event before closing
  expect(events.some(isTerminal)).toBe(true);
});

test('SE-02: no duplicate events in the stream', async ({ request }) => {
  const runId = await startRun(request);
  const events = await collectAuthenticatedSseEvents(request, eventsUrl(runId), { timeoutMs: 30_000 });
  assertNoSseDuplicates(events);
});

test('SE-03: already-terminal run closes stream immediately (< 3s)', async ({ request }) => {
  const runId = await startRun(request);

  // Wait for run to reach terminal state via HTTP polling (avoids SSE event type dependency)
  await expect.poll(
    () => pollRunStatus(request, runId),
    { timeout: 30_000, intervals: [1000, 2000] },
  ).toMatch(/success|completed|failed|cancelled/);

  // Reconnect — terminal run must close the new SSE connection quickly
  await expectAuthenticatedSseTerminates(request, eventsUrl(runId), { timeoutMs: 3_000 });
});

test('SE-04: invalid runId returns 404, not an SSE stream', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/runs/nonexistent-run-id-xyz/events`);
  expect(res.status()).toBe(404);
  expect((await res.json()).error.code).toBe('KB_RUNTIME_WORKFLOW_RUN_NOT_FOUND');
});

test('SE-06 @S-027.7: a connected subscriber receives stdout from the step after approval', async ({ request }) => {
  test.setTimeout(60_000);
  const runId = await startWorkflowRun(request, 'e2e-approval');
  let pending: Awaited<ReturnType<typeof listPendingApprovals>> = [];
  await expect.poll(async () => {
    pending = await listPendingApprovals(request, runId);
    return pending.length;
  }, { timeout: 20_000 }).toBe(1);
  const { jobId, stepId } = pending[0]!;
  const events: SseEvent[] = [];
  const headers = await sseAuthHeaders(request);
  for await (const event of readSse(eventsUrl(runId), { headers, timeoutMs: 30_000 })) {
    events.push(event);
    if (eventType(event) === 'run.snapshot') {
      // Receiving the snapshot proves this connection is open before the shell can emit.
      const approval = await resolveApproval(request, runId, jobId, stepId, 'approve');
      expect(approval.status).toBe(200);
    }
  }
  const stdoutIndex = events.findIndex((event) =>
    eventType(event) === 'log.appended' &&
    expect.objectContaining({ runId, payload: expect.objectContaining({
      stepName: 'After gate', stream: 'stdout', message: 'after approval',
    }) }).asymmetricMatch(event.json),
  );
  const terminalIndex = events.findIndex(isTerminal);
  expect(stdoutIndex, 'stdout from After gate must be delivered').toBeGreaterThanOrEqual(0);
  expect(terminalIndex, 'the stream must close with a terminal run event').toBeGreaterThan(stdoutIndex);
});

test('SE-05: multiple simultaneous subscribers receive same events', async ({ request }) => {
  const runId = await startRun(request);
  const url = eventsUrl(runId);

  const [eventsA, eventsB] = await Promise.all([
    collectAuthenticatedSseEvents(request, url, { timeoutMs: 30_000 }),
    collectAuthenticatedSseEvents(request, url, { timeoutMs: 30_000 }),
  ]);

  expect(eventsA.length).toBeGreaterThan(0);
  expect(eventsB.length).toBeGreaterThan(0);
  // Both must receive a terminal event
  expect(eventsA.some(isTerminal)).toBe(true);
  expect(eventsB.some(isTerminal)).toBe(true);
});
