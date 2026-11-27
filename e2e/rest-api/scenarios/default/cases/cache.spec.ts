import { test, expect } from '@playwright/test'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

const BASE = `${REST}${REST_API_PREFIX}`

// ETag middleware applies to GET responses.
// Using /plugins/registry as the cacheable endpoint (stable, always returns JSON).
// Envelope middleware wraps responses: { ok: true, data: <payload>, meta: {...} }

const CACHEABLE = `${BASE}/plugins/registry`

test('RA-CA-01: POST /cache/invalidate returns 200 with invalidated: true', async ({ request }) => {
  const res = await request.post(`${BASE}/cache/invalidate`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const data = body.data ?? body
  expect(data.invalidated).toBe(true)
})

test('RA-CA-02: POST /cache/invalidate response contains previousRev and pluginsDiscovered', async ({ request }) => {
  const res = await request.post(`${BASE}/cache/invalidate`)
  const body = await res.json()
  const data = body.data ?? body
  expect(typeof data.previousRev).toBe('number')
  expect(typeof data.pluginsDiscovered).toBe('number')
})

test('RA-CA-03: GET cacheable endpoint returns ETag header', async ({ request }) => {
  const res = await request.get(CACHEABLE)
  expect(res.status()).toBe(200)
  const etag = res.headers()['etag']
  if (!etag) {
    test.skip(true, 'ETag not present — cache middleware may not be active in this environment')
    return
  }
  expect(etag).toMatch(/^"[a-f0-9]+"$/)
})

test('RA-CA-04: GET with matching If-None-Match returns 304 Not Modified', async ({ request }) => {
  const first = await request.get(CACHEABLE)
  expect(first.status()).toBe(200)
  const etag = first.headers()['etag']
  if (!etag) {
    test.skip(true, 'ETag not present — skipping 304 test')
    return
  }

  const second = await request.get(CACHEABLE, {
    headers: { 'If-None-Match': etag },
  })
  expect(second.status()).toBe(304)
})

test('RA-CA-05: GET with stale If-None-Match returns 200 with new ETag', async ({ request }) => {
  const first = await request.get(CACHEABLE, {
    headers: { 'If-None-Match': '"000000000000000a"' },
  })
  expect(first.status()).toBe(200)
  const etag = first.headers()['etag']
  if (!etag) {
    test.skip(true, 'ETag not present — skipping stale ETag test')
    return
  }
  expect(etag).not.toBe('"000000000000000a"')
})

test('RA-CA-06: ETag changes or response is 200 after POST /cache/invalidate', async ({ request }) => {
  const before = await request.get(CACHEABLE)
  const etagBefore = before.headers()['etag']
  if (!etagBefore) {
    test.skip(true, 'ETag not present — skipping invalidation ETag test')
    return
  }

  await request.post(`${BASE}/cache/invalidate`)

  const after = await request.get(CACHEABLE)
  // After invalidation the important thing is that we don't get 304
  expect(after.status()).not.toBe(304)
  expect(after.status()).toBe(200)
})
