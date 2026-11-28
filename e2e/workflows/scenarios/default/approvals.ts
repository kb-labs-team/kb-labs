import { expect, type APIRequestContext } from '@playwright/test';
import { WORKFLOW, WORKFLOW_API_PREFIX } from '@kb-labs/e2e-shared/urls.js';

export async function startWorkflowRun(
  request: APIRequestContext,
  workflowId: string,
): Promise<string> {
  const res = await request.post(
    `${WORKFLOW}${WORKFLOW_API_PREFIX}/workflows/${encodeURIComponent(workflowId)}/runs`,
    { data: {} },
  );
  expect([200, 201]).toContain(res.status());
  const body = await res.json();
  const runId: string = body.data?.runId ?? body.data?.id ?? body.runId;
  expect(runId).toBeTruthy();
  return runId;
}

export async function listPendingApprovals(
  request: APIRequestContext,
  runId: string,
): Promise<Array<{ jobId: string; stepId: string; stepName: string }>> {
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/runs/${runId}/approvals`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  return (body.data?.pending ?? []) as Array<{ jobId: string; stepId: string; stepName: string }>;
}

export async function resolveApproval(
  request: APIRequestContext,
  runId: string,
  jobId: string,
  stepId: string,
  action: 'approve' | 'reject',
  comment?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await request.post(`${WORKFLOW}${WORKFLOW_API_PREFIX}/runs/${runId}/approvals/resolve`, {
    data: { jobId, stepId, action, comment },
  });
  return { status: res.status(), body: await res.json() };
}
