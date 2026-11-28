import { test, expect, type APIRequestContext } from '@playwright/test'
import { REGISTRY } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken, createRegistryIdentity } from '../../../fixtures/identity.js'
import { createTestTarball } from '../../../fixtures/create-test-tarball.js'

// ── Share & access-token e2e ──────────────────────────────────────────────────
// Requires: kb-dev start (gateway + marketplace-registry both running)
// RG-S* = share / token-based access

const TEST_HANDLE = 'e2e-share-author'
const TEST_VERSION = '1.0.0'

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniquePkg(prefix: string): string {
  return `${prefix}-${Date.now()}`
}

async function publish(
  request: APIRequestContext,
  token: string,
  pkgName: string,
  visibility: 'public' | 'private' = 'private',
) {
  const tarball = createTestTarball({ name: pkgName, version: TEST_VERSION, description: 'Share e2e test' })
  const meta = JSON.stringify({
    meta: { name: pkgName, version: TEST_VERSION, description: 'Share e2e test', keywords: ['e2e'] },
    visibility,
  })
  return request.post(`${REGISTRY}/api/v1/packages/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Author-Handle': TEST_HANDLE },
    multipart: {
      tarball: { name: `${pkgName}-${TEST_VERSION}.tgz`, mimeType: 'application/octet-stream', buffer: tarball },
      meta,
    },
  })
}

// ── Allowlist ─────────────────────────────────────────────────────────────────

test('RG-S01: POST share/allowlist → 204 adds namespace to allowlist', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-allowlist')

  expect((await publish(request, token, pkgName, 'private')).status()).toBe(201)

  const res = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/share/allowlist`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { namespaceId: 'ns_other_user_123' },
    },
  )
  expect(res.status()).toBe(204)
})

test('RG-S02: POST share/allowlist without auth → 401', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-allowlist-noauth')

  expect((await publish(request, token, pkgName, 'private')).status()).toBe(201)

  const res = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/share/allowlist`,
    { data: { namespaceId: 'ns_other_user_123' } },
  )
  expect(res.status()).toBe(401)
})

// ── Share token generation ────────────────────────────────────────────────────

test('RG-S03: POST share/token → 201 with token string', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-sharetoken')

  expect((await publish(request, token, pkgName, 'private')).status()).toBe(201)

  const res = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/share/token`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { ttlDays: 7 },
    },
  )
  expect(res.status()).toBe(201)
  const body = await res.json()
  const shareToken: string = body.token ?? body.shareToken ?? body.data?.token
  expect(typeof shareToken).toBe('string')
  expect(shareToken.length).toBeGreaterThan(0)
})

test('RG-S04: POST share/token without auth → 401', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-sharetoken-noauth')

  expect((await publish(request, token, pkgName, 'private')).status()).toBe(201)

  const res = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/share/token`,
    { data: { ttlDays: 1 } },
  )
  expect(res.status()).toBe(401)
})

// ── Token-based tarball access ────────────────────────────────────────────────

test('RG-S05: download private tarball with X-Share-Token header → 200', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-dl-header')

  expect((await publish(request, token, pkgName, 'private')).status()).toBe(201)

  const tokenRes = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/share/token`,
    { headers: { Authorization: `Bearer ${token}` }, data: { ttlDays: 1 } },
  )
  expect(tokenRes.status()).toBe(201)
  const shareToken: string = (await tokenRes.json()).token ?? (await tokenRes.json()).shareToken

  // Confirm private package is inaccessible without token
  const noAuth = await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/tarball`,
  )
  // case: S-268.21 — private versions are indistinguishable from missing ones.
  expect(noAuth.status()).toBe(404)
  expect(await noAuth.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' })

  // Access with share token via header
  const withToken = await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/tarball`,
    { headers: { 'X-Share-Token': shareToken } },
  )
  expect(withToken.status()).toBe(200)
  expect(withToken.headers()['content-type']).toContain('application/octet-stream')
})

test('RG-S06: download private tarball with ?token= query param → 200', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-dl-query')

  expect((await publish(request, token, pkgName, 'private')).status()).toBe(201)

  const tokenRes = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/share/token`,
    { headers: { Authorization: `Bearer ${token}` }, data: { ttlDays: 1 } },
  )
  expect(tokenRes.status()).toBe(201)
  const shareToken: string = (await tokenRes.json()).token ?? (await tokenRes.json()).shareToken

  const withToken = await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/tarball?token=${encodeURIComponent(shareToken)}`,
  )
  expect(withToken.status()).toBe(200)
  expect((await withToken.body()).length).toBeGreaterThan(0)
})

test('RG-S07: download private tarball with invalid token → 404', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-dl-badtoken')

  expect((await publish(request, token, pkgName, 'private')).status()).toBe(201)

  const res = await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/tarball`,
    { headers: { 'X-Share-Token': 'kbrt_invalid_token_xyz' } },
  )
  expect(res.status()).toBe(404)
  expect(await res.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' })
})

// ── Share token for metadata access ──────────────────────────────────────────

test('RG-S08: GET package metadata with valid share token → 200', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-meta-token')

  expect((await publish(request, token, pkgName, 'private')).status()).toBe(201)

  const tokenRes = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/share/token`,
    { headers: { Authorization: `Bearer ${token}` }, data: {} },
  )
  expect(tokenRes.status()).toBe(201)
  const shareToken: string = (await tokenRes.json()).token ?? (await tokenRes.json()).shareToken

  const meta = await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}`,
    { headers: { 'X-Share-Token': shareToken } },
  )
  expect(meta.status()).toBe(200)
  const body = await meta.json()
  expect(body.name ?? body.entry?.name).toBe(pkgName)
})

// ── Allowlist-based access ────────────────────────────────────────────────────

test('RG-S09: namespaceId added to allowlist can download private tarball', async ({ request }) => {
  const owner = await createRegistryIdentity()
  const ownerToken = owner.accessToken
  const pkgName = uniquePkg('e2e-allowlist-dl')

  expect((await publish(request, ownerToken, pkgName, 'private')).status()).toBe(201)

  // The Gateway generates independent machine namespaces for owner and guest.
  const guest = await createRegistryIdentity()
  const guestToken = guest.accessToken
  const guestNs = guest.namespaceId
  expect(guestNs).not.toBe(owner.namespaceId)

  // Confirm guest cannot access without allowlist
  const before = await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/tarball`,
    { headers: { Authorization: `Bearer ${guestToken}` } },
  )
  expect(before.status()).toBe(404)
  expect(await before.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' })

  // Owner adds guest to allowlist
  const allow = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/share/allowlist`,
    {
      headers: { Authorization: `Bearer ${ownerToken}` },
      data: { namespaceId: guestNs },
    },
  )
  expect(allow.status()).toBe(204)

  // Guest can now download
  const after = await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/tarball`,
    { headers: { Authorization: `Bearer ${guestToken}` } },
  )
  expect(after.status()).toBe(200)
  expect(after.headers()['content-type']).toContain('application/octet-stream')
})
