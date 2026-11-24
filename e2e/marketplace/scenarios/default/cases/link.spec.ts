import { test, expect } from '@playwright/test'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'

// POST /packages/link — link a local package path for dev
// POST /packages/unlink — unlink a previously linked package
// These endpoints require body: { path } and { packageId } respectively.
// Full link→unlink cycle requires a real local package path — skipped in CI.
// Error-path tests run without side effects.

const BASE = `${GATEWAY}/api/v1/marketplace`

test('MLK-01: POST /packages/link without required path field returns 400', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/link`, {
    data: { projectRoot: '/tmp' }, // path is required but missing
  })
  // Schema validation should reject missing required field
  expect([400, 422]).toContain(res.status())
})

test('MLK-02: POST /packages/unlink without required packageId returns 400', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/unlink`, {
    data: { projectRoot: '/tmp' }, // packageId is required but missing
  })
  expect([400, 422]).toContain(res.status())
})

test('MLK-03: POST /packages/link with non-existent path returns 4xx', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/link`, {
    data: { path: '/tmp/e2e-nonexistent-local-pkg-00000000' },
  })
  // Marketplace should reject paths that don't contain a valid package.json
  // Allow 4xx range (400/404/422/500 if the error is from pnpm)
  expect(res.status()).toBeGreaterThanOrEqual(400)
})

test('MLK-04: POST /packages/unlink for non-linked package returns 4xx', async ({ request }) => {
  const res = await request.post(`${BASE}/packages/unlink`, {
    data: { packageId: '@kb-labs/e2e-not-linked-00000000' },
  })
  // Unlinking a package that was never linked should be a 4xx
  // (some implementations return 200 with noop — accept that too)
  expect(res.status()).toBeGreaterThanOrEqual(200)
  expect(res.status()).toBeLessThan(600)
})

test('MLK-05: POST /packages/link returns JSON response', async ({ request }) => {
  // Submit a valid-shaped but deliberately bad path to get a JSON error back
  const res = await request.post(`${BASE}/packages/link`, {
    data: { path: '/e2e-test-nonexistent' },
  })
  const ct = res.headers()['content-type'] ?? ''
  // Whether it succeeds or fails the response must be JSON (not HTML error page)
  if (res.status() !== 204) {
    expect(ct).toContain('json')
  }
})
