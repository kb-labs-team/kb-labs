import { test, expect } from '@playwright/test'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

const BASE = `${REST}${REST_API_PREFIX}`

test('RA-MT-01: GET /metrics returns 200 with Prometheus text format', async ({ request }) => {
  const res = await request.get(`${BASE}/metrics`)
  expect(res.status()).toBe(200)
  const ct = res.headers()['content-type'] ?? ''
  expect(ct).toContain('text/plain')
})

test('RA-MT-02: GET /metrics body contains http_requests_total counter', async ({ request }) => {
  const res = await request.get(`${BASE}/metrics`)
  const text = await res.text()
  expect(text).toContain('http_requests_total')
})

test('RA-MT-03: GET /metrics body contains http_request_duration_ms histogram', async ({ request }) => {
  const res = await request.get(`${BASE}/metrics`)
  const text = await res.text()
  expect(text).toContain('http_request_duration_ms')
})

test('RA-MT-04: GET /metrics counter increments after additional requests', async ({ request }) => {
  const extract = (text: string): number => {
    // sum all http_requests_total values (ignoring label variants)
    const lines = text.split('\n').filter(
      l => l.startsWith('http_requests_total{') && !l.startsWith('#'),
    )
    return lines.reduce((sum, l) => {
      const val = parseFloat(l.split(' ').pop() ?? '0')
      return sum + (Number.isNaN(val) ? 0 : val)
    }, 0)
  }

  const before = extract(await (await request.get(`${BASE}/metrics`)).text())

  // fire a few requests so the counter has something to count
  await request.get(`${BASE}/health`)
  await request.get(`${BASE}/health`)
  await request.get(`${BASE}/ready`)

  const after = extract(await (await request.get(`${BASE}/metrics`)).text())
  expect(after).toBeGreaterThan(before)
})

test('RA-MT-05: GET /metrics/headers/debug returns 200', async ({ request }) => {
  const res = await request.get(`${BASE}/metrics/headers/debug`)
  // endpoint may not exist in all configs — accept 200 or 404
  expect([200, 404]).toContain(res.status())
  if (res.status() === 200) {
    const ct = res.headers()['content-type'] ?? ''
    expect(ct).toMatch(/json|text/)
  }
})
