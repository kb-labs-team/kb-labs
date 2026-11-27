import { test, expect } from '@playwright/test'
import { MARKETPLACE, REGISTRY } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { createTestTarball, testManifestIdentity } from '../../../../marketplace-registry/fixtures/create-test-tarball.js'

// ── Marketplace install via KB Registry ───────────────────────────────────────
// Requires: kb-dev start (gateway + marketplace :5070 + registry :5071 running)
// Marketplace daemon must have marketplace.registry.url configured to point at
// the local registry (:5071).
//
// MI-* = marketplace install by the identity declared in the plugin manifest

const REG_HANDLE = 'e2e-mi-author'
const TEST_VERSION = '1.0.0'

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniquePkg(prefix: string): string {
  return `@e2e/${prefix}-${Date.now()}`
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
    meta: { name: pkgName, identity: testManifestIdentity(pkgName), version: TEST_VERSION, description: 'MI e2e test', keywords: ['e2e'] },
    primaryKind: 'plugin',
    visibility,
  })
  return request.post(`${REGISTRY}/api/v1/packages/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Author-Handle': REG_HANDLE },
    multipart: {
      tarball: { name: `${encodeURIComponent(pkgName)}-${TEST_VERSION}.tgz`, mimeType: 'application/octet-stream', buffer: tarball },
      meta,
    },
  })
}

function skipOnRegistryNotConfigured(status: number) {
  expect(status, 'marketplace registry must be configured for the nightly install journey').not.toBe(503)
  expect(status, 'marketplace registry request must not fail internally').not.toBe(500)
}

// ── Public Registry install ────────────────────────────────────────────────────────

test('MI-01: install public Registry package via marketplace → 201', async ({ request }) => {
  const token = await getAccessToken(request)
  const pkgName = uniquePkg('e2e-mi-pub')

  const pub = await publishToRegistry(request, token, pkgName, 'public')
  expect(pub.status()).toBe(201)

  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: [testManifestIdentity(pkgName)] },
    timeout: 30_000,
  })
  skipOnRegistryNotConfigured(install.status())
  expect([200, 201, 409]).toContain(install.status())

  // Verify it appears in the installed packages list
  const list = await request.get(`${MARKETPLACE}/api/v1/marketplace/packages`)
  expect(list.status()).toBe(200)
  const body = await list.json()
  const packages: Array<{ name?: string; id?: string; spec?: string }> = body.entries ?? body.packages ?? []
  const spec = testManifestIdentity(pkgName)
  expect(packages.some(p => p.id === spec || p.spec === spec || p.name === pkgName)).toBe(true)
})

// ── Private Registry install (no token) ───────────────────────────────────────────

test('MI-02: install private Registry package without token → 403', async ({ request }) => {
  const token = await getAccessToken(request)
  const pkgName = uniquePkg('e2e-mi-priv')

  const pub = await publishToRegistry(request, token, pkgName, 'private')
  expect(pub.status()).toBe(201)

  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: [testManifestIdentity(pkgName)] },
    timeout: 30_000,
  })
  skipOnRegistryNotConfigured(install.status())
  // Should be forbidden — private package, no token provided
  expect([401, 403, 404]).toContain(install.status())
})

// ── Private Registry install with share token ─────────────────────────────────────

test('MI-03: install private Registry package with share token → 201', async ({ request }) => {
  const token = await getAccessToken(request)
  const pkgName = uniquePkg('e2e-mi-tok')

  const pub = await publishToRegistry(request, token, pkgName, 'private')
  expect(pub.status()).toBe(201)

  // Generate a share token
  const tokenRes = await request.post(
    `${REGISTRY}/api/v1/packages/${REG_HANDLE}/${encodeURIComponent(pkgName)}/share/token`,
    { headers: { Authorization: `Bearer ${token}` }, data: { ttlDays: 1 } },
  )
  expect(tokenRes.status()).toBe(201)
  const shareToken: string = (await tokenRes.json()).token ?? (await tokenRes.json()).shareToken
  expect(typeof shareToken).toBe('string')

  // Install via marketplace with share token
  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: [testManifestIdentity(pkgName)], token: shareToken },
    timeout: 30_000,
  })
  skipOnRegistryNotConfigured(install.status())
  expect([200, 201]).toContain(install.status())
})

// ── kb: spec format validation ────────────────────────────────────────────────

test('MI-04 @S-268.24: reject unsupported kb: prefix before source resolution', async ({ request }) => {
  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: ['kb:no-slash-here'] },
    timeout: 10_000,
  })
  skipOnRegistryNotConfigured(install.status())
  expect(install.status()).toBe(400)
  expect(await install.json()).toMatchObject({
    ok: false,
    error: {
      code: 'KB_RUNTIME_INPUT_INVALID',
      message: expect.stringContaining('kb:'),
      hint: expect.stringContaining('@scope/name'),
    },
  })
})
