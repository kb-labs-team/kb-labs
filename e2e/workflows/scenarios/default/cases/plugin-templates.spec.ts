import { test, expect } from '@playwright/test'
import { WORKFLOW, WORKFLOW_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

// Workflow engine must discover and expose workflow templates
// declared in plugin manifests under workflows.templates[].
// Templates are static YAML files bundled with the plugin and
// registered in the workflow catalog with source: 'plugin'.
//
// Release plugin (@kb-labs/release) declares 3 templates:
//   full-release, hotfix, dry-run

test('WFD-P01: plugin workflow templates appear in catalog', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/workflows`)
  expect(res.status()).toBe(200)

  const body = await res.json()
  const workflows: Array<{ id: string; source?: string; description?: string }> =
    body.data?.workflows ?? body.data ?? body.workflows ?? []

  expect(Array.isArray(workflows)).toBe(true)

  const pluginTemplates = workflows.filter(w => w.id?.startsWith('plugin:@kb-labs/release/'))
  expect(pluginTemplates.length).toBeGreaterThanOrEqual(3)

  const ids = pluginTemplates.map(w => w.id)
  expect(ids).toContain('plugin:@kb-labs/release/full-release')
  expect(ids).toContain('plugin:@kb-labs/release/hotfix')
  expect(ids).toContain('plugin:@kb-labs/release/dry-run')
})

test('WFD-P02: plugin workflow template has source=plugin', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/workflows`)
  expect(res.status()).toBe(200)

  const body = await res.json()
  const workflows: Array<{ id: string; source?: string }> =
    body.data?.workflows ?? body.data ?? body.workflows ?? []

  const template = workflows.find(w => w.id === 'plugin:@kb-labs/release/full-release')
  expect(!template, 'Release plugin templates not loaded — check plugin installation').toBe(false)

  expect(template?.source).toBe('plugin')
})

test('WFD-P03: plugin workflow template has description', async ({ request }) => {
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/workflows`)
  expect(res.status()).toBe(200)

  const body = await res.json()
  const workflows: Array<{ id: string; description?: string }> =
    body.data?.workflows ?? body.data ?? body.workflows ?? []

  const template = workflows.find(w => w.id === 'plugin:@kb-labs/release/full-release')
  expect(!template, 'Release plugin templates not loaded — check plugin installation').toBe(false)

  expect(typeof template?.description).toBe('string')
  expect(template?.description?.length).toBeGreaterThan(0)
})

test('WFD-P04: plugin template is resolvable by ID', async ({ request }) => {
  const id = encodeURIComponent('plugin:@kb-labs/release/dry-run')
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/workflows/${id}`)

  // May return 200 or 404 if template is not installed — skip gracefully
  if (res.status() === 404) {
    expect(true, 'Template not found — check plugin installation and workflow discovery').toBe(false)
    return
  }

  expect(res.status()).toBe(200)
  const body = await res.json()
  const workflow = body.data ?? body
  expect(workflow.id).toBe('plugin:@kb-labs/release/dry-run')
})
