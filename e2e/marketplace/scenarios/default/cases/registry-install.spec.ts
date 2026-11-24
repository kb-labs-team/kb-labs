import { test, expect } from '@playwright/test'
import { GATEWAY, REGISTRY } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { createTestTarball } from '../../../../marketplace-registry/fixtures/create-test-tarball.js'

// ── Marketplace install via KB Registry ───────────────────────────────────────
// Requires: kb-dev start (gateway + marketplace :5070 + registry :5071 running)
// Marketplace daemon must have marketplace.registry.url configured to point at
// the local registry (:5071).
//
// MI-* = marketplace install with kb: spec

const REG_HANDLE = 'e2e-mi-author'
const TEST_VERSION = '1.0.0'

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniquePkg(prefix: string): string {
  return `${prefix}-${Date.now()}`
}

async function publishToRegistry(
  request: Parameters<typeof getAccessToken>[0],
  token: string,
  pkgName: string,
  visibility: 'public' | 'private' = 'public',
) {
  // Install via marketplace requires a real KB entity — include a kb.plugin.json
  // manifest, otherwise the install is rejected with 422 (non-entity, B-021).
  const tarball = createTestTarball(
    { name: pkgName, version: TEST_VERSION, description: 'MI e2e test' },
    { manifest: true },
  )
  const meta = JSON.stringify({
    meta: { name: pkgName, version: TEST_VERSION, description: 'MI e2e test', keywords: ['e2e'] },
    visibility,
  })
  return request.post(`${REGISTRY}/api/v1/packages/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Author-Handle': REG_HANDLE },
    multipart: {
      tarball: { name: `${pkgName}-${TEST_VERSION}.tgz`, mimeType: 'application/octet-stream', buffer: tarball },
      meta,
    },
  })
}

function skipOnRegistryNotConfigured(status: number) {
  expect(status, 'marketplace registry must be configured for the nightly install journey').not.toBe(503)
  expect(status, 'marketplace registry request must not fail internally').not.toBe(500)
}

// ── Public kb: install ────────────────────────────────────────────────────────

test('MI-01: install public kb: package via marketplace → 201', async ({ request }) => {
  const token = await getAccessToken(request)
  const pkgName = uniquePkg('e2e-mi-pub')

  const pub = await publishToRegistry(request, token, pkgName, 'public')
  expect(pub.status()).toBe(201)

  const install = await request.post(`${GATEWAY}/api/v1/marketplace/packages/install`, {
    data: { specs: [`kb:${REG_HANDLE}/${pkgName}`] },
    timeout: 30_000,
  })
  skipOnRegistryNotConfigured(install.status())
  expect([200, 201, 409]).toContain(install.status())

  // Verify it appears in the installed packages list
  const list = await request.get(`${GATEWAY}/api/v1/marketplace/packages`)
  expect(list.status()).toBe(200)
  const body = await list.json()
  const packages: Array<{ name?: string; id?: string; spec?: string }> = body.entries ?? body.packages ?? []
  const spec = `kb:${REG_HANDLE}/${pkgName}`
  expect(packages.some(p => p.id === spec || p.spec === spec || p.name === pkgName)).toBe(true)
})

// ── Private kb: install (no token) ───────────────────────────────────────────

test('MI-02: install private kb: package without token → 403', async ({ request }) => {
  const token = await getAccessToken(request)
  const pkgName = uniquePkg('e2e-mi-priv')

  const pub = await publishToRegistry(request, token, pkgName, 'private')
  expect(pub.status()).toBe(201)

  const install = await request.post(`${GATEWAY}/api/v1/marketplace/packages/install`, {
    data: { specs: [`kb:${REG_HANDLE}/${pkgName}`] },
    timeout: 30_000,
  })
  skipOnRegistryNotConfigured(install.status())
  // Should be forbidden — private package, no token provided
  expect([401, 403, 404]).toContain(install.status())
})

// ── Private kb: install with share token ─────────────────────────────────────

test('MI-03: install private kb: package with share token → 201', async ({ request }) => {
  const token = await getAccessToken(request)
  const pkgName = uniquePkg('e2e-mi-tok')

  const pub = await publishToRegistry(request, token, pkgName, 'private')
  expect(pub.status()).toBe(201)

  // Generate a share token
  const tokenRes = await request.post(
    `${REGISTRY}/api/v1/packages/${REG_HANDLE}/${pkgName}/share/token`,
    { headers: { Authorization: `Bearer ${token}` }, data: { ttlDays: 1 } },
  )
  expect(tokenRes.status()).toBe(201)
  const shareToken: string = (await tokenRes.json()).token ?? (await tokenRes.json()).shareToken
  expect(typeof shareToken).toBe('string')

  // Install via marketplace with share token
  const install = await request.post(`${GATEWAY}/api/v1/marketplace/packages/install`, {
    data: { specs: [`kb:${REG_HANDLE}/${pkgName}`], token: shareToken },
    timeout: 30_000,
  })
  skipOnRegistryNotConfigured(install.status())
  expect([200, 201]).toContain(install.status())
})

// ── kb: spec format validation ────────────────────────────────────────────────

test('MI-04: install with malformed kb: spec → 400', async ({ request }) => {
  const install = await request.post(`${GATEWAY}/api/v1/marketplace/packages/install`, {
    data: { specs: ['kb:no-slash-here'] },
    timeout: 10_000,
  })
  skipOnRegistryNotConfigured(install.status())
  // malformed spec should be rejected with 400 or 422
  expect([400, 422]).toContain(install.status())
})
