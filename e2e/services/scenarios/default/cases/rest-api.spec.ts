import { test, expect } from '@playwright/test'
import { REST } from '@kb-labs/e2e-shared/urls.js'

// ── Analytics ─────────────────────────────────────────────────────────────────

test('RA-06: GET /analytics/stats returns stats or 501 with error code', async ({ request }) => {
  const res = await request.get(`${REST}/analytics/stats`)
  expect([200, 501]).toContain(res.status())
  const body = await res.json()
  if (res.status() === 200) {
    expect(typeof body.data.totalEvents).toBe('number')
  } else {
    expect(body.error?.code).toBe('KB_ANALYTICS_STATS_UNSUPPORTED')
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
