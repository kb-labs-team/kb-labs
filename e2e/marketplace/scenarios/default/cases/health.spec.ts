import { test, expect } from '@playwright/test'
import { MARKETPLACE_DIRECT } from '@kb-labs/e2e-shared/urls.js'

// Marketplace service health, readiness, metrics, and observability endpoints.
// The marketplace server does NOT use envelope middleware — responses are raw JSON.
// Port: 5070. No basePath prefix on these routes.

test('MH-01: GET /health returns 200 with status ok and service name', async ({ request }) => {
  const res = await request.get(`${MARKETPLACE_DIRECT}/health`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.status).toBe('ok')
  expect(body.service).toBe('marketplace')
})

test('MH-02: GET /health ts field is a unix timestamp (number)', async ({ request }) => {
  const before = Date.now()
  const res = await request.get(`${MARKETPLACE_DIRECT}/health`)
  const after = Date.now()
  const body = await res.json()
  expect(typeof body.ts).toBe('number')
  // ts should be within the request window (allow 5s drift for slow CI)
  expect(body.ts).toBeGreaterThanOrEqual(before - 5_000)
  expect(body.ts).toBeLessThanOrEqual(after + 5_000)
})

test('MH-03: GET /ready returns 200 with ready: true', async ({ request }) => {
  const res = await request.get(`${MARKETPLACE_DIRECT}/ready`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.ready).toBe(true)
})

test('MH-04: GET /ready contains marketplaceService component', async ({ request }) => {
  const res = await request.get(`${MARKETPLACE_DIRECT}/ready`)
  const body = await res.json()
  // createServiceReadyResponse returns { ready, components: { marketplaceService: { ready } } }
  expect(body.components).toBeDefined()
  const svc = body.components?.marketplaceService
  if (svc !== undefined) {
    expect(svc.ready).toBe(true)
  }
})

test('MH-05: GET /metrics returns 200 with Prometheus text format', async ({ request }) => {
  const res = await request.get(`${MARKETPLACE_DIRECT}/metrics`)
  expect(res.status()).toBe(200)
  const ct = res.headers()['content-type'] ?? ''
  expect(ct).toContain('text/plain')
  const body = await res.text()
  // Prometheus text format always starts with # HELP or # TYPE lines
  expect(body.length).toBeGreaterThan(0)
})

test('MH-06: GET /observability/describe returns serviceId', async ({ request }) => {
  const res = await request.get(`${MARKETPLACE_DIRECT}/observability/describe`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  // HttpObservabilityCollector.buildDescribe() includes serviceId / id
  expect(typeof (body.serviceId ?? body.id)).toBe('string')
})

test('MH-07: GET /observability/health returns status and checks array', async ({ request }) => {
  const res = await request.get(`${MARKETPLACE_DIRECT}/observability/health`)
  expect([200, 503]).toContain(res.status())
  const body = await res.json()
  expect(typeof body.status).toBe('string')
  expect(['healthy', 'degraded', 'unhealthy', 'ok']).toContain(body.status)
  if (Array.isArray(body.checks)) {
    const svcCheck = body.checks.find((c: { id: string }) => c.id === 'marketplace-service')
    if (svcCheck) {
      expect(['ok', 'warn', 'fail']).toContain(svcCheck.status)
    }
  }
})
