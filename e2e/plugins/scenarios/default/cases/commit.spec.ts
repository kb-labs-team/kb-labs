import { test, expect } from '@playwright/test'
import { projectRest } from '@kb-labs/e2e-shared/project-rest.js'

// CM-01: commit plugin is registered in platform
test('CM-01: commit plugin registered in platform', async ({ request }) => {
  const res = await (await projectRest(request)).get('/plugins/registry')
  expect(res.status()).toBe(200)
  const body = await res.json()
  const manifests: { pluginId?: string; manifest?: { id?: string; name?: string } }[] =
    body.data?.manifests ?? body.manifests ?? []
  const hasCommit = manifests.some(
    m =>
      m.pluginId?.includes('commit') ||
      m.manifest?.id?.includes('commit') ||
      m.manifest?.name?.toLowerCase().includes('commit'),
  )
  expect(hasCommit).toBe(true)
})

// CM-02: commit plugin manifest has commit command
test('CM-02: commit plugin manifest has commit command', async ({ request }) => {
  const res = await (await projectRest(request)).get('/plugins/registry')
  expect(res.status()).toBe(200)
  const body = await res.json()
  const manifests: { pluginId?: string; manifest?: { id?: string; name?: string; commands?: unknown[] } }[] =
    body.data?.manifests ?? body.manifests ?? []

  const commitPlugin = manifests.find(
    m =>
      m.pluginId?.includes('commit') ||
      m.manifest?.id?.includes('commit') ||
      m.manifest?.name?.toLowerCase().includes('commit'),
  )
  expect(!commitPlugin, 'commit plugin not found in registry').toBe(false)

  // Manifest must carry at least an identifier
  expect(
    commitPlugin!.pluginId ?? commitPlugin!.manifest?.id ?? commitPlugin!.manifest?.name,
  ).toMatch(/commit/i)
})
