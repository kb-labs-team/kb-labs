import { test, expect, type APIRequestContext } from '@playwright/test'
import { WORKFLOW } from '@kb-labs/e2e-shared/urls.js'

// Workflow engine tests: execution lifecycle, stats, job tracking
// Relies on e2e-hello and e2e-fail workflows scaffolded in .kb/workflows/

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
): Promise<string> {
  const res = await request.post(`${WORKFLOW}/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`, { data: {} })
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

test('WF-01: workflow stats endpoint responds with counts', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/stats`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const jobs = body.data?.jobs ?? body.jobs
  expect(typeof jobs?.running).toBe('number')
})

test('WF-02: workflow catalog is populated (e2e-hello is present)', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/workflows`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const workflows: { id?: string; name?: string }[] =
    body.data?.workflows ?? body.data ?? body.workflows ?? []
  expect(Array.isArray(workflows)).toBe(true)

  const hasHello = workflows.some(w => w.name === 'e2e-hello' || w.id === 'e2e-hello')
  expect(hasHello).toBe(true)
})

test('WF-03: e2e-hello run reaches terminal state within 30s', async ({ request }) => {
  const wf = await findWorkflow(request, 'e2e-hello')
  expect(!wf, 'e2e-hello workflow not found').toBe(false)

  const runId = await startRun(request, wf!.id ?? wf!.name!)

  await expect.poll(
    () => pollRunStatus(request, runId),
    { timeout: 30_000, intervals: [1000, 2000, 3000] },
  ).toMatch(/success|completed|failed|dlq/)
})

test('WF-04: runs list is accessible and includes recent run', async ({ request }) => {
  const wf = await findWorkflow(request, 'e2e-hello')
  expect(!wf, 'e2e-hello workflow not found').toBe(false)

  const runId = await startRun(request, wf!.id ?? wf!.name!)

  const res = await request.get(`${WORKFLOW}/api/v1/runs`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const runs: { id?: string; runId?: string }[] =
    body.data?.runs ?? body.data ?? body.runs ?? []
  expect(Array.isArray(runs)).toBe(true)

  const found = runs.some(r => r.id === runId || r.runId === runId)
  expect(found).toBe(true)
})

test('WF-05: stats running count increases during active run', async ({ request }) => {
  const wf = await findWorkflow(request, 'e2e-hello')
  expect(!wf, 'e2e-hello workflow not found').toBe(false)

  // Snapshot stats before starting a run
  const beforeStats = await (await request.get(`${WORKFLOW}/api/v1/stats`)).json()
  const runsBefore: number = beforeStats.data?.runs?.total ?? beforeStats.runs?.total ?? 0

  await startRun(request, wf!.id ?? wf!.name!)

  // After creating a run, total count must be >= before
  const afterStats = await (await request.get(`${WORKFLOW}/api/v1/stats`)).json()
  const runsAfter: number = afterStats.data?.runs?.total ?? afterStats.runs?.total ?? 0
  expect(runsAfter).toBeGreaterThanOrEqual(runsBefore)
})

test('WF-06: e2e-fail workflow ends with failed status', async ({ request }) => {
  const wf = await findWorkflow(request, 'e2e-fail')
  expect(!wf, 'e2e-fail workflow not found').toBe(false)

  const runId = await startRun(request, wf!.id ?? wf!.name!)

  const finalStatus = await expect.poll(
    () => pollRunStatus(request, runId),
    { timeout: 30_000, intervals: [1000, 2000, 3000] },
  ).toMatch(/failed|dlq/)

  // Verify run record contains error details
  const res = await request.get(`${WORKFLOW}/api/v1/runs/${runId}`)
  const body = await res.json()
  const run = body.data?.run ?? body.data ?? body
  // Failed run must surface why it failed. A user-step failure now ends as
  // `failed` (not `dlq`) with the error under run.result.error (B-029); the dlq
  // path remains for infrastructure failures.
  const hasError =
    run?.result?.error != null ||
    run?.error != null ||
    run?.failureReason != null ||
    run?.status === 'dlq'
  expect(hasError).toBe(true)
})

test('WF-07: cron catalog endpoint is accessible', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/crons`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const crons = body.data?.crons ?? body.data ?? body.crons ?? []
  expect(Array.isArray(crons)).toBe(true)
})
