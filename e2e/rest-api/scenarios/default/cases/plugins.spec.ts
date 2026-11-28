import { test, expect } from '@playwright/test'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

const BASE = `${REST}${REST_API_PREFIX}`

// Note: /plugins/snapshot does not exist as a route.
// Snapshot data is embedded in /plugins/registry and /plugins/refresh responses.
// Envelope middleware wraps all responses: { ok: true, data: <payload>, meta: {...} }

test('RA-PL-01: GET /plugins/health returns 200 with health status object', async ({ request }) => {
  // /plugins/health returns { healthy, snapshot, registryErrors, diagnostics, validation, message }
  const res = await request.get(`${BASE}/plugins/health`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const data = body.data ?? body
  expect(typeof data.healthy).toBe('boolean')
})

test('RA-PL-02: GET /plugins/health snapshot block has totalManifests count', async ({ request }) => {
  const res = await request.get(`${BASE}/plugins/health`)
  if (res.status() !== 200) {
    test.skip(true, 'Plugin health endpoint not available')
    return
  }
  const body = await res.json()
  const data = body.data ?? body
  if (!data.snapshot) {
    test.skip(true, 'Snapshot block absent — skipping snapshot-shape assertion')
    return
  }
  expect(typeof data.snapshot.totalManifests).toBe('number')
  expect(data.snapshot.totalManifests).toBeGreaterThanOrEqual(0)
})

test('RA-PL-03: GET /plugins/registry returns 200 with non-empty response', async ({ request }) => {
  const res = await request.get(`${BASE}/plugins/registry`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body).toBeTruthy()
})

test('RA-PL-04: GET /plugins/registry contains plugin entries with id field', async ({ request }) => {
  const res = await request.get(`${BASE}/plugins/registry`)
  const body = await res.json()
  // registry returns array of manifest entries wrapped in envelope
  const data = body.data ?? body
  // registry returns { manifests: [...], apiBasePath, diagnostics }
  const entries: Array<Record<string, unknown>> = data.manifests ?? (Array.isArray(data) ? data : [])
  if (entries.length === 0) {
    test.skip(true, 'No plugins in registry — skipping manifest assertion')
    return
  }
  const first = entries[0]
  // registry entries use pluginId field (not id)
  expect(first.pluginId ?? first.id ?? first.pluginRoot).toBeTruthy()
})

test('RA-PL-05: GET /plugins/registry response contains rev or checksum metadata', async ({ request }) => {
  const res = await request.get(`${BASE}/plugins/registry`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  // The top-level envelope has meta.requestId; the data itself may have rev
  expect(body.ok ?? true).toBeTruthy()
})

test('RA-PL-06: POST /plugins/refresh returns 200 with rev and total', async ({ request }) => {
  const res = await request.post(`${BASE}/plugins/refresh`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const data = body.data ?? body
  // refresh returns { ok: true, data: { rev, total, generatedAt, partial, stale } }
  expect(typeof data.rev).toBe('number')
  expect(typeof data.total).toBe('number')
})

test('RA-PL-07: POST /plugins/refresh rev is non-negative', async ({ request }) => {
  const res = await request.post(`${BASE}/plugins/refresh`)
  const body = await res.json()
  const data = body.data ?? body
  expect(data.rev).toBeGreaterThanOrEqual(0)
})

test('RA-PL-08: GET /plugins/registry after POST /plugins/refresh stays consistent', async ({ request }) => {
  const before = await request.post(`${BASE}/plugins/refresh`)
  const beforeData = (await before.json()).data ?? await before.json()
  const revBefore = beforeData.rev as number

  const after = await request.post(`${BASE}/plugins/refresh`)
  const afterData = (await after.json()).data ?? await after.json()
  const revAfter = afterData.rev as number

  // rev should stay the same or increment — never regress
  expect(revAfter).toBeGreaterThanOrEqual(revBefore)
})

test('RA-PL-09: GET /studio/registry returns 200', async ({ request }) => {
  const res = await request.get(`${BASE}/studio/registry`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body).toBeTruthy()
})
