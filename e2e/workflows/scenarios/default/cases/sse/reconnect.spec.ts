import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  collectSseEvents,
  expectSseTerminates,
  assertNoSseDuplicates,
} from '@kb-labs/shared-testing-e2e';
import type { SseEvent } from '@kb-labs/shared-testing-e2e';
import { WORKFLOW } from '@kb-labs/e2e-shared/urls.js';

function eventType(e: SseEvent): string {
  return (e.json as Record<string, string> | undefined)?.type ?? e.event;
}

function isTerminal(e: SseEvent): boolean {
  return ['run.finished', 'run.failed', 'run.cancelled'].includes(eventType(e));
}

async function startRun(
  request: APIRequestContext,
  workflowName = 'e2e-slow',
): Promise<string> {
  const catalogRes = await request.get(`${WORKFLOW}/api/v1/workflows`);
  const catalog = await catalogRes.json();
  const workflows: Array<{ id?: string; name?: string }> =
    catalog.data?.workflows ?? catalog.data ?? catalog.workflows ?? [];
  const wf = workflows.find((w) => (w.name ?? w.id) === workflowName) ?? workflows[0];
  const id = wf?.id ?? wf?.name;
  if (!id) throw new Error('No workflow found in catalog');

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

test('SE-R01: reconnect does not duplicate live events', async ({ request }) => {
  test.setTimeout(60_000);

  const runId = await startRun(request);
  const url = eventsUrl(runId);

  // First connection: collect for a short window then disconnect.
  const firstBatch = await collectSseEvents(url, { timeoutMs: 3_000 });

  // Reconnect and collect until stream closes (run finishes).
  const secondBatch = await collectSseEvents(url, { timeoutMs: 30_000 });

  assertNoSseDuplicates(secondBatch);

  // Every reconnect gets a fresh run.snapshot — that is expected, not a duplicate.
  // Verify non-snapshot live events from second batch were not already in first batch.
  const firstLiveIds = new Set(
    firstBatch
      .filter((e) => eventType(e) !== 'run.snapshot')
      .map((e) => e.id)
      .filter(Boolean),
  );

  const duplicatedLiveEvents = secondBatch.filter(
    (e) => eventType(e) !== 'run.snapshot' && e.id !== undefined && firstLiveIds.has(e.id),
  );

  expect(
    duplicatedLiveEvents,
    `Server replayed ${duplicatedLiveEvents.length} live event(s) on reconnect`,
  ).toHaveLength(0);

  // Sanity: the second batch must contain a terminal event
  expect(secondBatch.some(isTerminal)).toBe(true);
});

test('SE-R02: run.finished is not missed on reconnect to already-terminal run', async ({ request }) => {
  test.setTimeout(60_000);

  const runId = await startRun(request, 'e2e-hello');
  const url = eventsUrl(runId);

  // Wait for run to reach terminal state via HTTP polling (avoids SSE event type dependency)
  await expect.poll(
    () => pollRunStatus(request, runId),
    { timeout: 30_000, intervals: [1000, 2000] },
  ).toMatch(/success|completed|failed|cancelled/);

  // Reconnect after the run is already terminal — stream must close immediately.
  await expectSseTerminates(url, { timeoutMs: 3_000 });
});

test('SE-R03: rapid reconnect delivers run.finished without data loss', async ({ request }) => {
  test.setTimeout(60_000);

  const runId = await startRun(request);
  const url = eventsUrl(runId);

  // Simulate a connection drop with a very short timeout.
  await collectSseEvents(url, { timeoutMs: 500 });

  // Reconnect and collect until stream closes.
  const events = await collectSseEvents(url, { timeoutMs: 30_000 });

  expect(events.some(isTerminal)).toBe(true);
});
