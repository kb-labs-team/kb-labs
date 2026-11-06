import { test, expect, type APIRequestContext } from '@playwright/test'
import { WORKFLOW } from '@kb-labs/e2e-shared/urls.js'

// Workflow runs API: POST /api/v1/workflows/:id/runs → { data: { runId, status } }
// Run status: GET /api/v1/runs/:runId → { data: { run: { id, status, ... } } }

async function findWorkflow(
  request: APIRequestContext,
  name: string,
): Promise<{ id?: string; name?: string } | undefined> {
  const res = await request.get(`${WORKFLOW}/api/v1/workflows`)
  const body = await res.json()
  const list: { id?: string; name?: string }[] =
    body.data?.workflows ?? body.data ?? body.workflows ?? []
  return list.find(w => w.name === name || w.id === name)
}

async function startRun(
  request: APIRequestContext,
  workflowId: string,
  input: Record<string, unknown> = {},
): Promise<string> {
  const res = await request.post(`${WORKFLOW}/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`, {
    data: input,
  })
  expect([200, 201]).toContain(res.status())
  const body = await res.json()
  const runId = body.data?.runId ?? body.data?.id ?? body.runId
  expect(runId).toBeTruthy()
  return runId as string
}

async function pollRunStatus(
  request: APIRequestContext,
  runId: string,
): Promise<string | undefined> {
  const res = await request.get(`${WORKFLOW}/api/v1/runs/${runId}`)
  const body = await res.json()
  return body.data?.run?.status ?? body.data?.status ?? body.status
}

// ── W-01 / W-02: basic job lifecycle ────────────────────────────────────────

test('W-01: create workflow run returns run ID', async ({ request }) => {
  const wf = await findWorkflow(request, 'e2e-hello')
  expect(wf, 'required e2e-hello workflow is missing from the nightly fixture').toBeTruthy()

  const runId = await startRun(request, wf!.id ?? wf!.name!)

  const statusRes = await request.get(`${WORKFLOW}/api/v1/runs/${runId}`)
  expect(statusRes.status()).toBe(200)
  const statusBody = await statusRes.json()
  expect(statusBody.data?.run ?? statusBody.data).toBeTruthy()
})

test('W-02: GET /runs/:id returns a valid initial status', async ({ request }) => {
  const wf = await findWorkflow(request, 'e2e-hello')
  expect(wf, 'required e2e-hello workflow is missing from the nightly fixture').toBeTruthy()

  const runId = await startRun(request, wf!.id ?? wf!.name!)
  const status = await pollRunStatus(request, runId)
  expect(status).toMatch(/pending|running|queued|success|completed|failed/)
})

test('W-03: e2e-hello workflow reaches completed within 30s', async ({ request }) => {
  const wf = await findWorkflow(request, 'e2e-hello')
  expect(wf, 'required e2e-hello workflow is missing from the nightly fixture').toBeTruthy()

  const runId = await startRun(request, wf!.id ?? wf!.name!)

  await expect.poll(
    () => pollRunStatus(request, runId),
    { timeout: 30_000, intervals: [1000, 2000, 3000] },
  ).toMatch(/^(success|completed)$/)
})

test('W-04: e2e-fail workflow reaches failed status within 30s', async ({ request }) => {
  const wf = await findWorkflow(request, 'e2e-fail')
  expect(wf, 'required e2e-fail workflow is missing from the nightly fixture').toBeTruthy()

  const runId = await startRun(request, wf!.id ?? wf!.name!)

  await expect.poll(
    () => pollRunStatus(request, runId),
    { timeout: 30_000, intervals: [1000, 2000, 3000] },
  ).toMatch(/failed|dlq/)
})
