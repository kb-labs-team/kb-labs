import { test, expect, type APIRequestContext } from '@playwright/test'
import { GATEWAY, REGISTRY } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken } from '../../../fixtures/identity.js'
import { createTestTarball } from '../../../fixtures/create-test-tarball.js'

// ── Registry lifecycle e2e ────────────────────────────────────────────────────
// Requires: kb-dev start (gateway + marketplace-registry both running)
// RG-A* = auth / access control
// RG-P* = publish lifecycle

const TEST_HANDLE = 'e2e-author'
const TEST_VERSION = '1.0.0'

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMeta(name: string, visibility: 'public' | 'private' = 'public'): string {
  return JSON.stringify({
    meta: { name, version: TEST_VERSION, description: 'E2E test package', keywords: ['e2e'] },
    visibility,
  })
}

async function publish(
  request: APIRequestContext,
  token: string,
  pkgName: string,
  visibility: 'public' | 'private' = 'public',
) {
  const tarball = createTestTarball({ name: pkgName, version: TEST_VERSION, description: 'E2E test package' })
  return request.post(`${REGISTRY}/api/v1/packages/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Author-Handle': TEST_HANDLE },
    multipart: {
      tarball: { name: `${pkgName}-${TEST_VERSION}.tgz`, mimeType: 'application/octet-stream', buffer: tarball },
      meta: buildMeta(pkgName, visibility),
    },
  })
}

function uniquePkg(prefix: string): string {
  return `${prefix}-${Date.now()}`
}

// ── Public endpoints (no auth) ────────────────────────────────────────────────

test('RG-A01: GET /api/v1/packages returns array without auth', async ({ request }) => {
  const res = await request.get(`${REGISTRY}/api/v1/packages`)
  expect(res.status()).toBe(200)
  expect(Array.isArray(await res.json())).toBe(true)
})

test('RG-A02: GET /api/v1/my/packages returns 401 without auth', async ({ request }) => {
  const res = await request.get(`${REGISTRY}/api/v1/my/packages`)
  expect(res.status()).toBe(401)
})

test('RG-A03: POST /api/v1/packages/publish returns 401 without auth', async ({ request }) => {
  const tarball = createTestTarball({ name: 'test', version: '1.0.0' })
  const res = await request.post(`${REGISTRY}/api/v1/packages/publish`, {
    headers: { 'X-Author-Handle': 'nobody' },
    multipart: {
      tarball: { name: 'test.tgz', mimeType: 'application/octet-stream', buffer: tarball },
      meta: buildMeta('test'),
    },
  })
  expect(res.status()).toBe(401)
})

test('RG-A04: POST /publish returns 400 when X-Author-Handle missing', async ({ request }) => {
  const token = await getAccessToken()
  const tarball = createTestTarball({ name: 'test', version: '1.0.0' })
  const res = await request.post(`${REGISTRY}/api/v1/packages/publish`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      tarball: { name: 'test.tgz', mimeType: 'application/octet-stream', buffer: tarball },
      meta: buildMeta('test'),
    },
  })
  expect(res.status()).toBe(400)
  const body = await res.json()
  expect(body.error).toMatch(/author.handle/i)
})

// ── Publish lifecycle ─────────────────────────────────────────────────────────

test('RG-P01: publish public package → appears in public listing', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-pub')

  const pub = await publish(request, token, pkgName, 'public')
  expect(pub.status()).toBe(201)
  const result = await pub.json()
  expect(result.entry?.name ?? result.name).toBe(pkgName)

  const list = await request.get(`${REGISTRY}/api/v1/packages`)
  const packages: Array<{ name: string }> = await list.json()
  expect(packages.some(p => p.name === pkgName)).toBe(true)
})

test('RG-P02: publish private package → NOT in public listing', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-priv')

  const pub = await publish(request, token, pkgName, 'private')
  expect(pub.status()).toBe(201)

  const list = await request.get(`${REGISTRY}/api/v1/packages`)
  const packages: Array<{ name: string }> = await list.json()
  expect(packages.some(p => p.name === pkgName)).toBe(false)
})

test('RG-P03: publish same version twice → 409 Conflict', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-conflict')

  expect((await publish(request, token, pkgName)).status()).toBe(201)
  expect((await publish(request, token, pkgName)).status()).toBe(409)
})

test('RG-P04: download published tarball → binary content', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-dl')

  expect((await publish(request, token, pkgName, 'public')).status()).toBe(201)

  const dl = await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/tarball`,
  )
  expect(dl.status()).toBe(200)
  expect(dl.headers()['content-type']).toContain('application/octet-stream')
  expect((await dl.body()).length).toBeGreaterThan(0)
})

// ── Yank ──────────────────────────────────────────────────────────────────────

test('RG-P05: yank version → tarball download returns 403', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-yank')

  expect((await publish(request, token, pkgName, 'public')).status()).toBe(201)

  const yank = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/yank`,
    { headers: { Authorization: `Bearer ${token}` }, data: { reason: 'e2e test yank' } },
  )
  expect(yank.status()).toBe(204)

  const dl = await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/tarball`,
  )
  expect(dl.status()).toBe(403)
})

test('RG-P06: yank without auth → 401', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-yank-noauth')

  expect((await publish(request, token, pkgName, 'public')).status()).toBe(201)

  const res = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/yank`,
    { data: { reason: 'no auth test' } },
  )
  expect(res.status()).toBe(401)
})

// ── Deprecate ─────────────────────────────────────────────────────────────────

test('RG-P07: deprecate package → removed from public listing', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-dep')

  expect((await publish(request, token, pkgName, 'public')).status()).toBe(201)

  const beforeList: Array<{ name: string }> = await (
    await request.get(`${REGISTRY}/api/v1/packages`)
  ).json()
  expect(beforeList.some(p => p.name === pkgName)).toBe(true)

  const dep = await request.post(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/deprecate`,
    { headers: { Authorization: `Bearer ${token}` }, data: { message: 'e2e test deprecation' } },
  )
  expect(dep.status()).toBe(204)

  const afterList: Array<{ name: string }> = await (
    await request.get(`${REGISTRY}/api/v1/packages`)
  ).json()
  expect(afterList.some(p => p.name === pkgName)).toBe(false)
})

// ── My packages ───────────────────────────────────────────────────────────────

test('RG-P08: GET /my/packages includes own private packages', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-my')

  expect((await publish(request, token, pkgName, 'private')).status()).toBe(201)

  const myList = await request.get(`${REGISTRY}/api/v1/my/packages`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(myList.status()).toBe(200)
  const packages: Array<{ name: string }> = await myList.json()
  expect(packages.some(p => p.name === pkgName)).toBe(true)
})

// ── Meta-only update ──────────────────────────────────────────────────────────

test('RG-P10: PATCH /meta → updates description without new tarball', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-meta')

  expect((await publish(request, token, pkgName, 'public')).status()).toBe(201)

  const patch = await request.patch(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/meta`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { description: 'Updated description via meta-only patch' },
    },
  )
  expect(patch.status()).toBe(204)

  const meta = await request.get(`${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}`)
  expect(meta.status()).toBe(200)
  const body: { meta?: { description?: string } } = await meta.json()
  expect(body.meta?.description).toBe('Updated description via meta-only patch')
})

test('RG-P11: PATCH /meta without auth → 401', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-meta-noauth')

  expect((await publish(request, token, pkgName, 'public')).status()).toBe(201)

  const patch = await request.patch(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/meta`,
    { data: { description: 'Should be rejected' } },
  )
  expect(patch.status()).toBe(401)
})

// ── Stats ─────────────────────────────────────────────────────────────────────

test('RG-P09: stats.installs increments after tarball download', async ({ request }) => {
  const token = await getAccessToken()
  const pkgName = uniquePkg('e2e-stats')

  expect((await publish(request, token, pkgName, 'public')).status()).toBe(201)

  await request.get(
    `${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/${TEST_VERSION}/tarball`,
  )

  const stats = await request.get(`${REGISTRY}/api/v1/packages/${TEST_HANDLE}/${pkgName}/stats`)
  expect(stats.status()).toBe(200)
  const body = await stats.json()
  expect(typeof body.installs).toBe('number')
  expect(body.installs).toBeGreaterThanOrEqual(1)
})

// ── Search ────────────────────────────────────────────────────────────────────

test('RG-Q01: GET /packages?q= matches by package name', async ({ request }) => {
  const token = await getAccessToken()
  // Use a rare prefix so search results are unambiguous
  const suffix = Date.now()
  const pkgName = `e2e-searchbyname-${suffix}`

  expect((await publish(request, token, pkgName, 'public')).status()).toBe(201)

  const res = await request.get(`${REGISTRY}/api/v1/packages?q=searchbyname-${suffix}`)
  expect(res.status()).toBe(200)
  const results: Array<{ name: string }> = await res.json()
  expect(results.some(p => p.name === pkgName)).toBe(true)
})

test('RG-Q02: GET /packages?q= matches by keyword', async ({ request }) => {
  const token = await getAccessToken()
  const suffix = Date.now()
  const pkgName = `e2e-searchbykw-${suffix}`
  const keyword = `e2ekw-${suffix}`

  const tarball = createTestTarball({ name: pkgName, version: TEST_VERSION, keywords: [keyword] })
  const meta = JSON.stringify({
    meta: { name: pkgName, version: TEST_VERSION, keywords: [keyword] },
    visibility: 'public',
  })
  const pub = await request.post(`${REGISTRY}/api/v1/packages/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Author-Handle': TEST_HANDLE },
    multipart: {
      tarball: { name: `${pkgName}-${TEST_VERSION}.tgz`, mimeType: 'application/octet-stream', buffer: tarball },
      meta,
    },
  })
  expect(pub.status()).toBe(201)

  const res = await request.get(`${REGISTRY}/api/v1/packages?q=${encodeURIComponent(keyword)}`)
  expect(res.status()).toBe(200)
  const results: Array<{ name: string }> = await res.json()
  expect(results.some(p => p.name === pkgName)).toBe(true)
})

test('RG-Q03: GET /packages?q= does not return private packages', async ({ request }) => {
  const token = await getAccessToken()
  const suffix = Date.now()
  const pkgName = `e2e-searchpriv-${suffix}`

  const tarball = createTestTarball({ name: pkgName, version: TEST_VERSION, description: `unique-priv-${suffix}` })
  const meta = JSON.stringify({
    meta: { name: pkgName, version: TEST_VERSION, description: `unique-priv-${suffix}` },
    visibility: 'private',
  })
  const pub = await request.post(`${REGISTRY}/api/v1/packages/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Author-Handle': TEST_HANDLE },
    multipart: {
      tarball: { name: `${pkgName}-${TEST_VERSION}.tgz`, mimeType: 'application/octet-stream', buffer: tarball },
      meta,
    },
  })
  expect(pub.status()).toBe(201)

  const res = await request.get(`${REGISTRY}/api/v1/packages?q=searchpriv-${suffix}`)
  expect(res.status()).toBe(200)
  const results: Array<{ name: string }> = await res.json()
  expect(results.some(p => p.name === pkgName)).toBe(false)
})

test('RG-Q04: GET /packages?q= with no matches returns empty array', async ({ request }) => {
  const res = await request.get(`${REGISTRY}/api/v1/packages?q=zzz-nomatch-${Date.now()}`)
  expect(res.status()).toBe(200)
  const results: unknown[] = await res.json()
  expect(Array.isArray(results)).toBe(true)
  expect(results).toHaveLength(0)
})

test('RG-Q05: GET /packages without q returns full public listing', async ({ request }) => {
  const res = await request.get(`${REGISTRY}/api/v1/packages`)
  expect(res.status()).toBe(200)
  expect(Array.isArray(await res.json())).toBe(true)
})
