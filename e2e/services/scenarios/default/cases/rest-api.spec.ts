import { test, expect } from '@playwright/test'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

// ── Observability describe ────────────────────────────────────────────────────

test('RA-01: GET /observability/describe returns service identity', async ({ request }) => {
  const res = await request.get(`${REST}/observability/describe`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const desc = body.data ?? body
  expect(typeof (desc.serviceId ?? desc.id)).toBe('string')
  expect(typeof desc.serviceType).toBe('string')
  expect(typeof desc.version).toBe('string')
})

// ── Prometheus metrics ────────────────────────────────────────────────────────

test('RA-02: GET /api/v1/metrics returns Prometheus exposition with process metrics', async ({ request }) => {
  const res = await request.get(`${REST}${REST_API_PREFIX}/metrics`)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toMatch(/text/)
  const text = await res.text()
  expect(text).toMatch(/http_request_duration_ms|kb_plugins_mount_total/)
  expect(text).toMatch(/^# HELP /m)
})

// ── OpenAPI plugins registry ──────────────────────────────────────────────────

test('RA-03: GET /openapi-plugins.json returns merged OpenAPI with paths', async ({ request }) => {
  const res = await request.get(`${REST}/openapi-plugins.json`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const spec = body.data ?? body
  expect(typeof spec).toBe('object')
  const hasPaths = spec.paths !== undefined || Array.isArray(spec) || spec.info !== undefined
  expect(hasPaths).toBe(true)
})

// ── Observability health ──────────────────────────────────────────────────────

test('RA-04: GET /observability/health returns status field', async ({ request }) => {
  const res = await request.get(`${REST}/observability/health`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const status = body.data?.status ?? body.status
  expect(status).toMatch(/ok|healthy|degraded|unhealthy/)
})

// ── State broker proxy ────────────────────────────────────────────────────────

test('RA-05: GET /observability/state-broker returns ok flag or 503', async ({ request }) => {
  const res = await request.get(`${REST}/observability/state-broker`)
  expect([200, 503]).toContain(res.status())
  const body = await res.json()
  expect(typeof body.ok).toBe('boolean')
  if (res.status() === 200) {
    expect(typeof body.data?.totalEntries).toBe('number')
  }
})

// ── Analytics ─────────────────────────────────────────────────────────────────

test('RA-06: GET /analytics/stats returns stats or 501 with error code', async ({ request }) => {
  const res = await request.get(`${REST}/analytics/stats`)
  expect([200, 501]).toContain(res.status())
  const body = await res.json()
  if (res.status() === 200) {
    expect(typeof body.data ?? body).toBe('object')
  } else {
    expect(body.error?.code).toBe('ANALYTICS_NOT_IMPLEMENTED')
  }
})

// ── LLM adapter usage ─────────────────────────────────────────────────────────

test('RA-08: GET /adapters/llm/usage returns usage stats or 501', async ({ request }) => {
  const res = await request.get(`${REST}/adapters/llm/usage`)
  expect([200, 501]).toContain(res.status())
  const body = await res.json()
  if (res.status() === 200) {
    expect(body.ok).toBe(true)
    const stats = body.data
    expect(typeof stats.totalRequests).toBe('number')
    expect(typeof stats.totalTokens).toBe('number')
    expect(typeof stats.byModel).toBe('object')
  } else {
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('ANALYTICS_NOT_IMPLEMENTED')
  }
})

// ── Additional adapter usage endpoints ───────────────────────────────────────

test('RA-09: GET /adapters/embeddings/usage returns stats or 501', async ({ request }) => {
  const res = await request.get(`${REST}/adapters/embeddings/usage`)
  expect([200, 501]).toContain(res.status())
  const body = await res.json()
  if (res.status() === 200) {
    expect(body.ok).toBe(true)
    expect(typeof body.data.totalRequests).toBe('number')
  } else {
    expect(body.error?.code).toBe('ANALYTICS_NOT_IMPLEMENTED')
  }
})

test('RA-10: retired storage analytics endpoint is not registered', async ({ request }) => {
  const res = await request.get(`${REST}/adapters/storage/usage`)
  expect(res.status()).toBe(404)
})

test('RA-11: retired cache analytics endpoint is not registered', async ({ request }) => {
  const res = await request.get(`${REST}/adapters/cache/usage`)
  expect(res.status()).toBe(404)
})

test('RA-12: retired vector-store analytics endpoint is not registered', async ({ request }) => {
  const res = await request.get(`${REST}/adapters/vectorstore/usage`)
  expect(res.status()).toBe(404)
})
