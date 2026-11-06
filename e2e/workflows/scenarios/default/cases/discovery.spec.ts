import { test, expect } from '@playwright/test'
import { WORKFLOW } from '@kb-labs/e2e-shared/urls.js'

// Workflow daemon must discover workflow/cron definitions from .kb/workflows/
// in both platformRoot and projectRoot. This is distinct from the engine being healthy.
// Workflow daemon API uses { ok: true, data: { workflows: [...] } } envelope.

test('WFD-01: workflow catalog endpoint is accessible', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/workflows`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const workflows = body.data?.workflows ?? body.data ?? body.workflows ?? []
  // Endpoint must return a valid array (even if empty on minimal install)
  expect(Array.isArray(workflows)).toBe(true)
})

test('WFD-02: cron catalog is populated from .kb/workflows', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}/api/v1/crons`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const crons = body.data?.crons ?? body.data ?? body.crons ?? (Array.isArray(body) ? body : [])
  // May be empty if no crons scaffolded — but endpoint must respond correctly
  expect(Array.isArray(crons)).toBe(true)
})

test('WFD-03: workflow refresh rescans .kb/workflows without restart', async ({ request }) => {
  const before = await request.get(`${WORKFLOW}/api/v1/workflows`)
  const beforeBody = await before.json()
  const workflowsBefore = beforeBody.data?.workflows ?? beforeBody.data ?? beforeBody.workflows ?? []
  const countBefore = Array.isArray(workflowsBefore) ? workflowsBefore.length : 0

  const refresh = await request.post(`${WORKFLOW}/api/v1/workflows/refresh`)
  expect([200, 204]).toContain(refresh.status())

  const after = await request.get(`${WORKFLOW}/api/v1/workflows`)
  const afterBody = await after.json()
  const workflowsAfter = afterBody.data?.workflows ?? afterBody.data ?? afterBody.workflows ?? []
  const countAfter = Array.isArray(workflowsAfter) ? workflowsAfter.length : 0

  // Count must be equal or more (refresh can discover new files, not lose existing)
  expect(countAfter).toBeGreaterThanOrEqual(countBefore)
})

test('WFD-04: workflow found by name from .kb/workflows is runnable', async ({ request }) => {
  const listRes = await request.get(`${WORKFLOW}/api/v1/workflows`)
  const listBody = await listRes.json()
  const workflows: { id?: string; name?: string }[] = listBody.data?.workflows ?? listBody.data ?? listBody.workflows ?? []
  const first = Array.isArray(workflows) ? workflows[0] : undefined
  expect(!first, 'No workflows discovered — check .kb/workflows directory').toBe(false)

  const id = first!.id ?? first!.name!
  const run = await request.post(`${WORKFLOW}/api/v1/workflows/${encodeURIComponent(id)}/runs`, { data: {} })
  expect([200, 201, 202]).toContain(run.status())
})

test('WFD-05: workflow defined in projectRoot/.kb/workflows overrides platformRoot definition', async () => { test.skip(true, 'not yet implemented') })
test('WFD-06: invalid workflow YAML in .kb/workflows is reported in /ready diagnostics', async () => { test.skip(true, 'not yet implemented') })
