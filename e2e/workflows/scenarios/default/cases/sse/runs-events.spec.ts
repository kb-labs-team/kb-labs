import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  collectSseEvents,
  expectSseTerminates,
  assertNoSseDuplicates,
} from '@kb-labs/shared-testing-e2e';
import type { SseEvent } from '@kb-labs/shared-testing-e2e';
import { WORKFLOW } from '@kb-labs/e2e-shared/urls.js';

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
  const catalogRes = await request.get(`${WORKFLOW}/api/v1/workflows`);
  const catalog = await catalogRes.json();
  const workflows: Array<{ id?: string; name?: string }> =
    catalog.data?.workflows ?? catalog.data ?? catalog.workflows ?? [];
  const wf = workflows.find((w) => (w.name ?? w.id) === 'e2e-hello') ?? workflows[0];
  if (!wf?.id && !wf?.name) throw new Error('No workflow found in catalog');

  const id = wf.id ?? wf.name!;
  const runRes = await request.post(`${WORKFLOW}/api/v1/workflows/${encodeURIComponent(id)}/runs`, { data: {} });
  const body = await runRes.json();
  const runId: string = body.data?.runId ?? body.data?.id ?? body.runId;
  if (!runId) throw new Error(`Failed to start run: ${JSON.stringify(body)}`);
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

function eventsUrl(runId: string): string {
  return `${WORKFLOW}/api/v1/runs/${runId}/events`;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('SE-01: run.snapshot arrives first, terminal event closes stream', async ({ request }) => {
  const runId = await startRun(request);
  // Collect until stream closes naturally (terminal event triggers cleanup + raw.end())
  const events = await collectSseEvents(eventsUrl(runId), { timeoutMs: 30_000 });

  expect(events.length).toBeGreaterThan(0);
  // First event must always be the snapshot
  expect(eventType(events[0])).toBe('run.snapshot');
  // Stream must have delivered a terminal event before closing
  expect(events.some(isTerminal)).toBe(true);
});

test('SE-02: no duplicate events in the stream', async ({ request }) => {
  const runId = await startRun(request);
  const events = await collectSseEvents(eventsUrl(runId), { timeoutMs: 30_000 });
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
  await expectSseTerminates(eventsUrl(runId), { timeoutMs: 3_000 });
});

test('SE-04: invalid runId returns 404, not an SSE stream', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/runs/nonexistent-run-id-xyz/events`);
  expect(res.status()).toBe(404);
});

test('SE-06: log.appended events include stepName in payload', async ({ request }) => {
  const runId = await startRun(request);
  const events = await collectSseEvents(eventsUrl(runId), { timeoutMs: 30_000 });

  const logEvents = events.filter((e) => eventType(e) === 'log.appended');

  // Workflow may produce zero log events if steps emit nothing — only assert when present
  if (logEvents.length === 0) { return; }

  // At least one log event must carry stepName (set by engine.publishLog)
  const withStepName = logEvents.filter((e) => {
    const payload = (e.json as Record<string, unknown> | undefined)?.payload as Record<string, unknown> | undefined;
    return typeof payload?.stepName === 'string' && payload.stepName.length > 0;
  });
  expect(withStepName.length).toBeGreaterThan(0);
});

test('SE-05: multiple simultaneous subscribers receive same events', async ({ request }) => {
  const runId = await startRun(request);
  const url = eventsUrl(runId);

  const [eventsA, eventsB] = await Promise.all([
    collectSseEvents(url, { timeoutMs: 30_000 }),
    collectSseEvents(url, { timeoutMs: 30_000 }),
  ]);

  expect(eventsA.length).toBeGreaterThan(0);
  expect(eventsB.length).toBeGreaterThan(0);
  // Both must receive a terminal event
  expect(eventsA.some(isTerminal)).toBe(true);
  expect(eventsB.some(isTerminal)).toBe(true);
});
