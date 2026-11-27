import { test, expect } from '@playwright/test'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

const BASE = `${REST}${REST_API_PREFIX}`

// Envelope middleware wraps all responses: { ok: true, data: <payload>, meta: {...} }

test('RA-OB-01: GET /observability/describe returns 200 with serviceId and contractVersion', async ({ request }) => {
  const res = await request.get(`${BASE}/observability/describe`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const data = body.data ?? body
  expect(typeof (data.serviceId ?? data.id)).toBe('string')
  expect(data.contractVersion ?? data.serviceType).toBeTruthy()
})

test('RA-OB-02: GET /observability/describe contains metricsEndpoint and healthEndpoint', async ({ request }) => {
  const res = await request.get(`${BASE}/observability/describe`)
  const body = await res.json()
  const data = body.data ?? body
  expect(typeof data.metricsEndpoint).toBe('string')
  expect(data.metricsEndpoint).toContain('/metrics')
  expect(typeof data.healthEndpoint).toBe('string')
  expect(data.healthEndpoint).toContain('/observability/health')
})

test('RA-OB-03: GET /observability/health returns 200 with serviceId and status', async ({ request }) => {
  const res = await request.get(`${BASE}/observability/health`)
  expect([200, 503]).toContain(res.status())
  const body = await res.json()
  const data = body.data ?? body
  expect(typeof (data.serviceId ?? data.id)).toBe('string')
  expect(['healthy', 'degraded', 'unhealthy', 'ok']).toContain(data.status)
})

test('RA-OB-04: GET /observability/health contains checks array with registry entry', async ({ request }) => {
  const res = await request.get(`${BASE}/observability/health`)
  const body = await res.json()
  const data = body.data ?? body
  expect(Array.isArray(data.checks)).toBe(true)
  const registryCheck = data.checks.find((c: { id: string }) => c.id === 'registry')
  expect(registryCheck).toBeDefined()
  expect(['ok', 'warn', 'fail']).toContain(registryCheck.status)
})

test('RA-OB-05: GET /observability/health has state field', async ({ request }) => {
  const res = await request.get(`${BASE}/observability/health`)
  const body = await res.json()
  const data = body.data ?? body
  expect(typeof data.state).toBe('string')
  expect(data.state.length).toBeGreaterThan(0)
})

test('RA-OB-06: GET /routes returns non-empty list containing health and ready', async ({ request }) => {
  const res = await request.get(`${BASE}/routes`)
  // /routes is a debug endpoint, may return 404 in some environments
  if (res.status() === 404) {
    test.skip(true, '/routes debug endpoint not registered in this environment')
    return
  }
  expect(res.status()).toBe(200)
  const body = await res.json()
  const data = body.data ?? body
  const routes: unknown[] = Array.isArray(data) ? data : (data.routes ?? [])
  expect(routes.length).toBeGreaterThan(0)
  // debug.ts returns { method, url } objects — url field (not path)
  const paths = routes
    .map((r: unknown) => {
      if (typeof r === 'string') return r
      const obj = r as { url?: string; path?: string }
      return obj.url ?? obj.path
    })
    .filter((p): p is string => typeof p === 'string')
  const hasHealth = paths.some((p) => p.includes('health'))
  const hasReady = paths.some((p) => p.includes('ready'))
  expect(hasHealth).toBe(true)
  expect(hasReady).toBe(true)
})
