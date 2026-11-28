import { test, expect } from '@playwright/test'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { listTools, postMcp } from './_helpers.js'

// MCP tools/list — secured mode rejects anonymous callers; authenticated callers see the
// plugin-command tool catalog derived live from manifests.

test.describe('without a saved session', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('M-01: anonymous tools/list returns 401', async ({ request }) => {
    const response = await postMcp(request, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(response.status).toBe(401)
  })
})

test('M-02: authenticated tools/list returns a non-empty catalog', async ({ request }) => {
  const token = await getAccessToken(request)
  const tools = await listTools(request, token)
  expect(tools.length).toBeGreaterThan(0)
})

test('M-03: every tool has name, description and an object input schema', async ({ request }) => {
  const token = await getAccessToken(request)
  const tools = await listTools(request, token)
  for (const tool of tools) {
    expect(typeof tool.name).toBe('string')
    expect(typeof tool.description).toBe('string')
    expect(tool.inputSchema).toBeTruthy()
  }
})

test('M-04: tool names are pluginId-namespaced (collision-safe)', async ({ request }) => {
  const token = await getAccessToken(request)
  const tools = await listTools(request, token)
  for (const tool of tools) {
    // `${pluginId}__${command_path}` — lowercase/digit/dash plugin, `__`, underscore path.
    expect(tool.name).toMatch(/^[a-z0-9-]+__[a-z0-9_]+$/)
  }
})
