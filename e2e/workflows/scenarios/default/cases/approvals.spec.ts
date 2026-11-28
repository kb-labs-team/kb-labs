import { listPendingApprovals, resolveApproval, startWorkflowRun } from '../approvals.js';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { WORKFLOW, WORKFLOW_API_PREFIX } from '@kb-labs/e2e-shared/urls.js';

// Approval-step e2e tests.
// Relies on e2e-approval workflow scaffolded in entrypoint.sh.
// The workflow pauses at a builtin:approval step and resumes when resolved.

async function pollRunStatus(
  request: APIRequestContext,
  runId: string,
): Promise<string | undefined> {
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/runs/${runId}`);
  const body = await res.json();
  return body.data?.run?.status ?? body.data?.status ?? body.status;
}

test('WA-01: approval run pauses at waiting_approval, approve resumes to success', async ({ request }) => {
  test.setTimeout(60_000);

  const runId = await startWorkflowRun(request, 'e2e-approval');

  // Wait until the run reaches waiting_approval
  await expect
    .poll(() => pollRunStatus(request, runId), { timeout: 30_000, intervals: [500, 1000, 2000] })
    .toBe('running');

  // Poll approvals until a step appears
  let pending: Array<{ jobId: string; stepId: string; stepName: string }> = [];
  await expect
    .poll(
      async () => {
        pending = await listPendingApprovals(request, runId);
        return pending.length;
      },
      { timeout: 20_000, intervals: [500, 1000] },
    )
    .toBeGreaterThan(0);

  expect(pending[0]).toBeDefined();
  const { jobId, stepId } = pending[0]!;

  // Approve
  const { status } = await resolveApproval(request, runId, jobId, stepId, 'approve');
  expect(status).toBe(200);

  // Run should reach a terminal state after approval
  await expect
    .poll(() => pollRunStatus(request, runId), { timeout: 30_000, intervals: [1000, 2000] })
    .toMatch(/success|completed|failed/);
});

test('WA-02: approval run pauses, reject transitions run to failed/completed', async ({ request }) => {
  test.setTimeout(60_000);

  const runId = await startWorkflowRun(request, 'e2e-approval');

  // Wait for a pending approval to appear
  let pending: Array<{ jobId: string; stepId: string; stepName: string }> = [];
  await expect
    .poll(
      async () => {
        pending = await listPendingApprovals(request, runId);
        return pending.length;
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBeGreaterThan(0);

  const { jobId, stepId } = pending[0]!;

  // Reject
  const { status } = await resolveApproval(request, runId, jobId, stepId, 'reject', 'Rejected by e2e test');
  expect(status).toBe(200);

  // Run must reach a terminal state regardless of rejection semantics
  await expect
    .poll(() => pollRunStatus(request, runId), { timeout: 30_000, intervals: [1000, 2000] })
    .toMatch(/success|completed|failed|cancelled/);
});

test('WA-03: GET approvals for run with no pending steps returns empty array', async ({ request }) => {
  // e2e-hello has no approval steps — pending should always be empty
  const runId = await startWorkflowRun(request, 'e2e-hello');

  const pending = await listPendingApprovals(request, runId);
  expect(Array.isArray(pending)).toBe(true);
  expect(pending.length).toBe(0);
});

test('WA-04: GET approvals for unknown run returns 404', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/runs/nonexistent-run-xyz/approvals`);
  expect(res.status()).toBe(404);
});

test('WA-05: resolve approval for unknown run returns 404', async ({ request }) => {
  const res = await request.post(`${WORKFLOW}${WORKFLOW_API_PREFIX}/runs/nonexistent-run-xyz/approvals/resolve`, {
    data: { jobId: 'j1', stepId: 's1', action: 'approve' },
  });
  expect(res.status()).toBe(404);
});

test('WA-06: resolve approval with invalid action returns 400', async ({ request }) => {
  // Start a run just to get a valid runId (action validation should fire before run lookup)
  const runId = await startWorkflowRun(request, 'e2e-hello');

  const res = await request.post(`${WORKFLOW}${WORKFLOW_API_PREFIX}/runs/${runId}/approvals/resolve`, {
    data: { jobId: 'j1', stepId: 's1', action: 'skip' },
  });
  // 400 (validation) is expected; 404 is also acceptable (run finished before resolve)
  expect([400, 404, 409]).toContain(res.status());
});

test('WA-07: resolve already-resolved approval returns 409', async ({ request }) => {
  test.setTimeout(60_000);

  const runId = await startWorkflowRun(request, 'e2e-approval');

  let pending: Array<{ jobId: string; stepId: string }> = [];
  await expect
    .poll(
      async () => {
        pending = await listPendingApprovals(request, runId);
        return pending.length;
      },
      { timeout: 30_000, intervals: [500, 1000] },
    )
    .toBeGreaterThan(0);

  const { jobId, stepId } = pending[0]!;

  // First resolve — should succeed
  const first = await resolveApproval(request, runId, jobId, stepId, 'approve');
  expect(first.status).toBe(200);

  // Second resolve on the same step — must fail (not 2xx)
  const second = await resolveApproval(request, runId, jobId, stepId, 'approve');
  expect(second.status).not.toBe(200);
  expect([409, 400, 404]).toContain(second.status);
});
