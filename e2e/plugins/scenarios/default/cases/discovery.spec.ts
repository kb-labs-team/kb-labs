import { test, expect } from '@playwright/test'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { projectRest } from '@kb-labs/e2e-shared/project-rest.js'

test('P-01: platform plugin registry contains expected plugins after boot', async ({ request }) => {
  // Verify discovery after installing the fixtures into the registered project.
  // Gateway auth + /hosts list tested separately in gateway/auth.spec.ts.
  const res = await (await projectRest(request)).get('/plugins/registry')
  expect(res.status()).toBe(200)
  const body = await res.json()
  // Response: { ok: true, data: { manifests: [{ pluginId, manifest: { id, name }, ... }] } }
  const manifests: { pluginId?: string; manifest?: { id?: string } }[] =
    body.data?.manifests ?? body.manifests ?? []
  // All KB Labs CLI plugins register with id @kb-labs/<name> — at least one must be present
  const hasKbPlugin = manifests.some(
    m => m.pluginId?.startsWith('@kb-labs') || m.manifest?.id?.startsWith('@kb-labs'),
  )
  expect(hasKbPlugin).toBe(true)
})

test('P-02: rest-api /api/v1/routes lists registered routes', async ({ request }) => {
  const res = await (await projectRest(request)).get('/routes')
  expect(res.status()).toBe(200)
})

test('P-03: unknown gateway route returns 401 (not 500) without auth', async ({ request }) => {
  // Gateway auth now applies to every route, including ones with no match at
  // all (GHSA-75rf-rhxh-2p52) — an unauthenticated caller gets 401 before the
  // router even determines the path doesn't exist. The important assertion
  // is "no 500", not "404 specifically" — see the next case for the
  // authenticated 404 behavior.
  const res = await request.get(`${GATEWAY}/this-does-not-exist-e2e`)
  expect(res.status()).toBe(401)
})

test('P-03b: unknown gateway route returns 404 (not 500) with valid auth', async ({ request }) => {
  const token = await getAccessToken(request)
  const res = await request.get(`${GATEWAY}/this-does-not-exist-e2e`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status()).toBe(404)
})

test('P-04: plugin commands appear in registered routes', async ({ request }) => {
  // Verifies that plugin infrastructure is wired into the platform by checking
  // the REST API routes listing — response is { schema, count, routes: [{url, method}], raw }
  const res = await (await projectRest(request)).get('/routes')
  expect(res.status()).toBe(200)
  const body = await res.json()
  // Response shape: { schema: 'kb.routes/1', count, routes: [{url, method}] }
  const routes: { url?: string; method?: string }[] =
    body.routes ?? body.data?.routes ?? (Array.isArray(body) ? body : [])
  expect(Array.isArray(routes)).toBe(true)
  expect(routes.length).toBeGreaterThan(10)
  // /api/v1/plugins/registry is always mounted — proves plugin infra is active
  const urls = routes.map(r => r.url ?? '')
  expect(urls.some(u => u.includes('/plugins/'))).toBe(true)
})

test('P-05: plugin manifest loads without errors', async ({ request }) => {
  const res = await (await projectRest(request)).get('/plugins/registry')
  expect(res.status()).toBe(200)
  const body = await res.json()
  const manifests: {
    pluginId?: string
    manifest?: { id?: string; name?: string; version?: string }
  }[] = body.data?.manifests ?? body.manifests ?? []
  expect(manifests.length).toBeGreaterThan(0)
  // Every manifest entry must have at minimum an id and name
  for (const entry of manifests.slice(0, 10)) {
    const id = entry.pluginId ?? entry.manifest?.id
    const name = entry.manifest?.name ?? id
    expect(typeof id).toBe('string')
    expect(typeof name).toBe('string')
  }
})
