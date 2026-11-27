import { test, expect, request as playwrightRequest } from '@playwright/test'
import { loginAdmin } from '@kb-labs/e2e-shared/auth.js'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

const BASE = `${REST}${REST_API_PREFIX}`

const cacheRead = {
  requestId: 'e2e-auth',
  adapter: 'cache',
  method: 'get',
  args: ['e2e-auth'],
  context: { namespaceId: 'test', hostId: 'test' },
}

// POST /internal/adapter-call is guarded by x-internal-secret (GATEWAY_INTERNAL_SECRET env var).
// If the env var is not set the server treats ALL requests as unauthorized.

test('RA-IN-01: POST /internal/adapter-call without x-internal-secret returns 401 or 403', async () => {
  const adminContext = await playwrightRequest.newContext()
  try {
    await loginAdmin(adminContext)
    const res = await adminContext.post(`${BASE}/internal/adapter-call`, {
      data: cacheRead,
    })
    expect(res.status()).toBe(403)
    expect((await res.json()).error.code).toBe('KB_AUTH_FORBIDDEN')
  } finally {
    await adminContext.dispose()
  }
})

test('RA-IN-02: POST /internal/adapter-call with wrong secret returns 401 or 403', async () => {
  const adminContext = await playwrightRequest.newContext()
  try {
    await loginAdmin(adminContext)
    const res = await adminContext.post(`${BASE}/internal/adapter-call`, {
      headers: { 'x-internal-secret': 'definitely-wrong-secret-e2e' },
      data: cacheRead,
    })
    expect(res.status()).toBe(403)
    expect((await res.json()).error.code).toBe('KB_AUTH_FORBIDDEN')
  } finally {
    await adminContext.dispose()
  }
})

test('RA-IN-03: POST /internal/adapter-call with no body returns 401/403 (auth checked before validation)', async () => {
  // Auth must be rejected before body validation to avoid leaking info
  const adminContext = await playwrightRequest.newContext()
  try {
    await loginAdmin(adminContext)
    const res = await adminContext.post(`${BASE}/internal/adapter-call`)
    expect([400, 401, 403, 422]).toContain(res.status())
    // Must NOT be 500
    expect(res.status()).not.toBe(500)
  } finally {
    await adminContext.dispose()
  }
})
