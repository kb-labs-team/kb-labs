import { test, expect } from '@playwright/test'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { listTools, postMcp } from './_helpers.js'

// Secured MCP validates the gateway-issued Bearer token and rejects missing or
// invalid credentials with HTTP 401.
//
// Granular per-operation visibility (read vs write hiding) is enforced by the
// PDP and covered by unit tests on filterTools/authz. Today the PDP is permit-all,
// so any valid identity sees the full catalog; these specs assert the
// authenticated-vs-anonymous boundary, which is the live, observable contract.

test.describe('without a saved session', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('A-01: no token → 401', async ({ request }) => {
    const response = await postMcp(request, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(response.status).toBe(401)
  })

  test('A-02: invalid token → 401', async ({ request }) => {
    const response = await postMcp(request, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'not-a-real-jwt')
    expect(response.status).toBe(401)
  })
})

test('A-03: valid token → non-empty catalog', async ({ request }) => {
  const token = await getAccessToken(request)
  const tools = await listTools(request, token)
  expect(tools.length).toBeGreaterThan(0)
})
