import { request as playwrightRequest, test, expect, type APIRequestContext } from '@playwright/test'
import { MARKETPLACE, REGISTRY } from '@kb-labs/e2e-shared/urls.js'
import { createRegistryIdentity } from '../../../../marketplace-registry/fixtures/identity.js'
import { createTestTarball, testManifestIdentity } from '../../../../marketplace-registry/fixtures/create-test-tarball.js'

// ── Marketplace install via KB Registry ───────────────────────────────────────
// Requires: kb-dev start (gateway + marketplace :5070 + registry :5071 running)
// Marketplace daemon must have marketplace.registry.url configured to point at
// the local registry (:5071).
//
// Each actor gets an isolated request context with only its machine bearer token.
// The secured journey's admin cookie must not override a publisher/consumer token.

const REG_HANDLE = 'e2e-mi-author'
const TEST_VERSION = '1.0.0'

type RegistryActor = Awaited<ReturnType<typeof createRegistryIdentity>>
type MarketplaceEntry = { id?: string; name?: string; spec?: string; version?: string; source?: string; marketplaceSource?: string }

async function actorContext(actor: RegistryActor): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${actor.accessToken}` },
  })
}

function uniquePkg(prefix: string): string {
  return `@e2e/${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

async function publishToRegistry(
  request: APIRequestContext,
  pkgName: string,
  visibility: 'public' | 'private' = 'public',
) {
  // Marketplace installation requires a real KB entity, not only an npm package.
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
    headers: { 'X-Author-Handle': REG_HANDLE },
    multipart: {
      tarball: { name: `${encodeURIComponent(pkgName)}-${TEST_VERSION}.tgz`, mimeType: 'application/octet-stream', buffer: tarball },
      meta,
    },
  })
}

async function listPackages(request: APIRequestContext): Promise<MarketplaceEntry[]> {
  const response = await request.get(`${MARKETPLACE}/api/v1/marketplace/packages`)
  expect(response.status(), await response.text()).toBe(200)
  const body = await response.json()
  return body.entries ?? body.data?.entries ?? body.packages ?? []
}

async function uninstall(request: APIRequestContext, identity: string): Promise<void> {
  const response = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/uninstall`, {
    data: { packageIds: [identity] },
  })
  expect([200, 204], await response.text()).toContain(response.status())
  expect((await listPackages(request)).some(entry => entry.id === identity || entry.spec === identity || entry.name === identity)).toBe(false)
}

function expectMarketplaceConfigured(status: number) {
  expect(status, 'marketplace registry must be configured for the nightly install journey').not.toBe(503)
  expect(status, 'marketplace registry request must not fail internally').not.toBe(500)
}

// ── Public Registry install ───────────────────────────────────────────────────

test('MI-01: install a newly published public Registry package', async () => {
  const publisher = await createRegistryIdentity()
  const consumer = await createRegistryIdentity()
  expect(consumer.namespaceId).not.toBe(publisher.namespaceId)
  const publisherRequest = await actorContext(publisher)
  const consumerRequest = await actorContext(consumer)
  const pkgName = uniquePkg('e2e-mi-pub')
  const identity = testManifestIdentity(pkgName)

  try {
    const published = await publishToRegistry(publisherRequest, pkgName, 'public')
    expect(published.status(), await published.text()).toBe(201)
    const before = await listPackages(consumerRequest)
    expect(before.some(entry => entry.id === identity || entry.spec === identity || entry.name === pkgName)).toBe(false)

    const install = await consumerRequest.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
      data: { specs: [identity] },
      timeout: 30_000,
    })
    expectMarketplaceConfigured(install.status())
    expect(install.status(), await install.text()).toBe(201)
    const result = await install.json()
    expect(result.installed).toHaveLength(1)
    expect(result.installed[0]).toMatchObject({
      spec: identity,
      id: identity,
      version: TEST_VERSION,
      source: 'registry',
      scope: 'platform',
      signatureStatus: 'verified',
    })

    const after = await listPackages(consumerRequest)
    expect(after).toContainEqual(expect.objectContaining({
      id: identity,
      version: TEST_VERSION,
      source: 'marketplace',
      marketplaceSource: 'registry',
    }))
  } finally {
    // Keep the shared installed platform clean for the other Marketplace cases.
    if ((await listPackages(consumerRequest)).some(entry => entry.id === identity || entry.spec === identity || entry.name === identity)) {
      await uninstall(consumerRequest, identity)
    }
    await publisherRequest.dispose()
    await consumerRequest.dispose()
  }
})

// ── Private Registry install without a grant ──────────────────────────────────

test('MI-02: deny a separate consumer access to a private Registry package', async () => {
  const publisher = await createRegistryIdentity()
  const consumer = await createRegistryIdentity()
  expect(consumer.namespaceId).not.toBe(publisher.namespaceId)
  const publisherRequest = await actorContext(publisher)
  const consumerRequest = await actorContext(consumer)
  const pkgName = uniquePkg('e2e-mi-priv')
  const identity = testManifestIdentity(pkgName)

  try {
    const published = await publishToRegistry(publisherRequest, pkgName, 'private')
    expect(published.status(), await published.text()).toBe(201)
    expect((await listPackages(consumerRequest)).some(entry => entry.id === identity || entry.spec === identity || entry.name === identity)).toBe(false)

    const install = await consumerRequest.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
      data: { specs: [identity] },
      timeout: 30_000,
    })
    expectMarketplaceConfigured(install.status())
    expect(install.status(), await install.text()).toBe(401)
    expect(await install.json()).toMatchObject({
      ok: false,
      error: {
        code: 'KB_MARKETPLACE_AUTH_FAILED',
        details: { package: identity, scope: 'platform' },
      },
    })
    expect((await listPackages(consumerRequest)).some(entry => entry.id === identity || entry.spec === identity || entry.name === identity)).toBe(false)
  } finally {
    await publisherRequest.dispose()
    await consumerRequest.dispose()
  }
})

// ── Private Registry install with an explicit share grant ────────────────────

test('MI-03: a different consumer installs a private package with its share token', async () => {
  const publisher = await createRegistryIdentity()
  const consumer = await createRegistryIdentity()
  expect(consumer.namespaceId).not.toBe(publisher.namespaceId)
  const publisherRequest = await actorContext(publisher)
  const consumerRequest = await actorContext(consumer)
  const pkgName = uniquePkg('e2e-mi-tok')
  const identity = testManifestIdentity(pkgName)

  try {
    const published = await publishToRegistry(publisherRequest, pkgName, 'private')
    expect(published.status(), await published.text()).toBe(201)
    expect((await listPackages(consumerRequest)).some(entry => entry.id === identity || entry.spec === identity || entry.name === identity)).toBe(false)

    const grant = await publisherRequest.post(
      `${REGISTRY}/api/v1/packages/${REG_HANDLE}/${encodeURIComponent(pkgName)}/share/token`,
      { data: { ttlDays: 1 } },
    )
    expect(grant.status()).toBe(201)
    const grantBody = await grant.json()
    const shareToken: string = grantBody.token ?? grantBody.shareToken ?? grantBody.data?.token
    expect(/^kbrt_[0-9a-f]{32}$/.test(shareToken), 'Registry returned a malformed share token').toBe(true)

    const install = await consumerRequest.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
      data: { specs: [identity], token: shareToken },
      timeout: 30_000,
    })
    expectMarketplaceConfigured(install.status())
    expect(install.status()).toBe(201)
    const result = await install.json()
    expect(result.installed).toHaveLength(1)
    expect(result.installed[0]).toMatchObject({
      spec: identity,
      id: identity,
      version: TEST_VERSION,
      source: 'registry',
      scope: 'platform',
      signatureStatus: 'verified',
    })

    const after = await listPackages(consumerRequest)
    expect(after).toContainEqual(expect.objectContaining({
      id: identity,
      version: TEST_VERSION,
      source: 'marketplace',
      marketplaceSource: 'registry',
    }))
  } finally {
    if ((await listPackages(consumerRequest)).some(entry => entry.id === identity || entry.spec === identity || entry.name === identity)) {
      await uninstall(consumerRequest, identity)
    }
    await publisherRequest.dispose()
    await consumerRequest.dispose()
  }
})

// ── kb: spec format validation ────────────────────────────────────────────────

test('MI-04 @S-268.24: reject unsupported kb: prefix before source resolution', async ({ request }) => {
  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: ['kb:no-slash-here'] },
    timeout: 10_000,
  })
  expectMarketplaceConfigured(install.status())
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
