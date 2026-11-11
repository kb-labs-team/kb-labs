import { test, expect } from '@playwright/test'
import { MARKETPLACE } from '@kb-labs/e2e-shared/urls.js'

// Verifies marketplace is functional after kb-create bootstrap
// GET /packages → { entries: [...], total: N }
// POST /packages/install → { specs: [...] } (not { packages: [...] })

test('MKT-01: marketplace lists installed packages', async ({ request }) => {
  const res = await request.get(`${MARKETPLACE}/api/v1/marketplace/packages`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const packages = body.entries ?? body.packages ?? (Array.isArray(body) ? body : [])
  // Fresh install may have no packages — endpoint must return a valid array
  expect(Array.isArray(packages)).toBe(true)
})

test('MKT-02: marketplace diagnostics — lock file OK, no errors', async ({ request }) => {
  const res = await request.get(`${MARKETPLACE}/api/v1/marketplace/diagnostics`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.lockFile?.ok ?? body.ok).toBe(true)
  const errors: unknown[] = body.errors ?? []
  expect(errors.length).toBe(0)
})

test('MKT-03: install a test package and verify it appears in listing', async ({ request }) => {
  const SPEC = '@kb-labs/qa'
  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: [SPEC] },
    timeout: 60_000,  // pnpm install can take 30-60s on first run
  })
  // 404 = package not found in registry, 500 = registry unreachable
  expect(install.status() === 404, 'package not found in registry — check Verdaccio publish step').toBe(false)
  expect(install.status(), 'npm registry must be reachable from the marketplace service').not.toBe(500)
  expect([200, 201, 409]).toContain(install.status()) // 409 = already installed, fine

  // A successful mutation is a commit boundary: the immediately following
  // read must observe it. Retrying here would hide a broken API contract.
  const list = await request.get(`${MARKETPLACE}/api/v1/marketplace/packages`)
  expect(list.status()).toBe(200)
  const body = await list.json()
  const packages: { name?: string; id?: string; spec?: string }[] = body.entries ?? body.packages ?? []
  expect(packages.some(p => p.name === SPEC || p.id === SPEC || p.spec === SPEC)).toBe(true)
})

test('MKT-04: install entity from remote registry', async () => { test.skip(true, 'not yet implemented') })
test('MKT-05: disable package → commands disappear from CLI', async () => { test.skip(true, 'not yet implemented') })
