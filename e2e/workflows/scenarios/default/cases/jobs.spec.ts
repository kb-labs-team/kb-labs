import { test, expect, type APIRequestContext } from '@playwright/test';
import { WORKFLOW } from '@kb-labs/e2e-shared/urls.js';

// Job execution API: /api/v1/jobs
// These tests cover the raw job layer (below workflow runs).

// ── helpers ──────────────────────────────────────────────────────────────────

async function submitJob(
  request: APIRequestContext,
  handler = 'e2e-hello#default',
): Promise<string> {
  const res = await request.post(`${WORKFLOW}/api/v1/jobs`, {
    data: { type: handler, payload: {} },
  });
  expect([200, 201]).toContain(res.status());
  const body = await res.json();
  const jobId: string = body.data?.jobId ?? body.data?.id ?? body.jobId ?? body.id;
  expect(jobId).toBeTruthy();
  return jobId;
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('WJ-01: GET /api/v1/jobs returns an array', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/jobs`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  const jobs = body.data?.jobs ?? body.data ?? body.jobs;
  expect(Array.isArray(jobs)).toBe(true);
});

test('WJ-02: POST /api/v1/jobs submits a job and returns a jobId', async ({ request }) => {
  const res = await request.post(`${WORKFLOW}/api/v1/jobs`, {
    data: { type: 'e2e-hello#default', payload: { source: 'wj-02' } },
  });
  expect([200, 201], 'e2e-hello#default handler must be registered by the workflow service').toContain(res.status());
  expect([200, 201]).toContain(res.status());
  const body = await res.json();
  const jobId = body.data?.jobId ?? body.data?.id ?? body.jobId;
  expect(typeof jobId).toBe('string');
  expect(jobId.length).toBeGreaterThan(0);
});

test('WJ-03: GET /api/v1/jobs/:jobId returns job detail', async ({ request }) => {
  // Submit a job first so we have a real ID
  const res = await request.post(`${WORKFLOW}/api/v1/jobs`, {
    data: { type: 'e2e-hello#default', payload: {} },
  });
  expect([200, 201], 'e2e-hello#default handler must be registered by the workflow service').toContain(res.status());

  const submitBody = await res.json();
  const jobId: string = submitBody.data?.jobId ?? submitBody.data?.id ?? submitBody.jobId;
  expect(jobId).toBeTruthy();

  const detailRes = await request.get(`${WORKFLOW}/api/v1/jobs/${jobId}`);
  expect(detailRes.status()).toBe(200);
  const body = await detailRes.json();
  const job = body.data?.job ?? body.data ?? body;
  expect(job?.id ?? job?.jobId).toBeTruthy();
  expect(job?.status).toMatch(/pending|running|completed|failed|cancelled/);
});

test('WJ-04: GET /api/v1/jobs/:jobId/logs returns log entries array', async ({ request }) => {
  const submitRes = await request.post(`${WORKFLOW}/api/v1/jobs`, {
    data: { type: 'e2e-hello#default', payload: {} },
  });
  expect([200, 201], 'e2e-hello#default handler must be registered by the workflow service').toContain(submitRes.status());

  const submitBody = await submitRes.json();
  const jobId: string = submitBody.data?.jobId ?? submitBody.data?.id ?? submitBody.jobId;
  expect(jobId).toBeTruthy();

  // Logs may be empty while job is pending — just verify endpoint responds correctly
  const logsRes = await request.get(`${WORKFLOW}/api/v1/jobs/${jobId}/logs`);
  expect(logsRes.status()).toBe(200);
  const body = await logsRes.json();
  const logs = body.data?.logs ?? body.data ?? body.logs;
  expect(Array.isArray(logs)).toBe(true);
});
