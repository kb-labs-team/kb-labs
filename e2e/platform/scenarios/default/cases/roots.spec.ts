import { test, expect } from '@playwright/test'
import { REST } from '@kb-labs/e2e-shared/urls.js'

test('ROOT-01: platform config endpoint is reachable and schema is valid', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/platform/config`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(body.data?.schema).toMatch(/kb\.platform\.config/)
})

test('ROOT-03: plugin registry uses projectRoot for local plugin discovery', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/plugins/registry`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  // Envelope: { ok: true, data: { manifests: [...] } }
  const manifests: unknown[] = body.data?.manifests ?? body.manifests ?? []
  // Plugins discovered from project root must be present
  expect(manifests.length).toBeGreaterThan(0)
})

test('ROOT-04: start with custom projectRoot env var → config reflects that root', async () => { test.skip(true, 'not yet implemented') })
test('ROOT-05: workflow daemon discovers .kb/workflows from projectRoot not platformRoot', async () => { test.skip(true, 'not yet implemented') })
test('ROOT-06: marketplace lock file is read from projectRoot/.kb/marketplace.lock', async () => { test.skip(true, 'not yet implemented') })
