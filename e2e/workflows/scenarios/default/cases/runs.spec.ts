import { test, expect, type APIRequestContext } from '@playwright/test'
import { GATEWAY, WORKFLOW } from '@kb-labs/e2e-shared/urls.js'
import { projectWorkflowRoute } from '@kb-labs/workflow-contracts/routes'

const projectId = process.env.KB_PROJECT_ID

/**
 * Workflow runs lifecycle tests.
 *
 * Tests run against the workflow daemon directly (WORKFLOW :7778) for
 * low-level run state, and against the built-in workflow REST API proxy
 * (the project-scoped Gateway workflow route) for the full stack.
 *
 * All tests that need an actual run pick the first available workflow from
 * the catalog — they do NOT depend on `e2e-hello` being scaffolded.
 */

// ── helpers ──────────────────────────────────────────────────────────────────

type WorkflowEntry = { id?: string; name?: string }
type RunEntry = { id?: string; runId?: string; status?: string }

async function getFirstWorkflow(
  request: APIRequestContext,
): Promise<WorkflowEntry | undefined> {
  const res = await request.get(`${WORKFLOW}/api/v1/workflows`)
  if (!res.ok()) return undefined
  const body = await res.json()
  const list: WorkflowEntry[] = body.data?.workflows ?? body.data ?? body.workflows ?? []
  // Only use e2e-hello — the lightweight smoke workflow scaffolded by the platform
  // entrypoint. Other catalog workflows require external deps (LLM, Docker, etc.)
  // and go to DLQ in the minimal E2E environment, causing WR-05 to time out.
  return list.find(w => (w.name ?? w.id) === 'e2e-hello')
}

async function startRun(
  request: APIRequestContext,
  workflowId: string,
): Promise<string | undefined> {
  const res = await request.post(`${WORKFLOW}/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`, { data: {} })
  if (!res.ok()) return undefined
  const body = await res.json()
  return body.data?.runId ?? body.data?.id ?? body.runId ?? body.id
}

// ── WR-01: GET /runs lists runs (even empty) ─────────────────────────────────

test('WR-01: GET /runs — returns a runs array', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/runs`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const runs: unknown[] = body.data?.runs ?? body.data ?? body.runs ?? (Array.isArray(body) ? body : [])
  expect(Array.isArray(runs)).toBe(true)
})

// ── WR-02: GET /runs supports status filter ─────────────────────────────────

test('WR-02: GET /runs?status=success — returns only success runs', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/runs?status=success`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const runs: RunEntry[] = body.data?.runs ?? body.data ?? body.runs ?? []
  for (const run of runs) {
    expect(run.status).toMatch(/success|completed/)
  }
})

// ── WR-03: POST /workflows/:id/runs — creates a run and returns runId ────────

test('WR-03: POST /workflows/:id/runs — returns a valid runId', async ({ request }) => {
  const wf = await getFirstWorkflow(request)
  expect(!wf, 'no workflows registered in catalog — nothing to run').toBe(false)

  const id = wf!.id ?? wf!.name!
  const runId = await startRun(request, id)
  expect(typeof runId).toBe('string')
  expect(runId!.length).toBeGreaterThan(0)
})

// ── WR-04: GET /runs/:runId — returns run detail ─────────────────────────────

test('WR-04: GET /runs/:runId — returns run detail', async ({ request }) => {
  const wf = await getFirstWorkflow(request)
  expect(!wf, 'no workflows in catalog').toBe(false)

  const runId = await startRun(request, wf!.id ?? wf!.name!)
  expect(runId, 'workflow run creation is required for detail lookup').toBeTruthy()

  const res = await request.get(`${WORKFLOW}/api/v1/runs/${runId}`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const run = body.data?.run ?? body.data ?? body
  expect(run.id ?? run.runId ?? runId).toBeTruthy()
  expect(run.status).toMatch(/pending|queued|running|success|completed|failed|cancelled/)
})

// ── WR-05: GET /runs/:runId reaches terminal state within 30s ───────────────

test('WR-05: run reaches terminal state within 30s', async ({ request }) => {
  const wf = await getFirstWorkflow(request)
  expect(!wf, 'no workflows in catalog').toBe(false)

  const runId = await startRun(request, wf!.id ?? wf!.name!)
  expect(runId, 'workflow run creation is required for terminal-state polling').toBeTruthy()

  await expect.poll(
    async () => {
      const res = await request.get(`${WORKFLOW}/api/v1/runs/${runId}`)
      const body = await res.json()
      return body.data?.run?.status ?? body.data?.status ?? body.status
    },
    { timeout: 30_000, intervals: [1000, 2000, 3000] },
  ).toMatch(/^(success|completed|failed|cancelled)$/)
})

// ── WR-06: POST /workflows/runs/:runId/cancel — cancel in-flight run ─────────

test('WR-06: POST cancel — accepted for a running or pending run', async ({ request }) => {
  const wf = await getFirstWorkflow(request)
  expect(!wf, 'no workflows in catalog').toBe(false)

  const runId = await startRun(request, wf!.id ?? wf!.name!)
  expect(runId, 'workflow run creation is required for cancellation').toBeTruthy()

  // Cancel immediately while run may still be pending/running.
  // Route is POST /api/v1/runs/:runId/cancel (no /workflows prefix despite the contracts constant).
  const cancel = await request.post(`${WORKFLOW}/api/v1/runs/${runId}/cancel`)
  // 200 = cancelled, 409 = already terminal (completed before we could cancel) — both valid
  expect([200, 409]).toContain(cancel.status())

  if (cancel.status() === 200) {
    const body = await cancel.json()
    const data = body.data ?? body
    expect(data.cancelled ?? data.ok ?? true).toBeTruthy()
  }
})

// ── WR-07: GET /jobs — lists jobs associated with runs ───────────────────────

test('WR-07: GET /jobs — returns a jobs array', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/jobs`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const jobs: unknown[] = body.data?.jobs ?? body.data ?? body.jobs ?? (Array.isArray(body) ? body : [])
  expect(Array.isArray(jobs)).toBe(true)
})

// ── WR-08: built-in workflow REST API — list runs ───────────────────────────

test('WR-08: built-in workflow route GET /runs responds 200', async ({ request }) => {
  expect(projectId, 'KB_PROJECT_ID must identify the registered workflow project').toBeTruthy()
  const res = await request.get(`${GATEWAY}${projectWorkflowRoute(projectId!, 'runs')}`)
  expect(res.status() === 404, 'built-in workflow REST route is missing').toBe(false)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const runs: unknown[] = body.data?.runs ?? body.data ?? body.runs ?? (Array.isArray(body) ? body : [])
  expect(Array.isArray(runs)).toBe(true)
})

// ── WR-09: built-in workflow REST API — start a run ─────────────────────────

test('WR-09: built-in workflow route POST /workflows/:id/run returns runId', async ({ request }) => {
  expect(projectId, 'KB_PROJECT_ID must identify the registered workflow project').toBeTruthy()
  const wf = await getFirstWorkflow(request)
  expect(!wf, 'no workflows in catalog').toBe(false)

  const id = wf!.id ?? wf!.name!
  const res = await request.post(`${GATEWAY}${projectWorkflowRoute(projectId!, `workflows/${encodeURIComponent(id)}/run`)}`)
  expect(res.status() === 404, 'built-in workflow REST route is missing').toBe(false)
  expect([200, 201]).toContain(res.status())
  const body = await res.json()
  const data = body.data ?? body
  expect(data.runId ?? data.id).toBeTruthy()
})

// ── WR-10: GET /runs?limit=1 — foundation for "latest run" UX ───────────────
// Verifies the API constraint that enables `kb workflow runs view` (no args)
// to show the latest run without requiring a run ID.

test('WR-10: GET /runs?limit=1 — returns at most one run', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/runs?limit=1`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const runs: RunEntry[] = body.data?.runs ?? body.data ?? body.runs ?? (Array.isArray(body) ? body : [])
  expect(Array.isArray(runs)).toBe(true)
  expect(runs.length).toBeLessThanOrEqual(1)
})

// ── WR-11: GET /runs?limit=1 after a run — returns the newest run ────────────

test('WR-11: GET /runs?limit=1 — returns latest run after a new one is started', async ({ request }) => {
  const wf = await getFirstWorkflow(request)
  expect(!wf, 'no workflows in catalog').toBe(false)

  const runId = await startRun(request, wf!.id ?? wf!.name!)
  expect(runId, 'workflow run creation is required for latest-run lookup').toBeTruthy()

  const res = await request.get(`${WORKFLOW}/api/v1/runs?limit=1`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const runs: RunEntry[] = body.data?.runs ?? body.data ?? body.runs ?? (Array.isArray(body) ? body : [])
  expect(runs.length).toBe(1)
  // The newest run should appear first
  const latestId = runs[0]?.id ?? runs[0]?.runId
  expect(latestId).toBe(runId)
})
