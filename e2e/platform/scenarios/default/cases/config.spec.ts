import { test, expect } from '@playwright/test'
import { REST } from '@kb-labs/e2e-shared/urls.js'

// Verifies platform config is loaded and adapters are configured
// Response shape: { ok: true, data: { adapters, adapterOptions, execution: { mode }, ... } }

test('CFG-01: platform config endpoint responds', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/platform/config`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(body.data?.execution?.mode).toBeTruthy()
})

test('CFG-02: platform config has adapters section (no empty config)', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/platform/config`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  // At minimum adapters key must exist — secrets are redacted, that's fine
  expect(body.data).toBeTruthy()
  expect('adapters' in (body.data ?? {}) || 'adapterOptions' in (body.data ?? {})).toBe(true)
})

test('CFG-03: LLM adapter is configured (not placeholder)', async () => { test.skip(true, 'not yet implemented') })
test('CFG-04: storage adapter is configured', async () => { test.skip(true, 'not yet implemented') })
