import { test, expect } from '@playwright/test'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'
import { decodeUxSuccessResult } from '@kb-labs/core-platform/ux-result'

const BASE = `${REST}${REST_API_PREFIX}`

interface ReadinessPayload {
  schema: string
  ready: boolean
  status: string
  reason: string
  components: {
    cliApi: { initialized: boolean }
    registry: { loaded: boolean }
    plugins: { mounted: boolean }
  }
}

// Envelope middleware wraps all successful JSON responses in the UX result contract.

test('RA-RD-01: GET /ready returns 200 or 503 — never crashes', async ({ request }) => {
  const res = await request.get(`${BASE}/ready`)
  expect([200, 503]).toContain(res.status())
})

test('RA-RD-02: GET /ready response has kb.ready/1 schema', async ({ request }) => {
  const res = await request.get(`${BASE}/ready`)
  const data = decodeUxSuccessResult<ReadinessPayload>(await res.json())
  expect(data.schema).toBe('kb.ready/1')
})

test('RA-RD-03: GET /ready response has required top-level fields', async ({ request }) => {
  const res = await request.get(`${BASE}/ready`)
  const data = decodeUxSuccessResult<ReadinessPayload>(await res.json())
  expect(typeof data.ready).toBe('boolean')
  expect(['ready', 'degraded', 'initializing']).toContain(data.status)
  expect(typeof data.reason).toBe('string')
  expect(data.reason.length).toBeGreaterThan(0)
  expect(data.components).toBeDefined()
})

test('RA-RD-04: GET /ready components block has cliApi, registry, plugins', async ({ request }) => {
  const res = await request.get(`${BASE}/ready`)
  const data = decodeUxSuccessResult<ReadinessPayload>(await res.json())
  const c = data.components
  expect(c.cliApi).toBeDefined()
  expect(typeof c.cliApi.initialized).toBe('boolean')
  expect(c.registry).toBeDefined()
  expect(typeof c.registry.loaded).toBe('boolean')
  expect(c.plugins).toBeDefined()
  expect(typeof c.plugins.mounted).toBe('boolean')
})

test('RA-RD-05: GET /ready when 200 — ready is true and status is ready', async ({ request }) => {
  const res = await request.get(`${BASE}/ready`)
  if (res.status() !== 200) {
    test.skip(true, `Service not fully ready yet (${res.status()}) — skipping readiness assertion`)
    return
  }
  const data = decodeUxSuccessResult<ReadinessPayload>(await res.json())
  expect(data.ready).toBe(true)
  expect(data.status).toBe('ready')
  expect(data.reason).toBe('ready')
})

test('RA-RD-06: GET /ready when 503 — ready is false with a non-empty reason', async ({ request }) => {
  const res = await request.get(`${BASE}/ready`)
  if (res.status() !== 503) {
    test.skip(true, 'Service is ready — 503 path not exercisable right now')
    return
  }
  const body = await res.json()
  expect(body).toMatchObject({ ok: false, error: {
    code: 'KB_SERVICE_UNAVAILABLE',
    details: { service: 'rest', status: expect.any(String) },
  } })
})
