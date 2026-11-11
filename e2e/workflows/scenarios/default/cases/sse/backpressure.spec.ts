import { test, expect, type APIRequestContext } from '@playwright/test';
import { collectSseEvents, assertNoSseDuplicates } from '@kb-labs/shared-testing-e2e';
import type { SseEvent } from '@kb-labs/shared-testing-e2e';
import { WORKFLOW } from '@kb-labs/e2e-shared/urls.js';

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
  const id = wf?.id ?? wf?.name;
  if (!id) throw new Error('No workflow found in catalog');

  const runRes = await request.post(`${WORKFLOW}/api/v1/workflows/${encodeURIComponent(id)}/runs`, { data: {} });
  const body = await runRes.json();
  const runId: string = body.data?.runId ?? body.data?.id ?? body.runId;
  if (!runId) throw new Error(`Failed to start run: ${JSON.stringify(body)}`);
  return runId;
}

test('SE-B01: burst — all events received in order without loss', async ({ request }) => {
  const runId = await startRun(request);
  const events = await collectSseEvents(`${WORKFLOW}/api/v1/runs/${runId}/events`, {
    timeoutMs: 30_000,
  });

  // Must receive at least snapshot + terminal
  expect(events.length).toBeGreaterThanOrEqual(2);
  // snapshot always comes first
  expect(eventType(events[0])).toBe('run.snapshot');
  // terminal event must be present
  expect(events.some(isTerminal)).toBe(true);
});

test('SE-B02: no duplicate events even after burst', async ({ request }) => {
  const runId = await startRun(request);
  const events = await collectSseEvents(`${WORKFLOW}/api/v1/runs/${runId}/events`, {
    timeoutMs: 30_000,
  });

  assertNoSseDuplicates(events);
});

test('SE-B03: stream does not hang after terminal event', async ({ request }) => {
  const runId = await startRun(request);
  const start = Date.now();

  const events = await collectSseEvents(`${WORKFLOW}/api/v1/runs/${runId}/events`, {
    timeoutMs: 30_000,
  });

  // Collection must stop shortly after terminal — not block waiting for more data
  const elapsed = Date.now() - start;
  expect(events.some(isTerminal)).toBe(true);

  // Stream terminated well before the timeout
  expect(elapsed).toBeLessThan(29_000);
});
