import { test, expect } from '@playwright/test'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

// Product analytics endpoints return data or 501; raw adapter telemetry routes are retired.

test('A-01: LLM adapter registered in REST API', async ({ request }) => {
  const res = await request.get(`${REST}${REST_API_PREFIX}/adapters/llm/usage`)
  expect([200, 501]).toContain(res.status())
  const body = await res.json()
  if (res.status() === 200) {
    expect(body.ok).toBe(true)
    expect(typeof body.data.totalRequests).toBe('number')
  } else {
    expect(body.error?.code).toBe('ANALYTICS_NOT_IMPLEMENTED')
  }
})

test('A-02: storage analytics route is retired', async ({ request }) => {
  const res = await request.get(`${REST}${REST_API_PREFIX}/adapters/storage/usage`)
  expect(res.status()).toBe(404)
})

test('A-03: LLM adapter responds to a real completion request', async () => {
  test.skip(true, 'requires LLM API key — not available in CI')
})
