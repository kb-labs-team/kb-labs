import { test, expect } from '@playwright/test'
import { projectRest } from '@kb-labs/e2e-shared/project-rest.js'
import { loginAdmin } from '@kb-labs/e2e-shared/auth.js'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'

const analyticsPluginId = '@kb-labs/e2e-analytics-emitter'
const platformPluginRoot = `/workspace/kb-e2e/state/home/store/entries/@kb-labs+e2e-analytics-emitter@1.0.0/node_modules/${analyticsPluginId}`
const projectPath = '/workspace/kb-e2e-root-proof'
const projectPluginPath = 'plugins/e2e-analytics-emitter'

type PluginRegistryEntry = {
  pluginId: string
  pluginRoot: string
  source: { kind: string; path: string }
}

async function expectRegistryEntry(
  rest: Awaited<ReturnType<typeof projectRest>>,
  expected: Array<Pick<PluginRegistryEntry, 'pluginRoot' | 'source'>>,
): Promise<void> {
  await expect.poll(async () => {
    try {
      const response = await rest.get('/plugins/registry')
      if (response.status() !== 200) return `HTTP ${response.status()}`
      const body = await response.json() as {
        data?: { manifests?: PluginRegistryEntry[] }
        manifests?: PluginRegistryEntry[]
      }
      const manifests = body.data?.manifests ?? body.manifests ?? []
      return manifests
        .filter(manifest => manifest.pluginId === analyticsPluginId)
        .map(entry => ({ pluginRoot: entry.pluginRoot, source: entry.source }))
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }, { timeout: 45_000, intervals: [250, 500, 1_000, 2_000] }).toEqual(expected)
}

async function unregisterProjectAtPath(request: Parameters<typeof loginAdmin>[0], path: string): Promise<void> {
  await loginAdmin(request)
  const listed = await request.get(`${GATEWAY}/api/v1/projects`)
  expect(listed.status()).toBe(200)
  const body = await listed.json() as { data?: Array<{ id?: string; path?: string }> }
  const ids = (body.data ?? []).flatMap(project => project.path === path && project.id ? [project.id] : [])
  for (const id of ids) {
    const removed = await request.delete(`${GATEWAY}/api/v1/projects/${encodeURIComponent(id)}`)
    expect(removed.status()).toBe(200)
  }
}

test('ROOT-01: platform config endpoint is reachable and schema is valid', async ({ request }) => {
  const rest = await projectRest(request)
  const res = await rest.get(`/platform/config`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  expect(body.ok).toBe(true)
  expect(body.data?.schema).toMatch(/kb\.platform\.config/)
})

test('ROOT-03: project-local plugin overrides the platform Marketplace copy', async ({ request }) => {
  test.setTimeout(120_000)
  const platformRest = await projectRest(request)
  await expectRegistryEntry(platformRest, [{
    pluginRoot: platformPluginRoot,
    source: { kind: 'marketplace', path: platformPluginRoot },
  }])

  await unregisterProjectAtPath(request, projectPath)
  try {
    const added = await request.post(`${GATEWAY}/api/v1/projects`, { data: { path: projectPath } })
    expect(added.status()).toBe(201)
    const addedBody = await added.json() as { data?: { id?: string; path?: string } }
    expect(typeof addedBody.data?.id).toBe('string')
    expect(addedBody.data?.path).toBe(projectPath)

    const rest = await projectRest(request, projectPath)
    await expectRegistryEntry(rest, [{
      pluginRoot: `${projectPath}/${projectPluginPath}`,
      source: { kind: 'local', path: projectPluginPath },
    }])
  } finally {
    await unregisterProjectAtPath(request, projectPath)
  }
})

test('ROOT-04: start with custom projectRoot env var → config reflects that root', async () => { test.skip(true, 'not yet implemented') })
test('ROOT-05: workflow daemon discovers .kb/workflows from projectRoot not platformRoot', async () => { test.skip(true, 'not yet implemented') })
test('ROOT-06: marketplace lock file is read from projectRoot/.kb/marketplace.lock', async () => { test.skip(true, 'not yet implemented') })
