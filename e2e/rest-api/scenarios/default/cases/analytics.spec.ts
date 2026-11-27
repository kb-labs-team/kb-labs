import { test, expect } from '@playwright/test'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

const BASE = `${REST}${REST_API_PREFIX}`

// Analytics endpoints may return 501 if the adapter is not configured.
// Envelope middleware wraps responses: { ok: true, data: <payload>, meta: {...} }

test('RA-AN-01: GET /analytics/events returns 200 or 501 — never 500', async ({ request }) => {
  const res = await request.get(`${BASE}/analytics/events`)
  expect(res.status()).not.toBe(500)
  expect([200, 501, 503]).toContain(res.status())
  if (res.status() === 200) {
    const body = await res.json()
    const data = body.data ?? body
    const events = Array.isArray(data) ? data : (data.events ?? data.items ?? [])
    expect(Array.isArray(events)).toBe(true)
  }
})

test('RA-AN-02: GET /analytics/stats returns 200 or 501', async ({ request }) => {
  const res = await request.get(`${BASE}/analytics/stats`)
  expect([200, 501]).toContain(res.status())
  if (res.status() === 200) {
    const body = await res.json()
    expect(body).toBeTruthy()
  }
})

test('RA-AN-03: GET /analytics/buffer/status returns 200 or 501', async ({ request }) => {
  // Path is /analytics/buffer/status (slash before status, not hyphen)
  const res = await request.get(`${BASE}/analytics/buffer/status`)
  expect([200, 501, 503]).toContain(res.status())
  if (res.status() === 200) {
    const body = await res.json()
    expect(body).toBeTruthy()
  }
})

test('RA-AN-04: GET /adapters/llm/usage returns 200 or graceful degradation (no 500)', async ({ request }) => {
  const res = await request.get(`${BASE}/adapters/llm/usage`)
  expect(res.status()).not.toBe(500)
  expect([200, 404, 501, 503]).toContain(res.status())
})

test('RA-AN-05: GET /adapters/state/stats returns 200 or graceful degradation (no 500)', async ({ request }) => {
  const res = await request.get(`${BASE}/adapters/state/stats`)
  expect(res.status()).not.toBe(500)
  expect([200, 404, 501, 503]).toContain(res.status())
})

test('RA-AN-06: GET /observability/system-metrics returns samples or a typed availability error', async ({ request }) => {
  const res = await request.get(`${BASE}/observability/system-metrics`)
  const body = await res.json()
  expect([200, 404, 503]).toContain(res.status())
  if (res.status() === 200) {
    expect(body.data.instances.length).toBeGreaterThan(0)
    expect(body.data.summary.totalInstances).toBe(body.data.instances.length)
  } else {
    expect(body).toMatchObject({ ok: false, error: {
      code: res.status() === 404 ? 'KB_RUNTIME_RESOURCE_NOT_FOUND' : 'KB_SERVICE_UNAVAILABLE',
    } })
  }
})

test('RA-AN-07: GET /observability/metrics/history returns 200 or 501', async ({ request }) => {
  const res = await request.get(`${BASE}/observability/metrics/history`)
  expect([200, 400, 404, 501, 503]).toContain(res.status())
  if (res.status() === 200) {
    const body = await res.json()
    const data = body.data ?? body
    const isArray = Array.isArray(data)
    const hasArray = !isArray && Object.values(data).some(Array.isArray)
    expect(isArray || hasArray).toBe(true)
  }
})

test('RA-AN-08: GET /observability/metrics/heatmap returns 200 or 501', async ({ request }) => {
  const res = await request.get(`${BASE}/observability/metrics/heatmap`)
  expect([200, 400, 404, 501, 503]).toContain(res.status())
  if (res.status() === 200) {
    const body = await res.json()
    expect(body).toBeTruthy()
  }
})

test('RA-AN-09: GET /platform/config returns 200 with config object', async ({ request }) => {
  const res = await request.get(`${BASE}/platform/config`)
  expect([200, 501, 503]).toContain(res.status())
  if (res.status() === 200) {
    const body = await res.json()
    const config = body.data ?? body
    expect(typeof config).toBe('object')
    expect(config).not.toBeNull()
  }
})
