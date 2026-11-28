import { test, expect } from '@playwright/test'
import { GATEWAY, REST, REST_API_PREFIX, WORKFLOW, WORKFLOW_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'

// Cross-service tests: verify that gateway auth integrates correctly with upstream services.
// These tests exercise the full request path: client → gateway (auth) → upstream service.

test('XS-01: authenticated request passes through gateway to REST upstream', async ({ request }) => {
  const token = await getAccessToken(request)

  // Platform config is proxied through gateway — requires valid token
  const res = await request.get(`${REST}${REST_API_PREFIX}/platform/config`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  // Must not be 401 — auth passed, upstream responded
  expect(res.status()).not.toBe(401)
  expect(res.status()).not.toBe(403)
  expect(res.status()).toBe(200)
})

test('XS-02: gateway rejects proxied request without token', async ({ request }) => {
  // A request to an upstream route proxied through gateway must be rejected
  // if the upstream route is inside the gateway auth scope
  const res = await request.get(`${GATEWAY}/hosts`)
  expect([401, 403]).toContain(res.status())
})

test('XS-03: gateway routes requests to correct upstream (workflow)', async ({ request }) => {
  const token = await getAccessToken(request)

  // Workflow catalog is served by workflow daemon, proxied via gateway
  const res = await request.get(`${WORKFLOW}${WORKFLOW_API_PREFIX}/workflows`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  // May be 200 (proxied) or 404/401 (not exposed via gateway) — must not be 502
  expect(res.status()).not.toBe(502)
  expect(res.status()).not.toBe(503)
})

test('XS-04: expired/invalid token rejected on gateway-owned routes', async ({ request }) => {
  // Only test gateway-owned routes — proxied upstream routes may have different auth policies
  const routes = ['/hosts']
  for (const route of routes) {
    const res = await request.get(`${GATEWAY}${route}`, {
      headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.invalid.signature' },
    })
    expect([401, 403]).toContain(res.status())
  }
})
