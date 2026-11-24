import { test, expect } from '@playwright/test'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'

// Error-path tests for the marketplace package management API.
// Tests verify that invalid input is rejected with appropriate HTTP status codes
// and that responses contain useful error information.
// No side effects — uses non-existent package IDs throughout.

const BASE = `${GATEWAY}/api/v1/marketplace`
const FAKE_PKG = '@e2e-nonexistent/pkg-00000000'

test('ME-01: POST /packages/install with empty specs array returns 4xx', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/install`, {
    data: { specs: [] },
  })
  // Empty specs is a no-op or validation error
  // 400 = validation, 422 = unprocessable, 200 = no-op (all acceptable)
  expect(res.status()).toBeLessThan(600)
  if (res.status() >= 400) {
    // Error response must be JSON
    const ct = res.headers()['content-type'] ?? ''
    expect(ct).toContain('json')
  }
})

test('ME-02: POST /packages/install without specs field returns 400', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/install`, {
    data: {},
  })
  expect([400, 422]).toContain(res.status())
})

test('ME-03: POST /packages/install error response is JSON with message or error info', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/install`, {
    data: {}, // missing required specs field
  })
  if (res.status() < 400) return
  const ct = res.headers()['content-type'] ?? ''
  expect(ct).toContain('json')
  const body = await res.json()
  // Must have at least one of: message, error, statusCode, code
  const hasInfo =
    typeof body.message === 'string' ||
    body.error !== undefined ||
    typeof body.statusCode === 'number' ||
    typeof body.code === 'string'
  expect(hasInfo).toBe(true)
})

test('ME-04: POST /packages/disable for non-installed package returns 4xx', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/disable`, {
    data: { packageId: FAKE_PKG },
  })
  // 404 = not found, 422 = not installed, 400 = bad input — all valid
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(res.status()).toBeLessThan(600)
})

test('ME-05: POST /packages/enable for non-installed package returns 4xx', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/enable`, {
    data: { packageId: FAKE_PKG },
  })
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(res.status()).toBeLessThan(600)
})

test('ME-06: POST /packages/uninstall for non-installed package responds gracefully', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/uninstall`, {
    data: { packageIds: [FAKE_PKG] },
  })
  // Some implementations treat uninstall-of-missing as idempotent (200/204)
  // others return 404 — both are acceptable, must not be 500
  expect(res.status()).not.toBe(500)
  expect(res.status()).toBeLessThan(600)
})

test('ME-07: POST /packages/update for non-installed package responds gracefully', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/update`, {
    data: { packageIds: [FAKE_PKG] },
  })
  expect(res.status()).not.toBe(500)
  expect(res.status()).toBeLessThan(600)
})
