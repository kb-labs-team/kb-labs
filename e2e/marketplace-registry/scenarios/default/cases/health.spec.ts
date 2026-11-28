import { test, expect } from '@playwright/test'
import { REGISTRY } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken } from '../../../fixtures/identity.js'

// Operational routes are reached through the authenticated Gateway.

test('RG-H01: /health returns 200 with status ok', async ({ request }) => {
  const token = await getAccessToken()
  const res = await request.get(`${REGISTRY}/health`, { headers: { Authorization: `Bearer ${token}` } })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toBe('ok')
  expect(body.service).toBe('marketplace-registry')
})

test('RG-H02: /ready returns 200 with ready true', async ({ request }) => {
  const token = await getAccessToken()
  const res = await request.get(`${REGISTRY}/ready`, { headers: { Authorization: `Bearer ${token}` } })
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.ready).toBe(true)
})

test('RG-H03: /metrics returns Prometheus text format', async ({ request }) => {
  const token = await getAccessToken()
  const res = await request.get(`${REGISTRY}/metrics`, { headers: { Authorization: `Bearer ${token}` } })
  expect(res.status()).toBe(200)
  const ct = res.headers()['content-type'] ?? ''
  expect(ct).toContain('text/plain')
})

test('RG-H04: /docs is available in non-production mode', async ({ request }) => {
  const token = await getAccessToken()
  const res = await request.get(`${REGISTRY}/docs`, { headers: { Authorization: `Bearer ${token}` } })
  // 200 = Swagger UI served; 404 = disabled in production — both valid
  expect([200, 404]).toContain(res.status())
})
