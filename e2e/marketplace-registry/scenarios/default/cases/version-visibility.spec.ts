import { randomUUID } from 'node:crypto'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { REGISTRY } from '@kb-labs/e2e-shared/urls.js'
import { createRegistryIdentity } from '../../../fixtures/identity.js'
import { createTestTarball } from '../../../fixtures/create-test-tarball.js'

const handle = 'e2e-versions'
const versions = ['1.0.0', '2.0.0'] as const

async function publish(request: APIRequestContext, token: string, name: string, version: string, visibility: 'public' | 'private') {
  const identity = `@e2e/${name}`
  const tarball = createTestTarball({ name, version }, { manifest: true })
  const result = await request.post(`${REGISTRY}/api/v1/packages/publish`, {
    headers: { Authorization: `Bearer ${token}`, 'X-Author-Handle': handle },
    multipart: {
      tarball: { name: `${name}-${version}.tgz`, mimeType: 'application/octet-stream', buffer: tarball },
      meta: JSON.stringify({ meta: { name, version, identity, description: `${visibility} ${version}` }, primaryKind: 'plugin', visibility }),
    },
  })
  expect(result.status(), `publish ${version}`).toBe(201)
  return tarball
}

// This exercises Registry visibility over the Gateway. Exact Marketplace install
// pins remain covered by registry-source.spec.ts and the installed Journey.
test('RG-V01: version visibility survives publish, resolve and sharing', async ({ request }) => {
  const owner = await createRegistryIdentity()
  const guest = await createRegistryIdentity()
  expect(guest.namespaceId).not.toBe(owner.namespaceId)
  const ownerAuth = { Authorization: `Bearer ${owner.accessToken}` }
  const guestAuth = { Authorization: `Bearer ${guest.accessToken}` }

  for (const privateVersion of versions) {
    const publicVersion = versions.find(version => version !== privateVersion)!
    const name = `visibility-${randomUUID()}`
    const identity = `@e2e/${name}`
    const path = `${REGISTRY}/api/v1/packages/${handle}/${name}`
    const tarballs = new Map<string, Buffer>()
    for (const version of versions) {
      tarballs.set(version, await publish(request, owner.accessToken, name, version, version === privateVersion ? 'private' : 'public'))
    }

    const listing = await request.get(`${REGISTRY}/api/v1/packages?q=${encodeURIComponent(name)}`)
    expect(listing.status()).toBe(200)
    expect((await listing.json()).some((entry: { name: string }) => entry.name === name)).toBe(true)

    const metadata = await request.get(path)
    expect(metadata.status()).toBe(200)
    const visible = await metadata.json()
    expect(visible.meta).toMatchObject({ version: publicVersion, description: `public ${publicVersion}`, identity })
    expect(visible.versions.map((entry: { version: string }) => entry.version)).toEqual([publicVersion])

    const resolve = `${REGISTRY}/api/v1/resolve?identity=${encodeURIComponent(identity)}`
    const resolved = await request.get(resolve)
    expect(resolved.status()).toBe(200)
    expect(await resolved.json()).toMatchObject({ status: 'found', package: { id: name, version: publicVersion } })
    for (const headers of [{}, guestAuth]) {
      const shortResolve = await request.get(`${REGISTRY}/api/v1/resolve?identity=${encodeURIComponent(name)}`, { headers })
      expect(shortResolve.status()).toBe(200)
      expect(await shortResolve.json()).toMatchObject({ status: 'found', package: { id: name, version: publicVersion } })
      const privateResolve = await request.get(`${resolve}&version=${privateVersion}`, { headers })
      expect(privateResolve.status()).toBe(403)
    }

    const publicTarball = await request.get(`${path}/${publicVersion}/tarball`)
    expect(publicTarball.status()).toBe(200)
    expect(await publicTarball.body()).toEqual(tarballs.get(publicVersion))
    for (const headers of [{}, guestAuth]) {
      const denied = await request.get(`${path}/${privateVersion}/tarball`, { headers })
      expect(denied.status()).toBe(404)
      expect(await denied.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' })
    }
    const missing = await request.get(`${path}/9.9.9/tarball`)
    expect(missing.status()).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'VERSION_NOT_FOUND' })

    const ownerMetadata = await request.get(path, { headers: ownerAuth })
    expect(ownerMetadata.status()).toBe(200)
    expect((await ownerMetadata.json()).versions.map((entry: { version: string }) => entry.version)).toEqual([...versions])
    const ownerResolve = await request.get(`${resolve}&version=${privateVersion}`, { headers: ownerAuth })
    expect(ownerResolve.status()).toBe(200)
    expect(await ownerResolve.json()).toMatchObject({ status: 'found', package: { id: name, version: privateVersion, signature: { algorithm: 'ed25519', value: expect.any(String) } } })
    const ownerTarball = await request.get(`${path}/${privateVersion}/tarball`, { headers: ownerAuth })
    expect(ownerTarball.status()).toBe(200)
    expect(await ownerTarball.body()).toEqual(tarballs.get(privateVersion))
    const publicStats = await request.get(`${path}/stats`)
    expect(publicStats.status()).toBe(200)
    expect(await publicStats.json()).toMatchObject({ installs: 1 })
    const ownerStats = await request.get(`${path}/stats`, { headers: ownerAuth })
    expect(ownerStats.status()).toBe(200)
    expect(await ownerStats.json()).toMatchObject({ installs: 2 })

    const grant = await request.post(`${path}/share/token`, { headers: ownerAuth, data: { ttlDays: 1 } })
    expect(grant.status()).toBe(201)
    const share = (await grant.json()).token
    expect(share).toEqual(expect.any(String))
    const shared = await request.get(`${path}/${privateVersion}/tarball`, { headers: { 'X-Share-Token': share } })
    expect(shared.status()).toBe(200)
    expect(await shared.body()).toEqual(tarballs.get(privateVersion))
    const sharedResolve = await request.get(`${resolve}&version=${privateVersion}`, { headers: { 'X-Share-Token': share } })
    expect(sharedResolve.status()).toBe(200)
    expect(await sharedResolve.json()).toMatchObject({ status: 'found', package: { id: name, version: privateVersion, signature: { algorithm: 'ed25519', value: expect.any(String) } } })
  }
})
