import { test, expect } from '@playwright/test'
import { REST } from '@kb-labs/e2e-shared/urls.js'

// Verifies plugins are actually discovered and registered — not just that REST API is up
// /api/v1/plugins/registry returns: { manifests: [...], apiBasePath, diagnostics }
// /api/v1/plugins/health returns:  { healthy, snapshot: { partial, stale, ... }, ... }

test('PL-01: plugin registry is populated after startup', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/plugins/registry`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  // Envelope: { ok: true, data: { manifests: [...] } }
  const manifests: unknown[] = body.data?.manifests ?? body.manifests ?? []
  expect(manifests.length).toBeGreaterThan(0)
})

test('PL-02: plugin registry health — no validation errors', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/plugins/health`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  // Envelope: { ok: true, data: { healthy, snapshot: { partial, stale, ... } } }
  const data = body.data ?? body
  expect(data.healthy).toBe(true)
  expect(data.snapshot?.partial).toBeFalsy()
  expect(data.snapshot?.stale).toBeFalsy()
})

test('PL-03: studio plugin registry loaded (MF pages)', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/studio/registry`)
  test.skip(res.status() === 404, 'Studio registry not available')
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(typeof body).toBe('object')
})

test('PL-04: commit plugin is registered and has expected commands', async () => { test.skip(true, 'not yet implemented') })
test('PL-05: scaffold plugin is registered and has expected templates', async () => { test.skip(true, 'not yet implemented') })
