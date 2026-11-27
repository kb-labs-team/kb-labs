import { test, expect } from '@playwright/test'
import { REST } from '@kb-labs/e2e-shared/urls.js'
import { decodeUxSuccessResult } from '@kb-labs/core-platform/ux-result'

const BASE = `${REST}/api/v1`

interface HealthPayload {
  schema: string
  uptimeSec: number
  version: { kbLabs: string }
  registry: {
    total: number
    withRest: number
    withStudio: number
    errors: number
    partial: boolean
    stale: boolean
  }
  status: string
  components: unknown[]
  ts: string
}

// Sprint 1 — Базовое здоровье сервера
// REST handlers do not enforce auth themselves; project-scoped Gateway routes do.
//
// Envelope middleware wraps every successful JSON response in the UX result contract.

test('RA-H-01: GET /health returns 200 with kb.health/1 schema', async ({ request }) => {
  const res = await request.get(`${BASE}/health`)
  expect(res.status()).toBe(200)
  const data = decodeUxSuccessResult<HealthPayload>(await res.json())
  expect(data.schema).toBe('kb.health/1')
})

test('RA-H-02: GET /health response contains required top-level fields', async ({ request }) => {
  const res = await request.get(`${BASE}/health`)
  expect(res.status()).toBe(200)
  const data = decodeUxSuccessResult<HealthPayload>(await res.json())
  expect(typeof data.uptimeSec).toBe('number')
  expect(data.uptimeSec).toBeGreaterThanOrEqual(0)
  expect(data.version).toBeDefined()
  expect(typeof data.version.kbLabs).toBe('string')
  expect(data.registry).toBeDefined()
  expect(['healthy', 'degraded', 'unhealthy']).toContain(data.status)
  expect(Array.isArray(data.components)).toBe(true)
})

test('RA-H-03: GET /health response contains X-Request-Id header', async ({ request }) => {
  const res = await request.get(`${BASE}/health`)
  expect(res.status()).toBe(200)
  expect(res.headers()['x-request-id']).toBeTruthy()
})

test('RA-H-04: GET /health registry block has required shape', async ({ request }) => {
  const res = await request.get(`${BASE}/health`)
  const data = decodeUxSuccessResult<HealthPayload>(await res.json())
  const reg = data.registry
  expect(typeof reg.total).toBe('number')
  expect(typeof reg.withRest).toBe('number')
  expect(typeof reg.withStudio).toBe('number')
  expect(typeof reg.errors).toBe('number')
  expect(typeof reg.partial).toBe('boolean')
  expect(typeof reg.stale).toBe('boolean')
})

test('RA-H-05: GET /health ts field is a valid ISO-8601 timestamp', async ({ request }) => {
  const res = await request.get(`${BASE}/health`)
  const data = decodeUxSuccessResult<HealthPayload>(await res.json())
  const ts = Date.parse(data.ts)
  expect(Number.isNaN(ts)).toBe(false)
})
